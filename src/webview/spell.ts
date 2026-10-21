/*
 * Corrector ortográfico del editor visual. VS Code no ofrece el corrector del sistema dentro de un
 * webview, así que las palabras del documento se envían al host (que las comprueba con Hunspell) y
 * las que no reconoce se subrayan con la API de resaltados de CSS: no se toca el DOM del documento,
 * de modo que ni el cursor ni la conversión a LaTeX se ven afectados.
 */

/** Tramo de texto del documento: un nodo y la posición donde empieza dentro del texto corrido. */
export interface Seg {
  node: Text;
  at: number;
}

export interface Word {
  word: string;
  start: number;
  end: number;
}

/** Palabra sin reconocer y dónde está. */
export interface Hit {
  word: string;
  range: Range;
}

const BLOCKS = new Set([
  'DIV', 'P', 'LI', 'TD', 'TH', 'TR', 'TABLE', 'UL', 'OL', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'FIGURE', 'FIGCAPTION', 'BLOCKQUOTE', 'BR', 'HR',
]);

/**
 * Texto corrido de un bloque con la procedencia de cada tramo. Quedan fuera las fórmulas, las
 * referencias y demás código LaTeX (átomos), el texto monoespaciado, la bibliografía y los adornos
 * que Mars añade (numeración). Una palabra con formato a medias («<b>pa</b>labra») o partida por
 * un salto de hoja sigue siendo una sola palabra.
 */
export function flatten(root: Node): { text: string; segs: Seg[] } {
  let text = '';
  const segs: Seg[] = [];
  const sep = (): void => {
    if (text && !text.endsWith('\n')) text += '\n';
  };
  const walk = (node: Node): void => {
    for (let ch = node.firstChild; ch; ch = ch.nextSibling) {
      if (ch.nodeType === 3) {
        const t = ch as Text;
        if (t.data) {
          segs.push({ node: t, at: text.length });
          text += t.data;
        }
        continue;
      }
      if (ch.nodeType !== 1) continue;
      const el = ch as Element;
      if (el.classList.contains('pg-split')) continue;
      if (el.hasAttribute('data-tex') || el.hasAttribute('data-skip') || el.tagName === 'CODE' || el.tagName === 'PRE' || el.classList.contains('bib')) {
        sep();
        continue;
      }
      const block = BLOCKS.has(el.tagName);
      if (block) sep();
      walk(el);
      if (block) sep();
    }
  };
  walk(root);
  return { text, segs };
}

const WORD = /\p{L}[\p{L}\p{M}]*(?:['’][\p{L}\p{M}]+)*/gu;
/** Direcciones web y de correo escritas como texto. */
const ADDRESS = /\S*(?:@|:\/\/|www\.)\S*/g;

/** Palabras del texto que merece la pena comprobar. */
export function wordsIn(text: string): Word[] {
  const skip: [number, number][] = [];
  for (const m of text.matchAll(ADDRESS)) skip.push([m.index, m.index + m[0].length]);
  const out: Word[] = [];
  for (const m of text.matchAll(WORD)) {
    const w = m[0];
    const start = m.index;
    const end = start + w.length;
    if (w.length < 2) continue;
    // pegada a un número (unidades, «3er», referencias) o con guion bajo: no es prosa
    if (/[\d_]/.test(text[start - 1] ?? '') || /[\d_]/.test(text[end] ?? '')) continue;
    if (w === w.toUpperCase()) continue; // siglas
    if (/\p{Ll}\p{Lu}/u.test(w)) continue; // mayúsculas interiores: LaTeX, iPhone
    if (skip.some(([a, b]) => start >= a && end <= b)) continue;
    out.push({ word: w.normalize('NFC'), start, end });
  }
  return out;
}

/** Rango del DOM que corresponde a las posiciones [start, end) del texto corrido. */
export function rangeOf(segs: Seg[], start: number, end: number): Range {
  const find = (i: number): Seg => {
    let lo = 0;
    let hi = segs.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (segs[mid].at <= i) lo = mid;
      else hi = mid - 1;
    }
    return segs[lo];
  };
  const a = find(start);
  const b = find(end - 1);
  const r = a.node.ownerDocument.createRange();
  r.setStart(a.node, start - a.at);
  r.setEnd(b.node, end - b.at);
  return r;
}

export interface SpellDeps {
  post(m: unknown): void;
  /** contenido de los bloques editables, en el orden del documento */
  contents(): HTMLElement[];
  /** se ha repintado: ha podido cambiar el número de palabras sin reconocer */
  changed(): void;
}

const inside = (range: Range, node: Node, offset: number): boolean => {
  try {
    return range.comparePoint(node, offset) === 0;
  } catch {
    return false; // el punto ya no pertenece al documento
  }
};

export class SpellChecker {
  enabled = false;
  private key = '';
  private epoch = 0;
  private readonly verdict = new Map<string, boolean>();
  private readonly flying = new Set<string>();
  private readonly asked = new Map<number, { epoch: number; words: string[] }>();
  private hits = new Map<HTMLElement, Hit[]>();
  private timer: number | undefined;
  private reqId = 0;
  private typing = false;
  /** palabra que se está tecleando: no se subraya hasta que el cursor sale de ella */
  private hidden: Range | undefined;
  private readonly highlight = typeof Highlight === 'undefined' ? undefined : new Highlight();

  constructor(private readonly deps: SpellDeps) {
    if (this.highlight) CSS.highlights.set('mars-spell', this.highlight);
  }

  /** Activa o desactiva el corrector y fija sus idiomas. */
  configure(enabled: boolean, langs: string[]): void {
    const key = langs.join('+');
    if (key !== this.key) {
      // otro idioma: lo comprobado hasta ahora ya no vale
      this.key = key;
      this.epoch++;
      this.verdict.clear();
      this.flying.clear();
    }
    this.enabled = enabled && langs.length > 0;
    this.schedule();
  }

  /** ¿Queda alguna comprobación por terminar? */
  get pending(): boolean {
    return this.timer !== undefined || this.asked.size > 0;
  }

  /** Vuelve a revisar el documento dentro de un momento. `typing`: el cambio es una pulsación de tecla. */
  schedule(typing = false, delay = 300): void {
    this.typing ||= typing;
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.run(), delay);
  }

  run(): void {
    window.clearTimeout(this.timer);
    this.timer = undefined;
    const typing = this.typing;
    this.typing = false;
    this.hidden = undefined;
    const next = new Map<HTMLElement, Hit[]>();
    const need = new Set<string>();
    if (this.enabled) {
      const sel = document.getSelection();
      const caret = typing && sel?.isCollapsed && sel.anchorNode ? { node: sel.anchorNode, offset: sel.anchorOffset } : undefined;
      for (const c of this.deps.contents()) {
        const { text, segs } = flatten(c);
        const list: Hit[] = [];
        for (const w of wordsIn(text)) {
          const ok = this.verdict.get(w.word);
          if (ok === undefined && !this.flying.has(w.word)) need.add(w.word);
          if (ok !== false) continue;
          const range = rangeOf(segs, w.start, w.end);
          if (caret && c.contains(caret.node) && inside(range, caret.node, caret.offset)) {
            this.hidden = range;
            continue;
          }
          list.push({ word: w.word, range });
        }
        if (list.length) next.set(c, list);
      }
    }
    this.hits = next;
    this.highlight?.clear();
    for (const list of next.values()) for (const h of list) this.highlight?.add(h.range);
    if (need.size) {
      const words = [...need];
      const id = ++this.reqId;
      this.asked.set(id, { epoch: this.epoch, words });
      for (const w of words) this.flying.add(w);
      this.deps.post({ type: 'spell', id, words });
    }
    this.deps.changed();
  }

  /** Respuesta del host: `bad` son las palabras de la petición `id` que no reconoce. */
  onResult(id: number, bad: string[]): void {
    const req = this.asked.get(id);
    if (!req) return;
    this.asked.delete(id);
    if (req.epoch !== this.epoch) {
      this.schedule(false, 0);
      return;
    }
    const wrong = new Set(bad);
    for (const w of req.words) {
      this.flying.delete(w);
      this.verdict.set(w, !wrong.has(w));
    }
    this.schedule(false, 0);
  }

  /** El cursor se ha movido: la palabra que se estaba tecleando ya se puede subrayar. */
  caretMoved(): void {
    if (!this.hidden) return;
    const sel = document.getSelection();
    if (sel?.isCollapsed && sel.anchorNode && inside(this.hidden, sel.anchorNode, sel.anchorOffset)) return;
    this.schedule(false, 120);
  }

  /** Palabras sin reconocer, en el orden del documento. */
  list(): Hit[] {
    return this.deps.contents().flatMap((c) => this.hits.get(c) ?? []);
  }

  /** Palabra sin reconocer que hay bajo un punto de la ventana. */
  at(x: number, y: number): Hit | undefined {
    const pos = document.caretRangeFromPoint(x, y);
    if (!pos) return undefined;
    for (const list of this.hits.values()) {
      for (const h of list) if (inside(h.range, pos.startContainer, pos.startOffset)) return h;
    }
    return undefined;
  }

  /** Da una palabra por buena (añadida al diccionario u omitida en esta sesión). */
  accept(word: string): void {
    this.verdict.set(word, true);
    this.schedule(false, 0);
  }
}
