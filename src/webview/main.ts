import { caretOffset, caretToEnd, offsetOf, pointAt, setCaretOffset, textAroundCaret, units, wrapRange } from './caret';
import { CITE, citesIn, removeCite } from './cites';
import { type CoverText, type DeckOptions, type DeckSection, type Slide, CLOSING_DEFAULTS, DECK_DEFAULTS, buildSlides, closingHtml, coverHtml, coverOf, isDeckOpen, openDeck, plainOf, slideHtml } from './deck';
import { GALLERY, PALETTE, closeDialog, fillDialog, formulaProbe, isDialogOpen, openForm, openFormula, renderMath, setMathContext } from './dialogs';
import { diffWords } from '../diff';
import { calc } from '../latex/expand';
import { FONTS } from '../latex/layout';
import type { MathContext } from '../latex/mathext';
import { canHyphenate, dropHyphensAt, hyphenate, unhyphenate } from './hyphen';
import { htmlToLatex } from './paste';
import { plotPreview, plotTex } from './plot';
import { type HeadFootSpec, type NumberPlace, headFootPreview, toFriendly, toTex, withPageNumber } from './headfoot';
import { colorOf, es, FONT_SIZES, LANDSCAPE_MENU, LAYOUT_MENUS, ptText, sheetThumb, SIZE_EM, SPELL_CHOICES, STANDARD_COLORS, STYLES, THEME_COLORS, themeTones } from './ribbon';
import { bracesBalanced, escHtml, escapeLiteral, escapeText, serializeBlock, serializeChildren, stamp, tidy } from './serialize';
import { type Hit, SpellChecker, flatten, rangeOf } from './spell';

declare function acquireVsCodeApi(): { postMessage(m: unknown): void; getState(): unknown; setState(s: unknown): void };

interface Block {
  s: number;
  e: number;
  html: string;
  kind: 'rich' | 'atom' | 'ro';
  src: string;
  /** hay una línea en blanco justo antes / justo después del bloque */
  gb: boolean;
  ga: boolean;
  /** numeración y estilo de página fijados justo antes de este bloque */
  pagenum?: string;
  pagestyle?: string;
  pagestyleFrom?: string;
  /** interlineado propio del bloque (\singlespacing, \doublespacing... en el cuerpo) */
  lh?: number;
  /** entradas del índice (\addcontentsline) escritas justo antes de este bloque */
  anchors?: string[];
}

interface BlockEl extends HTMLDivElement {
  /** html renderizado actualmente; null = el usuario lo ha modificado */
  _html?: string | null;
  _b?: Block;
  /** idioma con el que se marcaron sus puntos de división de palabras ('' = sin marcar) */
  _hy?: string;
}

interface UpdateMsg {
  type: 'update';
  blocks: Block[];
  origin: 'preview' | 'editor' | 'full';
  ack: number;
  macros: Record<string, string>;
  labels: string[];
  insertLine: number;
  tailGap: boolean;
  meta: { title?: string; author?: string; date?: string };
  sources: { key: string; label: string; raw?: string; where?: 'bib' | 'doc' }[];
  authorYear?: boolean;
  layout?: LayoutInfo;
  page?: PageInfo;
  spell?: SpellInfo;
  /** partir las palabras con guion al final de línea, como hace LaTeX */
  hyphenate?: boolean;
  /** cómo se ven las hojas horizontales (ajuste `mars.landscapePages`) */
  landscape?: string;
  /** el archivo es una parte (un capítulo) de este documento principal */
  part?: string;
  /** versión antigua sacada de git: no se edita */
  readonly?: boolean;
  issues?: DocIssue[];
  furniture?: Furniture;
  shift?: number;
  focusLine?: number;
  /** comenzar a escribir tras instalar el documento base en una hoja vacía */
  startWriting?: boolean;
  /** lo que el preámbulo cambia en las fórmulas (babel en español, physics, siunitx) */
  math?: MathContext;
}

/** Estado del corrector ortográfico: lo elegido por el usuario y los idiomas que resultan. */
interface SpellInfo {
  enabled: boolean;
  /** «auto», «es», «en» o «es+en» */
  choice: string;
  langs: string[];
}

/** Encabezado y pie de las hojas (ver `Furniture` en el renderizador). */
interface Furniture {
  style: string;
  head: [string, string, string];
  foot: [string, string, string];
  headRule: boolean;
  footRule: boolean;
  src?: { head: [string, string, string]; foot: [string, string, string] };
}

/** Medidas de la hoja en centímetros. */
interface PageInfo {
  pageW: number;
  pageH: number;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  fontPt: number;
  spacing: number;
  columns: number;
  /** fuentes con las que se dibuja el texto (según el tipo de letra del documento) */
  fontCss?: string;
  /** alto de línea en veces el tamaño de letra, sangría de párrafo y separación entre párrafos (CSS) */
  lineHeight?: number;
  indent?: string;
  parSkip?: string;
  /** líneas de un párrafo que como mínimo quedan juntas al pie y al principio de una hoja */
  keepLines?: number;
}

/** Configuración de página leída del preámbulo. */
interface LayoutInfo {
  cls: string;
  paper: string;
  /** tamaño personalizado «ancho,alto» */
  paperSize: string;
  fontSize: string;
  columns: string;
  orientation: string;
  /** márgenes «superior,inferior,izquierdo,derecho»; vacío = los de LaTeX */
  margins: string;
  margin: string;
  spacing: string;
  lang: string;
  /** tipo de letra del documento (clave de FONTS); vacío = el de LaTeX */
  font: string;
  /** '1' = sin líneas viudas ni huérfanas */
  widows?: string;
  /** ancho de la caja de texto en centímetros */
  textWidth: number;
}

/** Bloque que se está editando y rango de líneas del documento que le pertenece. */
interface Active {
  el: BlockEl;
  rs: number;
  /** última línea incluida; re < rs = párrafo nuevo que aún no existe en el documento */
  re: number;
  /** líneas en blanco propias que el rango incluye antes y después del contenido (0 o 1) */
  lead: number;
  trail: number;
  /** ¿está en blanco la línea anterior / la siguiente al rango? */
  before: boolean;
  after: boolean;
  /** texto de las líneas vecinas, si se conoce: el host comprueba que siguen ahí al insertar */
  prev?: string;
  next?: string;
  /** líneas que hay ahora mismo en el documento dentro de [rs, re] */
  cur: string[];
  dirty: boolean;
  timer?: number;
  /** volver a pintar el bloque con el render real en la próxima actualización */
  refresh?: boolean;
  /** paquetes que necesita lo que se ha escrito: van con el próximo envío al documento */
  pkgs?: string[];
}

/** Qué hay a cada lado de un punto de inserción. */
interface Gap {
  /** la línea anterior / la que quedará detrás está en blanco */
  before: boolean;
  after: boolean;
  prev?: string;
  next?: string;
}

/** Líneas del documento que ocupa el contenido de un bloque y lo que tiene alrededor. */
interface Extent extends Gap {
  s: number;
  lines: string[];
}

interface Focus {
  line: number;
  atStart?: boolean;
  offset?: number;
  /** final de la selección que hay que recuperar (empieza en `offset`) y el texto que abarcaba */
  end?: number;
  text?: string;
  /** si el bloque no admite texto (un salto de página, una figura), abrir un párrafo nuevo detrás */
  thenWrite?: boolean;
  /** si en esa línea ya no hay nada, ir al bloque siguiente en lugar del anterior */
  forward?: boolean;
}

const vscode = acquireVsCodeApi();
const post = (m: unknown): void => vscode.postMessage(m);
/**
 * Preferencias de la vista que valen para todos los documentos: las guarda la extensión y llegan
 * en la página (`data-prefs`). Al cambiar una, se avisa al host, que la guarda y la pasa a los
 * demás editores abiertos. (Antes se guardaban por pestaña: se leen de ahí si aún no hay globales.)
 */
interface Prefs {
  paper?: Paper;
  ribbonMin?: boolean;
  colors?: string[];
  view?: 'page' | 'flow';
  zoom?: number | 'fit' | 'sheet';
  /** cómo se hacen las presentaciones: qué incluyen y con qué estilo */
  deck?: Partial<DeckOptions>;
}
const prefs: Prefs = ((): Prefs => {
  const old = (vscode.getState() as Prefs | undefined) ?? {};
  try {
    return { paper: old.paper, ribbonMin: old.ribbonMin, colors: old.colors, ...(JSON.parse(document.body.dataset.prefs ?? '{}') as Prefs) };
  } catch {
    return old;
  }
})();
const savePrefs = (patch: Prefs): void => post({ type: 'prefs', patch });
/** qué llevan las presentaciones (panel lateral, cara «Presentación») */
let deckOpts: DeckOptions = { ...DECK_DEFAULTS, ...(prefs.deck ?? {}) };
/** textos propios de la portada de la presentación de este documento (los guarda la extensión) */
let deckCoverText: CoverText = ((): CoverText => {
  try {
    return JSON.parse(document.body.dataset.cover ?? '{}') as CoverText;
  } catch {
    return {};
  }
})();
/** color del papel en la vista de página: no cambia el documento, solo cómo se ve al escribir */
type Paper = 'white' | 'sepia' | 'dark';
let paper: Paper = prefs.paper === 'sepia' || prefs.paper === 'dark' ? prefs.paper : 'white';
function applyPaper(): void {
  document.body.classList.toggle('paper-sepia', paper === 'sepia');
  document.body.classList.toggle('paper-dark', paper === 'dark');
  document.querySelectorAll<HTMLElement>('button[data-cmd="paper"]').forEach((b) => b.classList.toggle('on', b.dataset.arg === paper));
}
const root = document.getElementById('root') as HTMLElement;
const toolbar = document.getElementById('toolbar') as HTMLElement;
const emptyEl = document.getElementById('empty') as HTMLElement;
const tail = document.getElementById('tail') as HTMLElement;

let blocks: Block[] = [];
let els: BlockEl[] = [];
let macros: Record<string, string> = {};
let labels: string[] = [];
let insertLine = 0;
let tailGap = false;
let meta: UpdateMsg['meta'] = {};
let sources: UpdateMsg['sources'] = [];
/** el documento cita por autor y año (natbib, biblatex): las citas nuevas van entre paréntesis, con \citep */
let authorYear = false;
const citeTex = (key: string): string => `\\${authorYear ? 'citep' : 'cite'}{${key}}`;
let layout: LayoutInfo | undefined;
let pageInfo: PageInfo = {
  pageW: 21.59, pageH: 27.94, marginTop: 3.7, marginBottom: 3.7, marginLeft: 4.75, marginRight: 4.75, fontPt: 10, spacing: 1, columns: 1,
};
/** 'page' = hojas como al imprimir; 'flow' = texto continuo con los colores del editor */
let viewMode: 'page' | 'flow' = prefs.view === 'flow' ? 'flow' : 'page';
/** factor de zoom, o 'fit' para ajustar la hoja al ancho del panel */
/** 'fit' = ajuste automático al panel; 'sheet' = hoja completa aunque quede pequeña */
let zoom: number | 'fit' | 'sheet' = typeof prefs.zoom === 'number' && prefs.zoom >= 0.15 && prefs.zoom <= 2.5 ? prefs.zoom : prefs.zoom === 'sheet' ? 'sheet' : 'fit';
/** Guarda el zoom elegido por el usuario (con la rueda llegan muchos seguidos: solo el último). */
let zoomSaveTimer: number | undefined;
function rememberZoom(): void {
  window.clearTimeout(zoomSaveTimer);
  zoomSaveTimer = window.setTimeout(() => savePrefs({ zoom }), 400);
}
let seq = 0;
let active: Active | undefined;
let nextFocus: Focus | undefined;
let lastEl: BlockEl | undefined;
let modal = false;
let saved: Range | undefined;
let composing = false;

const content = (el: BlockEl): HTMLElement => el.lastElementChild as HTMLElement;
const selection = (): Selection => document.getSelection() as Selection;

// ------------------------------------------------------------------ imágenes PDF

interface PdfJs {
  GlobalWorkerOptions: { workerSrc: string; workerPort: Worker | null };
  getDocument(src: { url: string }): { promise: Promise<PdfDoc> };
}
interface PdfDoc {
  getPage(n: number): Promise<{
    getViewport(o: { scale: number }): { width: number; height: number };
    render(o: { canvasContext: CanvasRenderingContext2D; canvas: HTMLCanvasElement; viewport: unknown }): { promise: Promise<void> };
  }>;
}

let pdfjs: Promise<PdfJs> | undefined;

/** Carga pdf.js solo cuando el documento contiene alguna imagen PDF. */
function loadPdfJs(): Promise<PdfJs> {
  pdfjs ??= (async () => {
    const lib = (await import(/* @vite-ignore */ document.body.dataset.pdfjs as string)) as PdfJs;
    try {
      // el worker vive en otro origen: se descarga y se lanza desde un blob
      const code = await (await fetch(document.body.dataset.pdfworker as string)).blob();
      const url = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
      lib.GlobalWorkerOptions.workerPort = new Worker(url, { type: 'module' });
    } catch {
      lib.GlobalWorkerOptions.workerSrc = document.body.dataset.pdfworker as string;
    }
    return lib;
  })();
  return pdfjs;
}

function drawPdfs(scope: HTMLElement): void {
  for (const canvas of Array.from(scope.querySelectorAll<HTMLCanvasElement>('canvas.pdfimg:not([data-done])'))) {
    canvas.dataset.done = 'pending';
    void (async () => {
      try {
        const lib = await loadPdfJs();
        const page = await (await lib.getDocument({ url: canvas.dataset.pdf as string }).promise).getPage(1);
        const viewport = page.getViewport({ scale: 2 });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        // sin medidas en \includegraphics: el tamaño de la página del PDF (en puntos), por `scale`
        if (canvas.dataset.scale) {
          const cm = (viewport.width / 2 / 72) * 2.54 * (parseFloat(canvas.dataset.scale) || 1);
          canvas.style.width = `calc(${cm.toFixed(3)} * var(--cm, 37.8px))`;
        }
        await page.render({ canvasContext: canvas.getContext('2d') as CanvasRenderingContext2D, canvas, viewport }).promise;
        canvas.dataset.done = 'ok';
        if (canvas.dataset.angle && canvas.parentElement) rotateImages(canvas.parentElement);
      } catch (err) {
        canvas.dataset.done = 'error';
        canvas.title = `No se pudo dibujar el PDF: ${String(err)}`;
      }
      post({ type: 'pdfDrawn', state: canvas.dataset.done, error: canvas.dataset.done === 'error' ? canvas.title : undefined });
    })();
  }
}

// ------------------------------------------------------------------ bloques

function createBlock(): BlockEl {
  const el = document.createElement('div') as BlockEl;
  el.className = 'block';
  el.innerHTML =
    '<div class="tools" contenteditable="false">' +
    '<button data-act="drag" title="Arrastrar para mover el bloque (con Ctrl, copiarlo)"><i class="codicon codicon-gripper"></i></button>' +
    '<button data-act="up" title="Subir el bloque (Alt+↑)"><i class="codicon codicon-arrow-up"></i></button>' +
    '<button data-act="down" title="Bajar el bloque (Alt+↓)"><i class="codicon codicon-arrow-down"></i></button>' +
    '<button data-act="dup" title="Duplicar el bloque (Ctrl+D)"><i class="codicon codicon-copy"></i></button>' +
    '<span class="tools-sep"></span>' +
    '<button data-act="src" title="Editar el código LaTeX de este bloque"><i class="codicon codicon-code"></i></button>' +
    '<button data-act="add" title="Nuevo párrafo debajo"><i class="codicon codicon-add"></i></button>' +
    '<button data-act="goto" title="Ir a la línea en el editor de código"><i class="codicon codicon-go-to-file"></i></button>' +
    '<button data-act="del" title="Eliminar bloque"><i class="codicon codicon-trash"></i></button>' +
    '</div><div class="content"></div>';
  return el;
}

/**
 * Una imagen incluida sin medidas se ve a su tamaño natural, como en LaTeX: sus píxeles a la
 * resolución que declare el archivo (72 por pulgada si no dice nada), por el factor `scale`.
 */
function sizeImages(scope: HTMLElement): void {
  for (const img of Array.from(scope.querySelectorAll<HTMLImageElement>('img[data-scale]'))) {
    const apply = (): void => {
      // (si el archivo ya dijo cuántos píxeles tiene, no hace falta esperar a que cargue)
      const width = Number(img.getAttribute('width')) || img.naturalWidth;
      if (!width) return;
      const dpi = parseFloat(img.dataset.dpi ?? '') || 72;
      const cm = (width / dpi) * 2.54 * (parseFloat(img.dataset.scale ?? '1') || 1);
      img.style.width = `calc(${cm.toFixed(3)} * var(--cm, 37.8px))`;
    };
    if (img.complete || img.hasAttribute('width')) apply();
    else img.addEventListener('load', apply, { once: true });
  }
}

function setHtml(el: BlockEl, b: Block, force = false): void {
  const c = content(el);
  if (force || el._html !== b.html) {
    c.innerHTML = b.html;
    stamp(c);
    drawPdfs(c);
    sizeImages(c);
    cropImages(c);
    rotateImages(c);
    el._html = b.html;
    el._hy = '';
    dirty.add(el);
  }
  el._b = b;
  // una figura rodeada de texto: el ancho pedido es el del bloque que va a un lado
  const wrapped = c.querySelector<HTMLElement>(':scope > figure[data-wrap]');
  if (wrapped && wrapped.style.width !== '100%') {
    el.style.width = wrapped.style.width;
    wrapped.style.width = '100%';
  } else if (!wrapped) el.style.removeProperty('width');
  if (b.pagenum) el.dataset.pagenum = b.pagenum;
  else delete el.dataset.pagenum;
  if (b.pagestyle) el.dataset.pagestyle = b.pagestyle;
  else delete el.dataset.pagestyle;
  if (b.pagestyleFrom) el.dataset.pagestyleFrom = b.pagestyleFrom;
  else delete el.dataset.pagestyleFrom;
  if (b.anchors?.length) el.dataset.anchors = b.anchors.join(' ');
  else delete el.dataset.anchors;
  const lh = b.lh ? String(b.lh) : '';
  if (el.style.lineHeight !== lh) {
    if (lh) el.style.lineHeight = lh;
    else el.style.removeProperty('line-height');
    dirty.add(el);
  }
  c.contentEditable = b.kind === 'rich' && !readOnly ? 'true' : 'false';
  el.classList.remove('k-rich', 'k-atom', 'k-ro', 'pending');
  el.classList.add('k-' + b.kind);
  // el preámbulo no es contenido de la hoja: se muestra como una etiqueta en el margen superior
  el.classList.toggle('is-preamble', c.firstElementChild?.getAttribute('data-role') === 'preamble');
}

/** Lo que tardó el último redibujado completo y el último reparto en hojas (milisegundos). */
const perf: Record<string, number> = { update: 0, paginate: 0 };
(window as unknown as { __perf: unknown }).__perf = perf;
let perfMark = 0;
const lap = (name: string): void => {
  const now = performance.now();
  perf[name] = Math.round(now - perfMark);
  perfMark = now;
};

/**
 * Un documento grande se dibuja por tandas: las primeras hojas salen enseguida y el resto se va
 * añadiendo detrás sin bloquear el editor (componer cientos de párrafos de golpe tarda segundos).
 */
const LOAD_MIN = 120;
/** bloques nuevos por tanda; se ajusta para que cada una dure poco más de una décima de segundo */
let loadChunk = 30;
let loadTimer: number | undefined;
/** parte del documento ya dibujada mientras se carga (0–1); 1 cuando está entero */
let loaded = 1;

function onUpdate(m: UpdateMsg): void {
  const started = performance.now();
  window.clearTimeout(loadTimer);
  let more = false;
  try {
    more = applyUpdate(m);
  } finally {
    perf.update = performance.now() - started;
  }
  if (more) {
    loadChunk = Math.round(Math.min(Math.max((loadChunk * 140) / Math.max(perf.update, 20), 20), 260));
    // lo que queda, en la siguiente tanda: sin volver a mover el cursor ni desplazar líneas
    loadTimer = window.setTimeout(() => onUpdate({ ...m, origin: 'preview', shift: undefined, focusLine: undefined }), 12);
  }
}

/** Dibuja el documento recibido. Devuelve `true` si, por ser grande, queda parte para otra tanda. */
function applyUpdate(m: UpdateMsg): boolean {
  if (m.ack < seq) {
    // viene otra actualización más reciente en camino
    post({ type: 'rendered', ignored: true });
    loaded = 1;
    return false;
  }
  macros = m.macros;
  setMathContext(m.math);
  labels = m.labels;
  insertLine = m.insertLine;
  tailGap = m.tailGap;
  meta = m.meta;
  sources = m.sources ?? [];
  authorYear = m.authorYear === true;
  layout = m.layout;
  if (m.page) pageInfo = m.page;
  if (m.spell) spellInfo = m.spell;
  hyphenation = m.hyphenate !== false;
  setLandscapeView(m.landscape ?? 'edit');
  partOf = m.part ?? '';
  issues = m.issues ?? [];
  if (readOnly !== (m.readonly === true)) {
    readOnly = m.readonly === true;
    document.body.classList.toggle('readonly', readOnly);
    // una versión antigua se abre enseñando qué cambió en ella
    if (readOnly && !gitOpen) window.setTimeout(() => run('git'), 0);
  }
  if (m.furniture) furniture = m.furniture;
  updateSources();
  if (m.shift && nextFocus) nextFocus.line += m.shift;
  if (m.focusLine !== undefined && !nextFocus) nextFocus = { line: m.focusLine };

  let keep = -1;
  let pendingEl: BlockEl | undefined;
  if (active) {
    if (m.origin !== 'preview') {
      // un formato que añade su paquete al preámbulo desplaza las líneas y obliga a redibujar todo:
      // el cursor vuelve al mismo sitio del mismo bloque
      if (m.shift && !nextFocus && active.re >= active.rs) {
        const c = content(active.el);
        const sel = selection();
        const r = sel.rangeCount && c.contains(sel.anchorNode) ? sel.getRangeAt(0) : undefined;
        nextFocus = {
          line: active.rs + active.lead + m.shift, offset: caretOffset(c),
          end: r && !r.collapsed ? offsetOf(c, r.endContainer, r.endOffset) : undefined, text: r?.toString(),
        };
      }
      dropActive();
    } else if (active.re < active.rs) pendingEl = active.el;
    else {
      const cs = active.rs + active.lead;
      const ce = active.re - active.trail;
      keep = m.blocks.findIndex((b) => b.s === cs && b.e === ce && b.kind === 'rich');
      if (keep < 0) {
        nextFocus ??= { line: ce };
        dropActive();
      } else nextFocus = undefined;
    }
  }

  // con muchos bloques por crear, en esta tanda solo los siguientes (y las notas al pie, que van al final)
  let list = m.blocks;
  if (m.blocks.length - els.length > LOAD_MIN) {
    const n = Math.max(els.length + loadChunk, keep + 1);
    if (n < m.blocks.length - 1) {
      const last = m.blocks[m.blocks.length - 1];
      list = [...m.blocks.slice(0, n), ...(last.kind === 'ro' ? [last] : [])];
    }
  }
  const partial = list !== m.blocks;
  loaded = partial ? list.length / m.blocks.length : 1;

  const a = keep >= 0 ? active : undefined;
  const old = els.filter((e) => e !== a?.el);
  const before = a ? old.filter((e) => a.el.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_PRECEDING) : old;
  const after = a ? old.filter((e) => !(a.el.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_PRECEDING)) : [];
  // el bloque de las notas al pie va siempre al final: conserva su elemento aunque delante aparezcan
  // bloques nuevos (si no, cada tanda de carga lo daría por cambiado y obligaría a repartirlo todo)
  const tailPool = after.length || !a ? (after.length ? after : before) : before;
  const lastOld = tailPool[tailPool.length - 1];
  const notesEl = list.length && list[list.length - 1].kind === 'ro' && lastOld?._b?.kind === 'ro' ? tailPool.pop() : undefined;
  const next: BlockEl[] = [];
  list.forEach((b, j) => {
    let el: BlockEl;
    if (a && j === keep) {
      el = a.el;
      el.classList.remove('pending');
      el._b = b;
      if (!a.lead) a.before = b.gb;
      if (!a.trail) a.after = b.ga;
      // se repinta si se pidió, o si el usuario no lo ha tocado y su dibujo ha cambiado
      // (p. ej. terminó de generarse una figura que está dentro del bloque)
      if (!a.dirty && (a.refresh || (el._html !== null && el._html !== b.html))) {
        const c = content(el);
        const off = caretOffset(c);
        // Lo recién insertado (un texto pegado con formato, un enlace) era una sola pieza y ahora se
        // dibuja con su texto, que ocupa más: si queda delante del cursor, este se recoloca contando
        // desde el final del bloque, que es lo que no ha cambiado.
        const fresh = Array.from(c.querySelectorAll('[data-new]')).pop();
        const behind = fresh?.parentNode && off !== undefined && offsetOf(c, fresh.parentNode, Array.from(fresh.parentNode.childNodes).indexOf(fresh) + 1) <= off;
        const tail = behind && off !== undefined ? units(c) - off : undefined;
        setHtml(el, b, true);
        if (tail !== undefined) setCaretOffset(c, Math.max(units(c) - tail, 0));
        else if (off !== undefined) setCaretOffset(c, off);
        a.refresh = false;
      }
    } else {
      el = (notesEl && j === list.length - 1 ? notesEl : keep < 0 || j < keep ? before.shift() : after.shift()) ?? createBlock();
      setHtml(el, b);
    }
    el.dataset.i = String(j);
    next.push(el);
  });
  const gone = [...before, ...after];
  for (const e of gone) {
    // lo que rodeaba a un bloque que desaparece hay que volver a repartirlo
    let near = e.nextElementSibling as BlockEl | null;
    while (near && gone.includes(near)) near = near.nextElementSibling as BlockEl | null;
    if (!near) {
      near = e.previousElementSibling as BlockEl | null;
      while (near && gone.includes(near)) near = near.previousElementSibling as BlockEl | null;
    }
    if (near) dirty.add(near);
    else dirtyAll = true;
  }
  for (const e of gone) e.remove();

  let ref: ChildNode | null = root.firstChild;
  const skipPending = (): void => {
    while (ref && ref === pendingEl) ref = ref.nextSibling;
  };
  skipPending();
  for (const el of next) {
    if (el === ref) {
      ref = ref.nextSibling;
      skipPending();
    } else root.insertBefore(el, ref);
  }
  els = next;
  blocks = list;
  markParagraphs();
  markHyphens();
  if (lastEl && !lastEl.isConnected) lastEl = undefined;
  emptyEl.hidden = blocks.length > 0 || pendingEl !== undefined;
  // medidas de la hoja y reparto en páginas, ya con el contenido nuevo y antes de situar el cursor
  applyLayout();

  if (nextFocus) {
    const nf = nextFocus;
    nextFocus = undefined;
    focusLine(nf);
  }
  if (m.startWriting && !readOnly) openPending(insertLine, { before: tailGap, after: false });
  replayTypeAhead();
  if (xsel) {
    // la selección de varios bloques sobrevive a un repintado propio; si el documento cambió por otro lado, no
    if (m.origin === 'preview' || m.ack === xselKeep) paintXsel();
    else clearXsel();
  }
  xselKeep = -1;
  if (moveKeep) {
    // los bloques que se acaban de mover siguen seleccionados: se pueden seguir subiendo o bajando
    const { from, to } = moveKeep;
    moveKeep = undefined;
    const moved = els.filter((el) => selectable(el) && el._b !== undefined && el._b.s >= from && el._b.s <= to);
    if (moved.length) {
      setXsel({ el: moved[0], off: 0 }, { el: moved[moved.length - 1], off: XEND });
      moved[0].scrollIntoView({ block: 'nearest' });
    }
  }
  updateToolbar();
  updateOutline();
  updateSpellUi();
  updateStyles();
  if (!findEl.hidden) runFind(true);
  spell.configure(spellInfo.enabled, spellInfo.langs);
  if (partial) return true;
  if (gitOpen && gitState.changes.length) markChanges();
  post({ type: 'rendered', count: blocks.length, ack: m.ack });
  return false;
}

// ------------------------------------------------------------------ teclas en tránsito

/*
 * Un cambio de estructura (partir un párrafo, convertirlo en título o en lista...) pasa por el
 * documento y vuelve redibujado. Durante ese instante no hay bloque en edición: lo que se teclee
 * se guarda aquí y se escribe en cuanto el cursor vuelve a estar en su sitio, para no perder
 * letras al escribir deprisa.
 */
let typeAhead = '';
let transitAt = 0;
const inTransit = (): boolean => !active && nextFocus !== undefined && Date.now() - transitAt < 2500;

document.addEventListener(
  'keydown',
  (e) => {
    if (!inTransit() || isDialogOpen()) return;
    // AltGr (Ctrl+Alt) escribe caracteres como @, #, { o \ en los teclados españoles
    if ((e.ctrlKey || e.metaKey || e.altKey) && !e.getModifierState('AltGraph')) return;
    if (e.key.length === 1) typeAhead += e.key;
    else if (e.key === 'Backspace') typeAhead = typeAhead.slice(0, -1);
    else return;
    e.preventDefault();
    e.stopPropagation();
  },
  true,
);

function replayTypeAhead(): void {
  const text = typeAhead;
  const paste = pendingPaste;
  typeAhead = '';
  pendingPaste = undefined;
  if (!active || !active.el.contains(selection().anchorNode)) return;
  // lo que se pegó sobre una selección de varios bloques, ahora que el hueco existe
  if (paste) pasteHtml(paste.html, paste.text);
  if (!text) return;
  if (!document.execCommand('insertText', false, text)) {
    const r = selection().getRangeAt(0);
    r.insertNode(document.createTextNode(text));
    r.collapse(false);
  }
  markDirty();
}

/**
 * Marca los párrafos de texto corrido para dibujarlos como los compone LaTeX: seguidos, con
 * sangría en la primera línea. No la llevan el que sigue a un título (salvo en español, donde
 * babel la pone siempre), el que continúa tras una ecuación sin línea en blanco, ni el que
 * empieza con `\noindent`.
 */
function markParagraphs(): void {
  const spanish = layout?.lang === 'spanish';
  let afterHead = false;
  for (const el of els) {
    if (el.classList.contains('is-preamble')) continue;
    const c = content(el);
    const para = el._b?.kind === 'rich' && isPlain(c);
    const was = el.className;
    el.classList.toggle('k-para', para);
    const glued = el._b?.gb === false && !afterHead;
    el.classList.toggle('no-indent', para && (glued || (afterHead && !spanish) || /^\s*\\noindent\b/.test(el._b?.src ?? '')));
    afterHead = c.querySelector(':scope > [data-k="head"]') !== null;
    // con otra sangría el párrafo puede ocupar otras líneas
    if (el.className.replace(/ ?(active|sel|page-start|floated)\b/g, '') !== was.replace(/ ?(active|sel|page-start|floated)\b/g, '')) dirty.add(el);
  }
}

let furniture: Furniture = { style: 'plain', head: ['', '', ''], foot: ['', '\u0002PAGE\u0002', ''], headRule: false, footRule: false };
/** ¿se parten las palabras al final de línea? (ajuste `mars.hyphenation`) */
let hyphenation = true;
/** documento principal del que este archivo es un capítulo */
let partOf = '';
interface DocIssue {
  kind: 'ref' | 'cite' | 'label' | 'image';
  text: string;
  line: number;
}
/** avisos que daría LaTeX al compilar: referencias y citas sin definir, etiquetas repetidas, imágenes que faltan */
let issues: DocIssue[] = [];
/** el documento es una versión antigua (de git): se ve pero no se edita */
let readOnly = false;
/** Por encima de este tamaño de documento las marcas de división pesarían demasiado. */
const HYPHEN_LIMIT = 600_000;

/**
 * Marca dónde puede partirse cada palabra, en el idioma del documento, para que los párrafos
 * rompan las líneas como en el PDF. Solo se tratan los bloques recién dibujados.
 */
function markHyphens(): void {
  // sin idioma declarado LaTeX divide con los patrones del inglés
  const wanted = layout?.lang || 'english';
  const lang = hyphenation && canHyphenate(wanted) && blocks.reduce((n, b) => n + b.src.length, 0) < HYPHEN_LIMIT ? wanted : '';
  for (const el of els) {
    if (el._hy === lang || el.classList.contains('is-preamble')) continue;
    const c = content(el);
    if (el._hy) unhyphenate(c);
    if (lang) hyphenate(c, lang);
    el._hy = lang;
    dirty.add(el);
  }
}

function select(el: BlockEl | undefined): void {
  root.querySelector('.block.sel')?.classList.remove('sel');
  el?.classList.add('sel');
  if (el) lastEl = el;
}

function focusLine(nf: Focus): void {
  let idx = -1;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].s <= nf.line) idx = i;
    else break;
  }
  if (nf.forward && idx >= 0 && blocks[idx].e < nf.line) {
    // la línea ha quedado vacía: el primer bloque de texto que venga después
    const next = blocks.findIndex((b, i) => i > idx && b.kind !== 'ro');
    if (next >= 0 && blocks[next].kind === 'rich') idx = next;
  }
  if (idx < 0) idx = 0;
  const el = els[idx];
  if (!el) return;
  el.scrollIntoView({ block: 'nearest' });
  if (blocks[idx].kind !== 'rich') {
    select(el);
    const x = nf.thenWrite ? extent(el) : undefined;
    if (x) {
      const at = afterOf(x);
      openPending(at.line, at.gap, el);
    }
    return;
  }
  activateEl(el);
  const c = content(el);
  if (nf.offset !== undefined && nf.end !== undefined && nf.end > nf.offset) {
    // se recupera la selección entera, no solo el cursor. El formato recién aplicado puede haber
    // metido dentro su comando (una unidad oculta más): se alarga hasta abarcar el mismo texto
    const a = pointAt(c, nf.offset);
    const range = document.createRange();
    for (let extra = 0; extra < 4; extra++) {
      const b = pointAt(c, nf.end + extra);
      range.setStart(a.node, a.offset);
      range.setEnd(b.node, b.offset);
      if (nf.text === undefined || range.toString() === nf.text) break;
    }
    selection().removeAllRanges();
    selection().addRange(range);
  } else if (nf.offset !== undefined) setCaretOffset(c, nf.offset);
  else if (nf.atStart) setCaretOffset(c, 0);
  else caretToEnd(c);
}

// ------------------------------------------------------------------ edición en sitio

function activate(el: BlockEl): void {
  if (active?.el === el) return;
  if (active) deactivate();
  const b = el._b;
  if (!b || b.kind !== 'rich' || readOnly) return;
  active = { el, rs: b.s, re: b.e, lead: 0, trail: 0, before: b.gb, after: b.ga, cur: b.src.split('\n'), dirty: false };
  el.classList.add('active');
  select(el);
  updateToolbar();
  post({ type: 'reveal', line: b.s });
  // una hoja horizontal se edita apaisada y entera: en el centro de la vista (o desde su borde de
  // arriba, si es más alta que lo que se ve)
  const land = landscapeView === 'edit' && document.body.classList.contains('paged') ? el.querySelector<HTMLElement>(':scope > .content > .landscape') : null;
  if (land) {
    requestAnimationFrame(() => {
      const r = land.getBoundingClientRect();
      const floor = toolbar.getBoundingClientRect().bottom + 12;
      const room = window.innerHeight - floor - 12;
      const top = r.height <= room ? r.top - floor - (room - r.height) / 2 : r.top - floor;
      if (Math.abs(top) > 4) window.scrollBy({ top, behavior: 'smooth' });
    });
  }
}

function activateEl(el: BlockEl): void {
  content(el).focus({ preventScroll: true });
  activate(el);
}

/** `lines` con las líneas en blanco propias del rango del bloque. */
const padded = (a: Active, lines: string[]): string[] => [...(a.lead ? [''] : []), ...lines, ...(a.trail ? [''] : [])];

/** Contenido del bloque en edición dentro del documento (sin sus líneas en blanco propias). */
function activeExtent(a: Active): Extent {
  if (a.re < a.rs) return { s: a.rs, lines: [], before: a.before, after: a.after, prev: a.prev, next: a.next };
  return { s: a.rs + a.lead, lines: a.cur.slice(a.lead, a.cur.length - a.trail), before: a.lead === 1 || a.before, after: a.trail === 1 || a.after };
}

function extent(el: BlockEl): Extent | undefined {
  if (active?.el === el) return activeExtent(active);
  const b = el._b;
  return b ? { s: b.s, lines: b.src.split('\n'), before: b.gb, after: b.ga } : undefined;
}

/** Punto de inserción justo detrás / justo delante de un bloque. */
function afterOf(x: Extent): { line: number; gap: Gap } {
  if (!x.lines.length) return { line: x.s, gap: x };
  return { line: x.s + x.lines.length, gap: { before: false, after: x.after, prev: x.lines[x.lines.length - 1] } };
}
const beforeOf = (x: Extent): { line: number; gap: Gap } => ({ line: x.s, gap: { before: x.before, after: false, next: x.lines[0] } });

/**
 * Qué poner en lugar de unas líneas que se eliminan sin que el documento acumule líneas en blanco:
 * nada si ya hay una al lado (y si las hay a ambos lados, sobra una); si no, una línea en blanco
 * para que los párrafos vecinos no se junten.
 */
function removal(x: Extent): { expect: string[]; lines: string[] } {
  if (x.before && x.after) return { expect: [...x.lines, ''], lines: [] };
  return { expect: x.lines, lines: x.before || x.after ? [] : [''] };
}

/** El documento ha cambiado de tamaño a partir de `from`: se corrigen las líneas que se conocen. */
function shiftLines(from: number, delta: number): void {
  if (!delta) return;
  for (const b of blocks) {
    if (b.s >= from) {
      b.s += delta;
      b.e += delta;
    }
  }
  if (insertLine >= from) insertLine += delta;
}

/** Envía al documento el contenido del bloque activo si ha cambiado. */
function flush(a: Active, final = false, packages?: string[]): boolean {
  window.clearTimeout(a.timer);
  a.timer = undefined;
  if (!a.dirty) return false;
  dirty.add(a.el);
  packages ??= a.pkgs;
  a.pkgs = undefined;
  const tex = serializeBlock(content(a.el));
  // un bloque vacío no se borra mientras se sigue escribiendo en él
  if (!tex && (!final || a.re < a.rs)) return false;
  a.dirty = false;
  const end = a.rs + a.cur.length;
  if (!tex) {
    // bloque vaciado: desaparece del documento
    const r = removal({ s: a.rs, lines: a.cur, before: a.before, after: a.after });
    post({ type: 'splice', s: a.rs, d: r.expect.length, lines: r.lines, expect: r.expect, seq: ++seq, packages });
    shiftLines(end, r.lines.length - r.expect.length);
    if (r.expect.length > a.cur.length) a.after = false; // se llevó la línea en blanco siguiente
    else if (r.lines.length) a.after = true; // dejó una línea en blanco en su lugar
    a.re = a.rs - 1;
    a.cur = [];
    a.lead = a.trail = 0;
    a.prev = a.next = undefined;
    return true;
  }
  const out = padded(a, tex.split('\n'));
  // una inserción no sustituye nada: se comprueba al menos que las líneas vecinas son las esperadas
  const guard = a.cur.length ? {} : { prev: a.prev, next: a.next };
  post({ type: 'splice', s: a.rs, d: a.cur.length, lines: out, expect: a.cur, seq: ++seq, packages, ...guard });
  shiftLines(end, out.length - a.cur.length);
  a.re = a.rs + out.length - 1;
  a.cur = out;
  return true;
}

function markDirty(now = false): void {
  const a = active;
  if (!a) return;
  a.dirty = true;
  a.el._html = null;
  dirty.add(a.el);
  window.clearTimeout(a.timer);
  if (now) flush(a);
  else {
    a.timer = window.setTimeout(() => {
      if (composing || active !== a) return;
      flush(a);
      rehyphenate(a.el);
    }, 250);
  }
}

/**
 * En una pausa al escribir se vuelven a marcar los puntos de división del bloque: las palabras
 * nuevas también se parten al final de línea, sin esperar a salir del párrafo. El cursor no se
 * mueve: partir o unir nodos de texto conserva su posición.
 */
function rehyphenate(el: BlockEl): void {
  if (!el._hy) return;
  const c = content(el);
  unhyphenate(c);
  hyphenate(c, el._hy);
  dirty.add(el);
  schedulePaginate(false);
}

function deactivate(): void {
  const a = active;
  if (!a) return;
  active = undefined;
  a.el.classList.remove('active');
  const sent = flush(a, true);
  if (a.re < a.rs) a.el.remove();
  else if (!sent && a.el._html === null && a.el._b) setHtml(a.el, a.el._b, true);
  emptyEl.hidden = blocks.length > 0;
  updateToolbar();
}

/** Abandona la edición sin enviar nada (el documento ha cambiado por otro lado). */
function dropActive(): void {
  const a = active;
  if (!a) return;
  active = undefined;
  window.clearTimeout(a.timer);
  a.el.classList.remove('active');
  a.el._html = null;
  if (a.re < a.rs) a.el.remove();
}

/**
 * Sustituye líneas del documento y pide un repintado completo. `expect` son las líneas que se
 * cree estar sustituyendo: si el documento no coincide, el host descarta el cambio.
 */
function sendFull(s: number, expect: string[], lines: string[], packages?: string[], guard: { prev?: string; next?: string } = {}): void {
  post({ type: 'splice', s, d: expect.length, lines, expect, seq: ++seq, full: true, packages, prev: guard.prev, next: guard.next });
  shiftLines(s + expect.length, lines.length - expect.length);
  transitAt = Date.now();
}

/** Sustituye el bloque activo por `tex` conservando la posición del cursor. */
function commitFull(tex: string, focus?: Focus, packages?: string[]): void {
  const a = active;
  if (!a) return;
  const off = caretOffset(content(a.el));
  nextFocus = focus ?? { line: a.rs + a.lead, offset: off };
  dropActive();
  sendFull(a.rs, a.cur, padded(a, tex.split('\n')), packages, a.cur.length ? {} : a);
}

/** Abre un párrafo nuevo, todavía sin escribir, en la línea `line` del documento. */
function openPending(line: number, gap: Gap, after?: Element, before?: Element): void {
  if (active) deactivate();
  const el = createBlock();
  el.classList.add('pending', 'k-rich', 'k-para');
  const c = content(el);
  c.contentEditable = 'true';
  if (after?.isConnected) after.after(el);
  else if (before?.isConnected) before.before(el);
  else {
    const at = els.find((e) => e.isConnected && e._b && e._b.s >= line);
    if (at) at.before(el);
    else root.appendChild(el);
  }
  // solo se añaden las líneas en blanco que falten para separarlo de sus vecinos
  active = {
    el, rs: line, re: line - 1, lead: gap.before ? 0 : 1, trail: gap.after ? 0 : 1,
    before: gap.before, after: gap.after, prev: gap.prev, next: gap.next, cur: [], dirty: false,
  };
  el.classList.add('active');
  emptyEl.hidden = true;
  c.focus();
  setCaretOffset(c, 0);
  updateToolbar();
}

/** Punto donde termina el documento: lo nuevo va justo antes de `\end{document}`. */
const tailPoint = (): { line: number; gap: Gap } => ({ line: insertLine, gap: { before: tailGap, after: false } });

/** Dónde insertar un bloque nuevo: tras el bloque activo o seleccionado, o al final. */
function insertionPoint(): { line: number; gap: Gap; after?: BlockEl } {
  if (active) {
    const a = active;
    const el = a.el;
    flush(a);
    if (a.re < a.rs) dropActive();
    else deactivate();
    return { ...afterOf(activeExtent(a)), after: el.isConnected ? el : undefined };
  }
  const x = lastEl?.isConnected && lastEl._b?.kind !== 'ro' ? extent(lastEl) : undefined;
  return x ? { ...afterOf(x), after: lastEl } : tailPoint();
}

function insertBlock(tex: string, packages?: string[]): void {
  const { line, gap } = insertionPoint();
  const lead = gap.before ? [] : [''];
  nextFocus = { line: line + lead.length, atStart: true };
  sendFull(line, [], [...lead, ...tex.split('\n'), ...(gap.after ? [] : [''])], packages, gap);
}

function insertInline(tex: string, html?: string, packages?: string[], cls = ''): void {
  if (!active) {
    const p = insertionPoint();
    openPending(p.line, p.gap, p.after);
  }
  const a = active as Active;
  const c = content(a.el);
  const sel = selection();
  let range: Range;
  if (sel.rangeCount && c.contains(sel.anchorNode)) range = sel.getRangeAt(0);
  else {
    range = document.createRange();
    range.selectNodeContents(c);
    range.collapse(false);
  }
  range.deleteContents();
  const span = document.createElement('span');
  span.className = 'atom' + (cls ? ' ' + cls : '');
  span.setAttribute('data-tex', tex);
  // (marca de recién insertado: al dibujarse de verdad, el cursor debe seguir detrás de él)
  span.setAttribute('data-new', '');
  span.contentEditable = 'false';
  span.innerHTML = html ?? escHtml(tex);
  range.insertNode(span);
  range.setStartAfter(span);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  a.refresh = true;
  a.dirty = true;
  a.el._html = null;
  const off = caretOffset(c);
  flush(a, false, packages);
  if (packages?.length) nextFocus = { line: a.rs + a.lead, offset: off };
}

// ------------------------------------------------------------------ teclado

const BLOCK_TAGS = new Set(['DIV', 'FIGURE', 'FIGCAPTION', 'BLOCKQUOTE', 'LI', 'TD', 'TH', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6']);

function hostOf(node: Node, c: HTMLElement): HTMLElement {
  let n: Node | null = node;
  while (n && n !== c) {
    if (n.nodeType === 1 && BLOCK_TAGS.has((n as Element).tagName)) return n as HTMLElement;
    n = n.parentNode;
  }
  return c;
}

const isPlain = (c: HTMLElement): boolean => !c.querySelector('[data-k], div[data-o], figure, blockquote');

function newParagraphAfter(): void {
  const a = active;
  if (!a) return;
  flush(a);
  const el = a.el;
  const prev = el.previousElementSibling ?? undefined;
  const next = el.nextElementSibling ?? undefined;
  // al cerrarse, un bloque que ha quedado vacío (una lista sin elementos) se elimina
  deactivate();
  const at = afterOf(activeExtent(a));
  openPending(at.line, at.gap, el.isConnected ? el : prev, next);
}

function handleEnter(): void {
  const a = active;
  if (!a) return;
  const c = content(a.el);
  const sel = selection();
  if (!sel.rangeCount) return;
  if (!serializeBlock(c)) return;
  const range = sel.getRangeAt(0);
  range.deleteContents();
  const host = hostOf(range.startContainer, c);
  const tag = host.tagName;

  if (tag === 'LI') {
    if (ownEmpty(host)) {
      // elemento vacío dentro de una sublista: sube un nivel (con lo que cuelgue de él), como en un procesador de textos
      if (host.parentElement?.parentElement?.closest('li')) {
        indentLi(host, true);
        return;
      }
      // en el primer nivel, lo que colgaba de él pasa al elemento anterior (o sube, si no lo hay)
      const sub = Array.from(host.children).filter(isSublist) as HTMLElement[];
      let prev = host.previousElementSibling as HTMLElement | null;
      while (prev?.classList.contains('pg-split')) prev = prev.previousElementSibling as HTMLElement | null;
      if (sub.length && prev?.tagName === 'LI') {
        prev.append(...sub);
        tidyLi(prev);
      } else for (const l of sub) host.before(...Array.from(l.children));
      // elemento vacío: salir de la lista
      const listEl = host.parentElement as HTMLElement;
      host.remove();
      if (!listEl.querySelector('li')) listEl.remove();
      a.dirty = true;
      a.el._html = null;
      newParagraphAfter();
      return;
    }
    const rest = document.createRange();
    rest.selectNodeContents(host);
    rest.setStart(range.startContainer, range.startOffset);
    const li = host.cloneNode(false) as HTMLElement;
    li.removeAttribute('id');
    li.removeAttribute('class');
    li.removeAttribute('data-raw');
    if (li.hasAttribute('data-o') && !host.closest('.bib')) li.setAttribute('data-o', '\\item ');
    li.appendChild(rest.extractContents());
    // lo que pasa al nuevo elemento puede ser solo la sublista del anterior (o nada, o el corte fue al
    // principio y el de arriba se ha quedado sin texto): cada uno con su línea propia
    tidyLi(li);
    tidyLi(host);
    host.after(li);
    const r = document.createRange();
    r.setStart(li, 0);
    r.collapse(true);
    sel.removeAllRanges();
    sel.addRange(r);
    markDirty(true);
    return;
  }
  if (tag === 'TD' || tag === 'TH') {
    moveCell(1);
    return;
  }
  if (host !== c && (/^H\d$/.test(tag) || tag === 'FIGCAPTION')) {
    newParagraphAfter();
    return;
  }
  if (host !== c) {
    // dentro de un entorno (cita, teorema...): salto de párrafo interno
    const pb = document.createElement('span');
    pb.className = 'atom pb';
    pb.setAttribute('data-tex', '\n\n');
    pb.contentEditable = 'false';
    pb.innerHTML = '<span class="parbreak"></span>';
    range.insertNode(pb);
    range.setStartAfter(pb);
    range.collapse(true);
    sel.removeAllRanges();
    sel.addRange(range);
    markDirty(true);
    return;
  }

  // párrafo normal: se parte en dos
  const marker = document.createElement('span');
  marker.setAttribute('data-tex', '\u0002');
  range.insertNode(marker);
  const [l, r] = serializeChildren(c).split('\u0002').map(tidy);
  marker.remove();
  if (!r) {
    newParagraphAfter();
    return;
  }
  if (!l) {
    flush(a);
    const el = a.el;
    const at = beforeOf(activeExtent(a));
    deactivate();
    openPending(at.line, at.gap, undefined, el);
    return;
  }
  const left = l.split('\n');
  commitFull(`${l}\n\n${r}`, { line: a.rs + a.lead + left.length + 1, atStart: true });
}

function neighbour(el: BlockEl, dir: -1 | 1): BlockEl | undefined {
  let i = els.indexOf(el);
  if (i < 0) {
    // párrafo pendiente: buscar por posición en el DOM
    const sib = dir < 0 ? el.previousElementSibling : el.nextElementSibling;
    i = els.indexOf(sib as BlockEl) - dir;
  }
  for (i += dir; i >= 0 && i < els.length; i += dir) if (els[i]._b?.kind === 'rich') return els[i];
  return undefined;
}

function handleBackspaceAtStart(e: KeyboardEvent): void {
  const a = active;
  if (!a) return;
  const c = content(a.el);
  const prev = neighbour(a.el, -1);
  if (!serializeBlock(c)) {
    // bloque vacío: se elimina y el cursor pasa al anterior
    e.preventDefault();
    if (a.re < a.rs) {
      dropActive();
      if (prev) {
        activateEl(prev);
        caretToEnd(content(prev));
      }
      return;
    }
    nextFocus = prev?._b ? { line: prev._b.s } : undefined;
    dropActive();
    const gone = removal({ s: a.rs, lines: a.cur, before: a.before, after: a.after });
    sendFull(a.rs, gone.expect, gone.lines);
    return;
  }
  if (!prev?._b || a.re < a.rs || !isPlain(c) || !isPlain(content(prev)) || prev._html === null) return;
  // unir con el párrafo anterior
  e.preventDefault();
  const pb = prev._b;
  const tex = pb.src + '\n' + serializeBlock(c);
  nextFocus = { line: pb.s, offset: units(content(prev)) + 1 };
  // entre ambos solo puede haber líneas en blanco; si hay algo más, el host rechaza la unión
  const gap = Array.from({ length: Math.max(a.rs - pb.e - 1, 0) }, () => '');
  const expect = [...pb.src.split('\n'), ...gap, ...a.cur];
  dropActive();
  // la línea en blanco propia del final se conserva: separa el párrafo unido de lo que sigue
  sendFull(pb.s, expect, [...tex.split('\n'), ...(a.trail ? [''] : [])]);
}

function caretLine(c: HTMLElement): { first: boolean; last: boolean } {
  const off = caretOffset(c) ?? 0;
  const total = units(c);
  const sel = selection();
  const rect = sel.rangeCount ? sel.getRangeAt(0).getClientRects()[0] : undefined;
  if (!rect || !rect.height) return { first: off === 0, last: off >= total };
  const box = c.getBoundingClientRect();
  return { first: rect.top - box.top < rect.height * 0.9, last: box.bottom - rect.bottom < rect.height * 0.9 };
}

function handleArrow(e: KeyboardEvent): void {
  const a = active;
  if (!a || e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || !selection().isCollapsed) return;
  const c = content(a.el);
  const off = caretOffset(c) ?? 0;
  const at = caretLine(c);
  const up = (e.key === 'ArrowUp' && at.first) || (e.key === 'ArrowLeft' && off === 0);
  const down = (e.key === 'ArrowDown' && at.last) || (e.key === 'ArrowRight' && off >= units(c));
  if (!up && !down) return;
  const target = neighbour(a.el, up ? -1 : 1);
  if (!target) return;
  e.preventDefault();
  activateEl(target);
  if (up) caretToEnd(content(target));
  else setCaretOffset(content(target), 0);
  target.scrollIntoView({ block: 'nearest' });
}

function currentLi(): HTMLElement | null {
  const n = selection().anchorNode;
  const el = n && (n.nodeType === 1 ? (n as Element) : n.parentElement);
  return el?.closest('li') ?? null;
}

function currentCell(): HTMLTableCellElement | null {
  const n = selection().anchorNode;
  const el = n && (n.nodeType === 1 ? (n as Element) : n.parentElement);
  const td = el?.closest('td, th') ?? null;
  return td && active?.el.contains(td) ? (td as HTMLTableCellElement) : null;
}

/** Sublista dentro de un elemento de lista. */
const isSublist = (n: Node): boolean => n instanceof HTMLElement && (n.tagName === 'UL' || n.tagName === 'OL' || n.getAttribute('data-k') === 'list');

/** El elemento de lista no tiene texto propio (sin contar sus sublistas). */
function ownEmpty(li: HTMLElement): boolean {
  for (const n of Array.from(li.childNodes)) {
    if (isSublist(n)) continue;
    if (n.nodeType === Node.TEXT_NODE ? n.textContent?.trim() : n instanceof HTMLElement && (n.textContent?.trim() || n.matches('.atom:not(.hid)') || n.querySelector('.atom:not(.hid), img'))) return false;
  }
  return true;
}

/**
 * Deja un elemento de lista con una sola línea vacía (un <br>) si no tiene texto propio, delante de
 * su sublista si la tiene, y sin los <br> que el navegador deja sobrando delante de ella al escribir:
 * sin esa línea el cursor no tendría dónde ponerse y acabaría dentro de la sublista.
 */
function tidyLi(li: HTMLElement): void {
  // (de atrás adelante: al quitar uno, el de delante queda también justo antes de la sublista)
  for (const br of Array.from(li.children).filter((c) => c.tagName === 'BR').reverse()) {
    let next = br.nextSibling;
    while (next && next.nodeType === Node.TEXT_NODE && !next.textContent?.trim()) next = next.nextSibling;
    if (!next || isSublist(next)) br.remove();
  }
  if (!ownEmpty(li)) return;
  // (delante también del salto y la sangría que separan la sublista en el código: así se conservan)
  let at: ChildNode | null = Array.from(li.childNodes).find(isSublist) ?? null;
  while (at?.previousSibling?.nodeType === Node.TEXT_NODE && !at.previousSibling.textContent?.trim()) at = at.previousSibling;
  li.insertBefore(document.createElement('br'), at);
}

function indentLi(li: HTMLElement, out: boolean): void {
  const off = caretOffset(li);
  const parentList = li.parentElement as HTMLElement;
  if (out) {
    const parentLi = parentList.parentElement?.closest('li');
    if (!parentLi) return;
    parentLi.after(li);
    li.setAttribute('data-lead', parentLi.getAttribute('data-lead') ?? '\n  ');
    if (!parentList.querySelector('li')) parentList.remove();
  } else {
    let prev = li.previousElementSibling as HTMLElement | null;
    // el separador de un salto de hoja no cuenta como elemento anterior
    while (prev?.classList.contains('pg-split')) prev = prev.previousElementSibling as HTMLElement | null;
    if (!prev || prev.tagName !== 'LI') return;
    let sub = prev.lastElementChild as HTMLElement | null;
    if (!sub || sub.getAttribute('data-k') !== 'list') {
      // sublista nueva, sangrada un nivel más que el elemento del que cuelga
      const env = /\\begin\{([^}]*)\}/.exec(parentList.getAttribute('data-o') ?? '')?.[1] ?? 'itemize';
      const indent = (li.getAttribute('data-lead') ?? '\n  ').replace(/^[\s\S]*\n/, '') + '  ';
      sub = parentList.cloneNode(false) as HTMLElement;
      sub.setAttribute('data-o', `${indent}\\begin{${env}}`);
      sub.setAttribute('data-c', `\n${indent}\\end{${env}}`);
      prev.appendChild(sub);
    }
    const first = sub.querySelector(':scope > li');
    const inner = first?.getAttribute('data-lead') ?? '\n' + (/^[ \t]*/.exec(sub.getAttribute('data-o') ?? '')?.[0] ?? '') + '  ';
    sub.appendChild(li);
    li.setAttribute('data-lead', inner);
  }
  if (off !== undefined) setCaretOffset(li, off);
  markDirty(true);
}

function moveCell(dir: -1 | 1): void {
  const td = currentCell();
  if (!td) return;
  const cells = Array.from(td.closest('table')!.querySelectorAll('td, th'));
  const target = cells[cells.indexOf(td) + dir] as HTMLElement | undefined;
  if (!target) return;
  const r = document.createRange();
  r.selectNodeContents(target);
  const sel = selection();
  sel.removeAllRanges();
  sel.addRange(r);
}

/**
 * Garantiza que el bloque donde ocurre el evento es el bloque activo. Sin esto, tras una
 * resincronización el elemento podría seguir enfocado y recibir texto que nunca se guardaría.
 */
function ensureActive(target: EventTarget | null): void {
  const el = (target as HTMLElement | null)?.closest?.('.block') as BlockEl | null;
  if (el && active?.el !== el && el._b?.kind === 'rich' && els.includes(el)) activate(el);
}

// el menú de comandos «/» tiene prioridad sobre el resto de teclas mientras está abierto
root.addEventListener('keydown', (e) => {
  if (slashKey(e)) {
    e.preventDefault();
    e.stopPropagation();
  }
}, true);

root.addEventListener('keydown', (e) => {
  ensureActive(e.target);
  if (!active || composing || e.ctrlKey || e.metaKey) return;
  switch (e.key) {
    case 'Enter':
      if (e.shiftKey) return;
      e.preventDefault();
      handleEnter();
      break;
    case 'Backspace':
      if (selection().isCollapsed && (caretOffset(content(active.el)) ?? 1) === 0) handleBackspaceAtStart(e);
      break;
    case 'Tab': {
      e.preventDefault();
      const li = currentLi();
      if (li && active.el.contains(li)) indentLi(li, e.shiftKey);
      else if (currentCell()) moveCell(e.shiftKey ? -1 : 1);
      break;
    }
    case 'Escape':
      content(active.el).blur();
      deactivate();
      break;
    case 'ArrowUp': case 'ArrowDown': case 'ArrowLeft': case 'ArrowRight':
      handleArrow(e);
      break;
  }
});

root.addEventListener('beforeinput', (e) => {
  ensureActive(e.target);
  if (!active || !active.el.contains(e.target as Node)) {
    // texto dirigido a algo que no es el bloque en edición: no se admite
    e.preventDefault();
    return;
  }
  if (e.inputType === 'insertText' && e.data === '$') {
    e.preventDefault();
    run('ins-math');
    return;
  }
  trackInput(e);
});
root.addEventListener('input', (e) => {
  ensureActive(e.target);
  if (!active?.el.contains(e.target as Node)) return;
  dropHyphensAt(selection().anchorNode);
  // en la vista de varias páginas, la continuación de un párrafo es una copia: hay que rehacerla
  if (document.body.classList.contains('grid')) schedulePaginate(false);
  markDirty();
  spell.schedule(true);
  const ev = e as InputEvent;
  if (ev.inputType === 'insertText' && ev.data === ' ' && markdownShortcut()) return;
  if (ev.inputType === 'insertText' && ev.data === '/') openSlash();
  else if (slash) renderSlash();
});
root.addEventListener('compositionstart', () => (composing = true));
root.addEventListener('compositionend', () => {
  composing = false;
  markDirty();
});
/** ¿El texto pegado es código LaTeX (comandos, entornos, fórmulas) y no texto corriente? */
function looksLikeLatex(text: string): boolean {
  return /\\[a-zA-Z]+\s*[[{]|\\(begin|end|item|label|ref|cite|frac|sum|int|alpha|beta|[[\]()])|(^|[^\\$])\$[^$\n]+\$|\\\\/.test(text);
}

function pasteText(raw: string): void {
  const text = raw.replace(/\r/g, '');
  if (!text) return;
  if (looksLikeLatex(text)) {
    // LaTeX: se inserta tal cual y se vuelve a dibujar el bloque con el resultado
    insertInline(text.trim(), escHtml(text.trim()));
    return;
  }
  const plain = text.replace(/\n{2,}/g, '\u0000').replace(/\n/g, ' ').replace(/\u0000/g, '\n\n');
  // Texto corriente que LaTeX tomaría por código: una ruta de Windows (C:\Users\...) o una llave sin
  // pareja. Se escapa entero, para que se vea como se pegó y no descoloque lo que viene detrás.
  if (/(?:^|[\s"'(=])[A-Za-z]:\\[^\s\\]/.test(plain) || !bracesBalanced(plain)) {
    insertInline(escapeLiteral(plain), escHtml(plain));
    return;
  }
  if (!document.execCommand('insertText', false, plain)) {
    const r = selection().getRangeAt(0);
    r.deleteContents();
    r.insertNode(document.createTextNode(plain));
    r.collapse(false);
  }
  markDirty();
}

/** LaTeX obtenido de contenido con formato: en línea va al cursor; con párrafos, listas o tablas, como bloques. */
function pasteLatex(tex: string): void {
  if (!/\n\s*\n|\\begin\{|\\(sub)*section\{/.test(tex)) {
    insertInline(tex, escHtml(tex));
    return;
  }
  if (active && !serializeBlock(content(active.el))) commitFull(tex);
  else insertBlock(tex);
}

function pasteHtml(html: string, text: string): void {
  const grid = html ? undefined : gridOf(text);
  if (grid) {
    // texto separado por tabuladores, sin formato: es una tabla
    pasteGrid(grid);
    return;
  }
  if (html && !looksLikeLatex(text)) {
    const tex = htmlToLatex(new DOMParser().parseFromString(html, 'text/html').body);
    if (tex) {
      pasteLatex(tex);
      return;
    }
  }
  pasteText(text);
}

root.addEventListener('paste', (e) => {
  ensureActive(e.target);
  const cd = e.clipboardData;
  if (!cd) return;
  const text = cd.getData('text/plain');
  if (!active) return;
  e.preventDefault();
  // celdas copiadas de una hoja de cálculo: dentro de una tabla rellenan sus celdas
  const grid = gridOf(text);
  if (grid && currentCell()) {
    pasteGrid(grid);
    return;
  }
  pasteHtml(cd.getData('text/html'), text);
});
/** Guarda junto al documento una imagen (del portapapeles o soltada encima) y la ofrece para insertar. */
function storeImage(image: Blob): void {
  if (active) flush(active);
  const reader = new FileReader();
  reader.onload = (): void => {
    const data = String(reader.result).split(',')[1] ?? '';
    post({ type: 'pasteImage', data, ext: image.type.split('/')[1]?.replace('jpeg', 'jpg').replace('svg+xml', 'svg') ?? 'png' });
  };
  reader.readAsDataURL(image);
}

/** Imagen que trae un portapapeles o un arrastre, si lo que trae es eso y no texto. */
function imageIn(data: DataTransfer | null): File | undefined {
  const image = Array.from(data?.files ?? []).find((f) => f.type.startsWith('image/'));
  return image && !data?.getData('text/plain').trim() ? image : undefined;
}

// Ctrl+V con una imagen en el portapapeles (una captura de pantalla, una imagen copiada de la web o
// un archivo copiado en el explorador): se inserta tras el bloque en curso, haya o no cursor
document.addEventListener(
  'paste',
  (e) => {
    const t = e.target as HTMLElement | null;
    if (isDialogOpen() || t?.closest?.('#findbar, .overlay, input, textarea')) return;
    const image = imageIn(e.clipboardData);
    if (!image) return;
    e.preventDefault();
    e.stopPropagation();
    storeImage(image);
  },
  true,
);
// soltar una imagen sobre el documento la inserta (en VS Code, manteniendo Mayús al soltar)
document.addEventListener('dragover', (e) => {
  if (Array.from(e.dataTransfer?.types ?? []).some((t) => t === 'Files' || t === 'text/uri-list')) e.preventDefault();
});
document.addEventListener('drop', (e) => {
  const dt = e.dataTransfer;
  if (!dt || isDialogOpen()) return;
  e.preventDefault();
  const el = (e.target as HTMLElement | null)?.closest?.('#root > .block') as BlockEl | null;
  if (el) select(el);
  const image = Array.from(dt.files).find((f) => f.type.startsWith('image/') || /\.(png|jpe?g|gif|svg|webp|pdf)$/i.test(f.name));
  // un archivo arrastrado desde el explorador de VS Code llega como dirección, no como contenido
  const uri = dt.getData('text/uri-list').split(/\r?\n/).find((u) => /^file:.*\.(png|jpe?g|gif|svg|webp|pdf|eps)$/i.test(u.trim()));
  if (uri) {
    if (active) flush(active);
    post({ type: 'dropImage', file: decodeURIComponent(uri.trim().replace(/^file:\/\/\/?/, '')).replace(/^(?![A-Za-z]:)/, '/') });
  } else if (image) storeImage(image);
});

root.addEventListener('focusin', (e) => {
  const c = (e.target as HTMLElement).closest?.('.content');
  const el = c?.parentElement as BlockEl | undefined;
  if (el && c?.getAttribute('contenteditable') === 'true') activate(el);
});
// copiar formato: lo recogido se aplica a lo que se seleccione a continuación
root.addEventListener('mouseup', (e) => {
  if (e.button === 0 && brush) window.setTimeout(applyBrush, 0);
});
// un clic en una imagen la deja elegida: aparece su pestaña en la cinta
root.addEventListener('click', (e) => {
  const img = (e.target as HTMLElement).closest('.atom.img, figure img, figure canvas');
  const el = img?.closest('.block') as BlockEl | null | undefined;
  pickedImage = el && /\\includegraphics\b/.test(el._b?.src ?? '') ? el : undefined;
  pickedIndex = img && pickedImage ? imageIndexOf(img) : 0;
  if (pickedImage) select(pickedImage);
  updateToolbar();
  if (pickedImage && currentTab !== 'image') showTab('image');
});
// un bloque puede conservar el foco sin estar en edición (tras un repintado completo): al volver a
// hacer clic en él no llega `focusin`, así que se activa aquí
root.addEventListener('mouseup', (e) => {
  if (e.button !== 0 || active || xsel) return;
  const c = (document.activeElement as HTMLElement | null)?.closest?.('.content');
  const el = c?.parentElement as BlockEl | undefined;
  if (el && c?.getAttribute('contenteditable') === 'true' && els.includes(el)) activate(el);
});
root.addEventListener('focusout', () => {
  if (modal) return;
  window.setTimeout(() => {
    if (modal || !active) return;
    if (!document.hasFocus()) {
      // la ventana perdió el foco (Alt+Tab, clic en el editor de código): se guarda sin cerrar la edición
      flush(active);
      return;
    }
    if (!active.el.contains(document.activeElement)) deactivate();
  }, 0);
});
document.addEventListener('selectionchange', () => {
  updateToolbar();
  scheduleBubble();
  spell.caretMoved();
  if (slash && slashQuery() === undefined) closeSlash();
});

// ------------------------------------------------------------------ ratón

/** Líneas que ocupa un bloque, con lo último que se haya escrito en él ya enviado al documento. */
function blockRange(el: BlockEl): (Extent & { src: string }) | undefined {
  if (active?.el === el) flush(active);
  const x = extent(el);
  return x ? { ...x, src: x.lines.join('\n') } : undefined;
}

function openSource(el: BlockEl): void {
  const r = blockRange(el);
  if (!r) return;
  beginModal();
  const isMath = content(el).firstElementChild?.classList.contains('math') ?? false;
  const apply = (src: string): void => {
    dropActive();
    nextFocus = { line: r.s };
    if (src.trim()) sendFull(r.s, r.lines, src.split('\n'));
    else {
      const gone = removal(r);
      sendFull(r.s, gone.expect, gone.lines);
    }
  };
  if (isMath && /^\s*(\\\[|\$\$|\\begin\{(equation|align|gather|multline)\*?\})/.test(r.src)) {
    const m = /^\s*(\\\[|\$\$|\\begin\{[a-z]+\*?\})([\s\S]*?)(\\\]|\$\$|\\end\{[a-z]+\*?\})\s*$/.exec(r.src);
    if (m) {
      openFormula({
        title: 'Editar ecuación', tex: tidy(m[2]), display: true, macros, closed: endModal,
        ok: (tex) => apply(`${m[1]}\n  ${tex.replace(/\n/g, '\n  ')}\n${m[3]}`),
      });
      return;
    }
  }
  openForm('Código LaTeX del bloque', [{ id: 'src', label: 'LaTeX', type: 'textarea', value: r.src }], (v) => apply(v.src), endModal);
}

function openMeta(): void {
  beginModal();
  openForm(
    'Título del documento',
    [
      { id: 'title', label: 'Título', value: meta.title ?? '' },
      { id: 'author', label: 'Autor', value: meta.author ?? '' },
      { id: 'date', label: 'Fecha', value: meta.date ?? '\\today', placeholder: '\\today' },
    ],
    (v) => {
      dropActive();
      post({ type: 'setMeta', title: v.title, author: v.author, date: v.date });
    },
    endModal,
  );
}

function editAtom(at: HTMLElement, el: BlockEl): void {
  const tex = at.getAttribute('data-tex') ?? '';
  activateEl(el);
  beginModal();
  const done = (newTex: string, html?: string): void => {
    if (!active) return;
    if (!newTex) at.remove();
    else {
      at.setAttribute('data-tex', newTex);
      if (html !== undefined) at.innerHTML = html;
    }
    active.refresh = true;
    markDirty(true);
  };
  const inline = /^(\$(?!\$)([\s\S]*)\$|\\\(([\s\S]*)\\\))$/.exec(tex);
  if (inline) {
    openFormula({
      title: 'Editar fórmula', tex: inline[2] ?? inline[3], display: false, macros, closed: endModal,
      ok: (t) => done(`$${t}$`, renderMath(t, false, macros)),
    });
    return;
  }
  const name = /^(\\[a-zA-Z@]+)(?:\{\})?\s*$/.exec(tex)?.[1];
  const body = name ? macros[name] : undefined;
  if (name && body !== undefined && at.classList.contains('var')) {
    // una variable del documento: se ve su nombre y su texto, y el texto se cambia aquí mismo
    const uses = root.querySelectorAll(`.atom.var[data-tex^="${name.replace(/\\/g, '\\\\')}"]`).length;
    openForm(
      `Variable ${name}`,
      [
        { id: 'body', label: `Texto de ${name} (se define en el preámbulo${uses > 1 ? ` y aparece ${uses} veces` : ''})`, type: body.includes('\n') || body.length > 70 ? 'textarea' : 'text', value: body },
        { id: 'tex', label: 'Lo que hay escrito aquí en el documento', value: tex.trim() },
        { id: 'only', label: 'Solo aquí: dejar de usar la variable y escribir este texto en su lugar', type: 'checkbox', value: false },
      ],
      (v) => {
        const ending = /\s*$/.exec(tex)?.[0] ?? '';
        if (v.only === '1') done(v.body);
        else {
          if (v.tex.trim() !== tex.trim()) done(v.tex.trim() ? v.tex.trim() + ending : '');
          if (v.body !== body) {
            if (active) flush(active);
            post({ type: 'setMacro', name, body: v.body, old: body });
          }
        }
      },
      endModal,
    );
    return;
  }
  openForm('Código LaTeX', [{ id: 'tex', label: 'LaTeX', type: tex.includes('\n') ? 'textarea' : 'text', value: tex }], (v) => done(v.tex), endModal);
}

root.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const el = t.closest('.block') as BlockEl | null;
  const btn = t.closest('.tools button') as HTMLElement | null;
  if (btn && el) {
    const act = btn.dataset.act;
    if (act === 'src') openSource(el);
    else if (act === 'up' || act === 'down') moveBlocks(act === 'up' ? -1 : 1, [el]);
    else if (act === 'dup') duplicateBlocks([el]);
    else if (act === 'goto' && el._b) post({ type: 'goto', line: el._b.s });
    else if (act === 'add' && el._b) {
      const r = blockRange(el);
      if (r) {
        const at = afterOf(r);
        openPending(at.line, at.gap, el);
      }
    } else if (act === 'del') {
      const r = blockRange(el);
      if (r) {
        const gone = removal(r);
        dropActive();
        sendFull(r.s, gone.expect, gone.lines);
      }
    }
    return;
  }
  const link = t.closest('a[href]');
  const href = link?.getAttribute('href');
  if (href?.startsWith('#')) {
    e.preventDefault();
    anchorOf(href.slice(1))?.scrollIntoView({ block: 'center' });
    return;
  }
  if (el && el !== active?.el) select(el);
});

// Un clic sobre una fórmula (o cualquier otro elemento que no se edita en sitio) dejaría el cursor
// dentro de ella, donde no se puede escribir: se coloca a su lado, según la mitad en la que se pulsó.
root.addEventListener('mouseup', (e) => {
  if (e.button !== 0) return;
  const sel = selection();
  const node = sel.anchorNode;
  if (!sel.isCollapsed || !node) return;
  const at = (node.nodeType === 1 ? (node as Element) : node.parentElement)?.closest('[data-tex]');
  if (!at || !at.parentElement?.closest('.content[contenteditable="true"]')) return;
  const box = vrect(at);
  const range = document.createRange();
  if (e.clientX < box.left + box.width / 2) range.setStartBefore(at);
  else range.setStartAfter(at);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
});

root.addEventListener('dblclick', (e) => {
  const t = e.target as HTMLElement;
  const el = t.closest('.block') as BlockEl | null;
  if (!el?._b || el._b.kind === 'ro' || t.closest('.tools')) return;
  if (el._b.kind === 'atom') {
    e.preventDefault();
    if (t.closest('[data-role="title"]')) openMeta();
    else openSource(el);
    return;
  }
  const at = t.closest('.atom') as HTMLElement | null;
  if (at && !at.classList.contains('pb')) {
    e.preventDefault();
    if (at.classList.contains('titleblock')) openMeta();
    else editAtom(at, el);
  }
});

tail.addEventListener('click', () => {
  const last = els[els.length - 1];
  if (last?._b?.kind === 'rich' && !serializeBlock(content(last))) activateEl(last);
  else {
    // lo que se esté escribiendo se envía antes: mueve la línea donde termina el documento
    if (active) deactivate();
    const at = tailPoint();
    openPending(at.line, at.gap);
  }
});

// ------------------------------------------------------------------ diálogos e inserciones

function beginModal(): void {
  closeDialog();
  modal = true;
  const sel = selection();
  saved = active && sel.rangeCount && active.el.contains(sel.anchorNode) ? sel.getRangeAt(0).cloneRange() : undefined;
}

function endModal(): void {
  modal = false;
  if (active?.el.isConnected) {
    content(active.el).focus({ preventScroll: true });
    if (saved) {
      const sel = selection();
      sel.removeAllRanges();
      sel.addRange(saved);
    }
  }
  saved = undefined;
}

/** Un párrafo en una sola línea. Los comentarios se quitan: lo que quedara detrás de uno se perdería. */
const oneLineTex = (s: string): string =>
  s
    .split('\n')
    .map((l) => l.replace(/(^|[^\\])%.*$/, '$1'))
    .join('\n')
    .replace(/\s*\n\s*/g, ' ')
    .trim();

/** Un párrafo como elemento de lista: en una línea o, si lleva comentarios que conservar, con sus líneas. */
const itemTex = (s: string): string => (/(^|[^\\])%/.test(s) ? s.split('\n').map((l) => l.trim()).join('\n    ') : s.replace(/\s*\n\s*/g, ' '));

function setStyle(level: string): void {
  const a = active;
  if (!a) return;
  const c = content(a.el);
  const head = c.querySelector(':scope > [data-k="head"]');
  let tex: string;
  if (head) {
    head.setAttribute('data-o', level ? `\\${level}{` : '');
    head.setAttribute('data-c', level ? '}' : '');
    tex = serializeBlock(c);
  } else {
    if (!level || !isPlain(c)) return;
    tex = `\\${level}{${oneLineTex(serializeBlock(c))}}`;
  }
  commitFull(tex);
}

/**
 * Sustituye los párrafos de una selección de varios bloques por lo que devuelva `build` (una lista,
 * un entorno que los envuelva...). Solo actúa si todo lo seleccionado son párrafos de texto.
 */
function paragraphsXsel(build: (paragraphs: string[]) => string[], packages?: string[]): void {
  const x = xselRange();
  if (!x || !x.list.every((el) => isRich(el) && isPlain(content(el)))) return;
  const exts = x.list.map((el) => extent(el));
  if (exts.some((e) => e === undefined)) return;
  const all = exts as Extent[];
  const batch: Splice[] = all.map((ext, i) => {
    if (i === 0) return { s: ext.s, d: ext.lines.length, expect: ext.lines, lines: build(all.map((e) => e.lines.join('\n'))) };
    const gone = removal(ext);
    return { s: ext.s, d: gone.expect.length, expect: gone.expect, lines: gone.lines };
  });
  clearXsel();
  nextFocus = { line: all[0].s };
  post({ type: 'splices', list: batch, seq: ++seq, packages });
  transitAt = Date.now();
}

function toggleList(env: string): void {
  if (xsel) {
    // varios párrafos seleccionados: cada uno pasa a ser un elemento de la lista
    paragraphsXsel((p) => [`\\begin{${env}}`, ...p.flatMap((s) => `  \\item ${itemTex(s)}`.split('\n')), `\\end{${env}}`]);
    return;
  }
  const a = active;
  if (!a) {
    insertBlock(`\\begin{${env}}\n  \\item \n\\end{${env}}`);
    return;
  }
  const c = content(a.el);
  const li = currentLi();
  const listEl = li && a.el.contains(li) ? (li.parentElement as HTMLElement) : null;
  if (listEl) {
    const cur = listEl.tagName === 'OL' ? 'enumerate' : 'itemize';
    if (cur === env) {
      // quitar la lista: cada elemento pasa a ser un párrafo
      const paras = Array.from(listEl.children).map((x) => tidy(serializeChildren(x))).filter(Boolean);
      listEl.setAttribute('data-tex', paras.join('\n\n'));
    } else {
      listEl.setAttribute('data-o', `\\begin{${env}}`);
      listEl.setAttribute('data-c', `\\end{${env}}`);
    }
    commitFull(serializeBlock(c));
    return;
  }
  if (!isPlain(c)) return;
  commitFull(`\\begin{${env}}\n  \\item ${itemTex(serializeBlock(c))}\n\\end{${env}}`);
}

/**
 * Deja fuera de la selección los espacios de sus extremos: un doble clic se lleva también el
 * espacio que sigue a la palabra, y el formato no debe incluirlo (`\textbf{palabra} otra`).
 */
function trimSelection(): void {
  const sel = selection();
  if (!sel.rangeCount || sel.isCollapsed) return;
  const r = sel.getRangeAt(0);
  const text = r.toString();
  if (!text.trim()) return;
  const lead = text.length - text.trimStart().length;
  const trail = text.length - text.trimEnd().length;
  if (!lead && !trail) return;
  if (trail && r.endContainer.nodeType === 3 && r.endOffset >= trail) r.setEnd(r.endContainer, r.endOffset - trail);
  if (lead && r.startContainer.nodeType === 3 && (r.startContainer as Text).length - r.startOffset >= lead) r.setStart(r.startContainer, r.startOffset + lead);
  sel.removeAllRanges();
  sel.addRange(r);
}

/**
 * Ciñe el rango a lo que contiene: si empieza justo delante de un elemento y termina dentro de él
 * (o al revés), sus extremos entran en el elemento. Así el formato nuevo se aplica al texto, por
 * dentro del que ya tenía, y no deja fuera un envoltorio vacío.
 */
function tightenRange(r: Range): void {
  const hidden = (n: Node | undefined): boolean => n?.nodeType === 1 && (n as Element).classList.contains('hid');
  const group = (n: Node | undefined): n is Element => n?.nodeType === 1 && !(n as Element).hasAttribute('data-tex') && !(n as Element).hasAttribute('data-skip');
  for (let guard = 0; guard < 40 && !r.collapsed; guard++) {
    const n = r.startContainer;
    if (n.nodeType === 3) {
      if (r.startOffset < (n as Text).length || !n.parentNode) break;
      r.setStartAfter(n);
      continue;
    }
    const child = n.childNodes[r.startOffset] as Node | undefined;
    if (hidden(child)) r.setStart(n, r.startOffset + 1);
    else if (child?.nodeType === 3 && child.contains(r.endContainer)) r.setStart(child, 0);
    else if (group(child) && child.contains(r.endContainer)) r.setStart(child, 0);
    else break;
  }
  for (let guard = 0; guard < 40 && !r.collapsed; guard++) {
    const n = r.endContainer;
    if (n.nodeType === 3) {
      if (r.endOffset > 0 || !n.parentNode) break;
      r.setEndBefore(n);
      continue;
    }
    const child = n.childNodes[r.endOffset - 1] as Node | undefined;
    if (child?.nodeType === 3 && child.contains(r.startContainer)) r.setEnd(child, (child as Text).length);
    else if (group(child) && child.contains(r.startContainer)) r.setEnd(child, child.childNodes.length);
    else break;
  }
}

/** Quita los envoltorios que han quedado vacíos junto a `w` al sacar de ellos el texto seleccionado. */
function dropEmptyShells(w: Element): void {
  for (const sib of [w.previousSibling, w.nextSibling]) {
    if (sib?.nodeType === 1 && (sib as Element).hasAttribute('data-o') && units(sib) === 0) sib.remove();
  }
}

/**
 * Envuelve la selección en un comando LaTeX (`o` + texto + `}`); si ya estaba envuelta con ese
 * mismo comando, lo quita.
 */
function wrapSelection(tag: string, o: string, attrs: Record<string, string> = {}, packages?: string[]): void {
  if (xsel) {
    // selección de varios bloques: el formato se aplica a todo su texto
    wrapXsel(
      () => {
        const w = document.createElement(tag);
        w.setAttribute('data-o', o);
        w.setAttribute('data-c', '}');
        for (const [k, v] of Object.entries(attrs)) w.setAttribute(k, v);
        return w;
      },
      `[data-o="${o.replace(/["\\]/g, '\\$&')}"]`,
      packages,
    );
    return;
  }
  const a = active;
  const sel = selection();
  if (!a || !sel.rangeCount || sel.isCollapsed || !a.el.contains(sel.anchorNode)) return;
  trimSelection();
  const range = sel.getRangeAt(0);
  tightenRange(range);
  const n = range.commonAncestorContainer;
  let inside = n.nodeType === 1 ? (n as Element) : n.parentElement;
  while (inside && inside !== a.el && inside.getAttribute('data-o') !== o) inside = inside.parentElement;
  if (inside && inside !== a.el) inside.replaceWith(...Array.from(inside.childNodes));
  else {
    const w = document.createElement(tag);
    w.setAttribute('data-o', o);
    w.setAttribute('data-c', '}');
    for (const [k, v] of Object.entries(attrs)) w.setAttribute(k, v);
    w.appendChild(range.extractContents());
    range.insertNode(w);
    dropEmptyShells(w);
    sel.selectAllChildren(w);
  }
  a.dirty = true;
  a.el._html = null;
  flush(a, false, packages);
}

/**
 * ¿Hay texto seleccionado al que dar formato? Seleccionar el documento entero no cuenta: ahí el
 * cambio de fuente o de tamaño va al preámbulo, no párrafo por párrafo.
 */
function hasTextSelection(): boolean {
  const x = xselRange();
  if (x) return !(x.list.length === els.filter(selectable).length && x.list.every((el) => xselWhole(x, el)));
  const sel = selection();
  return active !== undefined && sel.rangeCount > 0 && !sel.isCollapsed && active.el.contains(sel.anchorNode);
}

/** Elemento del bloque en edición cuyo formato se ve en la cinta: donde empieza la selección. */
function styleNode(): Element | null {
  const sel = selection();
  if (!active || !sel.rangeCount || !active.el.contains(sel.anchorNode)) return null;
  const r = sel.getRangeAt(0);
  let n: Node = r.startContainer;
  if (!r.collapsed && n.nodeType === 3 && r.startOffset >= (n as Text).length) {
    // empieza justo al final de un texto: lo seleccionado está en el siguiente
    const w = document.createTreeWalker(active.el, NodeFilter.SHOW_TEXT);
    w.currentNode = n;
    n = w.nextNode() ?? n;
  }
  return n.nodeType === 1 ? (n as Element) : n.parentElement;
}

/**
 * Grupo `{\cmd{...}... texto}` que envuelve a `from`. Recién creado es un único elemento con el
 * comando en `data-o`; tras redibujarse, un grupo `{}` cuyo primer hijo (oculto) lleva el comando.
 */
interface Decl {
  el: Element;
  tex: string;
  set(tex: string, css: string): void;
  /** quita el grupo y deja su contenido; devuelve los nodos que quedan en su lugar */
  unwrap(): Node[];
}

function declAround(from: Element | null, cmd: string): Decl | undefined {
  const stop = active?.el;
  const lift = (host: Element, inner: Element): Node[] => {
    const kids = Array.from(inner.childNodes);
    host.replaceWith(...kids);
    return kids;
  };
  for (let el = from; el && el !== stop; el = el.parentElement) {
    const o = el.getAttribute('data-o') ?? '';
    if (o.startsWith(`{\\${cmd}{`)) {
      const host = el;
      return { el, tex: o.slice(1), set: (tex, css) => (host.setAttribute('data-o', `{${tex}`), host.setAttribute('style', css)), unwrap: () => lift(host, host) };
    }
    const first = el.firstElementChild;
    const styled = first?.nextElementSibling;
    if (o === '{' && first?.classList.contains('hid') && styled && (first.getAttribute('data-tex') ?? '').startsWith(`\\${cmd}{`)) {
      const host = el;
      return {
        el, tex: first.getAttribute('data-tex') ?? '',
        set: (tex, css) => (first.setAttribute('data-tex', tex), styled.setAttribute('style', css)),
        unwrap: () => lift(host, styled),
      };
    }
  }
  return undefined;
}

/**
 * Aplica a la selección una declaración de fuente (`\fontfamily`, `\fontsize`). Si lo seleccionado
 * es justo un texto que ya llevaba una, se le cambia el valor en vez de anidar otra dentro; y si
 * el valor nuevo es el del documento (`plain`), se le quita.
 */
function redeclare(cmd: string, tex: string, css: string, packages?: string[], plain = false): void {
  const a = active;
  const sel = selection();
  if (!xsel && a && sel.rangeCount) {
    trimSelection();
    const r = sel.getRangeAt(0);
    tightenRange(r);
    sel.removeAllRanges();
    sel.addRange(r);
    const d = declAround(styleNode(), cmd);
    if (d && sel.toString().trim() === (d.el.textContent ?? '').trim()) {
      if (plain) {
        const kids = d.unwrap();
        if (kids.length) {
          const range = document.createRange();
          range.setStartBefore(kids[0]);
          range.setEndAfter(kids[kids.length - 1]);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      } else d.set(tex, css);
      a.dirty = true;
      a.el._html = null;
      flush(a, false, plain ? undefined : packages);
      updateFontBoxes();
      return;
    }
  }
  wrapSelection('span', `{${tex}`, { style: css }, packages);
  updateFontBoxes();
}

/** Tamaño de letra, en puntos, donde está el cursor (el del documento si no se está editando). */
function currentSizePt(): number {
  const at = styleNode();
  return at ? parseFloat(getComputedStyle(at).fontSize) / pxPerPt() : pageInfo.fontPt;
}

/** Los cuadros de fuente y tamaño de Inicio muestran lo que hay donde está el cursor. */
function updateFontBoxes(): void {
  const nameEl = toolbar.querySelector('#dd-font .combo-val');
  const sizeEl = toolbar.querySelector('#dd-fsize .combo-val');
  if (!nameEl || !sizeEl) return;
  const at = styleNode();
  const docFont = layout?.font ?? '';
  let key: string | undefined = docFont;
  let name = (FONTS[docFont] ?? FONTS['']).name;
  let generic = '';
  const family = /\\fontfamily\{([^}]*)\}/.exec(declAround(at, 'fontfamily')?.tex ?? '')?.[1];
  if (family) {
    key = Object.keys(FONTS).find((k) => FONTS[k].family === family);
    name = key !== undefined ? FONTS[key].name : family;
  } else if (at?.closest('code')) generic = 'code';
  else if (at?.closest('[data-o="\\\\textsf{"]')) generic = 'sf';
  else if (at?.closest('[data-o="\\\\textrm{"]')) generic = 'rm';
  if (generic) name = generic === 'code' ? 'Monoespaciada' : generic === 'sf' ? 'Sin remates' : 'Con remates';
  nameEl.textContent = name;
  const pt = currentSizePt();
  sizeEl.textContent = ptText(pt);
  toolbar.querySelectorAll<HTMLElement>('#dd-font button[data-cmd="font"]').forEach((b) => b.classList.toggle('checked', !generic && (b.dataset.arg ?? '') === key));
  toolbar.querySelectorAll<HTMLElement>('#dd-font button[data-cmd="wrap"], #dd-font button[data-cmd="code"]').forEach((b) => {
    b.classList.toggle('checked', generic !== '' && (b.dataset.cmd === 'code' ? generic === 'code' : b.dataset.arg === generic));
  });
  toolbar.querySelectorAll<HTMLElement>('#dd-fsize button[data-cmd="fsize"]').forEach((b) => b.classList.toggle('checked', Math.abs(Number(b.dataset.arg) - pt) < 0.05));
  const hint = hasTextSelection() ? 'Se aplica al texto seleccionado' : 'Sin selección: se aplica a todo el documento';
  toolbar.querySelectorAll('#dd-font .menu-hint, #dd-fsize .menu-hint').forEach((h) => (h.textContent = hint));
}

/** Formatos de carácter de la pestaña Inicio: [etiqueta HTML, comando, atributos]. */
const WRAPS: Record<string, [string, string, Record<string, string>]> = {
  strike: ['s', '\\sout{', {}],
  sup: ['sup', '\\textsuperscript{', {}],
  sub: ['sub', '\\textsubscript{', {}],
  sc: ['span', '\\textsc{', { class: 'sc' }],
  emph: ['em', '\\emph{', {}],
  // familia de letra del texto seleccionado
  rm: ['span', '\\textrm{', { class: 'rm' }],
  sf: ['span', '\\textsf{', { class: 'sf' }],
};

/** Alineación del párrafo: lo mete en (o lo saca de) un entorno center/flushleft/flushright. */
function setAlign(env: string): void {
  if (xsel) {
    // varios párrafos seleccionados: van juntos dentro del entorno
    if (env) paragraphsXsel((p) => [`\\begin{${env}}`, ...p.join('\n\n').split('\n'), `\\end{${env}}`]);
    return;
  }
  const a = active;
  if (!a) return;
  const c = content(a.el);
  const wrapper = Array.from(c.children).find((el) => /^\\begin\{(center|flushleft|flushright)\}/.test(el.getAttribute('data-o') ?? ''));
  if (!wrapper && !isPlain(c)) return;
  const inner = tidy(wrapper ? serializeChildren(wrapper) : serializeChildren(c));
  if (!inner) return;
  commitFull(env ? `\\begin{${env}}\n${inner}\n\\end{${env}}` : inner);
}

function format(cmd: 'bold' | 'italic' | 'underline'): void {
  if (xsel) {
    const tag = cmd === 'bold' ? 'b' : cmd === 'italic' ? 'i' : 'u';
    wrapXsel(() => document.createElement(tag), cmd === 'bold' ? 'b, strong' : tag);
    return;
  }
  if (!active) return;
  trimSelection();
  // sin las marcas de división: el formato debe envolver cada palabra entera, no sus sílabas
  const c = content(active.el);
  unhyphenate(c);
  document.execCommand(cmd);
  if (active.el._hy) hyphenate(c, active.el._hy);
  markDirty(true);
}

/** Piezas de la especificación de columnas de una tabla: barras, letras y columnas con argumento. */
const SPEC_TOKEN = /\|+|[lcrXLCRS]|[pmb]\{[^}]*\}|[@!><]\{[^}]*\}|\s+|./g;

/**
 * Estilos de tabla de la galería. `bars`: barras verticales entre columnas; `before(k, n)`: lo que va
 * delante de la fila k de n (reglas, color de fondo); `end`: la regla que cierra la tabla.
 */
const TABLE_STYLES: { id: string; name: string; about: string; bars: boolean; before(k: number, n: number): string[]; end: string; packages: string[] }[] = [
  { id: 'grid', name: 'Cuadrícula', about: 'Todas las líneas', bars: true, before: () => ['\\hline'], end: '\\hline', packages: [] },
  { id: 'plain', name: 'Sin bordes', about: 'Solo el texto', bars: false, before: () => [], end: '', packages: [] },
  { id: 'book', name: 'Profesional', about: 'Tres líneas, como en los libros (booktabs)', bars: false, before: (k) => (k === 0 ? ['\\toprule'] : k === 1 ? ['\\midrule'] : []), end: '\\bottomrule', packages: ['booktabs'] },
  { id: 'lines', name: 'Líneas horizontales', about: 'Una línea entre cada fila', bars: false, before: () => ['\\hline'], end: '\\hline', packages: [] },
  {
    id: 'header', name: 'Encabezado sombreado', about: 'La primera fila con fondo gris', bars: false,
    before: (k) => (k === 0 ? ['\\toprule', '\\rowcolor{gray!25}'] : k === 1 ? ['\\midrule'] : []), end: '\\bottomrule', packages: ['booktabs', 'xcolor', 'colortbl'],
  },
  {
    id: 'striped', name: 'Filas alternas', about: 'Una fila sí y otra no con fondo', bars: false,
    before: (k) => [...(k === 0 ? ['\\toprule'] : k === 1 ? ['\\midrule'] : []), ...(k > 0 && k % 2 === 0 ? ['\\rowcolor{gray!15}'] : [])], end: '\\bottomrule', packages: ['booktabs', 'xcolor', 'colortbl'],
  },
];

/** Miniatura de un estilo de tabla para su menú: tres filas con sus líneas y fondos. */
function tableThumb(s: (typeof TABLE_STYLES)[number]): string {
  const row = (k: number): string => {
    const marks = s.before(k, 3).join(' ');
    const top = /toprule/.test(marks) ? '2px solid' : /hline|midrule/.test(marks) ? '1px solid' : '0';
    const bg = /gray!25/.test(marks) ? '#cfcfcf' : /gray!15/.test(marks) ? '#e4e4e4' : 'transparent';
    const cell = `<i style="${s.bars ? 'border-left:1px solid;border-right:1px solid' : ''}"></i>`;
    return `<span style="border-top:${top};background:${bg}">${cell.repeat(3)}</span>`;
  };
  const end = /bottomrule/.test(s.end) ? '2px solid' : s.end ? '1px solid' : '0';
  return `<span class="tthumb" style="border-bottom:${end}">${row(0)}${row(1)}${row(2)}</span>`;
}

/** Pasa a `td` el contenido de otra celda, separado por un solo espacio. */
function joinCells(td: HTMLElement, other: HTMLElement): void {
  const edge = (n: ChildNode | null, trim: (s: string) => string): void => {
    if (n?.nodeType === 3) (n as Text).data = trim((n as Text).data);
  };
  edge(td.lastChild, (s) => s.trimEnd());
  edge(td.firstChild, (s) => s.trimStart());
  edge(other.firstChild, (s) => s.trimStart());
  edge(other.lastChild, (s) => s.trimEnd());
  if (other.textContent?.trim() || other.querySelector('[data-tex]')) td.append(document.createTextNode(' '), ...Array.from(other.childNodes));
}

function tableOp(op: string): void {
  const td = currentCell();
  const tr = td?.parentElement as HTMLTableRowElement | null;
  const tbl = td?.closest('table');
  if (!td || !tr || !tbl) return;
  const rows = Array.from(tbl.querySelectorAll('tr'));
  const index = Array.from(tr.children).indexOf(td);
  const newCell = (like: Element): HTMLElement => {
    const c = document.createElement('td');
    c.setAttribute('data-k', 'cell');
    c.setAttribute('style', like.getAttribute('style') ?? '');
    return c;
  };
  const spec = (edit: (s: string) => string): void => {
    const o = tbl.getAttribute('data-o') ?? '';
    const j = specStart(o);
    if (j >= 0) tbl.setAttribute('data-o', o.slice(0, j + 1) + edit(o.slice(j + 1, -1)) + '}');
  };
  if (op === 'row+') {
    const row = document.createElement('tr');
    row.setAttribute('data-k', 'row');
    // misma sangría que la fila actual; en tablas con bordes, con su \hline
    const lead = tr.getAttribute('data-lead') ?? '\n  ';
    row.setAttribute('data-lead', lead);
    row.setAttribute('data-post', ' \\\\');
    if (tbl.classList.contains('bordered')) {
      row.setAttribute('data-pre', '\\hline' + lead);
      row.className = 'rule';
    }
    for (const c of Array.from(tr.children)) row.appendChild(newCell(c));
    tr.after(row);
  } else if (op === 'row-') {
    if (rows.length < 2) return;
    tr.remove();
  } else if (op === 'sort-asc' || op === 'sort-desc') {
    // ordena las filas de datos (todas menos la primera, el encabezado) por el texto de esta columna
    const data = rows.slice(1);
    if (data.length < 2 || data.some((r) => Array.from(r.children).some((c) => (c as HTMLTableCellElement).rowSpan > 1 || (c as HTMLTableCellElement).colSpan > 1))) {
      post({ type: 'info', text: 'Para ordenar, la tabla no puede tener celdas combinadas y necesita al menos dos filas de datos.' });
      return;
    }
    const value = (r: Element): string => (r.children[index]?.textContent ?? '').replace(/\u00AD/g, '').trim();
    const number = (s: string): number => parseFloat(s.replace(/\s/g, '').replace(/\.(?=\d{3}\b)/g, '').replace(',', '.'));
    const numeric = data.every((r) => value(r) === '' || !Number.isNaN(number(value(r))));
    const dir = op === 'sort-asc' ? 1 : -1;
    const sorted = [...data].sort((a, b) => dir * (numeric ? (number(value(a)) || 0) - (number(value(b)) || 0) : value(a).localeCompare(value(b), 'es', { numeric: true, sensitivity: 'base' })));
    // los filetes y los finales de línea son de la posición, no de la fila: se quedan donde estaban
    const keep = data.map((r) => ['data-pre', 'data-lead', 'data-post', 'class', 'style'].map((k) => r.getAttribute(k)));
    const parent = data[0].parentElement as HTMLElement;
    const after = data[data.length - 1].nextSibling;
    sorted.forEach((r, k) => {
      ['data-pre', 'data-lead', 'data-post', 'class', 'style'].forEach((name, q) => {
        const v = keep[k][q];
        if (v === null) r.removeAttribute(name);
        else r.setAttribute(name, v);
      });
      parent.insertBefore(r, after);
    });
  } else if (op === 'col+') {
    for (const r of rows) {
      const ref = r.children[Math.min(index, r.children.length - 1)];
      if (ref) ref.after(newCell(ref));
    }
    spec((s) => (s.trimEnd().endsWith('|') ? s + 'c|' : s + 'c'));
  } else if (op === 'col-') {
    if (tr.children.length < 2) return;
    for (const r of rows) r.children[index]?.remove();
    spec((s) => s.replace(/\|?(?:[lcr]|[pmb]\{[^}]*\})(\|?)$/, '$1').replace(/^$/, 'c'));
  } else if (op.startsWith('align-')) {
    // alineación de la columna: cambia su letra en la especificación (l, c, r)
    const letter = op.slice(6);
    const css = letter === 'c' ? 'center' : letter === 'r' ? 'right' : 'left';
    let col = -1;
    spec((s) => (s.match(SPEC_TOKEN) ?? []).map((t) => (/^([lcrXLCRS]|[pmb]\{)/.test(t) && ++col === index && /^[lcr]$/.test(t) ? letter : t)).join(''));
    for (const r of rows) (r.children[index] as HTMLElement | undefined)?.style.setProperty('text-align', css);
  } else if (op === 'merge-r') {
    // combina la celda con la de su derecha: una sola celda de varias columnas (\multicolumn)
    const next = td.nextElementSibling as HTMLTableCellElement | null;
    if (!next || td.rowSpan > 1 || next.rowSpan > 1) return;
    const n = (td.colSpan || 1) + (next.colSpan || 1);
    joinCells(td, next);
    next.remove();
    td.colSpan = n;
    td.setAttribute('data-o', `\\multicolumn{${n}}{${tbl.classList.contains('bordered') ? '|c|' : 'c'}}{`);
    td.setAttribute('data-c', '}');
    td.style.textAlign = 'center';
  } else if (op === 'merge-d') {
    // combina la celda con la de debajo: baja una fila más (\multirow) y la de abajo queda vacía
    const below = rows[rows.indexOf(tr) + (td.rowSpan || 1)]?.children[index] as HTMLTableCellElement | undefined;
    if (!below || (td.colSpan || 1) > 1 || (below.colSpan || 1) > 1) return;
    const n = (td.rowSpan || 1) + 1;
    joinCells(td, below);
    below.textContent = '';
    td.setAttribute('data-o', `\\multirow{${n}}{*}{`);
    td.setAttribute('data-c', '}');
    if (active) active.pkgs = ['multirow'];
  } else if (op === 'split') {
    // deshace la combinación: vuelven a ser celdas sueltas
    const n = td.colSpan || 1;
    if (n < 2 && (td.rowSpan || 1) < 2) return;
    td.removeAttribute('data-o');
    td.removeAttribute('data-c');
    td.removeAttribute('colspan');
    td.removeAttribute('rowspan');
    for (let k = 1; k < n; k++) td.after(newCell(td));
  } else if (op.startsWith('style-')) {
    // estilo de toda la tabla: barras de la especificación, reglas entre filas y color de fondo
    const style = TABLE_STYLES.find((s) => s.id === op.slice(6));
    if (!style) return;
    const strip = (s: string): string => s.replace(/[ \t]*\\(?:hline|toprule|midrule|bottomrule|rowcolor\s*(?:\[[^\]]*\])?\s*\{[^}]*\})[ \t]*\n?/g, '');
    spec((s) => {
      const cols = (s.match(SPEC_TOKEN) ?? []).filter((t) => !/^\|+$/.test(t) && t.trim());
      return style.bars ? `|${cols.join('|')}|` : cols.join('');
    });
    rows.forEach((r, k) => {
      const lead = r.getAttribute('data-lead') ?? '\n  ';
      const rest = strip(r.getAttribute('data-pre') ?? '').trimStart();
      const marks = style.before(k, rows.length);
      r.setAttribute('data-pre', marks.map((m) => m + lead).join('') + rest);
      delete (r as HTMLElement & { _sig?: string })._sig; // obliga a reescribir la fila
    });
    const closing = strip(tbl.getAttribute('data-c') ?? '');
    const lead = rows[0]?.getAttribute('data-lead') ?? '\n  ';
    tbl.setAttribute('data-c', style.end ? `${lead}${style.end}${closing.startsWith('\n') ? '' : '\n'}${closing}` : closing);
    if (active && style.packages.length) active.pkgs = style.packages;
  } else if (op === 'borders') {
    // todos los bordes o ninguno: barras en la especificación y \hline entre filas
    const on = !tbl.classList.contains('bordered');
    const strip = (s: string): string => s.replace(/[ \t]*\\hline[ \t]*\n?/g, '');
    spec((s) => {
      const cols = (s.match(SPEC_TOKEN) ?? []).filter((t) => !/^\|+$/.test(t) && t.trim());
      return on ? `|${cols.join('|')}|` : cols.join('');
    });
    for (const r of rows) {
      const lead = r.getAttribute('data-lead') ?? '\n  ';
      const pre = strip(r.getAttribute('data-pre') ?? '');
      r.setAttribute('data-pre', on ? `\\hline${lead}${pre.trimStart()}` : pre.trimStart());
      r.classList.toggle('rule', on);
      delete (r as HTMLElement & { _sig?: string })._sig; // obliga a reescribir la fila
    }
    // la regla final va justo antes del cierre de la tabla, con la sangría de las filas
    const closing = strip(tbl.getAttribute('data-c') ?? '');
    const lead = rows[0]?.getAttribute('data-lead') ?? '\n  ';
    tbl.setAttribute('data-c', on ? `${lead}\\hline${closing.startsWith('\n') ? '' : '\n'}${closing}` : closing);
    tbl.classList.toggle('bordered', on);
    tbl.classList.toggle('rule-end', on);
  }
  if (active) active.refresh = true;
  markDirty(true);
}

function tableTex(rows: number, cols: number, header: boolean, caption: string): string {
  const spec = '|' + 'c|'.repeat(cols);
  const row = (cells: string[], ind: string): string => `${ind}${cells.join(' & ')} \\\\\n${ind}\\hline`;
  const ind = caption ? '    ' : '  ';
  const body: string[] = [`${ind}\\hline`];
  for (let r = 0; r < rows; r++) {
    body.push(row(Array.from({ length: cols }, (_, c) => (r === 0 && header ? `\\textbf{Columna ${c + 1}}` : '')), ind));
  }
  const tabular = `\\begin{tabular}{${spec}}\n${body.join('\n')}\n${ind.slice(2)}\\end{tabular}`;
  if (!caption) return `\\begin{center}\n${tabular}\n\\end{center}`;
  return `\\begin{table}[h]\n  \\centering\n  ${tabular}\n  \\caption{${escapeText(caption)}}\n\\end{table}`;
}

// ------------------------------------------------------------------ párrafo: interlineado, sangría y viñetas

/** Entorno que envuelve el párrafo en edición y cuyo `\begin` cumple `re` (él, o uno dentro de otro). */
function paraEnv(c: HTMLElement, re: RegExp): HTMLElement | undefined {
  return Array.from(c.querySelectorAll<HTMLElement>(':scope > div[data-o], :scope > div[data-o] > div[data-o]')).find((d) => re.test(d.getAttribute('data-o') ?? ''));
}

/**
 * Mete el párrafo en edición (o los párrafos seleccionados) en un entorno, le cambia la apertura
 * si ya estaba dentro de uno igual, o lo saca de él (`open` sin definir).
 */
function wrapPara(re: RegExp, open: string | undefined, close: string, packages?: string[]): void {
  if (xsel) {
    if (open !== undefined) paragraphsXsel((p) => [open, ...p.join('\n\n').split('\n'), close], packages);
    return;
  }
  const a = active;
  if (!a) return;
  const c = content(a.el);
  const w = paraEnv(c, re);
  if (w) {
    w.setAttribute('data-o', open ?? '');
    if (open === undefined) w.setAttribute('data-c', '');
    commitFull(serializeBlock(c), undefined, open === undefined ? undefined : packages);
    return;
  }
  const inner = serializeBlock(c);
  if (open === undefined || !inner) return;
  commitFull(`${open}\n${inner}\n${close}`, undefined, packages);
}

/** Interlineado de un párrafo: factores del paquete setspace que dan cada espaciado. */
const PAR_SPACING: [factor: string, name: string][] = [['1', 'Sencillo'], ['1.15', '1,15'], ['1.25', '1,5 líneas'], ['1.667', 'Doble']];
const SPACING_ENV = /^\\begin\{spacing\}/;
const INDENT_ENV = /^\\begin\{adjustwidth\}\{\s*([\d.]+)\s*cm\s*\}/;

/** Sangría izquierda (en cm) del párrafo en edición. */
function paraIndent(): number {
  const w = active ? paraEnv(content(active.el), INDENT_ENV) : undefined;
  return parseFloat(INDENT_ENV.exec(w?.getAttribute('data-o') ?? '')?.[1] ?? '0') || 0;
}

/** Viñetas y numeraciones del menú de listas: [entorno, etiqueta de enumitem, muestra]. */
const LIST_STYLES: [env: string, label: string, sample: string][] = [
  ['itemize', '', '•'], ['itemize', '$\\circ$', '○'], ['itemize', '--', '–'], ['itemize', '$\\ast$', '∗'], ['itemize', '$\\blacksquare$', '■'], ['itemize', '\\checkmark', '✓'],
  ['enumerate', '', '1.'], ['enumerate', '\\arabic*)', '1)'], ['enumerate', '\\alph*)', 'a)'], ['enumerate', '(\\alph*)', '(a)'], ['enumerate', '\\Alph*.', 'A.'], ['enumerate', '\\roman*.', 'i.'], ['enumerate', '\\Roman*.', 'I.'],
];

/**
 * Esquemas de lista multinivel: [id, nombre, entorno, etiqueta de cada nivel, muestra de cada nivel].
 * Sin entorno, cada lista conserva el suyo; sin etiquetas, quedan las de LaTeX (o las de babel).
 */
const LIST_SCHEMES: [id: string, name: string, env: string, labels: string[], sample: string[]][] = [
  ['latex', 'Viñetas de LaTeX', 'itemize', ['\\textbullet', '--', '$\\ast$', '$\\cdot$'], ['•', '–', '∗', '·']],
  ['shapes', 'Formas', 'itemize', ['$\\bullet$', '$\\circ$', '$\\blacksquare$', '$\\triangleright$'], ['•', '○', '■', '▹']],
  ['arrows', 'Flechas', 'itemize', ['$\\rightarrow$', '$\\triangleright$', '--', '$\\cdot$'], ['→', '▹', '–', '·']],
  ['outline', 'Esquema', 'enumerate', ['\\arabic*.', '\\alph*)', '\\roman*)', '\\Alph*.'], ['1.', 'a)', 'i)', 'A.']],
  ['legal', 'Numeración por niveles', 'enumerate', ['\\arabic*.', '\\arabic{enumi}.\\arabic*.', '\\arabic{enumi}.\\arabic{enumii}.\\arabic*.', '\\arabic{enumi}.\\arabic{enumii}.\\arabic{enumiii}.\\arabic*.'], ['1.', '1.1.', '1.1.1.', '1.1.1.1.']],
  ['roman', 'Romanos', 'enumerate', ['\\Roman*.', '\\Alph*.', '\\arabic*.', '\\alph*)'], ['I.', 'A.', '1.', 'a)']],
  ['default', 'Las del documento', '', [], ['•', '–', '∗', '·']],
];

/** Paquetes que pide una etiqueta de lista: enumitem para ponerla y amssymb para algunos símbolos. */
const labelPackages = (labels: string[]): string[] | undefined =>
  labels.some(Boolean) ? [...(labels.some((l) => /\\(checkmark|blacksquare|square)\b/.test(l)) ? ['amssymb'] : []), 'enumitem'] : undefined;

/**
 * Apertura de una lista con otro entorno y otra etiqueta, conservando las demás opciones que tuviera
 * (noitemsep, start=3...). Sin etiqueta se quita la que hubiera.
 */
function listOpen(old: string, env: string, label: string): string {
  return old.replace(/^(\s*)\\begin\{[a-z]+\}(?:\[([^\]]*)\])?/, (_, lead: string, opts: string = '') => {
    const keep = opts.split(',').map((o) => o.trim()).filter((o) => o && !/^label\s*=/.test(o) && /=|^(noitemsep|nosep|nolistsep|wide|inline|resume\*?)$/.test(o));
    const all = [...(label ? [`label=${label}`] : []), ...keep];
    return `${lead}\\begin{${env}}${all.length ? `[${all.join(', ')}]` : ''}`;
  });
}

/** Nivel (desde 1) de un elemento de lista dentro de su bloque. */
function listLevel(li: HTMLElement): number {
  let n = 0;
  for (let e: HTMLElement | null = li; e; e = e.parentElement?.closest('li') ?? null) n++;
  return n;
}

/**
 * Lista multinivel: aplica un esquema a la lista donde está el cursor y a todas sus sublistas, a
 * cada una la etiqueta de su nivel. Fuera de una lista, crea una con la del primer nivel.
 */
function applyListScheme(id: string): void {
  const scheme = LIST_SCHEMES.find((x) => x[0] === id);
  if (!scheme) return;
  const [, , env, labels] = scheme;
  const a = active;
  const li = currentLi();
  if (!a || !li || !a.el.contains(li)) {
    setListStyle(env || 'itemize', labels[0] ?? '');
    return;
  }
  const c = content(a.el);
  let top = li.parentElement as HTMLElement;
  for (let up = top.parentElement?.closest('li'); up && c.contains(up); up = top.parentElement?.closest('li')) top = up.parentElement as HTMLElement;
  const used: string[] = [];
  const walk = (list: HTMLElement, depth: number): void => {
    const was = /\\begin\{([a-z]+)\}/.exec(list.getAttribute('data-o') ?? '')?.[1] ?? 'itemize';
    // (una lista de descripciones no tiene marcas: se queda como está, pero sus sublistas sí cambian)
    if (was !== 'description') {
      const want = env || was;
      const label = labels[Math.min(depth, labels.length - 1)] ?? '';
      used.push(label);
      list.setAttribute('data-o', listOpen(list.getAttribute('data-o') ?? `\\begin{${want}}`, want, label));
      list.setAttribute('data-c', (list.getAttribute('data-c') ?? `\n\\end{${want}}`).replace(/\\end\{[a-z]+\}(\s*)$/, `\\end{${want}}$1`));
    }
    for (const item of Array.from(list.children).filter((x) => x.tagName === 'LI')) {
      for (const sub of Array.from(item.children).filter(isSublist)) walk(sub as HTMLElement, depth + 1);
    }
  };
  walk(top, 0);
  commitFull(serializeBlock(c), undefined, labelPackages(used));
}

function setListStyle(env: string, label: string): void {
  const open = `\\begin{${env}}${label ? `[label=${label}]` : ''}`;
  const close = `\\end{${env}}`;
  const pk = labelPackages([label]);
  if (xsel) {
    paragraphsXsel((p) => [open, ...p.flatMap((s) => `  \\item ${itemTex(s)}`.split('\n')), close], pk);
    return;
  }
  const a = active;
  if (!a) {
    insertBlock(`${open}\n  \\item \n${close}`, pk);
    return;
  }
  const c = content(a.el);
  const li = currentLi();
  const listEl = li && a.el.contains(li) ? (li.parentElement as HTMLElement) : null;
  if (listEl) {
    // solo cambian la apertura y el cierre del entorno (con sus demás opciones): lo que hubiera entre ellos y los elementos se conserva
    listEl.setAttribute('data-o', listOpen(listEl.getAttribute('data-o') ?? open, env, label));
    listEl.setAttribute('data-c', (listEl.getAttribute('data-c') ?? '').replace(/\\end\{[a-z]+\}\s*$/, () => close));
    commitFull(serializeBlock(c), undefined, pk);
    return;
  }
  if (!isPlain(c)) return;
  commitFull(`${open}\n  \\item ${itemTex(serializeBlock(c))}\n${close}`, undefined, pk);
}

// ------------------------------------------------------------------ copiar formato

/** Etiquetas HTML de formato de carácter que el editor crea por su cuenta. */
const FORMAT_TAGS = new Set(['B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'CODE', 'SUP', 'SUB', 'INS', 'DEL', 'MARK']);
/** Formato recogido con «Copiar formato»: moldes vacíos, de fuera adentro, y los paquetes que piden. */
let brush: { molds: HTMLElement[]; packages: string[] } | undefined;

/** El formato de carácter que tiene el texto donde está el cursor. */
function formatAt(): { molds: HTMLElement[]; packages: string[] } {
  const molds: HTMLElement[] = [];
  const packages = new Set<string>();
  const stop = active ? content(active.el) : null;
  for (let el = styleNode(); el && stop && el !== stop && stop.contains(el); el = el.parentElement) {
    const o = el.getAttribute('data-o');
    if (el.hasAttribute('data-tex') || el.hasAttribute('data-skip') || el.hasAttribute('data-k')) continue;
    if (o === null && !FORMAT_TAGS.has(el.tagName)) continue;
    // envoltorios de bloque (entornos, celdas, elementos de lista) no son formato de carácter
    if (o?.startsWith('\\begin') || /^(DIV|LI|TD|TH|UL|OL|TABLE|FIGURE|BLOCKQUOTE|H\d)$/.test(el.tagName)) continue;
    if (o === '' && el.getAttribute('data-c') === '') continue; // la parte con estilo de un grupo: va con su grupo
    const mold = el.cloneNode(false) as HTMLElement;
    mold.removeAttribute('id');
    const first = el.firstElementChild;
    if (o === '{' && first?.classList.contains('hid')) {
      // grupo con una declaración dentro ({\fontsize{14}{17}\selectfont texto}): se copia entera
      mold.setAttribute('data-o', `{${first.getAttribute('data-tex') ?? ''}`);
      mold.setAttribute('style', first.nextElementSibling?.getAttribute('style') ?? '');
    }
    const tex = mold.getAttribute('data-o') ?? '';
    if (/\\(textcolor|color)\b/.test(tex)) packages.add('xcolor');
    if (/\\sout\b/.test(tex) || el.tagName === 'S') packages.add('ulem');
    if (/\\fontsize\b/.test(tex)) packages.add('anyfontsize');
    molds.unshift(mold);
  }
  return { molds, packages: [...packages] };
}

function setBrush(next: typeof brush): void {
  brush = next;
  document.body.classList.toggle('brush', brush !== undefined);
  toolbar.querySelector('button[data-cmd="brush"]')?.classList.toggle('on', brush !== undefined);
}

/** Da a la selección el formato recogido con «Copiar formato». */
function applyBrush(): void {
  const b = brush;
  const a = active;
  const sel = selection();
  if (!b || !a || !sel.rangeCount || sel.isCollapsed || !a.el.contains(sel.anchorNode)) return;
  setBrush(undefined);
  if (!b.molds.length) return;
  trimSelection();
  const range = sel.getRangeAt(0);
  tightenRange(range);
  let outer: HTMLElement | undefined;
  let inner: HTMLElement | undefined;
  for (const mold of b.molds) {
    const n = mold.cloneNode(false) as HTMLElement;
    if (inner) inner.appendChild(n);
    else outer = n;
    inner = n;
  }
  if (!outer || !inner) return;
  inner.appendChild(range.extractContents());
  range.insertNode(outer);
  dropEmptyShells(outer);
  sel.selectAllChildren(inner);
  a.dirty = true;
  a.el._html = null;
  flush(a, false, b.packages.length ? b.packages : undefined);
}

// ------------------------------------------------------------------ buscar y reemplazar

const findEl = document.createElement('div');
findEl.id = 'findbar';
findEl.hidden = true;
findEl.innerHTML =
  '<div class="fb-row"><input id="find-q" placeholder="Buscar" spellcheck="false">' +
  '<span id="find-n"></span>' +
  `<button data-f="case" title="Distinguir mayúsculas y minúsculas">Aa</button>` +
  `<button data-f="prev" title="Anterior (Mayús+Enter)"><i class="codicon codicon-arrow-up"></i></button>` +
  `<button data-f="next" title="Siguiente (Enter)"><i class="codicon codicon-arrow-down"></i></button>` +
  `<button data-f="close" title="Cerrar (Esc)"><i class="codicon codicon-close"></i></button></div>` +
  '<div class="fb-row"><input id="find-r" placeholder="Reemplazar con" spellcheck="false">' +
  '<button data-f="one" class="wide" title="Reemplazar esta coincidencia">Reemplazar</button>' +
  '<button data-f="all" class="wide" title="Reemplazar todas las coincidencias">Todas</button></div>';
document.body.appendChild(findEl);
const findQ = findEl.querySelector('#find-q') as HTMLInputElement;
const findR = findEl.querySelector('#find-r') as HTMLInputElement;
const findMark = typeof Highlight === 'undefined' ? undefined : new Highlight();
const findCur = typeof Highlight === 'undefined' ? undefined : new Highlight();
if (findMark && findCur) {
  CSS.highlights.set('mars-find', findMark);
  CSS.highlights.set('mars-find-cur', findCur);
}
let finds: { el: BlockEl; range: Range }[] = [];
let findAt = -1;
let findCase = false;

/** Busca el texto en los bloques editables (no en fórmulas, código ni adornos) y pinta las coincidencias. */
function runFind(keep = false): void {
  const q = findCase ? findQ.value : findQ.value.toLowerCase();
  finds = [];
  if (q && !findEl.hidden) {
    for (const el of els) {
      if (!isRich(el)) continue;
      const { text, segs } = flatten(content(el));
      const hay = findCase ? text : text.toLowerCase();
      for (let i = hay.indexOf(q); i >= 0; i = hay.indexOf(q, i + q.length)) finds.push({ el, range: rangeOf(segs, i, i + q.length) });
    }
  }
  findAt = finds.length ? (keep ? Math.min(Math.max(findAt, 0), finds.length - 1) : 0) : -1;
  paintFind();
}

function paintFind(scroll = false): void {
  findMark?.clear();
  findCur?.clear();
  finds.forEach((f, i) => (i === findAt ? findCur : findMark)?.add(f.range));
  (findEl.querySelector('#find-n') as HTMLElement).textContent = findQ.value ? (finds.length ? `${findAt + 1} de ${finds.length}` : 'Sin resultados') : '';
  const cur = finds[findAt];
  if (scroll && cur) {
    const r = vrect(cur.range);
    if (r.top < toolbar.offsetHeight + 90 || r.bottom > window.innerHeight - 60) window.scrollTo({ top: window.scrollY + r.top - window.innerHeight / 2 });
  }
}

function openFind(): void {
  const picked = selection().toString().trim();
  findEl.hidden = false;
  findEl.style.top = `${toolbar.offsetHeight + 8}px`;
  if (picked && !picked.includes('\n')) findQ.value = picked;
  findQ.focus();
  findQ.select();
  runFind();
  paintFind(true);
}

function closeFind(): void {
  findEl.hidden = true;
  finds = [];
  findAt = -1;
  paintFind();
}

function stepFind(dir: number): void {
  if (!finds.length) return;
  findAt = (findAt + dir + finds.length) % finds.length;
  paintFind(true);
}

/** Sustituye coincidencias por el texto de reemplazo y lleva los bloques cambiados al documento, en un solo paso. */
function replaceFinds(list: { el: BlockEl; range: Range }[]): void {
  if (!list.length) return;
  if (active) deactivate();
  const touched = new Map<BlockEl, Extent>();
  for (const f of list) {
    const ext = extent(f.el);
    if (ext && !touched.has(f.el)) touched.set(f.el, ext);
  }
  // de atrás hacia delante: cambiar un tramo no mueve los que quedan por cambiar
  for (const f of [...list].reverse()) {
    if (!touched.has(f.el)) continue;
    unhyphenate(content(f.el));
  }
  // al unir el texto los rangos se conservan; ahora sí se sustituye
  for (const f of [...list].reverse()) {
    if (!touched.has(f.el)) continue;
    f.range.deleteContents();
    if (findR.value) f.range.insertNode(document.createTextNode(findR.value));
  }
  const batch: Splice[] = [];
  for (const [el, ext] of touched) {
    el._html = null;
    el._hy = '';
    const lines = serializeBlock(content(el)).split('\n');
    if (lines.join('\n') !== ext.lines.join('\n')) batch.push({ s: ext.s, d: ext.lines.length, expect: ext.lines, lines });
  }
  if (batch.length) post({ type: 'splices', list: batch, seq: ++seq });
}

findEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button[data-f]') as HTMLElement | null;
  if (!b) return;
  const f = b.dataset.f;
  if (f === 'close') closeFind();
  else if (f === 'next') stepFind(1);
  else if (f === 'prev') stepFind(-1);
  else if (f === 'case') {
    findCase = !findCase;
    b.classList.toggle('on', findCase);
    runFind();
  } else if (f === 'one' && finds[findAt]) replaceFinds([finds[findAt]]);
  else if (f === 'all') replaceFinds(finds);
});
findQ.addEventListener('input', () => {
  runFind();
  paintFind(true);
});
findEl.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeFind();
  else if (e.key === 'Enter') {
    e.preventDefault();
    if (e.target === findR) {
      if (finds[findAt]) replaceFinds([finds[findAt]]);
    } else stepFind(e.shiftKey ? -1 : 1);
  }
  e.stopPropagation();
});

// ------------------------------------------------------------------ control de cambios y comentarios

/** Con el control de cambios activado, lo que se escribe y lo que se borra queda marcado (paquete changes). */
let tracking = false;
const CHANGE = /\\(added|deleted|replaced)(?![a-zA-Z])\s*(?:\[[^\]]*\])?\s*(?=\{)/g;

function setTracking(on: boolean): void {
  tracking = on;
  document.body.classList.toggle('tracking', on);
  toolbar.querySelector('button[data-cmd="track"]')?.classList.toggle('on', on);
}

function changeEl(tag: 'ins' | 'del'): HTMLElement {
  const el = document.createElement(tag);
  el.className = 'chg';
  el.setAttribute('data-o', tag === 'ins' ? '\\added{' : '\\deleted{');
  el.setAttribute('data-c', '}');
  return el;
}

const within = (node: Node | null, selector: string): HTMLElement | null => (node?.nodeType === 1 ? (node as Element) : node?.parentElement)?.closest<HTMLElement>(selector) ?? null;

/**
 * Una pulsación con el control de cambios activado. Lo escrito va dentro de `\added{...}`; lo
 * borrado no desaparece, queda dentro de `\deleted{...}` (salvo que fuese un añadido propio, que
 * sí se borra). Devuelve `true` si se ha encargado de la pulsación.
 */
function trackInput(e: InputEvent): boolean {
  const a = active;
  const sel = selection();
  if (!tracking || !a || !sel.rangeCount || composing) return false;
  const typing = e.inputType === 'insertText' && typeof e.data === 'string';
  const erasing = e.inputType.startsWith('delete');
  if (!typing && !erasing) return false;
  // dentro de un añadido propio se escribe y se borra con normalidad
  if (sel.isCollapsed && within(sel.anchorNode, 'ins.chg') && (typing || within(sel.anchorNode, 'ins.chg')?.textContent !== '')) {
    if (typing) return false;
    const ins = within(sel.anchorNode, 'ins.chg') as HTMLElement;
    const r = sel.getRangeAt(0);
    const atEdge = e.inputType.includes('Backward') ? offsetOf(ins, r.startContainer, r.startOffset) === 0 : offsetOf(ins, r.startContainer, r.startOffset) >= units(ins);
    if (!atEdge) return false;
  }
  e.preventDefault();
  a.pkgs = ['changes'];
  if (!sel.isCollapsed || erasing) {
    if (sel.isCollapsed) sel.modify('extend', e.inputType.includes('Forward') ? 'forward' : 'backward', e.inputType.includes('Word') ? 'word' : 'character');
    const r = sel.getRangeAt(0);
    if (!r.collapsed && content(a.el).contains(r.commonAncestorContainer)) {
      const forward = e.inputType.includes('Forward');
      if (within(r.commonAncestorContainer, 'del.chg')) {
        // ya estaba marcado como borrado: el cursor pasa de largo
        r.collapse(forward ? false : true);
      } else {
        const del = changeEl('del');
        del.appendChild(r.extractContents());
        // lo que era un añadido sin aceptar se borra de verdad
        del.querySelectorAll('ins.chg').forEach((n) => n.remove());
        if (del.textContent || del.querySelector('[data-tex]')) {
          // la marca de borrado va fuera de un añadido propio, no dentro
          const host = within(r.startContainer, 'ins.chg');
          if (host) {
            if (offsetOf(host, r.startContainer, r.startOffset) === 0) r.setStartBefore(host);
            else r.setStartAfter(host);
            r.collapse(true);
          }
          r.insertNode(del);
          dropEmptyShells(del);
          r.setStartBefore(del);
          r.setEndAfter(del);
          r.collapse(typing || forward ? false : true);
        }
      }
      sel.removeAllRanges();
      sel.addRange(r);
    }
  }
  if (typing) {
    const r = sel.getRangeAt(0);
    // justo detrás de un añadido propio: se sigue escribiendo dentro de él
    const prev = r.startContainer.nodeType === 3 ? (r.startOffset === 0 ? r.startContainer.previousSibling : null) : r.startContainer.childNodes[r.startOffset - 1];
    let ins = prev instanceof HTMLElement && prev.matches('ins.chg') ? prev : undefined;
    if (!ins) {
      ins = changeEl('ins');
      r.insertNode(ins);
    }
    ins.appendChild(document.createTextNode(e.data as string));
    ins.normalize();
    r.selectNodeContents(ins);
    r.collapse(false);
    sel.removeAllRanges();
    sel.addRange(r);
  }
  markDirty();
  spell.schedule(true);
  return true;
}

/** El código de un bloque con sus cambios aceptados (queda lo nuevo) o rechazados (queda lo de antes). */
function resolveChanges(tex: string, accept: boolean): string {
  let out = '';
  let at = 0;
  CHANGE.lastIndex = 0;
  for (let m = CHANGE.exec(tex); m; m = CHANGE.exec(tex)) {
    const first = braceGroup(tex, CHANGE.lastIndex);
    if (!first) continue;
    let end = first.end;
    let keep: string;
    if (m[1] === 'replaced') {
      const second = braceGroup(tex, end);
      if (!second) continue;
      end = second.end;
      keep = accept ? first.content : second.content;
    } else keep = (m[1] === 'added') === accept ? first.content : '';
    out += tex.slice(at, m.index) + resolveChanges(keep, accept);
    at = end;
    CHANGE.lastIndex = end;
  }
  return out + tex.slice(at);
}

/** Grupo `{...}` que empieza en `s[i]`, respetando los anidados. */
function braceGroup(s: string, i: number): { content: string; end: number } | undefined {
  if (s[i] !== '{') return undefined;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === '\\') j++;
    else if (s[j] === '{') depth++;
    else if (s[j] === '}' && --depth === 0) return { content: s.slice(i + 1, j), end: j + 1 };
  }
  return undefined;
}

/** Acepta o rechaza todos los cambios marcados del documento, en un solo paso de deshacer. */
function settleChanges(accept: boolean): void {
  if (active) deactivate();
  const batch: Splice[] = [];
  for (const el of els) {
    const ext = el._b?.kind === 'ro' || el.classList.contains('is-preamble') ? undefined : extent(el);
    if (!ext) continue;
    const src = ext.lines.join('\n');
    CHANGE.lastIndex = 0;
    if (!CHANGE.test(src)) continue;
    const next = resolveChanges(src, accept).replace(/[ \t]+\n/g, '\n').replace(/ {2,}/g, ' ').trim();
    if (next) batch.push({ s: ext.s, d: ext.lines.length, expect: ext.lines, lines: next.split('\n') });
    else {
      const gone = removal(ext);
      batch.push({ s: ext.s, d: gone.expect.length, expect: gone.expect, lines: gone.lines });
    }
  }
  if (batch.length) post({ type: 'splices', list: batch, seq: ++seq });
}

// ------------------------------------------------------------------ imágenes: alinear, rodear de texto y recortar

/** Bloque de la imagen sobre la que se trabaja: la última en la que se hizo clic, o la del bloque en edición. */
let pickedImage: BlockEl | undefined;
const imageBlock = (): BlockEl | undefined => {
  const el = pickedImage?.isConnected ? pickedImage : active?.el ?? (lastEl?.isConnected ? lastEl : undefined);
  return el && /\\includegraphics\b/.test(el._b?.src ?? '') ? el : undefined;
};

/** Sustituye el código del bloque de la imagen por lo que devuelva `change`. */
function editImage(change: (src: string) => string | undefined, packages?: string[]): void {
  const el = imageBlock();
  const r = el ? blockRange(el) : undefined;
  if (!el || !r) return;
  const next = change(r.src);
  if (next === undefined || next === r.src) return;
  dropActive();
  nextFocus = undefined;
  pickedImage = undefined;
  sendFull(r.s, r.lines, next.split('\n'), packages);
}

/** Cuál de las imágenes del bloque es la elegida (un bloque con subfiguras tiene varias). */
let pickedIndex = 0;
function imageIndexOf(target: Element): number {
  const all = Array.from(target.closest('.block')?.querySelectorAll('.content img, .content canvas.pdfimg, .content .img-missing') ?? []);
  return Math.max(all.findIndex((n) => n === target || target.contains(n) || n.contains(target)), 0);
}

/** Opciones separadas por comas, sin partir las que llevan llaves (`trim={1cm 0 0 0}`). */
function splitOptions(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (ch === ',' && depth <= 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  return [...out, cur].map((x) => x.trim()).filter(Boolean);
}

/** Opciones de `\includegraphics[...]` cambiadas con `edit` (las de la imagen elegida, si hay varias). */
function graphicsOptions(src: string, edit: (opts: string[]) => string[]): string {
  const total = (src.match(/\\includegraphics\b/g) ?? []).length;
  const index = pickedIndex < total ? pickedIndex : 0;
  let n = -1;
  return src.replace(/\\includegraphics\s*(\[[^\]]*\])?/g, (all: string, o: string | undefined) => {
    if (++n !== index) return all;
    const opts = edit(splitOptions((o ?? '[]').slice(1, -1)));
    return `\\includegraphics${opts.length ? `[${opts.join(', ')}]` : ''}`;
  });
}

/** Opciones que tiene ahora la imagen elegida. */
function imageOptions(src: string): Record<string, string> {
  const found: Record<string, string> = {};
  graphicsOptions(src, (opts) => {
    for (const o of opts) {
      const eq = o.indexOf('=');
      found[(eq < 0 ? o : o.slice(0, eq)).trim()] = eq < 0 ? '' : o.slice(eq + 1).trim();
    }
    return opts;
  });
  return found;
}

/** Dentro de una subfigura, una minipágina o una columna las medidas se refieren a su ancho, no al del texto. */
const widthUnit = (src: string): string => (/\\begin\{(subfigure|subtable|minipage|wrapfigure|column|columns|multicols)\}/.test(src) ? '\\linewidth' : '\\textwidth');
const fraction = (f: number, unit: string): string => (Math.abs(f - 1) < 0.001 ? unit : `${+f.toFixed(3)}${unit}`);

interface ImageSize {
  width?: string;
  height?: string;
  scale?: string;
  angle?: string;
  /** con ancho y alto a la vez, encajar la imagen sin deformarla */
  keep?: boolean;
}

/**
 * Cambia las medidas de la imagen elegida. Cada dato va tal cual a `\includegraphics` (vacío: se
 * quita); lo demás que tuviera (recorte, página del PDF...) se conserva.
 */
function sizeImage(size: ImageSize): void {
  editImage((src) =>
    graphicsOptions(src, (opts) => {
      const now = imageOptions(src);
      const next: ImageSize = { width: now.width, height: now.height ?? now.totalheight, scale: now.scale, keep: 'keepaspectratio' in now, ...size };
      // la escala y las medidas se excluyen: manda lo último que se pide
      if (size.scale) next.width = next.height = '';
      else if (size.width || size.height) next.scale = '';
      const rest = opts.filter((o) => !/^(width|height|totalheight|scale|keepaspectratio)\s*(=|$)/.test(o) && !(size.angle !== undefined && /^angle\s*=/.test(o)));
      return [
        ...(next.width ? [`width=${next.width}`] : []),
        ...(next.height ? [`height=${next.height}`] : []),
        ...(next.scale ? [`scale=${next.scale}`] : []),
        ...(next.keep && next.width && next.height ? ['keepaspectratio'] : []),
        ...rest,
        // el giro va al final: las medidas son las de la imagen antes de girarla
        ...(size.angle && parseFloat(size.angle) ? [`angle=${size.angle}`] : []),
      ];
    }),
  );
}

/** Ancho rápido, como fracción del ancho del texto; el alto pasa a ser el proporcional. */
function quickWidth(f: number): void {
  const el = imageBlock();
  const src = el?._b?.src ?? '';
  if (!f) {
    sizeImage({ width: '' });
    return;
  }
  // una imagen rodeada de texto ocupa su hueco entero: lo que cambia es el ancho del hueco
  const wrap = /(\\begin\{wrapfigure\}\{[^}]*\}\{)[^}]*\}/;
  if (wrap.test(src)) editImage((s) => s.replace(wrap, (_, head: string) => `${head}${fraction(f, '\\textwidth')}}`));
  else sizeImage({ width: fraction(f, widthUnit(src)), height: '' });
}

/** Gira la imagen `delta` grados más (en LaTeX, en sentido contrario a las agujas del reloj). */
function rotateImage(delta: number): void {
  const el = imageBlock();
  if (!el?._b) return;
  const now = parseFloat(imageOptions(el._b.src).angle ?? '0') || 0;
  sizeImage({ angle: String((((now + delta) % 360) + 360) % 360) });
}

const SIZE_UNITS = ['cm', 'mm', 'in', 'pt'];

/** Una medida de LaTeX, partida en número y unidad para el formulario (`%`: fracción del texto). */
function splitLength(v: string | undefined): { n: string; unit: string } {
  const t = (v ?? '').trim();
  if (!t) return { n: '', unit: '%' };
  const rel = /^([\d.]*)\s*\\(textwidth|linewidth|columnwidth|textheight)$/.exec(t);
  if (rel) return { n: String(+((rel[1] === '' ? 1 : parseFloat(rel[1])) * 100).toFixed(1)), unit: '%' };
  const abs = /^([\d.]+)\s*([a-z]{2})$/.exec(t);
  if (abs && SIZE_UNITS.includes(abs[2])) return { n: abs[1], unit: abs[2] };
  return { n: t, unit: 'raw' };
}

/** Lo contrario: del número y la unidad del formulario a la medida de LaTeX. */
function joinLength(n: string, unit: string, relative: string): string {
  const t = n.trim().replace(',', '.');
  if (!t) return '';
  if (unit === 'raw') return t;
  const v = parseFloat(t);
  if (!(v > 0)) return '';
  return unit === '%' ? fraction(v / 100, relative) : `${+v.toFixed(3)}${unit}`;
}

/** Formulario con todas las medidas de la imagen: ancho, alto, escala y giro. */
function imageSizeForm(): void {
  const el = imageBlock();
  if (!el?._b) return;
  const src = el._b.src;
  const now = imageOptions(src);
  const w = splitLength(now.width);
  const h = splitLength(now.height ?? now.totalheight);
  const units = (rel: string): [string, string][] => [['%', rel], ...SIZE_UNITS.map((u): [string, string] => [u, u]), ['raw', 'tal cual (LaTeX)']];
  const index = pickedIndex;
  form(
    'Tamaño de la imagen',
    [
      { id: 'w', label: 'Ancho (vacío: proporcional al alto)', value: w.n },
      { id: 'wu', label: 'Unidad del ancho', type: 'select', options: units('% del ancho del texto'), value: w.unit },
      { id: 'h', label: 'Alto (vacío: proporcional al ancho)', value: h.n },
      { id: 'hu', label: 'Unidad del alto', type: 'select', options: units('% del alto del texto'), value: h.unit },
      { id: 'keep', label: 'Con ancho y alto a la vez, encajar la imagen sin deformarla', type: 'checkbox', value: 'keepaspectratio' in now || !(now.width && now.height) },
      { id: 'scale', label: 'Escala (%), en lugar de ancho y alto', value: now.scale ? String(+(parseFloat(now.scale) * 100).toFixed(1)) : '' },
      { id: 'angle', label: 'Giro (grados, en sentido antihorario)', type: 'number', value: now.angle ?? '0' },
    ],
    (v) => {
      pickedImage = el;
      pickedIndex = index;
      const width = joinLength(v.w, v.wu, widthUnit(src));
      const height = joinLength(v.h, v.hu, '\\textheight');
      const pct = parseFloat(v.scale.replace(',', '.'));
      const scale = !width && !height && pct > 0 && Math.abs(pct - 100) > 0.01 ? String(+(pct / 100).toFixed(3)) : '';
      const angle = (((parseFloat(v.angle) || 0) % 360) + 360) % 360;
      sizeImage({ width, height, scale, keep: v.keep === '1', angle: String(angle) });
    },
  );
}

/**
 * Dibuja el giro de una imagen (`angle=`): se gira sobre su centro y se le deja alrededor el hueco
 * que ocupa ya girada, para que no pise el texto.
 */
function rotateImages(scope: HTMLElement, retry = true): void {
  for (const pic of Array.from(scope.querySelectorAll<HTMLElement>('img[data-angle], canvas[data-angle]'))) {
    const apply = (again: boolean): void => {
      const a = parseFloat(pic.dataset.angle ?? '') || 0;
      const t = pic.parentElement?.classList.contains('crop') ? pic.parentElement : pic;
      const w = t.offsetWidth;
      const h = t.offsetHeight;
      if (!w || !h) {
        // todavía sin sitio en la página: se mide en cuanto lo tenga
        if (again) requestAnimationFrame(() => apply(false));
        return;
      }
      const rad = (a * Math.PI) / 180;
      const bw = Math.abs(w * Math.cos(rad)) + Math.abs(h * Math.sin(rad));
      const bh = Math.abs(w * Math.sin(rad)) + Math.abs(h * Math.cos(rad));
      const margin = `${((bh - h) / 2).toFixed(1)}px ${((bw - w) / 2).toFixed(1)}px`;
      if (t.style.margin === margin) return;
      t.style.transform = `rotate(${-a}deg)`;
      t.style.margin = margin;
      const el = t.closest('.block') as BlockEl | null;
      if (el) {
        dirty.add(el);
        schedulePaginate(false);
      }
    };
    if (pic instanceof HTMLImageElement && !pic.complete) pic.addEventListener('load', () => apply(true), { once: true });
    else apply(retry);
  }
}

const FLOAT_ENV = /\\begin\{(figure|wrapfigure)\}\s*(\[[^\]]*\])?(\{[^}]*\}\{[^}]*\})?/;

/** Lo que hay dentro de la figura (imagen, pie, etiqueta), sin la orden de alineación. */
function figureBody(src: string): string | undefined {
  const m = /\\begin\{(?:figure|wrapfigure)\}(?:\s*\[[^\]]*\])?(?:\{[^}]*\}\{[^}]*\})?([\s\S]*)\\end\{(?:figure|wrapfigure)\}/.exec(src);
  return m ? m[1].replace(/^[ \t]*\\(centering|raggedright|raggedleft)[ \t]*\n?/m, '').replace(/^\n+|\s+$/g, '') : undefined;
}

/** Alinea la imagen: a un lado, centrada, o a un lado con el texto rodeándola (`wrap`). */
function alignImage(side: 'l' | 'c' | 'r', wrap = false): void {
  const decl = side === 'l' ? '\\raggedright' : side === 'r' ? '\\raggedleft' : '\\centering';
  editImage(
    (src) => {
      const body = figureBody(src) ?? src.replace(/\\begin\{(center|flushleft|flushright)\}\n?|\n?\\end\{(center|flushleft|flushright)\}/g, '').trim();
      const inner = body.split('\n').map((l) => `  ${l.trim()}`).join('\n');
      if (wrap) {
        // el ancho de la figura es el de la imagen si lo dice como fracción del texto; si no, un 40 %
        const w = /width\s*=\s*([\d.]+)\\(?:textwidth|linewidth)/.exec(body)?.[1] ?? '0.4';
        const fitted = graphicsOptions(inner, (o) => ['width=\\linewidth', ...o.filter((x) => !/^(width|height|scale)\s*=/.test(x))]);
        return `\\begin{wrapfigure}{${side === 'l' ? 'l' : 'r'}}{${w}\\textwidth}\n  \\centering\n${fitted}\n\\end{wrapfigure}`;
      }
      const place = FLOAT_ENV.exec(src)?.[1] === 'figure' ? FLOAT_ENV.exec(src)?.[2] ?? '[h]' : '[h]';
      // una imagen que rodeaba el texto recupera su ancho propio
      const w = /\\begin\{wrapfigure\}\{[^}]*\}\{([\d.]+)\\textwidth\}/.exec(src)?.[1];
      const sized = w ? graphicsOptions(inner, (o) => [`width=${w}\\textwidth`, ...o.filter((x) => !/^width\s*=/.test(x))]) : inner;
      return `\\begin{figure}${place}\n  ${decl}\n${sized}\n\\end{figure}`;
    },
    wrap ? ['wrapfig'] : undefined,
  );
}

/** Recorta la imagen: porcentaje que se quita por cada lado (`trim` y `clip` de graphicx). */
function cropImage(): void {
  const el = imageBlock();
  const img = el?.querySelector<HTMLImageElement>('img');
  if (!el || !img?.naturalWidth) return;
  // graphicx mide el recorte en puntos «bp» sobre el tamaño natural de la imagen
  const dpi = parseFloat(img.dataset.dpi ?? '') || 72;
  const bp = (px: number): number => (px / dpi) * 72;
  const now = (img.dataset.trim ?? '0 0 0 0').split(' ').map(Number);
  const pct = (v: number, total: number): string => String(Math.round((v / bp(total)) * 100) || 0);
  form(
    'Recortar imagen',
    [
      { id: 'l', label: 'Izquierda (%)', type: 'number', value: pct(now[0], img.naturalWidth) },
      { id: 'r', label: 'Derecha (%)', type: 'number', value: pct(now[2], img.naturalWidth) },
      { id: 't', label: 'Arriba (%)', type: 'number', value: pct(now[3], img.naturalHeight) },
      { id: 'b', label: 'Abajo (%)', type: 'number', value: pct(now[1], img.naturalHeight) },
    ],
    (v) => {
      const frac = (s: string): number => Math.min(Math.max(parseFloat(s) || 0, 0), 90) / 100;
      const [l, r, t, b] = [frac(v.l), frac(v.r), frac(v.t), frac(v.b)];
      if (l + r >= 0.95 || t + b >= 0.95) return;
      pickedImage = el;
      const n = (x: number): string => String(+x.toFixed(1));
      const trim = `trim=${n(l * bp(img.naturalWidth))} ${n(b * bp(img.naturalHeight))} ${n(r * bp(img.naturalWidth))} ${n(t * bp(img.naturalHeight))}`;
      editImage((src) => graphicsOptions(src, (o) => [...o.filter((x) => !/^(trim\s*=|clip$)/.test(x)), ...(l + r + t + b > 0 ? [trim, 'clip'] : [])]));
    },
  );
}

/**
 * Dibuja el recorte de una imagen (`trim=... , clip`). La parte que queda ocupa el ancho pedido,
 * como en LaTeX: la imagen entera se amplía y se desplaza dentro de una caja que la recorta.
 */
function cropImages(scope: HTMLElement): void {
  for (const img of Array.from(scope.querySelectorAll<HTMLImageElement>('img[data-trim]'))) {
    const apply = (): void => {
      if (!img.naturalWidth || img.parentElement?.classList.contains('crop')) return;
      const dpi = parseFloat(img.dataset.dpi ?? '') || 72;
      const [l, b, r, t] = (img.dataset.trim ?? '').split(' ').map((v) => ((parseFloat(v) || 0) / 72) * dpi);
      const w = img.naturalWidth - l - r;
      const h = img.naturalHeight - t - b;
      if (w <= 1 || h <= 1) return;
      const box = document.createElement('span');
      box.className = 'crop';
      // el ancho que tenía la imagen pasa a la caja; sin ancho, el natural de lo que queda
      box.style.width = img.style.width || `calc(${((w / dpi) * 2.54 * (parseFloat(img.dataset.scale ?? '1') || 1)).toFixed(3)} * var(--cm, 37.8px))`;
      box.style.aspectRatio = `${w} / ${h}`;
      img.replaceWith(box);
      box.appendChild(img);
      img.style.width = `${(img.naturalWidth / w) * 100}%`;
      img.style.height = 'auto';
      img.style.marginLeft = `${(-l / w) * 100}%`;
      img.style.marginTop = `${(-t / w) * 100}%`;
    };
    if (img.complete) apply();
    else img.addEventListener('load', apply, { once: true });
  }
}

// ------------------------------------------------------------------ tablas: pegar una cuadrícula y ancho de columnas

/** Filas y columnas de un texto copiado de una hoja de cálculo (separado por tabuladores), si lo es. */
function gridOf(text: string): string[][] | undefined {
  const rows = text.replace(/\r/g, '').replace(/\n+$/, '').split('\n');
  if (!rows.some((r) => r.includes('\t'))) return undefined;
  const grid = rows.map((r) => r.split('\t').map((c) => c.trim()));
  const cols = Math.max(...grid.map((r) => r.length));
  return cols >= 2 ? grid.map((r) => [...r, ...Array(cols - r.length).fill('')]) : undefined;
}

/** Pega una cuadrícula: dentro de una tabla rellena sus celdas desde la del cursor; fuera, crea una tabla. */
function pasteGrid(grid: string[][]): void {
  const td = currentCell();
  const tr = td?.parentElement;
  const tbl = td?.closest('table');
  if (!td || !tr || !tbl || !active) {
    const body = grid.map((r) => `  ${r.map(escapeText).join(' & ')} \\\\`).join('\n');
    const tex = `\\begin{tabular}{${'l'.repeat(grid[0].length)}}\n${body}\n\\end{tabular}`;
    if (active && !serializeBlock(content(active.el))) commitFull(`\\begin{center}\n${tex}\n\\end{center}`);
    else insertBlock(`\\begin{center}\n${tex}\n\\end{center}`);
    return;
  }
  const col = Array.from(tr.children).indexOf(td);
  let row: Element | null = tr;
  for (const cells of grid) {
    if (!row) {
      // faltan filas: se añaden al final, como la última
      const last = tbl.querySelector('tr:last-of-type') as HTMLElement;
      const fresh = last.cloneNode(true) as HTMLElement;
      fresh.removeAttribute('data-raw');
      Array.from(fresh.children).forEach((c) => (c.textContent = ''));
      last.after(fresh);
      row = fresh;
    }
    cells.forEach((value, k) => {
      const cell = row?.children[col + k];
      if (cell) cell.textContent = value;
    });
    row = row.nextElementSibling;
  }
  active.refresh = true;
  markDirty(true);
}

/** Columna (contando las celdas combinadas) en la que empieza una celda. */
const columnOf = (td: Element): number => {
  let n = 0;
  for (let c = td.previousElementSibling; c; c = c.previousElementSibling) n += (c as HTMLTableCellElement).colSpan || 1;
  return n;
};
let colDrag: { td: HTMLTableCellElement; x: number; w: number } | undefined;
const cellEdge = (e: MouseEvent): HTMLTableCellElement | null => {
  const td = (e.target as HTMLElement | null)?.closest?.('.block.active td') as HTMLTableCellElement | null;
  return td && (td.colSpan || 1) === 1 && vrect(td).right - e.clientX < 6 ? td : null;
};
root.addEventListener('mousemove', (e) => {
  if (!colDrag) document.body.classList.toggle('col-resize', cellEdge(e) !== null);
});
root.addEventListener(
  'mousedown',
  (e) => {
    const td = cellEdge(e);
    if (!td || e.button !== 0) return;
    // arrastrar el borde derecho de una celda fija el ancho de su columna
    e.preventDefault();
    e.stopPropagation();
    colDrag = { td, x: e.clientX, w: td.offsetWidth };
  },
  true,
);
document.addEventListener('mousemove', (e) => {
  if (!colDrag) return;
  const w = Math.max(colDrag.w + (e.clientX - colDrag.x) / currentZoom(), 20);
  colDrag.td.style.width = `${w}px`;
  colDrag.td.style.whiteSpace = 'normal';
});
document.addEventListener('mouseup', () => {
  if (!colDrag) return;
  const { td } = colDrag;
  colDrag = undefined;
  document.body.classList.remove('col-resize');
  setColumnWidth(td, td.offsetWidth / PX_PER_CM);
});

/** Fija el ancho de la columna de `td`: su letra en la especificación pasa a ser `p{...cm}`. */
function setColumnWidth(td: HTMLTableCellElement, cm: number): void {
  const tbl = td.closest('table');
  if (!tbl || !active) return;
  const index = columnOf(td);
  const width = `${Math.max(Math.round(cm * 10) / 10, 0.5)}cm`;
  const o = tbl.getAttribute('data-o') ?? '';
  const at = specStart(o);
  if (at < 0) return;
  let col = -1;
  const spec = (o.slice(at + 1, -1).match(SPEC_TOKEN) ?? []).map((t) => (/^([lcrXLCRS]|[pmb]\{)/.test(t) && ++col === index ? `p{${width}}` : t)).join('');
  tbl.setAttribute('data-o', o.slice(0, at + 1) + spec + '}');
  for (const r of Array.from(tbl.querySelectorAll('tr'))) {
    const cell = Array.from(r.children).find((c) => columnOf(c) === index) as HTMLElement | undefined;
    if (cell) {
      cell.style.width = `calc(${parseFloat(width)} * var(--cm, 37.8px))`;
      cell.style.whiteSpace = 'normal';
    }
  }
  active.refresh = true;
  markDirty(true);
}

/** Posición de la llave que abre la especificación de columnas en el `\begin{tabular}...{spec}`. */
function specStart(open: string): number {
  // la especificación es el último grupo de llaves del encabezado: se busca su apertura contando llaves
  let depth = 0;
  for (let i = open.length - 1; i >= 0; i--) {
    if (open[i] === '}') depth++;
    else if (open[i] === '{' && --depth === 0) return i;
  }
  return -1;
}

function form(title: string, fields: Parameters<typeof openForm>[1], ok: Parameters<typeof openForm>[2], preview?: Parameters<typeof openForm>[4]): void {
  beginModal();
  openForm(title, fields, ok, endModal, preview);
}

const COMMANDS: Record<string, (arg?: string) => void> = {
  save: () => {
    if (active) flush(active);
    post({ type: 'save' });
  },
  undo: () => {
    if (active) {
      flush(active);
      dropActive();
    }
    post({ type: 'undo' });
  },
  redo: () => {
    if (active) {
      flush(active);
      dropActive();
    }
    post({ type: 'redo' });
  },
  bold: () => format('bold'),
  italic: () => format('italic'),
  underline: () => format('underline'),
  code: () => wrapSelection('code', '\\texttt{'),
  wrap: (kind) => {
    const w = WRAPS[kind ?? ''];
    if (w) wrapSelection(w[0], w[1], w[2], kind === 'strike' ? ['ulem'] : undefined);
  },
  size: (name) => {
    if (name && SIZE_EM[name]) wrapSelection('span', `{\\${name} `, { style: `font-size:${SIZE_EM[name]}em` });
  },
  // tipo de letra: del texto seleccionado o, si no hay nada seleccionado, de todo el documento
  font: (key = '') => {
    const f = FONTS[key];
    if (!f) return;
    if (!hasTextSelection()) {
      if (active) flush(active);
      post({ type: 'layout', patch: { font: key } });
      return;
    }
    redeclare('fontfamily', `\\fontfamily{${f.family}}\\selectfont `, `font-family:${f.css}`, undefined, key === (layout?.font ?? ''));
  },
  // tamaño de letra en puntos: igual, de la selección o del documento
  fsize: (arg) => {
    const pt = parseFloat((arg ?? '').replace(',', '.'));
    if (!(pt >= 4 && pt <= 200)) return;
    if (!hasTextSelection()) {
      if (active) flush(active);
      post({ type: 'layout', patch: { fontSize: `${+pt.toFixed(2)}pt` } });
      return;
    }
    // \fontsize{tamaño}{interlineado}: el interlineado habitual, un 20 % más que la letra
    redeclare(
      'fontsize', `\\fontsize{${+pt.toFixed(2)}}{${+(pt * 1.2).toFixed(1)}}\\selectfont `, `line-height:0.95;font-size:${+(pt / pageInfo.fontPt).toFixed(3)}em`,
      ['anyfontsize'], Math.abs(pt - pageInfo.fontPt) < 0.05,
    );
  },
  'fsize-step': (dir) => {
    // sin selección el paso es sobre el tamaño del documento, no sobre el del título donde esté el cursor
    const now = hasTextSelection() ? currentSizePt() : pageInfo.fontPt;
    const next = dir === '-1' ? [...FONT_SIZES].reverse().find((n) => n < now - 0.05) : FONT_SIZES.find((n) => n > now + 0.05);
    if (next !== undefined) run('fsize', String(next));
  },
  color: (name) => applyColor(name),
  'color-more': () =>
    form(
      'Más colores',
      [
        { id: 'pick', label: 'Elige un color', type: 'color', value: `#${recentColors[0] ?? '4472C4'}` },
        { id: 'hex', label: 'O escribe su código (seis cifras hexadecimales, como 1F4E79)', value: '', placeholder: 'RRGGBB' },
      ],
      (v) => applyColor(/^#?[0-9a-fA-F]{6}$/.test(v.hex.trim()) ? v.hex.trim() : v.pick),
    ),
  'ribbon-min': () => setRibbonMin(!ribbonMin),
  align: (env) => setAlign(env ?? ''),
  layout: (arg) => {
    const [key, value] = (arg ?? '').split('=');
    if (!key) return;
    const send = (v: string): void => {
      if (active) flush(active);
      post({ type: 'layout', patch: { [key]: v } });
    };
    if (value !== 'custom') {
      send(value ?? '');
      return;
    }
    const num = (s: string, min: number, max: number): number | undefined => {
      const n = parseFloat(s.replace(',', '.'));
      return Number.isFinite(n) && n >= min && n <= max ? n : undefined;
    };
    if (key === 'paper') {
      form(
        'Tamaño de papel personalizado',
        [
          { id: 'w', label: 'Ancho (cm)', value: es(pageInfo.pageW) },
          { id: 'h', label: 'Alto (cm)', value: es(pageInfo.pageH) },
        ],
        (v) => {
          const w = num(v.w, 5, 120);
          const h = num(v.h, 5, 120);
          if (w === undefined || h === undefined) return;
          if (active) flush(active);
          post({ type: 'layout', patch: { paperSize: `${cmText(w)},${cmText(h)}`, orientation: 'portrait' } });
        },
      );
      return;
    }
    form(
      'Márgenes personalizados',
      [
        { id: 'top', label: 'Superior (cm)', value: es(pageInfo.marginTop) },
        { id: 'bottom', label: 'Inferior (cm)', value: es(pageInfo.marginBottom) },
        { id: 'left', label: 'Izquierdo (cm)', value: es(pageInfo.marginLeft) },
        { id: 'right', label: 'Derecho (cm)', value: es(pageInfo.marginRight) },
      ],
      (v) => {
        const m = { top: num(v.top, 0, 20), bottom: num(v.bottom, 0, 20), left: num(v.left, 0, 20), right: num(v.right, 0, 20) };
        if (Object.values(m).some((x) => x === undefined)) return;
        setMargins(m as Record<'top' | 'bottom' | 'left' | 'right', number>);
      },
    );
  },
  // viudas y huérfanas: \widowpenalty y \clubpenalty en el preámbulo
  widows: () => {
    if (active) flush(active);
    post({ type: 'layout', patch: { widows: layout?.widows === '1' ? '' : '1' } });
  },
  'par-spacing': (factor) => wrapPara(SPACING_ENV, factor ? `\\begin{spacing}{${factor}}` : undefined, '\\end{spacing}', ['setspace']),
  'par-indent': (dir) => {
    // en una lista, la sangría es el nivel del elemento (como Tab y Mayús+Tab)
    const li = currentLi();
    if (active && li && active.el.contains(li)) {
      indentLi(li, dir === '-');
      return;
    }
    const cm = Math.max(paraIndent() + (dir === '-' ? -1 : 1), 0);
    wrapPara(INDENT_ENV, cm > 0 ? `\\begin{adjustwidth}{${cm}cm}{0cm}` : undefined, '\\end{adjustwidth}', ['changepage']);
  },
  'list-scheme': (id) => applyListScheme(id ?? 'default'),
  'list-level': (dir) => {
    const li = currentLi();
    if (active && li && active.el.contains(li)) indentLi(li, dir === '-');
  },
  'list-style': (arg) => {
    const [env, label = ''] = (arg ?? '').split('|');
    if (env === 'itemize' || env === 'enumerate') setListStyle(env, label);
  },
  brush: () => {
    if (brush) setBrush(undefined);
    else if (active) setBrush(formatAt());
  },
  find: () => (findEl.hidden ? openFind() : closeFind()),
  track: () => setTracking(!tracking),
  'chg-accept': () => settleChanges(true),
  'chg-reject': () => settleChanges(false),
  'ins-comment': () =>
    form('Comentario al margen', [{ id: 'text', label: 'Comentario', type: 'textarea', value: '' }], (v) => {
      const text = v.text.trim().replace(/\s*\n\s*/g, ' ');
      if (text) insertInline(`\\todo{${escapeText(text)}}`, `<span class="mnote">${escHtml(text)}</span>`, ['todonotes'], 'cmt');
    }),
  'blk-up': () => void moveBlocks(-1),
  'blk-down': () => void moveBlocks(1),
  'blk-dup': () => void duplicateBlocks(),
  'blk-copy': () => clipBlocks(false),
  'blk-cut': () => clipBlocks(true),
  'img-width': (v) => quickWidth(parseFloat(v ?? '') || 0),
  'img-height': (v) => {
    const f = parseFloat(v ?? '') || 0;
    // el ancho pasa a ser el proporcional: la imagen no se deforma
    sizeImage(f ? { height: fraction(f, '\\textheight'), width: '' } : { height: '' });
  },
  'img-natural': () => sizeImage({ width: '', height: '', scale: '' }),
  'img-rotate': (v) => rotateImage(parseFloat(v ?? '90') || 90),
  'img-size': () => imageSizeForm(),
  'img-align': (side) => alignImage(side === 'l' || side === 'r' ? side : 'c'),
  'img-wrap': (side) => alignImage(side === 'l' ? 'l' : 'r', true),
  'img-crop': () => cropImage(),
  'img-source': () => {
    const el = imageBlock();
    if (el) openSource(el);
  },
  'clip-copy': () => document.execCommand('copy'),
  'clip-cut': () => document.execCommand('cut'),
  'clip-paste': () => void pasteFromClipboard(),
  'style-new': () => {
    const f = formatAt();
    if (!f.molds.length) return;
    form('Nuevo estilo con el formato del cursor', [{ id: 'name', label: 'Nombre (solo letras)', value: '' }], (v) => {
      const name = v.name.trim().replace(/[^a-zA-Z]/g, '');
      if (!name || macros[`\\${name}`] !== undefined) return;
      const TAG: Record<string, string> = { B: '\\textbf{', STRONG: '\\textbf{', I: '\\textit{', EM: '\\emph{', U: '\\underline{', S: '\\sout{', STRIKE: '\\sout{', CODE: '\\texttt{', SUP: '\\textsuperscript{', SUB: '\\textsubscript{' };
      const open = f.molds.map((m) => m.getAttribute('data-o') ?? TAG[m.tagName] ?? '').join('');
      const close = f.molds.map((m) => m.getAttribute('data-c') ?? (TAG[m.tagName] ? '}' : '')).reverse().join('');
      if (active) flush(active);
      post({ type: 'preamble', lines: [...f.packages, `\\newcommand{\\${name}}[1]{${open}#1${close}}`] });
    });
  },
  'style-use': (name) => {
    if (name && /^[a-zA-Z]+$/.test(name)) wrapSelection('span', `\\${name}{`, { class: 'ustyle' });
  },
  'ins-clearpage': () => pageBreak('\\clearpage'),
  'ins-vspace': () =>
    form('Espacio vertical', [{ id: 'h', label: 'Altura (cm)', value: '1' }], (v) => {
      const h = parseFloat(v.h.replace(',', '.'));
      if (Number.isFinite(h) && h > 0 && h <= 25) insertBlock(`\\vspace{${cmText(h)}}`);
    }),
  zoom: (dir) => {
    if (dir === 'fit' || dir === 'sheet') zoom = dir;
    else if (dir === '0') zoom = 1;
    else if (dir === 'multi') zoom = multiPageZoom();
    else zoom = Math.min(2.5, Math.max(0.15, Math.round((currentZoom() + (dir === '+' ? 0.1 : -0.1)) * 20) / 20));
    applyZoom();
    rememberZoom();
  },
  view: (mode) => {
    viewMode = mode === 'flow' ? 'flow' : 'page';
    applyLayout();
    savePrefs({ view: viewMode });
  },
  tab: (id) => showTab(id ?? 'home'),
  cite: (key) => {
    if (key) insertInline(citeTex(key), `[${escHtml(key)}]`);
  },
  'add-source': () =>
    form(
      'Agregar fuente bibliográfica',
      [
        { id: 'author', label: 'Autor(es)', placeholder: 'Knuth, Donald E.' },
        { id: 'title', label: 'Título', placeholder: 'The TeXbook' },
        { id: 'year', label: 'Año', placeholder: '1984' },
        { id: 'extra', label: 'Editorial, revista o dirección web (opcional)' },
        { id: 'key', label: 'Clave para citarla (opcional)', placeholder: 'knuth1984' },
        { id: 'cite', label: 'Citarla ahora en la posición del cursor', type: 'checkbox', value: true },
      ],
      (v) => {
        if (!v.author.trim() && !v.title.trim()) return;
        // clave automática: apellido + año
        const auto = (v.author.split(/[\s,]+/)[0] + v.year).normalize('NFD').replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
        const key = v.key.trim().replace(/[^\w:.-]/g, '') || auto || `fuente${sources.length + 1}`;
        if (v.cite) insertInline(citeTex(key), `[${escHtml(key)}]`);
        if (active) flush(active);
        post({ type: 'addSource', key, author: escapeText(v.author), title: escapeText(v.title), year: v.year, extra: escapeText(v.extra) });
      },
    ),
  'add-doi': () =>
    form(
      'Fuente a partir de un DOI',
      [
        { id: 'doi', label: 'DOI o dirección del artículo', placeholder: '10.1038/nature14539' },
        { id: 'cite', label: 'Citarla ahora en la posición del cursor', type: 'checkbox', value: true },
      ],
      (v) => {
        if (!v.doi.trim()) return;
        if (active) flush(active);
        // el host pide los datos a doi.org, los añade a la bibliografía y devuelve la cita
        post({ type: 'addDoi', doi: v.doi.trim(), cite: Boolean(v.cite) });
      },
    ),
  'cite-zotero': () => {
    if (active) flush(active);
    post({ type: 'citeZotero' });
  },
  'ins-bib': () => {
    // la bibliografía es el entorno thebibliography: se va a él o, si aún no existe, se crea con la primera fuente
    const bib = root.querySelector('.bib');
    if (bib) bib.scrollIntoView({ block: 'center' });
    else run('add-source');
  },
  'ins-grid': (size) => {
    const [r, c] = (size ?? '2,2').split(',').map(Number);
    insertBlock(tableTex(r, c, true, ''));
  },
  'ins-eq': (tex) => {
    if (tex) insertBlock(`\\[\n  ${tex}\n\\]`);
  },
  'ins-tikz': (id) => {
    const t = TIKZ[id ?? ''];
    if (t) insertBlock(`\\begin{center}\n${t[1]}\n\\end{center}`, t[2]);
  },
  'ins-lof': () => insertBlock('\\listoffigures'),
  'ins-lot': () => insertBlock('\\listoftables'),
  'ins-title': () => insertBlock('\\maketitle'),
  style: (level) => setStyle(level ?? ''),
  list: (env) => toggleList(env ?? 'itemize'),
  table: (op) => tableOp(op ?? ''),
  goto: () => post({ type: 'goto', line: active ? active.rs : lastEl?._b?.s ?? 0 }),
  newdoc: (template) => post({ type: 'newDoc', template }),
  'open-root': () => post({ type: 'openFile', root: true }),
  nav: () => {
    navOpen = !navOpen;
    updateOutline();
    applyZoom();
  },
  'refs-panel': () => {
    // el panel lateral, por su cara de referencias (pulsado otra vez, lo cierra)
    if (navOpen && navMode === 'refs') run('nav');
    else setNavMode('refs');
  },
  'deck-panel': () => {
    if (navOpen && navMode === 'deck') run('nav');
    else setNavMode('deck');
  },
  present: (from) => present(from),
  git: () => toggleGit(),
  case: (mode) => changeCase(mode ?? 'upper'),
  paper: (kind) => {
    paper = kind === 'sepia' || kind === 'dark' ? kind : 'white';
    savePrefs({ paper });
    applyPaper();
  },
  pdf: () => {
    if (active) flush(active);
    post({ type: 'exportPdf' });
  },
  issues: () => toggleIssues(),
  'pdf-goto': () => {
    const a = active;
    const line = a ? a.rs : lastEl?._b?.s;
    if (line === undefined) {
      post({ type: 'info', text: 'Pon el cursor en el párrafo que quieres ver en el PDF.' });
      return;
    }
    // con el texto a cada lado del cursor, el visor señala la palabra exacta y no solo el párrafo
    const around = a ? textAroundCaret(content(a.el)) : undefined;
    // (lo último escrito tiene que llegar al documento antes de buscarlo en el PDF; puede cambiar a.re)
    if (a) flush(a);
    const end = a ? (a.re >= a.rs ? a.re : undefined) : lastEl?._b?.e;
    post({ type: 'pdfForward', line, end, before: around?.before.slice(-2000), after: around?.after.slice(0, 200) });
  },
  'ins-plot': () =>
    form(
      'Insertar gráfica',
      [
        { id: 'kind', label: 'Tipo', type: 'select', options: [['line', 'Líneas'], ['bar', 'Barras'], ['scatter', 'Puntos'], ['func', 'Función y = f(x)']], value: 'line' },
        { id: 'title', label: 'Título de la gráfica', value: '' },
        { id: 'x', label: 'Rótulo del eje X', value: 'x' },
        { id: 'y', label: 'Rótulo del eje Y', value: 'y' },
        { id: 'data', label: 'Datos: un punto por línea (x y), o la función (por ejemplo x^2)', type: 'textarea', value: '1 2\n2 4\n3 5\n4 8' },
        { id: 'caption', label: 'Pie de figura (vacío: sin figura numerada)', value: '' },
      ],
      (v) => {
        const tex = plotTex(v);
        if (tex) insertBlock(tex, ['pgfplots']);
      },
      plotPreview,
    ),
  'spell-toggle': () => post({ type: 'spellConfig', enabled: !spellInfo.enabled }),
  'spell-lang': (choice) => post({ type: 'spellConfig', enabled: true, language: choice ?? 'auto' }),
  'land-view': (view) => {
    setLandscapeView(view ?? 'edit');
    paginate();
    post({ type: 'landscapeView', value: landscapeView });
  },
  headfoot: (focus) => headFootDialog(focus === 'foot' ? 'foot' : 'head'),
  'page-number': (place) => {
    if (active) flush(active);
    post({ type: 'headfoot', spec: withPageNumber(currentHeadFoot(), (place ?? 'bottom-center') as NumberPlace, layout?.lang) });
  },
  'headfoot-clear': () => {
    if (active) flush(active);
    post({ type: 'headfoot', spec: null });
  },
  'land-pdf': () => post({ type: 'landscapePackage', pdf: !root.querySelector('.landscape[data-land="pdf"]') }),
  'ins-landscape': () =>
    insertBlock('\\begin{landscape}\nContenido de la hoja horizontal.\n\\end{landscape}', [root.querySelector('.landscape[data-land="pdf"]') ? 'pdflscape' : 'lscape']),
  'spell-next': () => nextMisspelling(),
  'to-math': () => {
    // la selección pasa a ser una fórmula en línea
    const text = selection().toString().trim();
    if (active && text) insertInline(`$${text}$`, renderMath(text, false, macros), undefined, 'math');
  },
  meta: () => openMeta(),
  start: () => {
    post({ type: 'newDoc', template: 'blank', startWriting: true });
  },
  symbol: (tex) => {
    if (tex) insertInline(`$${tex}$`, renderMath(tex, false, macros), undefined, 'math');
  },
  'ins-math': () => {
    beginModal();
    openFormula({
      title: 'Fórmula en línea', tex: '', display: false, macros, closed: endModal,
      ok: (t) => insertInline(`$${t}$`, renderMath(t, false, macros), undefined, 'math'),
    });
  },
  'ins-equation': () => {
    beginModal();
    openFormula({
      title: 'Ecuación', tex: '', display: true, macros, askNumbered: true, closed: endModal,
      ok: (t, numbered) => {
        const body = '  ' + t.replace(/\n/g, '\n  ');
        insertBlock(numbered ? `\\begin{equation}\n${body}\n\\end{equation}` : `\\[\n${body}\n\\]`);
      },
    });
  },
  'ins-align': () => insertBlock('\\begin{align}\n  a &= b + c \\\\\n  d &= e + f\n\\end{align}', ['amsmath']),
  'ins-table': () =>
    form(
      'Insertar tabla',
      [
        { id: 'rows', label: 'Filas', type: 'number', value: 3 },
        { id: 'cols', label: 'Columnas', type: 'number', value: 3 },
        { id: 'header', label: 'Primera fila como encabezado', type: 'checkbox', value: true },
        { id: 'caption', label: 'Título (opcional)', placeholder: 'Deja vacío para una tabla sin numerar' },
      ],
      (v) => {
        const rows = Math.min(Math.max(parseInt(v.rows, 10) || 2, 1), 50);
        const cols = Math.min(Math.max(parseInt(v.cols, 10) || 2, 1), 20);
        insertBlock(tableTex(rows, cols, Boolean(v.header), v.caption.trim()));
      },
    ),
  'ins-image': () => {
    if (active) flush(active);
    post({ type: 'pickImage' });
  },
  'img-change': () => {
    if (!imageBlock()) return;
    pickedImage = imageBlock();
    post({ type: 'pickImage', replace: true });
  },
  'img-copy': () => void copyImage(false),
  'img-cut': () => void copyImage(true),
  'img-delete': () => deleteBlock(imageBlock()),
  'ins-link': () =>
    form(
      'Insertar enlace',
      [
        { id: 'url', label: 'Dirección (URL)', value: 'https://' },
        { id: 'text', label: 'Texto', value: selection().toString() },
      ],
      (v) => {
        const text = v.text.trim() || v.url;
        insertInline(`\\href{${v.url.trim()}}{${escapeText(text)}}`, `<a>${escHtml(text)}</a>`, ['hyperref']);
      },
    ),
  'ins-footnote': () =>
    form('Nota al pie', [{ id: 'text', label: 'Texto de la nota', type: 'textarea' }], (v) => {
      if (v.text.trim()) insertInline(`\\footnote{${escapeText(v.text.trim())}}`, '<sup class="fn">*</sup>');
    }),
  'ins-ref': () =>
    form(
      'Referencia cruzada',
      [labels.length ? { id: 'key', label: 'Etiqueta', type: 'select', options: labels } : { id: 'key', label: 'Etiqueta' }],
      (v) => {
        if (v.key.trim()) insertInline(`\\ref{${v.key.trim()}}`, '<span class="ref">??</span>');
      },
    ),
  'ins-label': () =>
    form('Etiqueta', [{ id: 'key', label: 'Nombre de la etiqueta', placeholder: 'sec:intro' }], (v) => {
      if (v.key.trim()) insertInline(`\\label{${v.key.trim()}}`, '');
    }),
  'ins-cite': () =>
    form(
      'Cita bibliográfica',
      [
        sources.length
          ? { id: 'key', label: 'Fuente', type: 'select', options: sources.map((s) => [s.key, `${s.key} — ${s.label}`] as [string, string]) }
          : { id: 'key', label: 'Clave(s) de la referencia', placeholder: 'knuth1984' },
      ],
      (v) => {
        if (v.key.trim()) insertInline(citeTex(v.key.trim()), `[${escHtml(v.key.trim())}]`);
      },
    ),
  'ins-code': () => insertBlock('\\begin{verbatim}\ncódigo\n\\end{verbatim}'),
  'ins-quote': () => insertBlock('\\begin{quote}\n  Texto citado.\n\\end{quote}'),
  'ins-toc': () => insertBlock('\\tableofcontents'),
  'ins-newpage': () => pageBreak('\\newpage'),
  'ins-section': () => insertBlock('\\section{Título}'),
};

/**
 * Salto de página como en un procesador de textos: si el cursor está en mitad de un párrafo, el
 * párrafo se parte ahí y lo que sigue pasa a la hoja siguiente; si está al final (o no hay
 * cursor), el salto va detrás del bloque y se abre un párrafo nuevo en la hoja siguiente.
 */
/** Encabezado y pie vigentes, en código LaTeX (los que escribe el documento o los de su estilo de página). */
function currentHeadFoot(): HeadFootSpec {
  const src = furniture.src ?? { head: ['', '', ''], foot: ['', '\\thepage', ''] };
  return { head: [...src.head], foot: [...src.foot], headRule: furniture.style === 'fancy' && furniture.headRule, footRule: furniture.style === 'fancy' && furniture.footRule };
}

/** Diálogo del encabezado y el pie: tres casillas arriba y tres abajo, con una vista previa de la hoja. */
function headFootDialog(focus: 'head' | 'foot' = 'head'): void {
  if (active) flush(active);
  const cur = currentHeadFoot();
  const sides = ['izquierda', 'centro', 'derecha'];
  const cellFields = (part: 'head' | 'foot'): Parameters<typeof openForm>[1] =>
    sides.map((side, k) => ({ id: `${part}${k}`, label: `${part === 'head' ? 'Encabezado' : 'Pie'} · ${side}`, value: toFriendly(cur[part][k]), placeholder: 'Texto, {página}, {total}, {sección}…' }));
  const specOf = (v: Record<string, string>): HeadFootSpec => ({
    head: [0, 1, 2].map((k) => toTex(v[`head${k}`] ?? '')) as HeadFootSpec['head'],
    foot: [0, 1, 2].map((k) => toTex(v[`foot${k}`] ?? '')) as HeadFootSpec['foot'],
    headRule: v.headRule === '1',
    footRule: v.footRule === '1',
  });
  const fields = [
    ...cellFields('head'),
    { id: 'headRule', label: 'Raya bajo el encabezado', type: 'checkbox' as const, value: cur.headRule },
    ...cellFields('foot'),
    { id: 'footRule', label: 'Raya sobre el pie', type: 'checkbox' as const, value: cur.footRule },
  ];
  form('Encabezado y pie de página', focus === 'foot' ? [...fields.slice(4), ...fields.slice(0, 4)] : fields, (v) => post({ type: 'headfoot', spec: specOf(v) }), (v) => headFootPreview(specOf(v)));
}

function pageBreak(command: string): void {
  const a = active;
  const sel = selection();
  if (a && a.re >= a.rs && sel.rangeCount) {
    const c = content(a.el);
    if (isPlain(c) && c.contains(sel.anchorNode)) {
      const at = sel.getRangeAt(0).cloneRange();
      at.collapse(true);
      const marker = document.createElement('span');
      marker.setAttribute('data-tex', '\u0002');
      at.insertNode(marker);
      const [before, after] = serializeChildren(c).split('\u0002').map(tidy);
      marker.remove();
      if (before && after) {
        const first = a.rs + a.lead;
        commitFull(`${before}\n\n${command}\n\n${after}`, { line: first + before.split('\n').length + 3, atStart: true });
        return;
      }
    }
  }
  insertBlock(command);
  if (nextFocus) nextFocus.thenWrite = true;
}

/** Texto con las mayúsculas cambiadas; cada letra sigue ocupando un carácter (para no mover nada de sitio). */
export function recase(text: string, mode: string): string {
  const up = (ch: string): string => (ch.toLocaleUpperCase('es').length === ch.length ? ch.toLocaleUpperCase('es') : ch);
  const low = (ch: string): string => (ch.toLocaleLowerCase('es').length === ch.length ? ch.toLocaleLowerCase('es') : ch);
  const letter = /\p{L}/u;
  const chars = Array.from(text);
  if (mode === 'upper') return chars.map(up).join('');
  if (mode === 'lower') return chars.map(low).join('');
  if (mode === 'toggle') return chars.map((ch) => (up(ch) === ch ? low(ch) : up(ch))).join('');
  let out = '';
  // al principio, y tras el final de una oración (o al empezar cada palabra), toca mayúscula
  let start = true;
  for (const ch of chars) {
    if (letter.test(ch) || /\p{N}/u.test(ch)) {
      out += start ? up(ch) : low(ch);
      start = false;
    } else {
      out += ch;
      if (mode === 'title' ? /[\s\-–—/(«"“¿¡]/.test(ch) : /[.!?…¿¡\n]/.test(ch)) start = true;
    }
  }
  return out;
}

/**
 * Cambia las mayúsculas y minúsculas del texto seleccionado (como en Word); sin selección, las de
 * la palabra donde está el cursor. Cambia las letras del documento, no les pone un formato.
 */
function changeCase(mode: string): void {
  const a = active;
  const sel = selection();
  if (!a || !sel.rangeCount || !content(a.el).contains(sel.anchorNode)) {
    post({ type: 'info', text: 'Para cambiar mayúsculas y minúsculas, selecciona texto dentro de un párrafo (o pon el cursor en una palabra).' });
    return;
  }
  if (sel.isCollapsed) {
    sel.modify('move', 'backward', 'word');
    sel.modify('extend', 'forward', 'word');
  }
  const r = sel.getRangeAt(0);
  if (r.collapsed) return;
  // los trozos de texto de la selección, sin entrar en fórmulas, citas ni otras piezas que no son texto corrido
  const c = content(a.el);
  const walker = document.createTreeWalker(c, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (r.intersectsNode(n) && !(n.parentElement as Element).closest('[data-tex], [data-skip], .katex') ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT),
  });
  const parts: { node: Text; from: number; to: number }[] = [];
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    const from = n === r.startContainer ? r.startOffset : 0;
    const to = n === r.endContainer ? r.endOffset : n.data.length;
    if (to > from) parts.push({ node: n, from, to });
  }
  if (!parts.length) return;
  // se transforma todo junto (una palabra puede ir repartida en varios trozos) y se devuelve a cada uno lo suyo
  const before = parts.map((p) => p.node.data.slice(p.from, p.to)).join('');
  const after = recase(before, mode);
  if (after === before || after.length !== before.length) return;
  const first = { node: r.startContainer, offset: r.startOffset };
  const last = { node: r.endContainer, offset: r.endOffset };
  let at = 0;
  for (const p of parts) {
    const n = p.to - p.from;
    p.node.data = p.node.data.slice(0, p.from) + after.slice(at, at + n) + p.node.data.slice(p.to);
    at += n;
  }
  // la selección se queda donde estaba, para poder probar otra opción seguida
  const keep = document.createRange();
  keep.setStart(first.node, first.offset);
  keep.setEnd(last.node, last.offset);
  sel.removeAllRanges();
  sel.addRange(keep);
  markDirty(true);
}

/** Órdenes que no cambian el documento: las únicas que valen en una versión de solo lectura. */
const VIEW_COMMANDS = new Set(['nav', 'git', 'view', 'zoom', 'spell-next', 'find', 'tab', 'issues', 'pdf', 'paper', 'pdf-goto', 'ribbon-min', 'refs-panel']);

function run(cmd: string, arg?: string): void {
  if (readOnly && !VIEW_COMMANDS.has(cmd)) return;
  COMMANDS[cmd]?.(arg);
}

function onImagePicked(path: string): void {
  form(
    'Insertar imagen',
    [
      { id: 'path', label: 'Archivo', value: path },
      { id: 'width', label: 'Ancho (% del texto)', type: 'number', value: 60 },
      { id: 'caption', label: 'Pie de figura', value: '' },
    ],
    (v) => {
      const w = Math.min(Math.max(parseInt(v.width, 10) || 60, 5), 100) / 100;
      const cap = v.caption.trim() ? `\n  \\caption{${escapeText(v.caption.trim())}}` : '';
      insertBlock(
        `\\begin{figure}[h]\n  \\centering\n  \\includegraphics[width=${w}\\textwidth]{${v.path.trim()}}${cap}\n\\end{figure}`,
        ['graphicx'],
      );
    },
  );
}

// ------------------------------------------------------------------ barra de herramientas

/** Píxeles de la hoja por punto tipográfico de LaTeX. */
const pxPerPt = (): number => 0.03515 * PX_PER_CM;
let recentColors: string[] = (prefs.colors ?? []).filter((c) => /^[0-9A-F]{6}$/.test(c));

/** Últimos colores usados, al pie de la paleta. */
function showRecentColors(): void {
  const box = toolbar.querySelector<HTMLElement>('#pal-recent');
  if (!box) return;
  box.innerHTML = recentColors.map((c) => `<button data-cmd="color" data-arg="${c}" title="#${c}" class="swatch" style="background:#${c}"></button>`).join('');
  (box.previousElementSibling as HTMLElement).hidden = box.hidden = recentColors.length === 0;
}

function applyColor(v: string | undefined): void {
  const c = colorOf(v);
  if (!c) return;
  wrapSelection('span', c.open, { style: `color:${c.css}` }, ['xcolor']);
  if (!c.hex) return;
  recentColors = [c.hex, ...recentColors.filter((x) => x !== c.hex)].slice(0, 10);
  savePrefs({ colors: recentColors });
  showRecentColors();
}

// ---- la cinta se puede minimizar, como en Word: quedan solo las pestañas y al pulsar una se despliega un momento
let ribbonMin = Boolean(prefs.ribbonMin);

function setRibbonMin(on: boolean, save = true): void {
  ribbonMin = on;
  toolbar.classList.toggle('min', on);
  toolbar.classList.remove('peek');
  if (save) savePrefs({ ribbonMin: on });
  const b = toolbar.querySelector<HTMLElement>('.rb-min');
  if (b) b.title = on ? 'Mostrar siempre la cinta (Ctrl+F1, o doble clic en una pestaña)' : 'Minimizar la cinta: dejar solo las pestañas (Ctrl+F1, o doble clic en una pestaña)';
  fitRibbon();
}

/** Plantillas de dibujo TikZ: [nombre, código, paquetes]. */
const TIKZ: Record<string, [string, string, string[]]> = {
  flow: [
    'Diagrama de cajas y flechas',
    '\\begin{tikzpicture}\n  \\node[draw, rounded corners] (a) at (0,0) {Inicio};\n  \\node[draw, rounded corners] (b) at (4,0) {Fin};\n  \\draw[->, thick] (a) -- node[above] {paso} (b);\n\\end{tikzpicture}',
    ['tikz'],
  ],
  plot: [
    'Gráfica de una función',
    '\\begin{tikzpicture}\n  \\begin{axis}[xlabel=$x$, ylabel=$y$, grid=major]\n    \\addplot[blue, thick, domain=-3:3, samples=60]{x^2};\n  \\end{axis}\n\\end{tikzpicture}',
    ['tikz', 'pgfplots'],
  ],
  axes: [
    'Ejes con un punto',
    '\\begin{tikzpicture}\n  \\draw[->] (-0.5,0) -- (4,0) node[right] {$x$};\n  \\draw[->] (0,-0.5) -- (0,3) node[above] {$y$};\n  \\fill (2,1.5) circle (2pt) node[above right] {$P$};\n\\end{tikzpicture}',
    ['tikz'],
  ],
  triangle: [
    'Triángulo rectángulo',
    '\\begin{tikzpicture}\n  \\draw[thick] (0,0) -- node[below] {$a$} (4,0) -- node[right] {$b$} (4,3) -- node[above left] {$c$} cycle;\n  \\draw (3.7,0) -- (3.7,0.3) -- (4,0.3);\n\\end{tikzpicture}',
    ['tikz'],
  ],
};

const ic = (name: string): string => `<i class="codicon codicon-${name}"></i>`;

function buildToolbar(): void {
  const btn = (cmd: string, label: string, title: string, arg = '', cls = ''): string =>
    `<button data-cmd="${cmd}" data-arg="${escHtml(arg)}" title="${escHtml(title)}" class="${cls}">${label}</button>`;
  const big = (cmd: string, icon: string, label: string, title: string, arg = ''): string =>
    btn(cmd, `${ic(icon)}<span>${label}</span>`, title, arg, 'big');
  const menu = (id: string, face: string, title: string, items: string, cls = 'big'): string =>
    `<div class="dd" id="${id}"><button class="dd-btn ${cls}" title="${escHtml(title)}">${face}</button><div class="menu">${items}</div></div>`;
  const bigMenu = (id: string, icon: string, label: string, title: string, items: string): string =>
    menu(id, `${ic(icon)}<span>${label} ▾</span>`, title, items);
  const group = (label: string, body: string): string =>
    `<div class="group"><div class="group-body">${body}</div><div class="group-label">${label}</div></div>`;
  const rows = (...r: string[]): string => `<div class="rows">${r.map((x) => `<div class="row">${x}</div>`).join('')}</div>`;
  const layoutMenu = (key: string, icon: string, label: string, title: string): string =>
    bigMenu(
      `dd-${key}`, icon, label, title,
      LAYOUT_MENUS[key].map(([v, t]) => btn('layout', `<span class="tick"></span>${t}`, t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(), `${key}=${v}`, 'mi')).join(''),
    );

  const symbols = PALETTE.filter((g) => !['Estructuras', 'Matrices', 'Acentos', 'Funciones'].includes(g.name))
    .map(
      (g) =>
        `<div class="menu-title">${g.name}</div><div class="sym-grid">${g.items
          .map(([shown, t, name]) => btn('symbol', renderMath(shown, false, {}), name ? `${name.split(' ')[0]}  ${t}` : t, t))
          .join('')}</div>`,
    )
    .join('');
  const gallery = GALLERY.map(([name, tex]) => btn('ins-eq', `<span class="eq-name">${name}</span>${renderMath(`\\displaystyle ${tex}`, false, {})}`, name, tex, 'eq')).join('');
  let cells = '';
  for (let r = 1; r <= 8; r++) for (let c = 1; c <= 8; c++) cells += `<span data-r="${r}" data-c="${c}"></span>`;

  // cuadro desplegable que muestra el valor vigente, como los de fuente y tamaño de un procesador de textos
  const combo = (id: string, title: string, items: string): string =>
    `<div class="dd combo" id="${id}"><button class="dd-btn" title="${escHtml(title)}"><span class="combo-val"></span>${ic('chevron-down')}</button><div class="menu">${items}</div></div>`;
  const scope = '<div class="menu-hint"></div>';
  const home =
    group(
      'Fuente',
      rows(
        combo(
          'dd-font', 'Fuente: tipo de letra del texto seleccionado o, sin selección, de todo el documento',
          scope +
            // cada tipo de letra, escrito con su propia fuente
            Object.entries(FONTS)
              .map(([key, f]) => btn('font', `<span class="tick"></span><span class="font-sample" style="font-family:${f.css}">${f.name}</span>`, f.name, key, 'mi'))
              .join('') +
            '<hr><div class="menu-title">Solo en la selección</div>' +
            btn('wrap', '<span class="tick"></span><span class="rm">Con remates (romana)</span>', 'Letra con remates', 'rm', 'mi') +
            btn('wrap', '<span class="tick"></span><span class="sf">Sin remates (palo seco)</span>', 'Letra sin remates', 'sf', 'mi') +
            btn('code', '<span class="tick"></span><code>Monoespaciada</code>', 'Letra de máquina de escribir', '', 'mi'),
        ) +
          combo(
            'dd-fsize', 'Tamaño de letra, en puntos: del texto seleccionado o, sin selección, de todo el documento',
            scope + FONT_SIZES.map((n) => btn('fsize', `<span class="tick"></span>${n}`, `${n} puntos`, String(n), 'mi')).join(''),
          ) +
          btn('fsize-step', '<span class="fs-step">A<i>▴</i></span>', 'Agrandar la letra', '1') +
          btn('fsize-step', '<span class="fs-step sm">A<i>▾</i></span>', 'Reducir la letra', '-1') +
          menu(
            'dd-case', 'Aa ▾', 'Cambiar mayúsculas y minúsculas del texto seleccionado (o de la palabra donde está el cursor)',
            btn('case', 'MAYÚSCULAS', 'Todo en mayúsculas', 'upper', 'mi') +
              btn('case', 'minúsculas', 'Todo en minúsculas', 'lower', 'mi') +
              btn('case', 'Tipo oración.', 'Mayúscula solo al empezar cada oración', 'sentence', 'mi') +
              btn('case', 'Cada Palabra En Mayúscula', 'Mayúscula inicial en cada palabra', 'title', 'mi') +
              btn('case', 'aLTERNAR', 'Cambia cada letra: las mayúsculas pasan a minúsculas y al revés', 'toggle', 'mi'),
            'sm',
          ) +
          menu(
            'dd-color', `${ic('symbol-color')} ▾`, 'Color del texto seleccionado',
            (() => {
              const sw = ([hex, name]: [string, string]): string => btn('color', '', `${name} (#${hex})`, hex, `swatch" style="background:#${hex}`);
              return (
                '<div class="cpal">' +
                btn('color', '<span class="swatch" style="background:#000"></span>Automático (negro)', 'El color normal del texto', '000000', 'mi') +
                `<div class="cpal-title">Colores del tema</div><div class="cpal-grid">${THEME_COLORS.map(sw).join('')}</div>` +
                `<div class="cpal-grid tones">${themeTones().map((row) => row.map(sw).join('')).join('')}</div>` +
                `<div class="cpal-title">Colores estándar</div><div class="cpal-grid">${STANDARD_COLORS.map(sw).join('')}</div>` +
                '<div class="cpal-title" hidden>Colores recientes</div><div class="cpal-grid" id="pal-recent" hidden></div>' +
                '<hr>' + btn('color-more', `${ic('symbol-color')} Más colores…`, 'Elegir cualquier color, o escribir su código', '', 'mi') +
                '</div>'
              );
            })(),
            'sm',
          ),
        btn('bold', ic('bold'), 'Negrita (Ctrl+B)') +
          btn('italic', ic('italic'), 'Cursiva (Ctrl+I)') +
          btn('underline', '<u>S</u>', 'Subrayado (Ctrl+U)') +
          btn('wrap', ic('strikethrough'), 'Tachado', 'strike') +
          btn('wrap', 'x<sup>2</sup>', 'Superíndice', 'sup') +
          btn('wrap', 'x<sub>2</sub>', 'Subíndice', 'sub') +
          btn('code', ic('code'), 'Monoespaciado (código)') +
          btn('wrap', '<span class="sc">Aa</span>', 'Versalitas', 'sc') +
          btn('wrap', '<em>énf</em>', 'Énfasis', 'emph') +
          btn('brush', ic('paintcan'), 'Copiar formato: recoge el formato del texto donde está el cursor y se lo da a lo siguiente que selecciones'),
      ),
    ) +
    group(
      'Párrafo',
      rows(
        btn('list', ic('list-unordered'), 'Lista con viñetas', 'itemize') +
          btn('list', ic('list-ordered'), 'Lista numerada', 'enumerate') +
          menu(
            'dd-bullets', '▾', 'Viñetas y numeración: el símbolo o el formato de los números de cada nivel, y listas multinivel',
            '<div class="menu-title list-level-title">Viñetas</div><div class="bullet-grid">' +
              LIST_STYLES.filter(([env]) => env === 'itemize').map(([env, label, sample]) => btn('list-style', sample, `Viñeta ${sample}`, `${env}|${label}`)).join('') +
              '</div><div class="menu-title">Numeración</div><div class="bullet-grid">' +
              LIST_STYLES.filter(([env]) => env === 'enumerate').map(([env, label, sample]) => btn('list-style', sample, `Numeración ${sample}`, `${env}|${label}`)).join('') +
              '</div><div class="menu-title">Lista multinivel: todos los niveles a la vez</div><div class="scheme-grid">' +
              LIST_SCHEMES.map(([id, name, , , sample]) =>
                btn('list-scheme', `<span class="ml">${sample.slice(0, 3).map((m, k) => `<span style="padding-left:${k * 12}px"><b>${escHtml(m)}</b><i></i></span>`).join('')}</span><small>${escHtml(name)}</small>`, `${name}: ${sample.join(' ')}`, id),
              ).join('') +
              '</div><div class="menu-title">Nivel</div>' +
              btn('list-level', `${ic('arrow-right')}<span class="mi-text"><b>Bajar un nivel</b><small>Tab</small></span>`, 'Bajar un nivel', '+', 'mi') +
              btn('list-level', `${ic('arrow-left')}<span class="mi-text"><b>Subir un nivel</b><small>Mayús+Tab</small></span>`, 'Subir un nivel', '-', 'mi'),
            'sm',
          ) +
          btn('par-indent', '<span class="ind">⇤</span>', 'Reducir la sangría del párrafo', '-') +
          btn('par-indent', '<span class="ind">⇥</span>', 'Aumentar la sangría del párrafo', '+'),
        btn('align', '<span class="al al-l"></span>', 'Alinear a la izquierda', 'flushleft') +
          btn('align', '<span class="al al-c"></span>', 'Centrar', 'center') +
          btn('align', '<span class="al al-r"></span>', 'Alinear a la derecha', 'flushright') +
          btn('align', '<span class="al al-j"></span>', 'Justificar (normal)', '') +
          menu(
            'dd-parspace', `${ic('unfold')}`, 'Interlineado de este párrafo (o de los seleccionados)',
            PAR_SPACING.map(([f, name]) => btn('par-spacing', name, `Interlineado ${name.toLowerCase()}`, f, 'mi')).join('') +
              '<hr>' + btn('par-spacing', 'El del documento', 'Quitar el interlineado propio de este párrafo', '', 'mi'),
            'sm',
          ),
      ),
    ) +
    group(
      'Estilos',
      `<div class="styles">${STYLES.map(([lvl, name, tag]) => btn('style', `<${tag}>${name}</${tag}>`, name, lvl, `style s-${lvl || 'normal'}`)).join('')}</div>` +
        // la misma lista como menú, para cuando la galería no cabe
        bigMenu(
          'dd-styles', 'symbol-text', 'Estilos', 'Estilos de párrafo y estilos propios del documento',
          '<div class="menu-title">Párrafo</div>' +
            STYLES.map(([lvl, name]) => btn('style', `<span class="tick"></span>${name}`, name, lvl, 'mi')).join('') +
            '<hr><div class="menu-title">Estilos del documento</div><div id="ustyle-list"></div>' +
            btn('style-new', `${ic('add')} Crear un estilo con el formato del cursor…`, 'Guarda como estilo (una orden nueva en el preámbulo) el formato del texto donde está el cursor', '', 'mi'),
        ),
    ) +
    group('Ecuación', big('ins-equation', 'symbol-operator', 'Ecuación', 'Abrir el editor de ecuaciones'));

  const insert =
    group('Páginas', big('ins-title', 'file-text', 'Portada', 'Bloque de título (\\maketitle)') + big('ins-newpage', 'fold-down', 'Salto', 'Salto de página')) +
    group(
      'Encabezado y pie',
      big('headfoot', 'layout-menubar', 'Encabezado', 'Escribir el encabezado de las páginas (también con doble clic en el margen de arriba)', 'head') +
        big('headfoot', 'layout-statusbar', 'Pie', 'Escribir el pie de las páginas (también con doble clic en el margen de abajo)', 'foot') +
        bigMenu(
          'dd-pagenum', 'symbol-numeric', 'Número', 'Número de página: dónde va',
          btn('page-number', `${ic('arrow-down')}<span class="mi-text"><b>Abajo, centrado</b><small>Como lo pone LaTeX por defecto</small></span>`, 'Número abajo, centrado', 'bottom-center', 'mi') +
            btn('page-number', `${ic('arrow-down')}<span class="mi-text"><b>Abajo, a la derecha</b></span>`, 'Número abajo, a la derecha', 'bottom-right', 'mi') +
            btn('page-number', `${ic('arrow-up')}<span class="mi-text"><b>Arriba, a la derecha</b></span>`, 'Número arriba, a la derecha', 'top-right', 'mi') +
            btn('page-number', `${ic('symbol-numeric')}<span class="mi-text"><b>Página 3 de 12</b><small>Abajo, centrado, con el total (paquete lastpage)</small></span>`, 'Página X de Y', 'page-of', 'mi') +
            btn('page-number', `${ic('circle-slash')}<span class="mi-text"><b>Sin número</b></span>`, 'Sin número de página', 'none', 'mi') +
            '<hr>' +
            btn('headfoot-clear', `${ic('discard')}<span class="mi-text"><b>Quitar encabezado y pie propios</b><small>Vuelve el de la clase: solo el número, abajo y centrado</small></span>`, 'Quitar encabezado y pie propios', '', 'mi'),
        ),
    ) +
    group(
      'Tablas',
      bigMenu(
        'dd-table', 'table', 'Tabla', 'Insertar una tabla',
        `<div class="menu-title" id="grid-label">Insertar tabla</div><div class="grid-pick">${cells}</div><hr>` + btn('ins-table', 'Insertar tabla con título…', 'Elegir filas, columnas y título', '', 'mi'),
      ),
    ) +
    group(
      'Ilustraciones',
      big('ins-image', 'file-media', 'Imagen', 'Insertar una imagen desde un archivo') +
        big('ins-plot', 'graph', 'Gráfica', 'Crear una gráfica a partir de datos o de una función') +
        bigMenu('dd-tikz', 'graph-line', 'Dibujo', 'Insertar un dibujo o gráfica TikZ', Object.entries(TIKZ).map(([id, [name]]) => btn('ins-tikz', name, name, id, 'mi')).join('')),
    ) +
    group('Vínculos', big('ins-link', 'link', 'Enlace', 'Insertar un enlace') + big('ins-ref', 'references', 'Referencia', 'Referencia cruzada a una etiqueta')) +
    group('Texto', big('ins-quote', 'quote', 'Cita', 'Cita textual') + big('ins-code', 'code', 'Código', 'Bloque de código') + big('ins-footnote', 'note', 'Nota', 'Nota al pie')) +
    group(
      'Símbolos',
      bigMenu(
        'dd-eq', 'symbol-operator', 'Ecuación', 'Insertar una ecuación',
        btn('ins-equation', `${ic('add')} Nueva ecuación…`, 'Editor de ecuaciones', '', 'mi') +
          btn('ins-math', `${ic('add')} Fórmula en línea…  ($)`, 'Fórmula dentro del texto', '', 'mi') +
          btn('ins-align', `${ic('add')} Ecuaciones alineadas`, 'Varias ecuaciones alineadas por el signo =', '', 'mi') +
          `<hr><div class="menu-title">Ecuaciones habituales</div>${gallery}`,
      ) + bigMenu('dd-sym', 'symbol-misc', 'Símbolo', 'Insertar un símbolo', symbols),
    );

  const layout =
    group(
      'Configurar página',
      layoutMenu('margins', 'screen-full', 'Márgenes', 'Márgenes de la página') +
        bigMenu(
          'dd-orientation', 'file', 'Orientación', 'Orientación de la página',
          LAYOUT_MENUS.orientation.map(([v, t]) => btn('layout', `<span class="tick"></span>${t}`, t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(), `orientation=${v}`, 'mi')).join('') +
            '<hr>' +
            btn('ins-landscape', `<span class="tick"></span>${sheetThumb(29.7, 21, undefined, 1)}<span class="mi-text"><b>Insertar hoja horizontal</b><small>Una hoja apaisada en medio del documento (lscape)</small></span>`, 'Insertar hoja horizontal', '', 'mi') +
            '<div class="menu-title">Ver las hojas horizontales</div>' +
            LANDSCAPE_MENU.map(([v, t]) => btn('land-view', `<span class="tick"></span>${t}`, t.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim(), v, 'mi')).join('') +
            '<hr>' +
            btn('land-pdf', `<span class="tick"></span>${ic('file-pdf')}<span class="mi-text"><b>Apaisadas también en el visor de PDF</b><small>Usa pdflscape: al imprimir sale igual, pero el visor la muestra horizontal</small></span>`, 'Apaisadas también en el visor de PDF', '', 'mi'),
        ) +
        layoutMenu('paper', 'files', 'Tamaño', 'Tamaño del papel') +
        layoutMenu('columns', 'split-horizontal', 'Columnas', 'Número de columnas') +
        bigMenu(
          'dd-breaks', 'fold-down', 'Saltos', 'Saltos de página y espacio vertical',
          btn('ins-newpage', `${ic('fold-down')}<span class="mi-text"><b>Página</b><small>El texto sigue en la hoja siguiente · Ctrl+Enter</small></span>`, 'Salto de página', '', 'mi') +
            btn('ins-clearpage', `${ic('fold-down')}<span class="mi-text"><b>Página, vaciando figuras</b><small>Coloca antes las figuras y tablas pendientes</small></span>`, 'Salto con \\clearpage', '', 'mi') +
            '<hr>' +
            btn('ins-vspace', `${ic('arrow-both')}<span class="mi-text"><b>Espacio vertical…</b><small>Deja un hueco de la altura que indiques</small></span>`, 'Espacio vertical', '', 'mi'),
        ),
    ) +
    group(
      'Texto',
      layoutMenu('spacing', 'word-wrap', 'Interlineado', 'Espacio entre líneas') +
        big('widows', 'fold', 'Viudas', 'Control de líneas viudas y huérfanas: no deja una línea suelta de un párrafo al pie o al principio de una hoja'),
    ) +
    group(
      'Documento',
      layoutMenu('cls', 'book', 'Tipo', 'Clase de documento') + layoutMenu('lang', 'globe', 'Idioma', 'Idioma del documento') + big('meta', 'edit', 'Título', 'Título, autor y fecha'),
    );

  const refs =
    group(
      'Tabla de contenido',
      big('ins-toc', 'list-tree', 'Índice', 'Tabla de contenido') + big('ins-lof', 'file-media', 'Figuras', 'Índice de figuras') + big('ins-lot', 'table', 'Tablas', 'Índice de tablas'),
    ) +
    group('Notas al pie', big('ins-footnote', 'note', 'Insertar nota', 'Nota al pie')) +
    group(
      'Citas y bibliografía',
      bigMenu(
        'dd-cite', 'quote', 'Insertar cita', 'Citar una fuente',
        '<div id="cite-list"></div><hr>' +
          btn('add-source', `${ic('add')} Agregar nueva fuente…`, 'Añadir una fuente a la bibliografía', '', 'mi') +
          btn('add-doi', `${ic('link-external')} Fuente a partir de un DOI…`, 'Traer los datos de un artículo por su DOI', '', 'mi') +
          btn('cite-zotero', `${ic('folder-library')} Elegir en Zotero…`, 'Abrir el selector de citas de Zotero', '', 'mi'),
      ) +
        big('refs-panel', 'list-unordered', 'Gestionar', 'Panel de referencias: ver todas las fuentes, cuántas veces se citan, editarlas, quitarlas y añadir otras') +
        big('add-source', 'library', 'Fuentes', 'Agregar una fuente bibliográfica') +
        big('add-doi', 'link-external', 'DOI', 'Añadir una fuente a partir de su DOI: los datos se traen de doi.org') +
        big('cite-zotero', 'folder-library', 'Zotero', 'Elegir referencias en Zotero (complemento Better BibTeX) y citarlas') +
        big('ins-bib', 'book', 'Bibliografía', 'Insertar la lista de referencias'),
    ) +
    group('Títulos', big('ins-ref', 'references', 'Referencia', 'Referencia cruzada') + big('ins-label', 'tag', 'Etiqueta', 'Marcar este punto para poder referenciarlo'));

  const review =
    group('Edición', big('find', 'search', 'Buscar', 'Buscar y reemplazar (Ctrl+H)')) +
    group(
      'Cambios',
      big('track', 'diff', 'Control', 'Control de cambios: lo que se escribe y lo que se borra queda marcado hasta que se acepte o se rechace') +
        big('chg-accept', 'check', 'Aceptar', 'Aceptar todos los cambios marcados') +
        big('chg-reject', 'close', 'Rechazar', 'Rechazar todos los cambios marcados'),
    ) +
    group('Comentarios', big('ins-comment', 'comment', 'Comentario', 'Comentario al margen, donde está el cursor')) +
    group(
    'Ortografía',
    big('spell-toggle', 'check-all', 'Ortografía', 'Subrayar las palabras que no están en el diccionario') +
      big('spell-next', 'arrow-down', 'Siguiente', 'Ir a la siguiente palabra sin reconocer') +
      bigMenu('dd-spell', 'globe', 'Idioma', 'Idioma del corrector', SPELL_CHOICES.map(([v, t]) => btn('spell-lang', `<span class="tick"></span>${t}`, t, v, 'mi')).join('')),
  );

  const view =
    group('Vistas', big('view', 'file', 'Página', 'Ver el documento en hojas, como al imprimir', 'page') + big('view', 'list-flat', 'Continua', 'Texto continuo con los colores del editor', 'flow')) +
    group(
      'Zoom',
      big('zoom', 'zoom-out', 'Alejar', 'Reducir', '-') +
        big('zoom', 'screen-normal', '100 %', 'Tamaño real', '0') +
        big('zoom', 'zoom-in', 'Acercar', 'Ampliar', '+') +
        big('zoom', 'arrow-both', 'Ajustar', 'Ajuste automático: la hoja entera si cabe a buen tamaño; si no, el ancho del texto', 'fit') +
        big('zoom', 'file', 'Hoja', 'Ver siempre la hoja completa, con sus márgenes', 'sheet') +
        big('zoom', 'split-horizontal', 'Varias', 'Varias páginas: las hojas, una al lado de otra (también al alejar el zoom)', 'multi'),
    ) +
    group(
      'Papel',
      big('paper', 'circle-large', 'Blanco', 'Hoja blanca, como al imprimir', 'white') +
        big('paper', 'coffee', 'Sepia', 'Papel cálido, más descansado para leer', 'sepia') +
        big('paper', 'color-mode', 'Oscuro', 'Hoja oscura para escribir de noche (el documento no cambia)', 'dark'),
    ) +
    group(
      'Presentación',
      big('present', 'play', 'Presentar', 'Proyectar en 16:9 los apartados elegidos, como diapositivas hechas solas a partir del documento') +
        big('deck-panel', 'checklist', 'Elegir', 'Elegir en el panel lateral qué apartados entran en la presentación y qué llevan'),
    ) +
    group('Código',big('goto', 'go-to-file', 'Ver código', 'Ir a esta línea en el editor de código'));

  const table =
    group('Filas y columnas', big('table', 'add', 'Fila', 'Añadir fila debajo', 'row+') + big('table', 'add', 'Columna', 'Añadir columna a la derecha', 'col+')) +
    group('Eliminar', big('table', 'trash', 'Fila', 'Eliminar la fila', 'row-') + big('table', 'trash', 'Columna', 'Eliminar la columna', 'col-')) +
    group('Ordenar', big('table', 'arrow-up', 'A → Z', 'Ordenar las filas por esta columna, de menor a mayor (la primera fila es el encabezado)', 'sort-asc') + big('table', 'arrow-down', 'Z → A', 'Ordenar las filas por esta columna, de mayor a menor', 'sort-desc')) +
    group(
      'Alinear columna',
      rows(
        btn('table', '<span class="al al-l"></span>', 'Columna alineada a la izquierda', 'align-l') +
          btn('table', '<span class="al al-c"></span>', 'Columna centrada', 'align-c') +
          btn('table', '<span class="al al-r"></span>', 'Columna alineada a la derecha', 'align-r'),
      ),
    ) +
    group(
      'Combinar',
      big('table', 'arrow-right', 'Derecha', 'Combinar la celda con la de su derecha', 'merge-r') +
        big('table', 'arrow-down', 'Abajo', 'Combinar la celda con la de debajo', 'merge-d') +
        big('table', 'split-horizontal', 'Dividir', 'Deshacer la combinación de la celda', 'split'),
    ) +
    group(
      'Estilo',
      bigMenu(
        'dd-tstyle', 'symbol-color', 'Estilos', 'Estilo de la tabla: líneas, bordes y sombreado',
        TABLE_STYLES.map((s) => btn('table', `${tableThumb(s)}<span class="mi-text"><b>${s.name}</b><small>${s.about}</small></span>`, s.name, `style-${s.id}`, 'mi')).join(''),
      ) + big('table', 'table', 'Bordes', 'Poner o quitar todos los bordes', 'borders'),
    );

  // pestaña de imagen: aparece al hacer clic en una imagen
  const image =
    group(
      'Posición',
      big('img-align', 'arrow-left', 'Izquierda', 'Imagen a la izquierda', 'l') +
        big('img-align', 'layout-centered', 'Centro', 'Imagen centrada', 'c') +
        big('img-align', 'arrow-right', 'Derecha', 'Imagen a la derecha', 'r'),
    ) +
    group(
      'Ajuste del texto',
      big('img-wrap', 'layout-sidebar-left', 'Izq.', 'La imagen a la izquierda y el texto rodeándola', 'l') +
        big('img-wrap', 'layout-sidebar-right', 'Der.', 'La imagen a la derecha y el texto rodeándola', 'r'),
    ) +
    group(
      'Tamaño',
      bigMenu(
        'dd-imgw', 'arrow-both', 'Ancho', 'Ancho de la imagen; el alto se ajusta solo, sin deformarla',
        [25, 33, 50, 66, 75, 100].map((p) => btn('img-width', `${p} % del ancho del texto`, `La imagen ocupa el ${p} % del ancho del texto`, String(p / 100), 'mi')).join('') +
          '<hr>' + btn('img-width', 'Sin ancho fijo', 'Quitar el ancho: lo decide el alto o el tamaño original', '', 'mi'),
      ) +
        bigMenu(
          'dd-imgh', 'unfold', 'Alto', 'Alto de la imagen; el ancho se ajusta solo, sin deformarla',
          [10, 20, 25, 33, 50, 75].map((p) => btn('img-height', `${p} % del alto del texto`, `La imagen ocupa el ${p} % del alto de la hoja escrita`, String(p / 100), 'mi')).join('') +
            '<hr>' + btn('img-height', 'Sin alto fijo', 'Quitar el alto: lo decide el ancho o el tamaño original', '', 'mi'),
        ) +
        big('img-size', 'symbol-ruler', 'Medidas', 'Ancho y alto exactos (cm, mm, %…), escala y giro') +
        big('img-natural', 'screen-full', 'Original', 'Tamaño original de la imagen: sin ancho, alto ni escala') +
        big('img-rotate', 'refresh', 'Girar', 'Girar la imagen 90°', '90') +
        big('img-crop', 'screen-normal', 'Recortar', 'Recortar la imagen por sus lados'),
    ) +
    group(
      'Imagen',
      big('img-copy', 'copy', 'Copiar', 'Copiar la imagen al portapapeles') +
        big('img-change', 'file-media', 'Cambiar', 'Sustituir la imagen por otro archivo, con el mismo tamaño y pie') +
        big('img-delete', 'trash', 'Eliminar', 'Quitar la imagen del documento'),
    );

  const tabs: [string, string, string][] = [
    ['home', 'Inicio', home], ['insert', 'Insertar', insert], ['layout', 'Disposición', layout],
    ['refs', 'Referencias', refs], ['review', 'Revisar', review], ['view', 'Vista', view], ['table', 'Tabla', table], ['image', 'Imagen', image],
  ];
  toolbar.innerHTML =
    `<div class="tabs"><span class="quick">${btn('save', ic('save'), 'Guardar (Ctrl+S)')}${btn('undo', ic('discard'), 'Deshacer (Ctrl+Z)')}${btn('redo', ic('redo'), 'Rehacer (Ctrl+Y)')}${btn('pdf', ic('file-pdf'), 'Exportar a PDF (compila con el LaTeX instalado) y verlo al lado')}${btn('pdf-goto', ic('target'), 'Ver en el PDF el párrafo donde está el cursor (en el PDF, doble clic vuelve al párrafo)')}</span>` +
    tabs.map(([id, name]) => `<button class="tab${id === 'table' ? ' ctx' : id === 'image' ? ' ctx-img' : ''}" data-tab="${id}">${name}</button>`).join('') +
    '</div>' +
    // (fuera de la fila de pestañas, que se desplaza: así nunca tapa ninguna)
    `<button class="rb-min" data-cmd="ribbon-min">${ic('chevron-up')}</button>` +
    tabs.map(([id, , body]) => `<div class="panel" data-panel="${id}">${body}</div>`).join('') +
    `<button class="rb-more" data-scroll="-1" title="Ver los botones anteriores" hidden>${ic('chevron-left')}</button>` +
    `<button class="rb-more" data-scroll="1" title="Ver más botones" hidden>${ic('chevron-right')}</button>`;
  showTab('home');
  showRecentColors();
  setRibbonMin(ribbonMin, false);
}

/** Preferencias cambiadas en otro editor de Mars: se aplican aquí también, sin volver a guardarlas. */
function applyPrefs(p: Prefs): void {
  if (p.paper && p.paper !== paper) {
    paper = p.paper === 'sepia' || p.paper === 'dark' ? p.paper : 'white';
    applyPaper();
  }
  if (p.colors && p.colors.join() !== recentColors.join()) {
    recentColors = p.colors.filter((c) => /^[0-9A-F]{6}$/.test(c));
    showRecentColors();
  }
  if (p.ribbonMin !== undefined && p.ribbonMin !== ribbonMin) setRibbonMin(p.ribbonMin, false);
  if (p.view && p.view !== viewMode) {
    viewMode = p.view === 'flow' ? 'flow' : 'page';
    applyLayout();
  }
  if (p.zoom !== undefined && p.zoom !== zoom && (p.zoom === 'fit' || p.zoom === 'sheet' || (typeof p.zoom === 'number' && p.zoom >= 0.15 && p.zoom <= 2.5))) {
    zoom = p.zoom;
    applyZoom();
  }
  if (p.deck && JSON.stringify(p.deck) !== JSON.stringify(deckOpts)) {
    deckOpts = { ...DECK_DEFAULTS, ...p.deck };
    if (navOpen && navMode === 'deck') updateOutline();
  }
}

let currentTab = 'home';

function showTab(id: string): void {
  applyPaper();
  currentTab = id;
  toolbar.querySelectorAll<HTMLElement>('.tab').forEach((t) => t.classList.toggle('on', t.dataset.tab === id));
  toolbar.querySelectorAll<HTMLElement>('.panel').forEach((p) => p.classList.toggle('on', p.dataset.panel === id));
  fitRibbon();
}

function closeMenus(): void {
  toolbar.querySelectorAll('.dd.open').forEach((d) => d.classList.remove('open'));
}

function updateToolbar(): void {
  if (!toolbar.firstChild) return;
  const level = active ? content(active.el).querySelector(':scope > [data-k="head"]')?.getAttribute('data-level') ?? '' : '';
  toolbar.querySelectorAll<HTMLElement>('button[data-cmd="style"]').forEach((b) => {
    const current = active !== undefined && (b.dataset.arg ?? '') === level;
    b.classList.toggle('on', current);
    b.classList.toggle('checked', current);
  });
  const inTable = currentCell() !== null;
  toolbar.classList.toggle('in-table', inTable);
  if (!inTable && currentTab === 'table') showTab('home');
  const inImage = imageBlock() !== undefined;
  toolbar.classList.toggle('in-image', inImage);
  if (!inImage && currentTab === 'image') showTab('home');
  const spacing = active ? /^\\begin\{spacing\}\{([^}]*)\}/.exec(paraEnv(content(active.el), SPACING_ENV)?.getAttribute('data-o') ?? '')?.[1] ?? '' : undefined;
  toolbar.querySelectorAll<HTMLElement>('button[data-cmd="par-spacing"]').forEach((b) => b.classList.toggle('checked', spacing !== undefined && (b.dataset.arg ?? '') === spacing));
  toolbar.classList.toggle('editing', active !== undefined);
  // viñetas: en qué nivel está el cursor y qué marca tiene esa lista
  const li = active ? currentLi() : null;
  const inList = li && active?.el.contains(li) ? li : null;
  const levelTitle = toolbar.querySelector('.list-level-title');
  if (levelTitle) levelTitle.textContent = inList ? `Viñetas · nivel ${listLevel(inList)} (el de la lista donde está el cursor)` : 'Viñetas';
  const open = inList?.parentElement?.getAttribute('data-o') ?? '';
  const curEnv = /\\begin\{([a-z]+)\}/.exec(open)?.[1];
  const curLabel = /label\s*=\s*([^,\]]*)/.exec(open)?.[1]?.trim() ?? '';
  toolbar.querySelectorAll<HTMLElement>('button[data-cmd="list-style"]').forEach((b) => b.classList.toggle('checked', curEnv !== undefined && b.dataset.arg === `${curEnv}|${curLabel}`));
  toolbar.querySelectorAll<HTMLButtonElement>('button[data-cmd="list-level"]').forEach((b) => (b.disabled = !inList));
  // el botón «sin etiqueta» enseña la marca que LaTeX (o babel) pone en este nivel
  const plainBullet = toolbar.querySelector<HTMLElement>('button[data-cmd="list-style"][data-arg="itemize|"]');
  if (plainBullet) {
    const ul = curEnv === 'itemize' ? inList?.parentElement : null;
    const mark = /^["']([^"']+?)\s*["']$/.exec(ul?.style.listStyleType ?? '')?.[1];
    plainBullet.textContent = mark ?? '•';
    plainBullet.title = ul ? `La viñeta de LaTeX para el nivel ${listLevel(inList as HTMLElement)}: ${mark ?? '•'}` : 'Viñeta •';
  }
  updateFontBoxes();
}

/** Estilos propios del documento: las órdenes de un argumento que solo le dan formato. */
function updateStyles(): void {
  const list = toolbar.querySelector('#ustyle-list');
  if (!list) return;
  const names = Object.entries(macros)
    .filter(([name, body]) => /^\\[a-zA-Z]+$/.test(name) && body.split('#1').length === 2 && !body.includes('#2') && body.length < 200)
    .map(([name]) => name.slice(1));
  list.innerHTML = names.length
    ? names.map((n) => `<button data-cmd="style-use" data-arg="${n}" class="mi" title="Dar este estilo al texto seleccionado"><span class="tick"></span>${escHtml(n)}</button>`).join('')
    : '<div class="menu-empty">Aún no hay estilos propios.</div>';
}

let layoutSignature = '';

/** Marca en los menús de Disposición la opción vigente y ajusta la página a esas medidas. */
function applyLayout(): void {
  toolbar.querySelectorAll<HTMLElement>('button[data-cmd="layout"]').forEach((b) => {
    const [key, value] = (b.dataset.arg ?? '').split('=');
    b.classList.toggle('checked', layout !== undefined && String(layout[key as keyof LayoutInfo]) === value);
  });
  toolbar.querySelector('button[data-cmd="widows"]')?.classList.toggle('on', layout?.widows === '1');
  toolbar.querySelectorAll<HTMLElement>('button[data-cmd="land-view"]').forEach((b) => b.classList.toggle('checked', b.dataset.arg === landscapeView));
  const lands = root.querySelectorAll<HTMLElement>('.landscape');
  const landPdf = toolbar.querySelector<HTMLButtonElement>('button[data-cmd="land-pdf"]');
  landPdf?.classList.toggle('checked', lands.length > 0 && lands[0].dataset.land === 'pdf');
  if (landPdf) landPdf.disabled = !lands.length;
  // con otras medidas, otra letra u otro encabezado, el reparto en hojas cambia entero
  const signature = JSON.stringify([pageInfo, furniture, viewMode, layout?.cls, layout?.lang]);
  if (signature !== layoutSignature) {
    layoutSignature = signature;
    dirtyAll = true;
  }
  const p = pageInfo;
  // medidas exactas, sin redondear al píxel: unas décimas deciden si una palabra cabe en su línea
  const set = (name: string, cm: number): void => pageEl.style.setProperty(name, `${+(cm * PX_PER_CM).toFixed(2)}px`);
  set('--pw', p.pageW);
  set('--ph', p.pageH);
  set('--mt', p.marginTop);
  set('--mb', p.marginBottom);
  set('--ml', p.marginLeft);
  set('--mr', p.marginRight);
  set('--tw', p.pageW - p.marginLeft - p.marginRight);
  set('--th', p.pageH - p.marginTop - p.marginBottom);
  pageEl.style.setProperty('--cm', `${PX_PER_CM}px`);
  // el tipo de letra del documento, imitado con fuentes del sistema (las fórmulas siguen con las suyas)
  pageEl.style.fontFamily = p.fontCss ?? '';
  pageEl.style.fontSize = `${(p.fontPt * 0.03515 * PX_PER_CM).toFixed(1)}px`;
  // interlineado, sangría y separación de párrafos como los fija el documento
  pageEl.style.lineHeight = String(p.lineHeight ?? 1.2 * p.spacing);
  pageEl.style.setProperty('--indent', p.indent ?? '1.5em');
  pageEl.style.setProperty('--parskip', p.parSkip ?? '0px');
  root.classList.toggle('two-col', p.columns === 2);
  document.body.classList.toggle('view-page', viewMode === 'page');
  document.body.classList.toggle('view-flow', viewMode === 'flow');
  applyZoom();
  paginate();
}

// ------------------------------------------------------------------ vista de página

/** Escala de la hoja en pantalla: 1 cm de papel = 46 px (un 120 % del tamaño real a 96 ppp). */
const PX_PER_CM = 46;
/** Separación visible entre una hoja y la siguiente. */
const PAGE_GAP = 22;
const pageEl = document.getElementById('page') as HTMLElement;
const statusEl = document.createElement('div');
statusEl.id = 'status';
document.body.appendChild(statusEl);
let pageCount = 1;

/**
 * Zoom automático. Si la hoja completa cabe a un tamaño legible, se muestra entera; si el panel
 * es estrecho, se ajusta al ancho del texto y los márgenes laterales quedan recortados.
 */
function fitZoom(): { z: number; crop: boolean } {
  const avail = document.documentElement.clientWidth - sideWidth();
  const sheet = (avail - 36) / (pageInfo.pageW * PX_PER_CM);
  if (zoom === 'sheet' || sheet >= 0.8) return { z: Math.max(0.3, Math.min(1.15, sheet)), crop: false };
  const text = (avail - 28) / ((pageInfo.pageW - pageInfo.marginLeft - pageInfo.marginRight) * PX_PER_CM);
  return { z: Math.max(0.5, Math.min(1, text)), crop: true };
}

function currentZoom(): number {
  if (typeof zoom === 'number') return zoom;
  return viewMode === 'page' ? fitZoom().z : 1;
}

/** Zoom con el que caben dos hojas (o tres, en un panel muy ancho) una al lado de otra. */
function multiPageZoom(): number {
  const avail = document.documentElement.clientWidth - sideWidth() - 36;
  const w = pageInfo.pageW * PX_PER_CM;
  const fit = (cols: number): number => avail / (cols * (w + 26) - 26);
  const z = fit(2) > 0.7 && fit(3) >= 0.4 ? fit(3) : fit(2);
  return Math.max(0.15, Math.min(0.7, Math.floor(z * 100) / 100));
}

// Ctrl + rueda del ratón (o pellizco en el panel táctil): acerca y aleja el documento
window.addEventListener(
  'wheel',
  (e) => {
    if (!e.ctrlKey || isDialogOpen()) return;
    e.preventDefault();
    const z = currentZoom() * (e.deltaY < 0 ? 1.1 : 1 / 1.1);
    zoom = Math.min(2.5, Math.max(0.15, Math.round(z * 100) / 100));
    applyZoom();
    rememberZoom();
  },
  { passive: false },
);

/**
 * Dentro de la hoja con zoom, `getBoundingClientRect` devuelve píxeles reales de la ventana en
 * los Chromium recientes, pero medidas sin ampliar en VS Code (que desactiva ese comportamiento).
 * Este factor convierte lo que devuelva el navegador en píxeles reales.
 */
function rectScale(): number {
  const w = pageEl.offsetWidth;
  const applied = parseFloat(pageEl.style.getPropertyValue('zoom')) || 1;
  if (!w) return 1;
  const measured = pageEl.getBoundingClientRect().width / w;
  return measured > 0 ? applied / measured : 1;
}

/** Rectángulo, en píxeles reales de la ventana, de un elemento o rango de la hoja. */
function vrect(target: Element | Range): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
  const r = target.getBoundingClientRect();
  const k = rectScale();
  return { left: r.left * k, top: r.top * k, right: r.right * k, bottom: r.bottom * k, width: r.width * k, height: r.height * k };
}

/** zoom, recorte y vista con los que se hizo el último reparto */
let zoomApplied = '';

function applyZoom(): void {
  const z = currentZoom();
  pageEl.style.setProperty('zoom', z.toFixed(3));
  // para lo que debe conservar su tamaño aunque la hoja se reduzca (herramientas del bloque)
  pageEl.style.setProperty('--z', z.toFixed(3));
  const crop = viewMode === 'page' && zoom === 'fit' && fitZoom().crop;
  // sin barra horizontal salvo que el zoom lo haya elegido el usuario
  document.body.classList.toggle('fitted', viewMode === 'page' && typeof zoom !== 'number');
  // con los márgenes fuera de la vista, lo que va en ellos (comentarios) se muestra entre el texto
  document.body.classList.toggle('cropped', crop);
  // en un panel estrecho el esquema flota sobre el documento en vez de quitarle sitio
  document.body.classList.toggle('nav-float', navOpen && !navDocked());
  document.body.classList.toggle('git-float', gitOpen && !gitDocked());
  if (crop) {
    // el texto queda centrado en el panel y los márgenes de la hoja se salen por los lados
    const avail = document.documentElement.clientWidth - sideWidth();
    const text = (pageInfo.pageW - pageInfo.marginLeft - pageInfo.marginRight) * PX_PER_CM * z;
    const left = (avail - text) / 2 - pageInfo.marginLeft * PX_PER_CM * z;
    pageEl.style.marginLeft = `${(left / z).toFixed(1)}px`;
    pageEl.style.marginRight = '0';
  } else {
    pageEl.style.removeProperty('margin-left');
    pageEl.style.removeProperty('margin-right');
  }
  updateStatus();
  updateRuler();
  fitLandscapeSheet();
  // con otro tamaño en pantalla las líneas pueden romper en otro punto: se recalculan los cortes
  const now = `${z.toFixed(3)}|${crop}|${viewMode}`;
  if (now !== zoomApplied) schedulePaginate();
  zoomApplied = now;
}

// ------------------------------------------------------------------ paginación

/** Elementos del contenido que no se pueden partir entre dos hojas. */
const SOLID = new Set(['TABLE', 'FIGURE', 'IMG', 'CANVAS', 'BR', 'PRE', 'SVG']);
/** Contenedores que, si la hoja se corta justo en su inicio, pasan enteros a la siguiente. */
const KEEP_HEAD = new Set(['LI', 'H1', 'H2', 'H3', 'H4', 'DIV', 'BLOCKQUOTE', 'FIGURE', 'FIGCAPTION', 'UL', 'OL', 'STRONG', 'B', 'I', 'EM', 'SPAN', 'U', 'CODE', 'A']);

/**
 * Átomo que por dentro es texto corrido (lo que genera un bucle, un examen, un capítulo traído con
 * \input): no se edita en sitio, pero se reparte entre hojas línea a línea como un párrafo.
 */
const isFlowAtom = (el: Element): boolean =>
  el.classList.contains('atom') && (el.classList.contains('gen') || el.classList.contains('exam') || el.querySelector(':scope > .included') !== null);

/** Unidades del contenido en orden de lectura: nodos de texto y elementos indivisibles. */
function leaves(node: Node, out: Node[] = []): Node[] {
  for (const ch of Array.from(node.childNodes)) {
    if (ch.nodeType === 3) {
      if ((ch as Text).data.trim()) out.push(ch);
    } else if (ch.nodeType === 1) {
      const el = ch as HTMLElement;
      if (el.classList.contains('pg-split')) continue;
      if (el.hasAttribute('data-skip') || SOLID.has(el.tagName) || (el.hasAttribute('data-tex') && !isFlowAtom(el))) out.push(el);
      else leaves(el, out);
    }
  }
  return out;
}

interface Line {
  top: number;
  bottom: number;
  /** primera unidad de la línea y, si es texto, cuál de sus fragmentos de línea */
  leaf: Node;
  rect: DOMRect;
}

/** Líneas visuales del contenido de un bloque (en píxeles de pantalla). */
function linesOf(c: HTMLElement): Line[] {
  const range = document.createRange();
  const lines: Line[] = [];
  for (const leaf of leaves(c)) {
    let rects: DOMRect[];
    if (leaf.nodeType === 3) {
      range.selectNodeContents(leaf);
      rects = Array.from(range.getClientRects());
    } else rects = [(leaf as Element).getBoundingClientRect()];
    for (const r of rects) {
      if (r.height < 1) continue;
      const last = lines[lines.length - 1];
      // misma línea si se solapa verticalmente con la anterior
      if (last && r.top < last.bottom - Math.min(r.height, last.bottom - last.top) * 0.5) {
        last.top = Math.min(last.top, r.top);
        last.bottom = Math.max(last.bottom, r.bottom);
      } else lines.push({ top: r.top, bottom: r.bottom, leaf, rect: r });
    }
  }
  return lines;
}

/** ¿Es solo espacio vertical (`\vspace`, `\vfill`, cambio de párrafo), sin nada que se vea? */
function isBlank(leaf: Node): boolean {
  if (leaf.nodeType !== 1) return false;
  const el = leaf as Element;
  if (el.textContent?.trim() || el.querySelector('img, canvas, svg, table, hr, .pagebreak')) return false;
  return el.matches('.vskip, .vfill, .parbreak') || el.querySelector('.vskip, .vfill, .parbreak') !== null;
}

/** Posición del DOM donde empieza una línea. */
function lineStart(line: Line): { parent: Node; before: Node | null } | { text: Text; offset: number } {
  if (line.leaf.nodeType !== 3) return { parent: line.leaf.parentNode as Node, before: line.leaf };
  const text = line.leaf as Text;
  const range = document.createRange();
  // primer carácter cuya línea empieza a la altura buscada (búsqueda binaria)
  const topFrom = (off: number): number => {
    range.setStart(text, off);
    range.setEnd(text, text.length);
    const r = Array.from(range.getClientRects()).find((x) => x.height >= 1);
    return r ? r.top : Infinity;
  };
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (topFrom(mid) >= line.rect.top - 1) hi = mid;
    else lo = mid + 1;
  }
  // los espacios que quedan al final de la línea anterior se dejan allí
  while (lo < text.length && /\s/.test(text.data[lo]) && topFrom(lo + 1) >= line.rect.top - 1) lo++;
  return { text, offset: lo };
}

/** ¿Hay contenido visible en `parent` antes de `node`? */
function hasContentBefore(node: Node, parent: Node): boolean {
  for (let n: Node | null = node.previousSibling; n; n = n.previousSibling) {
    if (n.nodeType === 3 ? (n as Text).data.trim() : !(n as Element).classList.contains('pg-split') && (n as HTMLElement).offsetHeight > 0 && !(n as Element).hasAttribute('data-skip')) return true;
  }
  return node.parentNode !== parent && node.parentNode ? hasContentBefore(node.parentNode, parent) : false;
}

/**
 * Parte un bloque entre dos hojas: inserta un separador antes de la primera línea que ya no cabe.
 * `start` es dónde empieza, dentro del bloque, la parte que va en la hoja actual y `room` el
 * espacio que queda en ella (píxeles CSS); `min`, las líneas que como mínimo deben quedarse en la
 * hoja actual. Devuelve dónde termina esa parte y dónde empieza la de la hoja siguiente;
 * `undefined` si no caben las líneas pedidas, y `'space'` si lo único que no cabe es espacio en
 * blanco (LaTeX lo descarta al cortar la hoja: no pasa a la siguiente).
 */
function splitBlock(
  el: HTMLElement, start: number, room: number, z: number, page: number, extra = 0, min = 1, keep = 1,
): { top: number; next: number; spacer: HTMLElement } | 'space' | undefined {
  const c = el.lastElementChild as HTMLElement;
  const top = el.getBoundingClientRect().top;
  const rel = (y: number): number => (y - top) / z;
  const lines = linesOf(c).filter((l) => rel(l.top) >= start - 1);
  let k = lines.findIndex((l) => rel(l.bottom) > start + room + 0.5);
  // caben todas las líneas con algo que ver: lo que sobresale es relleno o espacio vertical
  if (k < 0 ? lines.length > 0 : k > 0 && lines.slice(k).every((l) => isBlank(l.leaf))) return 'space';
  // sin viudas: a la hoja siguiente pasan al menos `keep` líneas
  if (keep > 1 && k > 0 && lines.length - k < keep) k = lines.length - keep;
  if (k < min) return undefined;
  const line = lines[k];
  const mb = pageInfo.marginBottom * PX_PER_CM - lead.bottom;
  const rest = Math.max(start + room - rel(line.top), 0);
  const spacer = document.createElement('span');
  spacer.className = 'pg-split';
  spacer.setAttribute('data-skip', '');
  spacer.contentEditable = 'false';
  // `extra`: sitio para los flotantes que abren la hoja siguiente
  spacer.style.height = `${Math.round(rest + mb + PAGE_GAP + pageInfo.marginTop * PX_PER_CM - lead.top + extra)}px`;
  const strip = document.createElement('span');
  strip.className = 'pg-strip';
  strip.dataset.page = String(page);
  strip.style.top = `${Math.round(rest + mb)}px`;
  spacer.appendChild(strip);

  const pos = lineStart(line);
  let parent: Node;
  let before: Node | null;
  if ('text' in pos) {
    if (pos.offset > 0 && pos.offset < pos.text.length) {
      before = pos.text.splitText(pos.offset);
      parent = before.parentNode as Node;
    } else {
      parent = pos.text.parentNode as Node;
      before = pos.offset === 0 ? pos.text : pos.text.nextSibling;
    }
  } else ({ parent, before } = pos);
  // si la línea es la primera de un elemento de lista, un título, etc., el corte va delante de él
  while (parent !== c && before && KEEP_HEAD.has((parent as Element).tagName) && !hasContentBefore(before, parent)) {
    before = parent;
    parent = parent.parentNode as Node;
  }
  parent.insertBefore(spacer, before);
  if ((parent as Element).tagName === 'UL' || (parent as Element).tagName === 'OL') spacer.classList.add('pg-block');
  // si la hoja se corta en mitad de una palabra, su guion se dibuja siempre (ya no depende del renglón)
  const prev = spacer.previousSibling;
  if (prev instanceof HTMLElement && prev.classList.contains('shy')) prev.classList.add('cut');
  const sr = spacer.getBoundingClientRect();
  strip.style.left = `${Math.round((pageEl.getBoundingClientRect().left - sr.left) / z)}px`;
  return { top: rel(sr.top), next: rel(sr.bottom), spacer };
}

/** El bloque entero pasa a la hoja siguiente: se abre delante el hueco entre hojas. */
function blockBreak(el: HTMLElement, rest: number, page: number, extra = 0): void {
  // `rest` negativo: lo último de la hoja anterior (espacio en blanco) asoma bajo su caja de texto
  const mb = pageInfo.marginBottom * PX_PER_CM - lead.bottom;
  const free = Math.max(rest, -mb);
  el.classList.add('page-start');
  // `extra`: sitio para los flotantes que abren la hoja, entre el hueco y este bloque
  el.style.setProperty('--gap', `${Math.round(free + mb + pageInfo.marginTop * PX_PER_CM - lead.top + PAGE_GAP + extra)}px`);
  el.style.setProperty('--extra', `${Math.round(extra)}px`);
  el.style.setProperty('--rest', `${Math.round(Math.max(rest, 0))}px`);
  el.style.setProperty('--head-top', `${headTop(el).toFixed(2)}px`);
  el.dataset.page = String(page);
}

/**
 * Margen que lleva un título que abre hoja para que su línea base quede donde la pone LaTeX: a
 * `\topskip` del borde de la caja de texto, o, con `titlesec` (que añade un puntal a cada título),
 * a 0,7 veces su interlineado si eso es más.
 */
function headTop(el: HTMLElement): number {
  const h = el.querySelector<HTMLElement>(':scope > .content > [data-k="head"]');
  if (!h || !lead.line) return 0;
  const topskip = pageInfo.fontPt * 0.03515 * PX_PER_CM;
  const ratio = parseFloat(getComputedStyle(h).fontSize) / topskip || 1;
  const wanted = h.hasAttribute('data-strut') ? Math.max(topskip, 0.7 * lead.line * ratio) : topskip;
  return wanted - (lead.base * ratio - lead.top);
}

/**
 * Reparte el documento en hojas. Los párrafos y las listas se parten por líneas, como en un
 * procesador de textos; las ecuaciones, tablas, figuras y bloques de código pasan enteros a la
 * hoja siguiente, y un título nunca se queda solo al pie de una hoja. Es una aproximación a la
 * paginación de LaTeX: Mars no compila el documento.
 */
function paginate(): void {
  if (composing) return;
  // repartir quita y repone los huecos entre hojas: lo que se estaba viendo no debe moverse de sitio.
  // Con la vista quieta vale la referencia guardada (compensa también una imagen que termina de
  // cargarse más arriba); en pleno desplazamiento, se mide en el momento para no frenarlo.
  const still = performance.now() - lastScrollAt > 300;
  const a = still && viewAnchor?.el.isConnected ? viewAnchor : anchorNow();
  layoutPages();
  if (a?.el.isConnected) {
    const shift = vrect(a.el).top - a.top;
    if (Math.abs(shift) > 0.5) window.scrollBy(0, shift);
  }
  viewAnchor = anchorNow();
}

/** Bloque de referencia para mantener la vista quieta: el que se edita si está a la vista; si no, el primero visible. */
let viewAnchor: { el: BlockEl; top: number } | undefined;
let lastScrollAt = 0;
function anchorNow(): { el: BlockEl; top: number } | undefined {
  const floor = toolbar.offsetHeight;
  if (active?.el.isConnected) {
    const r = vrect(active.el);
    if (r.bottom > floor && r.top < window.innerHeight) return { el: active.el, top: r.top };
  }
  for (const el of els) {
    const r = vrect(el);
    if (r.bottom > floor) return { el, top: r.top };
  }
  return undefined;
}

/** alto del documento tal como lo dejó el último reparto */
let pagedHeight = -1;

function layoutPages(): void {
  const started = performance.now();
  // mientras se recalcula, la hoja conserva su altura: si el documento encogiera un instante, el
  // navegador recolocaría el desplazamiento (y cortaría uno animado que estuviera en marcha)
  pageEl.style.minHeight = `${pageEl.offsetHeight}px`;
  try {
    repaginate();
  } finally {
    pageEl.style.removeProperty('min-height');
    pagedHeight = root.offsetHeight;
    perf.paginate = performance.now() - started;
  }
}

/** Separación entre hojas y margen alrededor cuando se muestran varias por fila. */
const GRID_GAP = 26;
const sheetsEl = document.createElement('div');
sheetsEl.id = 'sheets';
pageEl.prepend(sheetsEl);
/** Copias de solo lectura de los trozos de bloque que continúan en otra hoja (vista de varias páginas). */
const mirrorsEl = document.createElement('div');
mirrorsEl.id = 'mirrors';
root.after(mirrorsEl);

/** Trozo de un bloque que cae en una hoja: de `from` a `to` (píxeles dentro del bloque; sin `to`, hasta el final). */
interface Frag {
  el: BlockEl;
  from: number;
  to?: number;
}
/** Reparto vigente: los trozos de cada hoja, en orden. */
let sheets: Frag[][] = [];
/**
 * Número impreso al pie de cada hoja. Como en LaTeX, la portada (`titlepage`) no lleva número y
 * tras ella la numeración vuelve a empezar en 1 (salvo en la clase `book`, que sigue contando).
 */
let pageNums: string[] = [];

/**
 * LaTeX mide la hoja de línea base a línea base: la primera queda a `\topskip` (el tamaño de la
 * letra) del borde superior de la caja de texto y la última puede apoyarse en el inferior. El
 * navegador, en cambio, apila cajas de línea enteras, con el interlineado repartido por encima y
 * por debajo de las letras. Para que en cada hoja quepan las mismas líneas que en el PDF, la
 * primera caja sube lo que le sobra por encima de `\topskip` (`top`) y la última puede asomar
 * bajo la caja de texto lo que tiene por debajo de la línea base (`bottom`): son espacios en
 * blanco, no se ve nada fuera de sitio.
 */
let lead = { top: 0, bottom: 0, base: 0, line: 0 };
const leadProbe = document.createElement('div');
leadProbe.className = 'lead-probe';
leadProbe.innerHTML = '<span></span>x';
pageEl.appendChild(leadProbe);

function measureLead(z: number): void {
  const fontPx = pageInfo.fontPt * 0.03515 * PX_PER_CM;
  const box = leadProbe.getBoundingClientRect();
  const line = box.height / z;
  const base = ((leadProbe.firstElementChild as HTMLElement).getBoundingClientRect().bottom - box.top) / z;
  const ok = viewMode === 'page' && line > 0 && base > 0 && base <= line;
  const top = ok ? Math.max(-fontPx, Math.min(base - fontPx, line)) : 0;
  const bottom = ok ? line - base : 0;
  if (Math.abs(top - lead.top) < 0.05 && Math.abs(bottom - lead.bottom) < 0.05) return;
  lead = { top, bottom, base: ok ? base : 0, line: ok ? line : 0 };
  pageEl.style.setProperty('--lead-t', `${top.toFixed(2)}px`);
  pageEl.style.setProperty('--lead-b', `${bottom.toFixed(2)}px`);
}

/**
 * Hojas por fila. Con el zoom alejado (70 % o menos) y sitio para dos o más, las páginas se
 * colocan en mosaico, como la vista «Varias páginas» de un procesador de textos.
 */
function gridCols(): number {
  if (viewMode !== 'page' || pageInfo.columns === 2 || typeof zoom !== 'number' || zoom > 0.7) return 1;
  const avail = document.documentElement.clientWidth - sideWidth() - 36;
  const w = pageInfo.pageW * PX_PER_CM;
  return Math.max(1, Math.floor((avail / zoom + GRID_GAP) / (w + GRID_GAP)));
}

/** Reparte entre los espacios elásticos (`\vfill`) de una hoja lo que le queda libre. Devuelve lo que sobra. */
function fillPage(page: Frag[], rest: number): number {
  const fills = page.flatMap((f) => Array.from(f.el.querySelectorAll<HTMLElement>('.vfill')));
  if (!fills.length || rest <= 0) return rest;
  for (const f of fills) f.style.height = `${rest / fills.length}px`;
  return 0;
}

const isHeading = (el: BlockEl): boolean => el.querySelector(':scope > .content > [data-k="head"]') !== null;
/** Tras este bloque el documento salta de hoja: un salto de página o el final de la portada. */
/** En un informe o un libro, LaTeX pone en hoja propia el título, el resumen, el índice y cada capítulo. */
const chaptered = (): boolean => /^(report|book|scrreprt|scrbook|memoir|amsbook)$/.test(layout?.cls ?? '');
const ownPage = (el: Element): boolean => el.querySelector('.titlepage') !== null || (chaptered() && el.querySelector('.titleblock, .abstract') !== null);
/** Hoja horizontal (\begin{landscape}): como en LaTeX, empieza y termina hoja y no se parte. */
const isLandscape = (el: Element): boolean => el.querySelector(':scope > .content > .landscape') !== null;
const breaksAfter = (el: BlockEl): boolean => el.querySelector('.pagebreak') !== null || ownPage(el) || isLandscape(el);
const breaksBefore = (el: BlockEl): boolean => isLandscape(el) || (chaptered() && el.querySelector('[data-level="chapter"], .toc, .bib-title') !== null);

/**
 * Cómo se ven las hojas horizontales (ajuste `mars.landscapePages`): 'edit' (como en el PDF y
 * derecha mientras se edita), 'pdf' (según el paquete), 'rotated' o 'upright'.
 */
let landscapeView = '';
const LANDSCAPE_VIEWS = ['edit', 'pdf', 'rotated', 'upright'];
function setLandscapeView(view: string): void {
  const v = LANDSCAPE_VIEWS.includes(view) ? view : 'edit';
  toolbar.querySelectorAll<HTMLElement>('button[data-cmd="land-view"]').forEach((b) => b.classList.toggle('checked', b.dataset.arg === v));
  if (v === landscapeView) return;
  landscapeView = v;
  for (const k of LANDSCAPE_VIEWS) document.body.classList.toggle(`land-${k}`, k === v);
  dirtyAll = true;
}
/**
 * La hoja horizontal ocupa solo lo que mide derecha (apaisada). Girada, o girada salvo mientras se
 * edita ('edit' con lscape), ocupa la hoja entera: al entrar y salir de ella no se mueve nada.
 */
const landUpright = (land: HTMLElement): boolean => landscapeView === 'upright' || (landscapeView !== 'rotated' && land.dataset.land === 'pdf');

/**
 * La hoja horizontal mientras se edita: una hoja apaisada entera (el papel girado, con sus márgenes)
 * sobre la vertical, centrada con ella a lo ancho y a lo alto (la vertical asoma igual por arriba
 * y por abajo). Con lscape el margen de arriba de la hoja apaisada es el
 * izquierdo de la vertical y el izquierdo, el de abajo. Si no cabe en el panel, se reduce lo justo.
 */
function fitLandscapeSheet(): void {
  const p = pageInfo;
  const cm = (n: number): string => `${(n * PX_PER_CM).toFixed(2)}px`;
  const set = (name: string, v: string): void => pageEl.style.setProperty(name, v);
  set('--ls-w', cm(p.pageH - p.marginTop - p.marginBottom));
  set('--ls-h', cm(p.pageW - p.marginLeft - p.marginRight));
  set('--ls-pad', `${cm(p.marginLeft)} ${cm(p.marginTop)} ${cm(p.marginRight)} ${cm(p.marginBottom)}`);
  set('--ls-x', cm(-p.marginLeft - (p.pageH - p.pageW) / 2));
  set('--ls-y', cm(-p.marginTop + (p.pageH - p.pageW) / 2));
  const avail = document.documentElement.clientWidth - sideWidth() - 24;
  const wide = p.pageH * PX_PER_CM * currentZoom();
  set('--ls-fit', Math.min(1, avail / wide).toFixed(4));
}

/**
 * Medidas de las hojas horizontales. Su contenido se compone con el alto de la caja de texto como
 * ancho, igual que en LaTeX; girado ocupa la hoja entera y derecho se reduce al ancho del texto.
 */
function sizeLandscapes(blocks: BlockEl[], pageH: number): void {
  const h = Math.floor(pageH) - 2;
  const tw = (pageInfo.pageW - pageInfo.marginLeft - pageInfo.marginRight) * PX_PER_CM;
  const k = Math.min(tw / h, 1);
  pageEl.style.setProperty('--land-h', `${h}px`);
  pageEl.style.setProperty('--land-k', k.toFixed(4));
  fitLandscapeSheet();
  for (const el of blocks) {
    const land = el.querySelector<HTMLElement>(':scope > .content > .landscape');
    if (land && landUpright(land)) el.style.setProperty('--land-up', `${Math.ceil(land.offsetHeight * k)}px`);
  }
}

/** Capa con lo que LaTeX pone alrededor del texto de cada hoja: encabezado, pie y notas al pie. */
const furnEl = document.createElement('div');
furnEl.id = 'furniture';
mirrorsEl.after(furnEl);
// doble clic en el encabezado o el pie de cualquier hoja: se edita, como en un procesador de textos
furnEl.addEventListener('dblclick', (e) => {
  const row = (e.target as HTMLElement).closest<HTMLElement>('[data-hf]');
  if (!row || readOnly) return;
  e.preventDefault();
  headFootDialog(row.dataset.hf === 'foot' ? 'foot' : 'head');
});

/** Lo que se sabe de cada hoja tras repartir: su número impreso, su estilo y las notas que lleva. */
interface PageMeta {
  num: string;
  style: string;
  notes: number[];
  /** títulos en curso al terminar la hoja (\leftmark y \rightmark) */
  marks: [string, string];
}
let pageMeta: PageMeta[] = [];
/** Dónde empieza cada hoja en la vista de una por fila: el elemento que la abre y lo que lleva delante. */
let pageStarts: ({ el: HTMLElement; split: boolean; extra: number } | undefined)[] = [];

const isFloat = (el: BlockEl): boolean => el.querySelector(':scope > .content > [data-float]') !== null;
const isNotes = (el: BlockEl): boolean => el.querySelector(':scope > .content > .footnotes') !== null;
/** Figura con el texto alrededor (wrapfigure): va a un lado y no ocupa sitio propio en la hoja. */
const isWrapped = (el: BlockEl): boolean => el.querySelector(':scope > .content > figure[data-wrap]') !== null;

/** Número de página en el formato de `\pagenumbering`. */
function pageNumber(n: number, fmt: string): string {
  if (fmt === 'roman' || fmt === 'Roman') {
    let out = '';
    let k = n;
    for (const [v, s] of [[1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'], [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i']] as [number, string][]) {
      while (k >= v) {
        out += s;
        k -= v;
      }
    }
    return fmt === 'Roman' ? out.toUpperCase() : out;
  }
  if ((fmt === 'alph' || fmt === 'Alph') && n >= 1 && n <= 26) return String.fromCharCode((fmt === 'alph' ? 96 : 64) + n);
  return String(n);
}

/**
 * Qué hay que volver a repartir. Repartir un documento largo entero cuesta más de un segundo, así
 * que al escribir solo se rehace desde la hoja del bloque que ha cambiado hasta que el reparto
 * vuelve a coincidir con el que había. `dirtyAll`: ha cambiado algo que afecta a todo (medidas de
 * la hoja, zoom, fuentes) o no se sabe qué ha cambiado.
 */
const dirty = new Set<BlockEl>();
let dirtyAll = true;
/** notas al pie de cada hoja en el último reparto */
let pageNotes: number[][] = [];

/** Deja un bloque como si no se hubiera repartido: sin cortes, sin hueco delante y en su sitio. */
function unpage(el: BlockEl, keepStart = false): void {
  el.querySelectorAll('.pg-split').forEach((s) => s.remove());
  el.querySelectorAll('.shy.cut').forEach((s) => s.classList.remove('cut'));
  el.querySelectorAll<HTMLElement>('.vfill').forEach((f) => f.style.removeProperty('height'));
  if (!keepStart && el.classList.contains('page-start')) {
    el.classList.remove('page-start');
    el.style.removeProperty('--gap');
    el.style.removeProperty('--rest');
    el.style.removeProperty('--extra');
    el.style.removeProperty('--head-top');
    delete el.dataset.page;
  }
  if (el.classList.contains('floated')) {
    el.classList.remove('floated');
    el.style.removeProperty('top');
  }
  if (el.style.transform) el.style.removeProperty('transform');
  if (el.style.clipPath) el.style.removeProperty('clip-path');
}

function repaginate(): void {
  perfMark = performance.now();
  const kids = Array.from(root.children) as BlockEl[];
  const cols = gridCols();
  const wasGrid = document.body.classList.contains('grid');
  const paged = viewMode === 'page' && pageInfo.columns !== 2;
  const grid = paged && cols > 1;
  // el mosaico, y entrar o salir de él o de la vista de hojas, se reparten siempre enteros
  let full = dirtyAll || grid || wasGrid || !paged || !document.body.classList.contains('paged') || !sheets.length;
  const changed = [...dirty].filter((el) => el.isConnected);
  dirty.clear();
  dirtyAll = false;
  if (!full && !changed.length) return;
  // una nota al pie que cambia mueve la numeración y el sitio de las demás
  if (changed.some(isNotes)) full = true;

  const list = kids.filter((el) => !el.classList.contains('is-preamble') && !isNotes(el));
  const index = new Map<BlockEl, number>(list.map((el, k) => [el, k]));
  const old = { sheets, starts: pageStarts, notes: pageNotes };
  /** hoja desde la que se reparte y primer bloque que se vuelve a colocar */
  let first = 0;
  let from = 0;
  /** último bloque cambiado: más allá de él, el reparto puede volver a coincidir con el anterior */
  let last = list.length;
  if (!full) {
    const at = changed.map((el) => index.get(el) ?? -1).filter((k) => k >= 0);
    // hoja del primer bloque cambiado (o, si es nuevo, la del que tiene delante)
    // (un cambio fuera del texto repartido —el preámbulo, las notas— no da por dónde empezar)
    let k = at.length ? Math.min(...at) : -1;
    let page = -1;
    for (; k >= 0 && page < 0; k--) page = old.sheets.findIndex((p) => p.some((f) => f.el === list[k]));
    if (!at.length || page < 0) full = true;
    else {
      last = Math.max(...at);
      // se retrocede hasta una hoja que empiece limpia: con un bloque entero y sin flotantes heredados.
      // Una antes de la del cambio, porque un bloque que encoge puede volver a caber en la anterior
      for (first = Math.max(page - 1, 0); first > 0; first--) {
        const s = old.sheets[first];
        const start = old.starts[first];
        if (s[0] && s[0].from === 0 && start && !start.split && start.el === s[0].el && !s.some((f) => f.el.classList.contains('floated'))) break;
      }
      from = first > 0 ? index.get(old.sheets[first][0].el) ?? -1 : 0;
      if (from < 0) full = true;
    }
  }
  if (full) {
    first = 0;
    from = 0;
    last = list.length;
    mirrorsEl.textContent = '';
    for (const el of kids) unpage(el);
    document.body.classList.toggle('grid', grid);
    if (!grid) {
      pageEl.style.removeProperty('width');
      pageEl.style.removeProperty('height');
      // de vuelta a una hoja por fila: la regla reaparece, medida sobre esa hoja
      if (wasGrid) updateRuler();
    }
  }
  furnEl.textContent = '';
  pageNums = [];
  pageMeta = [];
  lap('reset');
  const z = pageEl.offsetWidth ? pageEl.getBoundingClientRect().width / pageEl.offsetWidth : 1;
  measureLead(z);
  lap('lead');
  for (const el of full ? kids : changed) sizeFills(el, z);
  document.body.classList.toggle('paged', paged);
  if (!paged) {
    tail.querySelector('.pg-strip')?.remove();
    tail.style.removeProperty('height');
    pageCount = 1;
    sheets = [];
    pageStarts = [];
    pageNotes = [];
    fillPageRefs(z);
    updateStatus();
    return;
  }
  const fontPx = pageInfo.fontPt * 0.03515 * PX_PER_CM;
  const mtE = pageInfo.marginTop * PX_PER_CM - lead.top;
  const mbE = pageInfo.marginBottom * PX_PER_CM - lead.bottom;
  const pageH = Math.max((pageInfo.pageH - pageInfo.marginTop - pageInfo.marginBottom) * PX_PER_CM, 120) + lead.top + lead.bottom;
  sizeLandscapes(full ? list : changed, pageH);
  // separación que el documento deja tras cada párrafo (\parskip): cuenta como espacio de la hoja
  const para = list.find((el) => el.classList.contains('k-para'));
  const parSkip = para ? parseFloat(getComputedStyle(para).marginBottom) || 0 : 0;
  const skipOf = (el: BlockEl): number => (el.classList.contains('k-para') ? parSkip : 0);
  const rootTop = (): number => root.getBoundingClientRect().top;
  const yOf = (clientY: number): number => (clientY - rootTop()) / z;

  // notas al pie: el texto de cada una y lo que ocupa al fondo de la hoja
  const noteHtml = Array.from(root.querySelectorAll('.footnotes > ol > li')).map((li, i) => `<div class="pg-note"><sup>${i + 1}</sup>${li.innerHTML}</div>`);
  const noteH: number[] = [];
  if (noteHtml.length) {
    const probe = document.createElement('div');
    probe.className = 'pg-notes probe';
    probe.innerHTML = noteHtml.join('');
    furnEl.appendChild(probe);
    for (const n of Array.from(probe.children)) noteH.push((n as HTMLElement).offsetHeight);
    probe.remove();
  }
  /** espacio y raya que separan el texto de las notas */
  const noteGap = fontPx * 1.1;
  /** notas de la hoja en curso y lo que ocupan */
  let notesHere: number[] = [];
  let notesUsed = 0;
  const needFor = (ids: number[]): number => {
    const fresh = ids.filter((i) => !notesHere.includes(i));
    return fresh.reduce((n, i) => n + (noteH[i] ?? 0), 0) + (fresh.length && !notesHere.length ? noteGap : 0);
  };
  const takeNotes = (ids: number[]): void => {
    notesUsed += needFor(ids);
    for (const i of ids) if (!notesHere.includes(i)) notesHere.push(i);
  };
  /** llamadas a nota de un bloque: qué nota y a qué altura dentro de él */
  const marksOf = (el: BlockEl): { id: number; y: number }[] => {
    if (!noteHtml.length) return [];
    const marks = el.querySelectorAll('sup.fn');
    if (!marks.length) return [];
    const top = el.getBoundingClientRect().top;
    return Array.from(marks).map((s) => ({ id: (parseInt(s.textContent ?? '', 10) || 1) - 1, y: (s.getBoundingClientRect().top - top) / z }));
  };

  lap('notes');
  // lo anterior a la hoja de partida se conserva tal cual
  const pages: Frag[][] = [...old.sheets.slice(0, first), []];
  const notesOf: number[][] = old.notes.slice(0, first);
  pageStarts = old.starts.slice(0, first + 1);
  pageCount = first + 1;
  const here = (): Frag[] => pages[pages.length - 1];
  /** flotantes que no cabían donde estaban: abren la hoja siguiente */
  let pending: BlockEl[] = [];
  /** separación entre un flotante y el texto (\textfloatsep, unos 20 pt a 10 pt) */
  const floatSep = fontPx * 1.6;
  /**
   * Altura de cada bloque. En un reparto completo se leen todas antes de empezar: medir uno tras
   * abrir un hueco obliga al navegador a recolocar el documento entero, y hacerlo en cada bloque
   * es lo que más tiempo se llevaba. Solo se vuelve a medir el bloque que cambia (el que se parte
   * entre dos hojas, o un título que pasa a abrir hoja y pierde el espacio de delante).
   */
  const heights = new Map<BlockEl, number>();
  if (full) for (const el of list) heights.set(el, el.offsetHeight);
  const hOf = (el: BlockEl): number => heights.get(el) ?? el.offsetHeight;
  const pendingH = (): number => pending.reduce((n, f) => n + hOf(f), 0) + (pending.length ? floatSep : 0);
  /** lo que ya ocupa la hoja recién abierta (sus flotantes) */
  let carry = 0;
  /** Pasa a la hoja siguiente; devuelve el número (físico) de la que se cierra. */
  const turn = (): number => {
    notesOf.push(notesHere);
    notesHere = [];
    notesUsed = 0;
    carry = pendingH();
    pages.push(pending.map((f) => ({ el: f, from: 0 })));
    pending = [];
    return pageCount++;
  };
  /** Coloca los flotantes de la hoja recién abierta justo encima de `y` (coordenadas del documento). */
  const dropFloats = (where: () => number): void => {
    // (sin flotantes en la hoja no hay nada que colocar: ni siquiera se mide dónde iría)
    if (grid || !here().some((f) => f.el.classList.contains('floated'))) return;
    let top = where() - carry;
    for (const f of here()) {
      if (!f.el.classList.contains('floated')) continue;
      f.el.style.top = `${top.toFixed(1)}px`;
      top += hOf(f.el);
    }
  };
  /** cómo abría hoja cada bloque antes de volver a colocarlo: su hueco y si estaba entero en ella */
  const before = new Map<BlockEl, string>();
  /** hoja del reparto anterior con la que este vuelve a coincidir: de ahí en adelante no cambia nada */
  let rejoin = -1;
  /** Abre hoja delante de `el`, que pasa entero a ella. */
  const breakBefore = (el: BlockEl, rest: number): void => {
    const was = before.get(el);
    const hadFloats = pending.length > 0;
    const page = turn();
    blockBreak(el, rest, page, carry);
    pageStarts[page] = { el, split: false, extra: carry };
    // un título que abre hoja pierde el espacio que llevaba delante: su altura ya no es la leída
    if (isHeading(el)) heights.delete(el);
    dropFloats(() => yOf(el.getBoundingClientRect().top));
    // pasado lo que cambió, si este bloque abre hoja igual que antes, el resto ya está repartido
    if (!full && !hadFloats && was !== undefined && was === el.style.getPropertyValue('--gap') && (index.get(el) ?? 0) > last) {
      rejoin = old.sheets.findIndex((p) => p[0]?.el === el && p[0].from === 0);
    }
  };
  const keep = Math.max(pageInfo.keepLines ?? 1, 1);

  let used = 0;
  let forced = false;
  /** título inmediatamente anterior y lo que había ocupado en la hoja antes de él */
  let head: { el: BlockEl; before: number } | undefined;
  for (let k = from; k < list.length && rejoin < 0; k++) {
    const el = list[k];
    if (!full) {
      // un bloque entero en su hoja y que la abría: si la vuelve a abrir igual, se enlaza con lo anterior
      if (el.classList.contains('page-start') && !el.querySelector('.pg-split')) before.set(el, el.style.getPropertyValue('--gap'));
      unpage(el, k === from && first > 0);
    }
    if ((forced || breaksBefore(el)) && used > 0) {
      // lo que queda libre en la hoja que se cierra se lo llevan sus espacios elásticos (\vfill)
      breakBefore(el, fillPage(here(), pageH - used - notesUsed));
      if (rejoin >= 0) break;
      used = carry;
      head = undefined;
    }
    if (isWrapped(el)) {
      // el texto que sigue la rodea: comparte la altura con él
      here().push({ el, from: 0 });
      continue;
    }
    forced = breaksAfter(el);
    const float = isFloat(el);
    const flow = el.classList.contains('k-atom') && Array.from(content(el).children).some(isFlowAtom);
    const splittable = (el.classList.contains('k-rich') || flow) && !isHeading(el) && !float && !isLandscape(el);
    let frag: Frag = { el, from: 0 };
    let deferred = false;
    for (let guard = 0; guard < 60; guard++) {
      const h = hOf(el) - frag.from;
      const marks = marksOf(el).filter((m) => m.y >= frag.from - 0.5);
      const all = marks.map((m) => m.id);
      if (used + h + notesUsed + needFor(all) <= pageH + 0.5 && !(float && pending.length)) {
        used += h + skipOf(el);
        takeNotes(all);
        break;
      }
      if (float && used > 0) {
        // un flotante que no cabe aquí no deja un hueco: el texto sigue y él abre la hoja siguiente
        el.classList.add('floated');
        pending.push(el);
        deferred = true;
        break;
      }
      // las notas de lo que pueda caber en esta hoja le quitan sitio al texto
      const room0 = pageH - used - notesUsed;
      const reach = marks.filter((m) => m.y < frag.from + room0).map((m) => m.id);
      const room = room0 - needFor(reach);
      // tras un título, LaTeX no deja en la hoja una sola línea del párrafo que lo sigue
      const min = Math.max(head && frag.from === 0 ? 2 : 1, keep);
      const cut = splittable ? splitBlock(el, frag.from, room, z, pageCount, pendingH(), min, keep) : undefined;
      if (cut === 'space') {
        // lo que no cabe es espacio en blanco: se queda asomando bajo la caja de texto
        used += h;
        takeNotes(all);
        break;
      }
      if (cut) {
        here().push({ ...frag, to: cut.top });
        takeNotes(marks.filter((m) => m.y < cut.top).map((m) => m.id));
        const page = turn();
        pageStarts[page] = { el: cut.spacer, split: true, extra: carry };
        // el corte añade al bloque el hueco entre hojas: su altura se vuelve a leer
        heights.delete(el);
        dropFloats(() => yOf(cut.spacer.getBoundingClientRect().bottom));
        frag = { el, from: cut.next };
        used = carry;
        head = undefined;
        continue;
      }
      if (used > 0 && frag.from === 0) {
        // no cabe ni su primera línea: pasa entero, arrastrando consigo el título que lo precede
        if (head && head.before > 0) {
          here().pop();
          breakBefore(head.el, pageH - head.before - notesUsed);
          // (un título arrastrado nunca enlaza con el reparto anterior: lo que le sigue ha cambiado)
          rejoin = -1;
          here().push({ el: head.el, from: 0 });
          used = carry + hOf(head.el);
          head = undefined;
        } else {
          breakBefore(el, pageH - used - notesUsed);
          if (rejoin >= 0) break;
          used = carry;
        }
        continue;
      }
      // más alto que una hoja y sin forma de partirlo: ocupa las que necesite
      let at = frag.from + (pageH - used);
      here().push({ ...frag, to: at });
      takeNotes(all);
      let left = h - (pageH - used);
      turn();
      while (left > pageH) {
        here().push({ el, from: at, to: at + pageH });
        at += pageH;
        left -= pageH;
        turn();
      }
      frag = { el, from: at };
      used = left;
      break;
    }
    if (rejoin >= 0) break;
    if (deferred) continue;
    here().push(frag);
    head = isHeading(el) ? { el, before: used - hOf(el) } : undefined;
  }
  lap('loop');
  if (rejoin >= 0) {
    // desde aquí el documento ya estaba bien repartido: se enlaza con lo que había
    const at = pages.length - 1;
    pages.splice(at, 1, ...old.sheets.slice(rejoin));
    notesOf.push(...old.notes.slice(rejoin));
    old.starts.slice(rejoin + 1).forEach((s, k) => (pageStarts[at + 1 + k] = s));
    pageCount = pages.length;
    if (at !== rejoin) {
      // hay hojas de más o de menos: las que siguen cambian de número y sus flotantes, de altura
      const moved = root.offsetHeight - pagedHeight;
      for (let p = at + 1; p < pages.length; p++) {
        const s = pageStarts[p];
        if (!s) continue;
        const floats = pages[p].filter((f) => f.el.classList.contains('floated'));
        if (s.el === tail || s.split) {
          const strip = s.el.querySelector<HTMLElement>('.pg-strip');
          if (strip) strip.dataset.page = String(p);
        } else s.el.dataset.page = String(p);
        if (!floats.length) continue;
        if (s.el === tail) {
          for (const f of floats) f.el.style.top = `${(parseFloat(f.el.style.top) + moved).toFixed(1)}px`;
          continue;
        }
        const r = s.el.getBoundingClientRect();
        let top = yOf(s.split ? r.bottom : r.top) - s.extra;
        for (const f of floats) {
          f.el.style.top = `${top.toFixed(1)}px`;
          top += f.el.offsetHeight;
        }
      }
      tail.dataset.page = String(pageCount);
    }
  } else {
    // la última hoja se completa hasta su altura (con sus espacios elásticos, si los tiene)
    tail.querySelector('.pg-strip')?.remove();
    let tailH = Math.max(fillPage(here(), pageH - used - notesUsed), 0) + notesUsed;
    if (pending.length) {
      // quedan flotantes sin colocar: ocupan una hoja más, al final
      const page = turn();
      const strip = document.createElement('span');
      strip.className = 'pg-strip';
      strip.dataset.page = String(page);
      strip.style.top = `${Math.round(tailH + mbE)}px`;
      strip.style.left = `${-Math.round(pageInfo.marginLeft * PX_PER_CM)}px`;
      tail.appendChild(strip);
      const y = root.offsetHeight + tailH + mbE + PAGE_GAP + mtE;
      pageStarts[page] = { el: tail, split: false, extra: 0 };
      carry = 0;
      if (!grid) {
        let top = y;
        for (const f of here()) {
          f.el.style.top = `${top.toFixed(1)}px`;
          top += f.el.offsetHeight;
        }
      }
      tailH += mbE + PAGE_GAP + mtE + pageH;
    }
    notesOf.push(notesHere);
    tail.style.height = `${Math.round(tailH)}px`;
    tail.dataset.page = String(pageCount);
  }
  sheets = pages;
  pageNotes = notesOf;

  // número impreso y estilo de cada hoja
  let base = 0;
  let fmt = 'arabic';
  let lm = '';
  let rm = '';
  /** estilo vigente por \pagestyle (el del preámbulo hasta que el cuerpo escriba otro) */
  let running: string = furniture.style;
  pages.forEach((page, p) => {
    const blocks = page.filter((f) => f.from === 0).map((f) => f.el);
    // \pagestyle en una línea propia o suelto en un párrafo: desde esta hoja en adelante. Dentro de
    // un entorno (una hoja horizontal, por ejemplo) vale solo hasta que se cierra: en sus hojas
    let scoped: string | undefined;
    for (const b of blocks) {
      if (b.dataset.pagestyleFrom) running = b.dataset.pagestyleFrom;
      for (const at of Array.from(b.querySelectorAll<HTMLElement>('[data-pagestyle-from]'))) {
        if (at.parentElement?.closest('[data-o^="\\\\begin{"]')) scoped = at.dataset.pagestyleFrom;
        else running = at.dataset.pagestyleFrom ?? running;
      }
    }
    scoped ??= page.map((f) => f.el.querySelector<HTMLElement>('[data-o^="\\\\begin{"] [data-pagestyle-from]')?.dataset.pagestyleFrom).find(Boolean);
    const pn = blocks.map((b) => b.dataset.pagenum ?? b.querySelector<HTMLElement>('[data-pagenum]')?.dataset.pagenum).find(Boolean);
    if (pn) {
      // \pagenumbering: otro formato, y se vuelve a contar desde 1
      fmt = pn;
      base = p;
    }
    const title = page.some((f) => ownPage(f.el));
    const own = blocks.map((b) => b.dataset.pagestyle ?? b.querySelector<HTMLElement>('[data-pagestyle]')?.dataset.pagestyle).find(Boolean);
    for (const b of blocks) {
      const h = b.querySelector<HTMLElement>(':scope > .content > [data-k="head"]');
      if (!h) continue;
      const num = h.querySelector('.secnum, .chapnum')?.textContent ?? '';
      const text = `${num ? `${num.replace(/\.$/, '')}. ` : ''}${Array.from(h.childNodes).filter((n) => !(n instanceof HTMLElement && n.classList.contains('deco'))).map((n) => n.textContent).join('').trim()}`;
      const top = chaptered() ? 'H1' : 'H2';
      if (h.tagName === top) {
        lm = text;
        rm = '';
      } else if (h.tagName === (top === 'H1' ? 'H2' : 'H3')) rm = text;
    }
    const num = title ? '' : pageNumber(p - base + 1, fmt);
    pageMeta.push({ num, style: title ? 'empty' : own ?? scoped ?? running, notes: notesOf[p] ?? [], marks: [lm, rm] });
    pageNums.push(num);
    // como en LaTeX, tras la portada la numeración vuelve a empezar (salvo en un libro, que sigue contando)
    if (title && !/book$/.test(layout?.cls ?? '')) base = p + 1;
  });

  if (grid) {
    layoutGrid(pages, cols, skipOf);
    updateRuler();
  }
  lap('meta');
  drawFurniture(noteHtml, grid ? cols : 0, z);
  fillPageRefs(z);
  lap('furniture');
  perf.full = full ? 1 : 0;
  perf.pagesDone = rejoin >= 0 ? pages.length - (old.sheets.length - rejoin) - first : pages.length - first;
  updateStatus();
}

/** El sitio al que apunta un enlace interno: un elemento con ese `id`, o el bloque que lo lleva anotado. */
function anchorOf(id: string): HTMLElement | null {
  return document.getElementById(id) ?? root.querySelector<HTMLElement>(`.block[data-anchors~="${CSS.escape(id)}"]`);
}

/**
 * `\dotfill`, `\hrulefill` y `\hfill` ocupan lo que queda libre en su línea (a partes iguales si hay varios).
 * Se mide con el relleno a cero: lo que falta para llenar la línea es lo suyo.
 */
function sizeFills(el: HTMLElement, z: number): void {
  const fills = Array.from(el.querySelectorAll<HTMLElement>('.dotfill, .hrulefill, .hfill'));
  if (!fills.length) return;
  for (const f of fills) f.style.width = '0px';
  const done = new Set<HTMLElement>();
  for (const f of fills) {
    if (done.has(f)) continue;
    // caja que hace de línea: el primer antepasado que no va en línea
    let box = f.parentElement as HTMLElement;
    while (box !== el && /^inline/.test(getComputedStyle(box).display)) box = box.parentElement as HTMLElement;
    // (en una celda el ancho lo fija el contenido: no hay hueco que repartir)
    if (box.closest('td, th')) continue;
    const y = f.getBoundingClientRect().bottom;
    const range = document.createRange();
    range.selectNodeContents(box);
    let left = Infinity;
    let right = -Infinity;
    for (const r of Array.from(range.getClientRects())) {
      if (r.width < 0.5 || r.top > y + 1 || r.bottom < y - 1) continue;
      // (la propia caja también da un rectángulo si es un elemento en línea de varias líneas)
      if (r.height > 3 * parseFloat(getComputedStyle(box).fontSize)) continue;
      left = Math.min(left, r.left);
      right = Math.max(right, r.right);
    }
    const cs = getComputedStyle(box);
    const inner = box.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const used = right > left ? (right - left) / z : 0;
    const same = fills.filter((g) => !done.has(g) && box.contains(g) && Math.abs(g.getBoundingClientRect().bottom - y) < 2);
    const free = Math.max(inner - used - 1, 0);
    for (const g of same) {
      g.style.width = `${Math.floor((free / same.length) * 100) / 100}px`;
      done.add(g);
    }
  }
}

/**
 * Escribe en cada `\pageref` el número de la hoja donde cae su etiqueta. Solo lo sabe el reparto en
 * hojas: el documento llega con un «?» en su lugar, que es lo que queda en la vista continua.
 */
function fillPageRefs(z: number): void {
  const refs = document.querySelectorAll<HTMLElement>('#root a.pageref[data-ref], #mirrors a.pageref[data-ref], #root a.toc-page[data-page-of], #mirrors a.toc-page[data-page-of]');
  if (!refs.length) return;
  for (const a of Array.from(refs)) {
    // las entradas del índice llevan la página de su título; si no se sabe (vista continua), nada
    const toc = a.dataset.pageOf;
    const target = toc ? anchorOf(toc) : document.getElementById(`lbl-${a.dataset.ref}`);
    const block = target?.closest('.block') as BlockEl | null | undefined;
    let num = toc ? '' : '?';
    // \pageref{LastPage}: la última hoja numerada
    if (!target && /^(?:LastPage|lastpage|TotPages)$/.test(a.dataset.ref ?? '')) num = [...pageNums].reverse().find(Boolean) ?? '?';
    else if (target && block && sheets.length) {
      // altura de la etiqueta dentro de su bloque: un párrafo partido entre dos hojas la tiene en una de ellas
      const y = (target.getBoundingClientRect().top - block.getBoundingClientRect().top) / z;
      const p = sheets.findIndex((page) => page.some((f) => f.el === block && y >= f.from - 0.5 && (f.to === undefined || y < f.to)));
      if (p >= 0 && pageNums[p]) num = pageNums[p];
    }
    if (a.textContent !== num) a.textContent = num;
  }
}

/** Esquina superior izquierda de la caja de texto de la hoja `p`, en coordenadas del documento. */
function pageOrigin(p: number, cols: number, z: number): { x: number; y: number } | undefined {
  if (cols > 0) {
    const w = pageInfo.pageW * PX_PER_CM;
    const h = pageInfo.pageH * PX_PER_CM;
    return { x: (p % cols) * (w + GRID_GAP) + pageInfo.marginLeft * PX_PER_CM, y: Math.floor(p / cols) * (h + GRID_GAP) + pageInfo.marginTop * PX_PER_CM };
  }
  if (p === 0) return { x: 0, y: lead.top };
  const s = pageStarts[p];
  if (!s) return undefined;
  const rootTop = root.getBoundingClientRect().top;
  const r = s.el.getBoundingClientRect();
  if (s.el === tail) {
    const strip = tail.querySelector<HTMLElement>('.pg-strip');
    return strip ? { x: 0, y: (strip.getBoundingClientRect().bottom - rootTop) / z + pageInfo.marginTop * PX_PER_CM } : undefined;
  }
  return { x: 0, y: ((s.split ? r.bottom : r.top) - rootTop) / z - s.extra + lead.top };
}

/** Dibuja en cada hoja su encabezado, su pie y sus notas al pie. */
function drawFurniture(noteHtml: string[], cols: number, z: number): void {
  furnEl.style.left = `${root.offsetLeft}px`;
  furnEl.style.top = `${root.offsetTop}px`;
  const th = (pageInfo.pageH - pageInfo.marginTop - pageInfo.marginBottom) * PX_PER_CM;
  const pt = 0.03515 * PX_PER_CM;
  const last = [...pageMeta].reverse().find((m) => m.num)?.num ?? '';
  const parts: string[] = [];
  const fill = (html: string, m: PageMeta): string =>
    html
      .replace(/\u0002PAGE\u0002/g, m.num)
      .replace(/\u0002LAST\u0002/g, last)
      .replace(/\u0002LM\u0002/g, `<span class="pg-mark">${escHtml(m.marks[0])}</span>`)
      .replace(/\u0002RM\u0002/g, `<span class="pg-mark">${escHtml(m.marks[1])}</span>`);
  const row = (cls: string, cells: [string, string, string], m: PageMeta, x: number, y: number, rule: boolean): void => {
    // (también vacío: un doble clic en el margen de arriba o de abajo abre el diálogo para escribirlo)
    const blank = !cells.some(Boolean);
    const what = cls === 'pg-head' ? 'el encabezado' : 'el pie de página';
    parts.push(
      `<div class="${cls}${rule && !blank ? ' ruled' : ''}${blank ? ' blank' : ''}" data-hf="${cls === 'pg-head' ? 'head' : 'foot'}" title="Doble clic para editar ${what}" style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px">` +
        cells.map((c, i) => `<span class="pg-${'lcr'[i]}">${fill(c, m)}</span>`).join('') +
        '</div>',
    );
  };
  pageMeta.forEach((m, p) => {
    const o = pageOrigin(p, cols, z);
    if (!o) return;
    if (m.notes.length) {
      parts.push(`<div class="pg-notes" style="left:${o.x.toFixed(1)}px;top:${(o.y + th).toFixed(1)}px">${m.notes.map((i) => noteHtml[i] ?? '').join('')}</div>`);
    }
    if (m.style === 'empty') return;
    // las hojas que abren capítulo o llevan el título solo tienen el número, centrado al pie
    const plain = m.style === 'plain';
    const head: [string, string, string] = plain ? ['', '', ''] : furniture.head;
    const foot: [string, string, string] = plain ? ['', '\u0002PAGE\u0002', ''] : furniture.foot;
    // LaTeX deja el encabezado 25 pt por encima del texto y la línea base del pie 30 pt por debajo
    row('pg-head', head, m, o.x, o.y - 25 * pt, !plain && furniture.headRule);
    row('pg-foot', foot, m, o.x, o.y + th + 30 * pt, !plain && furniture.footRule);
  });
  furnEl.innerHTML = parts.join('');
}

/**
 * Vista de varias páginas: el reparto es el mismo que en la vista de una hoja, pero cada trozo se
 * traslada a la hoja que le toca dentro de un mosaico de `cols` por fila. El documento sigue
 * siendo el mismo (se puede seleccionar y escribir). De un párrafo partido entre dos hojas, el
 * bloque real muestra su primer trozo y la continuación es una copia de solo lectura.
 */
function layoutGrid(pages: Frag[][], cols: number, skipOf: (el: BlockEl) => number): void {
  const w = pageInfo.pageW * PX_PER_CM;
  const h = pageInfo.pageH * PX_PER_CM;
  const ml = pageInfo.marginLeft * PX_PER_CM;
  const mt = pageInfo.marginTop * PX_PER_CM - lead.top;
  // primero se mide todo (posición natural de cada bloque) y después se coloca
  const jobs: { f: Frag; x: number; y: number; top: number; height: number; width: number; first: boolean }[] = [];
  const seen = new Set<BlockEl>();
  pages.forEach((page, p) => {
    const x = (p % cols) * (w + GRID_GAP) + ml;
    let y = Math.floor(p / cols) * (h + GRID_GAP) + mt;
    for (const f of page) {
      const height = f.el.offsetHeight;
      const floated = f.el.classList.contains('floated');
      jobs.push({ f, x, y: y - f.from, top: floated ? 0 : f.el.offsetTop, height, width: f.el.offsetWidth, first: !seen.has(f.el) });
      seen.add(f.el);
      if (!isWrapped(f.el)) y += (f.to ?? height + skipOf(f.el)) - f.from;
    }
  });
  mirrorsEl.style.left = `${root.offsetLeft}px`;
  mirrorsEl.style.top = `${root.offsetTop}px`;
  for (const j of jobs) {
    const whole = j.f.from === 0 && j.f.to === undefined;
    // lo que no es de este trozo queda recortado (por los lados se deja asomar lo que sobresalga)
    const clip = whole ? '' : `inset(${j.f.from > 0 ? `${j.f.from.toFixed(1)}px` : '-60px'} -60px ${(j.height - (j.f.to ?? j.height)).toFixed(1)}px -60px)`;
    if (j.first) {
      j.f.el.style.transform = `translate(${j.x.toFixed(1)}px, ${(j.y - j.top).toFixed(1)}px)`;
      if (clip) j.f.el.style.clipPath = clip;
      continue;
    }
    const m = j.f.el.cloneNode(true) as HTMLElement;
    m.classList.remove('active', 'sel', 'xs', 'page-start');
    m.classList.add('mirror');
    m.inert = true;
    m.removeAttribute('data-i');
    m.querySelector(':scope > .tools')?.remove();
    m.querySelectorAll('[id]').forEach((n) => n.removeAttribute('id'));
    // un lienzo clonado sale en blanco: se le copia el dibujo
    const drawn = j.f.el.querySelectorAll('canvas');
    m.querySelectorAll('canvas').forEach((c, i) => {
      try {
        c.getContext('2d')?.drawImage(drawn[i], 0, 0);
      } catch {
        // lienzo sin dibujo todavía
      }
    });
    m.style.width = `${j.width}px`;
    m.style.transform = `translate(${j.x.toFixed(1)}px, ${j.y.toFixed(1)}px)`;
    m.style.clipPath = clip;
    mirrorsEl.appendChild(m);
  }
  const rows = Math.ceil(pages.length / cols);
  pageEl.style.width = `${Math.round(Math.min(cols, pages.length) * (w + GRID_GAP) - GRID_GAP)}px`;
  pageEl.style.height = `${Math.round(rows * (h + GRID_GAP) - GRID_GAP)}px`;
  // las hojas, detrás del contenido
  while (sheetsEl.children.length > pages.length) sheetsEl.lastElementChild?.remove();
  while (sheetsEl.children.length < pages.length) {
    const sheet = document.createElement('div');
    sheet.className = 'ov-sheet';
    sheet.innerHTML = '<button class="ov-num" title="Abrir esta página"></button>';
    sheetsEl.appendChild(sheet);
  }
  Array.from(sheetsEl.children).forEach((sheet, p) => {
    const s = sheet as HTMLElement;
    s.style.left = `${Math.round((p % cols) * (w + GRID_GAP))}px`;
    s.style.top = `${Math.round(Math.floor(p / cols) * (h + GRID_GAP))}px`;
    s.style.width = `${Math.round(w)}px`;
    s.style.height = `${Math.round(h)}px`;
    s.dataset.page = String(p);
    (s.firstElementChild as HTMLElement).textContent = pageNums[p] ?? String(p + 1);
  });
}

/** En la vista de varias páginas, un clic en el número de una hoja (o doble clic en ella) la abre a tamaño de lectura. */
sheetsEl.addEventListener('click', (e) => {
  const sheet = (e.target as HTMLElement).closest('.ov-num')?.parentElement as HTMLElement | null;
  if (sheet) openPage(Number(sheet.dataset.page));
});
sheetsEl.addEventListener('dblclick', (e) => {
  const sheet = (e.target as HTMLElement).closest('.ov-sheet') as HTMLElement | null;
  if (sheet) openPage(Number(sheet.dataset.page));
});

/** Borde superior, en la ventana, de la hoja `index` (desde 0) en la vista de una hoja por fila. */
function pageTop(index: number): number | undefined {
  if (index <= 0) return vrect(pageEl).top;
  const z = pageEl.offsetWidth ? pageEl.getBoundingClientRect().width / pageEl.offsetWidth : 1;
  const o = pageOrigin(index, 0, z);
  return o ? vrect(root).top + (o.y - pageInfo.marginTop * PX_PER_CM) * currentZoom() : undefined;
}

function openPage(index: number): void {
  zoom = 'fit';
  applyZoom();
  paginate();
  const top = pageTop(index);
  if (top !== undefined) window.scrollTo({ top: window.scrollY + top - toolbar.offsetHeight - 12 });
}

let paginateTimer: number | undefined;
function schedulePaginate(all = true): void {
  // sin saber qué ha cambiado, se reparte todo; quien lo sabe marca sus bloques en `dirty`
  if (all) dirtyAll = true;
  window.clearTimeout(paginateTimer);
  paginateTimer = window.setTimeout(paginate, 80);
}
/** Repaginar cuando cambia la altura del contenido (al escribir, al cargar imágenes...). */
new ResizeObserver(() => {
  // el propio reparto cambia el alto del documento: ese aviso no es un cambio nuevo
  if (root.offsetHeight === pagedHeight && !dirty.size) return;
  schedulePaginate(dirty.size === 0);
}).observe(root);
// las fuentes del documento llegan después del primer dibujo y cambian dónde rompe cada línea
// una imagen que termina de cargarse cambia el alto de su bloque
root.addEventListener(
  'load',
  (e) => {
    const el = (e.target as HTMLElement | null)?.closest?.('#root > .block') as BlockEl | null;
    if (el) dirty.add(el);
    schedulePaginate(!el);
  },
  true,
);
window.addEventListener('resize', () => {
  applyZoom();
  // la barra de estado se abrevia o se despliega según el ancho
  updateStatus();
});

// ------------------------------------------------------------------ regla

const rulerEl = document.createElement('div');
rulerEl.id = 'ruler';
rulerEl.innerHTML =
  '<div class="rl-sheet"><div class="rl-ticks"></div><div class="rl-m rl-left"></div><div class="rl-m rl-right"></div>' +
  '<div class="rl-h" data-side="left" tabindex="0" role="slider" aria-label="Margen izquierdo"></div>' +
  '<div class="rl-h" data-side="right" tabindex="0" role="slider" aria-label="Margen derecho"></div></div>';
/** línea que baja del tirador por toda la hoja mientras se arrastra, y la medida que lleva */
const guideEl = document.createElement('div');
guideEl.id = 'rl-guide';
guideEl.hidden = true;
const tipEl = document.createElement('div');
tipEl.id = 'rl-tip';
tipEl.hidden = true;
document.body.append(guideEl, tipEl);
const cmText = (cm: number): string => `${Math.round(cm * 100) / 100}cm`;
/** centímetros como se leen: con coma y sin ceros de más (2,5 · 2,54 · 3) */
const cmShown = (cm: number): string => String(Math.round(cm * 100) / 100).replace('.', ',');
const RULER_HINT = 'arrastra para cambiarlo (Mayús: de 5 en 5 mm · Alt: décimas de milímetro · Ctrl: los dos a la vez) · flechas del teclado: milímetro a milímetro · doble clic: escribir la medida';
let dragMargin: { side: 'left' | 'right'; value: number; grab: number; both: boolean } | undefined;

/** Coloca la regla sobre la hoja: centímetros y milímetros, márgenes sombreados y tiradores. */
function updateRuler(): void {
  if (!rulerEl.isConnected) toolbar.appendChild(rulerEl);
  // con varias hojas por fila no hay una sola caja de texto que medir
  rulerEl.hidden = viewMode !== 'page' || document.body.classList.contains('grid');
  if (rulerEl.hidden) return;
  const sheet = vrect(pageEl);
  const cm = sheet.width / pageInfo.pageW;
  const inner = rulerEl.firstElementChild as HTMLElement;
  // posiciones exactas, sin redondear al píxel: medio píxel de más ya descuadra las marcas con el texto
  inner.style.left = `${(sheet.left - rulerEl.getBoundingClientRect().left).toFixed(2)}px`;
  inner.style.width = `${sheet.width.toFixed(2)}px`;
  inner.style.setProperty('--cmz', `${cm}px`);
  const ml = dragMargin && (dragMargin.side === 'left' || dragMargin.both) ? dragMargin.value : pageInfo.marginLeft;
  const mr = dragMargin && (dragMargin.side === 'right' || dragMargin.both) ? dragMargin.value : pageInfo.marginRight;
  (inner.querySelector('.rl-left') as HTMLElement).style.width = `${ml * cm}px`;
  (inner.querySelector('.rl-right') as HTMLElement).style.width = `${mr * cm}px`;
  const left = inner.querySelector('[data-side="left"]') as HTMLElement;
  const right = inner.querySelector('[data-side="right"]') as HTMLElement;
  left.style.left = `${ml * cm}px`;
  right.style.left = `${(pageInfo.pageW - mr) * cm}px`;
  left.title = `Margen izquierdo: ${cmShown(ml)} cm · ${RULER_HINT}`;
  right.title = `Margen derecho: ${cmShown(mr)} cm · ${RULER_HINT}`;
  left.setAttribute('aria-valuenow', String(ml));
  right.setAttribute('aria-valuenow', String(mr));
  rulerEl.classList.toggle('fixed', layout === undefined);
  // cuánto detalle cabe: milímetros si un centímetro ocupa bastante, medios centímetros o solo centímetros
  inner.dataset.density = cm >= 34 ? 'mm' : cm >= 15 ? 'half' : 'cm';
  // números cada centímetro (o cada dos si no caben), contados desde el margen izquierdo
  const step = cm < 26 ? 2 : 1;
  let marks = '';
  for (let i = step; i < pageInfo.pageW - ml; i += step) marks += `<span style="left:${((ml + i) * cm).toFixed(2)}px"${i > pageInfo.pageW - ml - mr ? ' class="out"' : ''}>${i}</span>`;
  const ticks = inner.querySelector('.rl-ticks') as HTMLElement;
  ticks.innerHTML = marks;
  ticks.style.backgroundPositionX = `${ml * cm}px`;
}

/** Enseña la guía y la medida del margen que se está moviendo. */
function showGuide(side: 'left' | 'right', value: number, both: boolean): void {
  const sheet = vrect(pageEl);
  const cm = sheet.width / pageInfo.pageW;
  const x = side === 'left' ? sheet.left + value * cm : sheet.right - value * cm;
  const other = both ? value : side === 'left' ? pageInfo.marginRight : pageInfo.marginLeft;
  guideEl.style.left = `${x.toFixed(1)}px`;
  guideEl.style.top = `${rulerEl.getBoundingClientRect().bottom}px`;
  guideEl.hidden = false;
  tipEl.textContent = `${both ? 'Márgenes laterales' : side === 'left' ? 'Margen izquierdo' : 'Margen derecho'}: ${cmShown(value)} cm  ·  texto: ${cmShown(pageInfo.pageW - value - other)} cm`;
  tipEl.hidden = false;
  const w = tipEl.offsetWidth;
  tipEl.style.left = `${Math.min(Math.max(x - w / 2, 8), document.documentElement.clientWidth - w - 8).toFixed(0)}px`;
  tipEl.style.top = `${rulerEl.getBoundingClientRect().bottom + 8}px`;
}

function hideGuide(): void {
  guideEl.hidden = true;
  tipEl.hidden = true;
}

/** Margen dentro de lo razonable: al menos medio centímetro y dejando 4 cm de texto. */
function clampMargin(value: number, other: number): number {
  return Math.round(Math.min(Math.max(value, 0.5), pageInfo.pageW - other - 4) * 100) / 100;
}

rulerEl.addEventListener('mousedown', (e) => {
  const h = (e.target as HTMLElement).closest('.rl-h') as HTMLElement | null;
  if (!h || !layout) return;
  e.preventDefault();
  const side = h.dataset.side as 'left' | 'right';
  const box = h.getBoundingClientRect();
  // se arrastra desde donde se cogió: el tirador no salta a ponerse bajo el puntero
  dragMargin = { side, value: side === 'left' ? pageInfo.marginLeft : pageInfo.marginRight, grab: e.clientX - (box.left + box.width / 2), both: false };
  document.body.classList.add('resizing');
  showGuide(side, dragMargin.value, false);
});
document.addEventListener('mousemove', (e) => {
  if (!dragMargin) return;
  const sheet = vrect(pageEl);
  const cm = sheet.width / pageInfo.pageW;
  const x = e.clientX - dragMargin.grab;
  const raw = dragMargin.side === 'left' ? (x - sheet.left) / cm : (sheet.right - x) / cm;
  // de milímetro en milímetro; con Mayús de cinco en cinco y con Alt, décimas de milímetro
  const step = e.altKey ? 0.01 : e.shiftKey ? 0.5 : 0.1;
  dragMargin.both = e.ctrlKey || e.metaKey;
  const other = dragMargin.both ? 0 : dragMargin.side === 'left' ? pageInfo.marginRight : pageInfo.marginLeft;
  dragMargin.value = clampMargin(Math.round(raw / step) * step, dragMargin.both ? clampMargin(Math.round(raw / step) * step, 0) : other);
  const px = `${(dragMargin.value * PX_PER_CM).toFixed(2)}px`;
  if (dragMargin.side === 'left' || dragMargin.both) pageEl.style.setProperty('--ml', px);
  if (dragMargin.side === 'right' || dragMargin.both) pageEl.style.setProperty('--mr', px);
  updateRuler();
  showGuide(dragMargin.side, dragMargin.value, dragMargin.both);
});
document.addEventListener('mouseup', () => {
  if (!dragMargin) return;
  const d = dragMargin;
  dragMargin = undefined;
  document.body.classList.remove('resizing');
  hideGuide();
  if (d.both) setMargins({ left: d.value, right: d.value });
  else if (d.value !== (d.side === 'left' ? pageInfo.marginLeft : pageInfo.marginRight)) setMargins({ [d.side]: d.value });
  else updateRuler();
});
// con el teclado: flechas de milímetro en milímetro (Mayús: 5 mm; Alt: décimas), Intro para escribir la medida
rulerEl.addEventListener('keydown', (e) => {
  const h = (e.target as HTMLElement).closest('.rl-h') as HTMLElement | null;
  if (!h || !layout) return;
  const side = h.dataset.side as 'left' | 'right';
  if (e.key === 'Enter') {
    e.preventDefault();
    askMargins();
    return;
  }
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  const step = e.altKey ? 0.01 : e.shiftKey ? 0.5 : 0.1;
  // hacia fuera de la hoja el margen encoge; hacia dentro, crece
  const grow = (e.key === 'ArrowRight') === (side === 'left') ? 1 : -1;
  const now = side === 'left' ? pageInfo.marginLeft : pageInfo.marginRight;
  const value = clampMargin(Math.round((now + grow * step) * 100) / 100, side === 'left' ? pageInfo.marginRight : pageInfo.marginLeft);
  if (value !== now) setMargins({ [side]: value });
});
rulerEl.addEventListener('dblclick', (e) => {
  if (!(e.target as HTMLElement).closest('.rl-h, .rl-m') || !layout) return;
  e.preventDefault();
  askMargins();
});

/** Pide los márgenes laterales por escrito, para fijarlos con la medida exacta. */
function askMargins(): void {
  const read = (s: string, fallback: number): number => {
    const n = parseFloat(s.replace(',', '.'));
    return Number.isFinite(n) ? n : fallback;
  };
  form(
    'Márgenes laterales',
    [
      { id: 'left', label: 'Izquierdo (cm)', value: cmShown(pageInfo.marginLeft) },
      { id: 'right', label: 'Derecho (cm)', value: cmShown(pageInfo.marginRight) },
    ],
    (v) => {
      const left = clampMargin(read(v.left, pageInfo.marginLeft), 0);
      const right = clampMargin(read(v.right, pageInfo.marginRight), left);
      setMargins({ left, right });
    },
  );
}

/** Escribe los márgenes en el preámbulo (en centímetros). */
function setMargins(change: Partial<Record<'top' | 'bottom' | 'left' | 'right', number>>): void {
  const m = { top: pageInfo.marginTop, bottom: pageInfo.marginBottom, left: pageInfo.marginLeft, right: pageInfo.marginRight, ...change };
  if (active) flush(active);
  post({ type: 'layout', patch: { margins: [m.top, m.bottom, m.left, m.right].map(cmText).join(',') } });
}

function updateStatus(): void {
  const words = els.reduce((n, el) => n + (el._b?.kind === 'rich' ? (content(el).textContent ?? '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0), 0);
  // en un panel estrecho todo se abrevia para que la barra siga cabiendo en una línea
  const tight = document.documentElement.clientWidth < 780;
  const pages = viewMode === 'page' && pageInfo.columns === 1
    ? `<span title="Página actual y total">${tight ? '' : 'Página '}${Math.min(currentPage, pageCount)}${tight ? '/' : ' de '}${pageCount}${loaded < 1 ? '…' : ''}</span>`
    : '';
  const loading = loaded < 1 ? `<span class="st-load" title="El resto del documento se está dibujando"><i class="codicon codicon-loading codicon-modifier-spin"></i> ${Math.round(loaded * 100)} %</span>` : '';
  const b = (cmd: string, arg: string, label: string, title: string, on = false): string =>
    `<button data-cmd="${cmd}" data-arg="${arg}" title="${title}" class="${on ? 'on' : ''}">${label}</button>`;
  const misspelled =
    spellInfo.enabled && spellCount ? b('spell-next', '', `<i class="codicon codicon-warning"></i> ${spellCount}`, 'Palabras sin reconocer: ir a la siguiente') : '';
  // un capítulo: de qué documento toma el preámbulo y la numeración, y cómo ir a él
  const part = partOf ? b('open-root', '', `<i class="codicon codicon-references"></i> ${tight ? '' : 'Parte de '}${escHtml(partOf)}`, 'Este archivo es un capítulo de ese documento: se dibuja con su preámbulo y su numeración. Pulsa para abrirlo') : '';
  statusEl.innerHTML =
    `<span class="st-left">${b('nav', '', '<i class="codicon codicon-list-tree"></i>', 'Panel de navegación', navOpen)}${pages}${loading}<span title="Palabras del documento">${words}${tight ? ' pal.' : ' palabras'}</span>${misspelled}${issues.length ? b('issues', '', `<i class="codicon codicon-warning"></i> ${issues.length}${tight ? '' : issues.length === 1 ? ' aviso' : ' avisos'}`, 'Referencias o citas sin definir, etiquetas repetidas, imágenes que faltan: lo que LaTeX avisaría al compilar') : ''}${part}${readOnly ? `<span class="st-ro" title="Versión antigua: solo lectura"><i class="codicon codicon-lock"></i>${tight ? '' : ' Solo lectura'}</span>` : ''}</span>` +
    '<span class="st-right">' +
    b('git', '', `<i class="codicon codicon-git-compare"></i>${gitOpen && gitState.changes.length ? ` ${gitState.changes.length}` : ''}`, 'Cambios e historial del documento (git)', gitOpen) +
    '<span class="st-sep"></span>' +
    b('view', 'page', '<i class="codicon codicon-file"></i>', 'Vista de página', viewMode === 'page') +
    b('view', 'flow', '<i class="codicon codicon-list-flat"></i>', 'Vista continua', viewMode === 'flow') +
    '<span class="st-sep"></span>' +
    b('zoom', '-', '<i class="codicon codicon-remove"></i>', 'Alejar') +
    b('zoom', 'fit', `${Math.round(currentZoom() * 100)} %`, 'Ajuste automático al ancho del panel', zoom === 'fit') +
    b('zoom', '+', '<i class="codicon codicon-add"></i>', 'Acercar') +
    '</span>';
}

statusEl.addEventListener('mousedown', (e) => e.preventDefault());
statusEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button[data-cmd]') as HTMLElement | null;
  if (b) run(b.dataset.cmd as string, b.dataset.arg);
});

/** Lista de fuentes del menú «Insertar cita». */
function updateSources(): void {
  const list = toolbar.querySelector('#cite-list');
  if (!list) return;
  list.innerHTML = sources.length
    ? sources.map((s) => `<button data-cmd="cite" data-arg="${escHtml(s.key)}" class="mi src"><b>${escHtml(s.key)}</b><span>${escHtml(s.label)}</span></button>`).join('')
    : '<div class="menu-empty">Aún no hay fuentes en este documento.</div>';
}

// el foco no debe salir del texto al usar la barra
toolbar.addEventListener('mousedown', (e) => e.preventDefault());
toolbar.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const tab = t.closest('.tab') as HTMLElement | null;
  if (tab) {
    closeMenus();
    const id = tab.dataset.tab as string;
    // cinta minimizada: la pestaña despliega sus botones un momento; pulsarla otra vez los recoge
    if (ribbonMin) toolbar.classList.toggle('peek', !(toolbar.classList.contains('peek') && currentTab === id));
    showTab(id);
    return;
  }
  const more = t.closest('.rb-more') as HTMLElement | null;
  if (more) {
    closeMenus();
    const p = toolbar.querySelector<HTMLElement>('.panel.on');
    p?.scrollBy({ left: Number(more.dataset.scroll) * p.clientWidth * 0.7, behavior: 'smooth' });
    return;
  }
  const cell = t.closest('.grid-pick span') as HTMLElement | null;
  if (cell) {
    closeMenus();
    run('ins-grid', `${cell.dataset.r},${cell.dataset.c}`);
    return;
  }
  const dd = t.closest('.dd-btn');
  if (dd) {
    const parent = dd.parentElement as HTMLElement;
    const open = parent.classList.contains('open');
    closeMenus();
    parent.classList.toggle('open', !open);
    if (!open) placeMenu(parent);
    return;
  }
  const b = t.closest('button[data-cmd]') as HTMLElement | null;
  if (!b) return;
  closeMenus();
  // (con la cinta minimizada, usar un botón la recoge de nuevo)
  if (b.dataset.cmd !== 'ribbon-min') toolbar.classList.remove('peek');
  run(b.dataset.cmd as string, b.dataset.arg || undefined);
});
toolbar.addEventListener('dblclick', (e) => {
  if ((e.target as HTMLElement).closest('.tab')) setRibbonMin(!ribbonMin);
});
document.addEventListener('mousedown', (e) => {
  if (ribbonMin && !toolbar.contains(e.target as Node)) toolbar.classList.remove('peek');
});
document.addEventListener(
  'keydown',
  (e) => {
    if (e.key !== 'F1' || !e.ctrlKey || e.altKey || e.shiftKey) return;
    e.preventDefault();
    setRibbonMin(!ribbonMin);
  },
  true,
);
// selector de tabla en cuadrícula, como el de Word
toolbar.addEventListener('mouseover', (e) => {
  const cell = (e.target as HTMLElement).closest('.grid-pick span') as HTMLElement | null;
  if (!cell) return;
  const r = Number(cell.dataset.r);
  const c = Number(cell.dataset.c);
  toolbar.querySelectorAll<HTMLElement>('.grid-pick span').forEach((s) => s.classList.toggle('on', Number(s.dataset.r) <= r && Number(s.dataset.c) <= c));
  const label = toolbar.querySelector('#grid-label');
  if (label) label.textContent = `Tabla de ${r} × ${c}`;
});
document.addEventListener('mousedown', (e) => {
  if (!(e.target as HTMLElement).closest('.dd')) closeMenus();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && brush) setBrush(undefined);
});
emptyEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button[data-cmd]') as HTMLElement | null;
  if (b) run(b.dataset.cmd as string, b.dataset.arg || undefined);
});

// doble clic en un párrafo de un archivo incluido: se abre ese archivo, en ese párrafo, para editarlo
root.addEventListener(
  'dblclick',
  (e) => {
    const block = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('.inc-block');
    const file = block?.closest('.included')?.querySelector<HTMLElement>(':scope > .inc-bar')?.dataset.file;
    if (!block || !file) return;
    e.preventDefault();
    e.stopPropagation();
    post({ type: 'openFile', file, line: Number(block.dataset.line) || 0 });
  },
  true,
);

// un archivo traído con \input: su etiqueta lo abre en el editor visual
root.addEventListener(
  'click',
  (e) => {
    const bar = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('.inc-bar');
    if (!bar) return;
    e.preventDefault();
    e.stopPropagation();
    post({ type: 'openFile', file: bar.dataset.file });
  },
  true,
);

// ------------------------------------------------------------------ plantillas (documento vacío)

/** Boceto de la primera hoja de una plantilla: título, líneas de texto y lo que la distingue. */
function tplThumb(id: string): string {
  const line = (w: number, cls = ''): string => `<i class="tl ${cls}" style="width:${w}%"></i>`;
  const text = (n: number): string => Array.from({ length: n }, (_, k) => line(k === n - 1 ? 62 : 100)).join('');
  switch (id) {
    case 'report': return line(70, 'tt c') + line(34, 'c') + '<i class="tgap"></i>' + line(46, 'th') + text(3) + line(46, 'th') + text(2);
    case 'thesis': return '<i class="tgap"></i>' + line(78, 'tt c') + line(52, 'tt c') + '<i class="tgap"></i>' + line(30, 'c') + '<i class="tgap"></i><i class="tgap"></i>' + line(40, 'c') + line(24, 'c');
    case 'homework': return line(56, 'tt') + line(40, 'th') + text(2) + line(60, 'tm c') + line(40, 'th') + line(86, 'tb') + line(72, 'tb');
    case 'letter': return line(38, 'r') + '<i class="tgap"></i>' + line(44) + line(36) + '<i class="tgap"></i>' + text(4) + '<i class="tgap"></i>' + line(30);
    default: return line(64, 'tt c') + line(30, 'c') + '<i class="tgap"></i>' + line(40, 'th') + text(5);
  }
}

const TEMPLATE_CARDS: [id: string, icon: string, name: string, about: string][] = [
  ['article', 'file-text', 'Artículo', 'Título, secciones y texto'],
  ['report', 'book', 'Informe', 'Capítulos, resumen e índice'],
  ['thesis', 'mortar-board', 'Tesis', 'Un archivo por capítulo'],
  ['homework', 'checklist', 'Tarea', 'Ejercicios con solución'],
  ['letter', 'mail', 'Carta', 'Fecha, destinatario y firma'],
];
emptyEl.innerHTML =
  '<div class="tpl-title">Documento nuevo</div><div class="tpl-sub">Elige una plantilla para empezar</div><div class="tpls">' +
  TEMPLATE_CARDS.map(
    ([id, icon, name, about]) =>
      `<button data-cmd="newdoc" data-arg="${id}" class="tpl"><span class="tpl-thumb t-${id}" title="${icon}">${tplThumb(id)}</span><b>${name}</b><span>${about}</span></button>`,
  ).join('') +
  '</div><button data-cmd="start" class="tpl-blank">o empieza con una página en blanco</button>';

// ------------------------------------------------------------------ panel de navegación

const NAV_WIDTH = 250;
const navEl = document.createElement('div');
navEl.id = 'nav';
document.body.appendChild(navEl);
let navOpen = document.documentElement.clientWidth >= 1250;
// (el sitio del panel se reserva desde el principio: lo que se mida después ya cuenta con él)
document.body.classList.toggle('nav-open', navOpen);
/** El esquema ocupa una columna propia solo si el panel es lo bastante ancho; si no, flota. */
function navDocked(): boolean {
  return navOpen && document.documentElement.clientWidth >= 900;
}
let currentPage = 1;
const HEAD_LEVEL: Record<string, number> = { part: 0, chapter: 0, section: 1, subsection: 2, subsubsection: 3 };

/** Texto de un título, sin su número ni lo que no se escribe. */
const headText = (head: HTMLElement): string =>
  Array.from(head.childNodes).filter((n) => !(n.nodeType === 1 && (n as Element).hasAttribute('data-skip'))).map((n) => n.textContent).join('').trim() || 'Sin título';
/** Un apartado se reconoce por su número y su título: así sobrevive a los repintados. */
const headKey = (num: string, text: string): string => `${num}|${text}`;
/** apartados plegados en el esquema */
const navShut = new Set<string>();
/** cara del panel que se dibujó la última vez: al volver a dibujar la misma, la lista no salta */
let navShown = '';

/** Rellena el panel conservando su desplazamiento si sigue en la misma cara. */
function setNav(html: string): void {
  const top = navShown === navMode ? navEl.scrollTop : 0;
  navEl.innerHTML = html;
  navEl.scrollTop = top;
  navShown = navMode;
}

/** Esquema del documento: un botón por título, sangrado según su nivel. */
function updateOutline(): void {
  if (document.body.classList.contains('nav-open') !== navOpen) {
    document.body.classList.toggle('nav-open', navOpen);
    // el panel desplaza la hoja: la regla se vuelve a colocar sobre ella
    updateRuler();
  }
  if (!navOpen) return;
  if (navMode === 'refs') {
    renderRefs();
    return;
  }
  if (navMode === 'deck') {
    renderDeckPanel();
    return;
  }
  const items: { i: number; level: number; num: string; text: string; words: number }[] = [];
  const count = (el: BlockEl): number => (el._b?.kind === 'ro' ? 0 : (content(el).textContent ?? '').replace(/\u00AD/g, '').split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length);
  els.forEach((el, i) => {
    const c = content(el);
    // las palabras de cada bloque cuentan para el último título que lo precede
    if (items.length && !c.querySelector(':scope > [data-k="head"]')) items[items.length - 1].words += count(el);
    const head = c.querySelector(':scope > [data-k="head"]') as HTMLElement | null;
    if (head) {
      items.push({ i, level: HEAD_LEVEL[head.dataset.level ?? ''] ?? 1, num: head.querySelector('.secnum')?.textContent ?? '', text: headText(head), words: 0 });
    } else if (c.querySelector(':scope > .titleblock')) {
      items.push({ i, level: -1, num: '', text: c.querySelector('.doctitle')?.textContent?.trim() || 'Título', words: 0 });
    }
  });
  const base = Math.min(...items.filter((x) => x.level >= 0).map((x) => x.level), 3);
  const most = Math.max(...items.map((y) => y.words), 1);
  // un título con otros más hondos debajo se puede plegar; lo de debajo de uno plegado no se ve
  const open: { level: number; shut: boolean }[] = [];
  const kids = (k: number): boolean => items[k].level >= 0 && (items[k + 1]?.level ?? -1) > items[k].level;
  const rows = items.map((x, k) => {
    while (open.length && open[open.length - 1].level >= x.level) open.pop();
    const hidden = open.some((a) => a.shut);
    const key = headKey(x.num, x.text);
    const shut = kids(k) && navShut.has(key);
    open.push({ level: x.level, shut });
    const fold = x.level < 0 ? '' : kids(k) ? `<span class="nav-fold codicon codicon-chevron-${shut ? 'right' : 'down'}" data-fold="${escHtml(key)}" title="${shut ? 'Desplegar' : 'Plegar'}"></span>` : '<span class="nav-fold"></span>';
    return `<button class="nav-item nav-l${x.level < 0 ? 't' : x.level - base}" data-i="${x.i}" style="--w:${(x.words / most).toFixed(2)}"${hidden ? ' hidden' : ''}>${fold}<span class="nav-num">${escHtml(x.num)}</span><span class="nav-text">${escHtml(x.text)}</span>${x.words ? `<span class="nav-words" title="Palabras de este apartado">${x.words}</span>` : ''}</button>`;
  });
  const folds = items.some((_, k) => kids(k));
  setNav(
    navHead() +
      (items.length
        ? (folds ? '<div class="nav-tools"><button data-fold-all="1" title="Ver solo los títulos del primer nivel">Plegar todo</button><button data-fold-all="0" title="Ver todos los títulos">Desplegar todo</button></div>' : '') +
          `<div class="nav-list">${rows.join('')}</div>`
        : '<div class="nav-empty">Los títulos del documento aparecerán aquí.<br>Usa los estilos <b>Título 1</b>, <b>Título 2</b>… de la pestaña Inicio.</div>'),
  );
  trackScroll();
}

/** Pliega (o despliega) todos los títulos que tienen otros debajo. */
function foldAll(shut: boolean): void {
  navShut.clear();
  if (shut) {
    const heads = els.map((el) => content(el).querySelector(':scope > [data-k="head"]') as HTMLElement | null).filter((h): h is HTMLElement => h !== null);
    const level = (h: HTMLElement): number => HEAD_LEVEL[h.dataset.level ?? ''] ?? 1;
    heads.forEach((h, k) => {
      if (heads[k + 1] && level(heads[k + 1]) > level(h)) navShut.add(headKey(h.querySelector('.secnum')?.textContent ?? '', headText(h)));
    });
  }
  updateOutline();
}

// ---- el panel tiene tres caras: el esquema del documento, sus referencias bibliográficas y la presentación
type NavMode = 'outline' | 'refs' | 'deck';
let navMode: NavMode = 'outline';
/** lo escrito en el buscador de referencias */
let refFilter = '';
/** referencia que espera la confirmación para quitarla */
let refAsk = '';
/** orden de la lista de referencias */
let refSort: 'doc' | 'az' | 'cited' | 'unused' = 'doc';

function navHead(): string {
  // la cara elegida lleva su nombre; las otras, solo su icono (el panel es estrecho)
  const tab = (mode: NavMode, icon: string, label: string, title: string): string =>
    `<button class="nav-tab${navMode === mode ? ' on' : ''}" data-mode="${mode}" title="${title}"><i class="codicon codicon-${icon}"></i><span>${label}</span></button>`;
  return (
    '<div class="nav-head"><span class="nav-tabs">' +
    tab('outline', 'list-tree', 'Esquema', 'Esquema: los títulos del documento') +
    tab('refs', 'book', 'Referencias', 'Referencias: las fuentes bibliográficas; añadir, editar, quitar y citar') +
    tab('deck', 'play', 'Presentación', 'Presentación: elegir apartados y proyectarlos en 16:9') +
    '</span><button data-cmd="nav" title="Cerrar el panel"><i class="codicon codicon-close"></i></button></div>'
  );
}

/** Claves citadas en el documento: cuántas veces y en qué bloque aparece cada una por primera vez. */
function citations(): Map<string, { n: number; first: number }> {
  const found = new Map<string, { n: number; first: number }>();
  blocks.forEach((b, i) => {
    if (b.kind === 'ro' || els[i]?.classList.contains('is-preamble')) return;
    // (la propia lista de referencias no cuenta como cita)
    const src = b.src.replace(/\\begin\{thebibliography\}[\s\S]*?\\end\{thebibliography\}/g, '');
    for (const m of citesIn(src)) {
      for (const key of m.keys) {
        const c = found.get(key);
        if (c) c.n++;
        else found.set(key, { n: 1, first: i });
      }
    }
  });
  return found;
}

const refMatches = (s: { key: string; label: string }, q: string): boolean => !q || `${s.key} ${s.label}`.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').includes(q);
const plainQuery = (): string => refFilter.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

/** Lista de referencias del documento, con lo que se puede hacer con cada una. */
function renderRefs(): void {
  const typing = document.activeElement === navEl.querySelector('.ref-search');
  const cited = citations();
  const known = new Set(sources.map((s) => s.key));
  const unused = sources.filter((s) => !cited.has(s.key)).length;
  const missing = [...cited.keys()].filter((k) => k !== '*' && !known.has(k));
  const q = plainQuery();
  const times = (n: number): string => `${n} ${n === 1 ? 'cita' : 'citas'}`;
  /** «2 de 3» mientras se recorren las citas de una fuente */
  const here = (key: string): boolean => refTurn?.key === key && refTurn.at >= 0 && !refTurn.done;
  const counter = (key: string, n: number): string => (here(key) && refTurn && n > 1 ? `${refTurn.at + 1} de ${n}` : times(n));
  /** se ha ido a una de sus citas: se puede quitar esa, y solo esa */
  const uncite = (key: string): string =>
    here(key) ? '<button data-ref="uncite" title="Quitar del texto la cita a la que se acaba de ir (la fuente sigue en la bibliografía)"><i class="codicon codicon-circle-slash"></i></button>' : '';
  const item = (s: (typeof sources)[number]): string => {
    const c = cited.get(s.key);
    const asking = refAsk === s.key;
    return (
      `<div class="ref-item${c ? '' : ' unused'}${refMatches(s, q) ? '' : ' out'}${refTurn?.key === s.key ? ' on' : ''}" data-key="${escHtml(s.key)}" data-n="${c ? times(c.n) : 'sin citar'}">` +
      `<button class="ref-main" data-ref="go" title="${c ? (c.n > 1 ? 'Ir a sus citas en el documento: cada clic lleva a la siguiente' : 'Ir a su cita en el documento') : 'Todavía no se cita en el documento'}">` +
      `<span class="ref-key">${escHtml(s.key)}</span><span class="ref-count" title="Veces que se cita">${c ? counter(s.key, c.n) : 'sin citar'}</span>` +
      `<span class="ref-label">${escHtml(s.label)}</span></button>` +
      (asking
        ? `<div class="ref-ask"><span>${c ? `Se cita ${c.n} ${c.n === 1 ? 'vez' : 'veces'}: esas citas quedarán sin referencia. ` : ''}¿Quitarla?</span><button data-ref="yes" class="danger">Quitar</button><button data-ref="no">Cancelar</button></div>`
        : '<div class="ref-acts">' +
          uncite(s.key) +
          '<button data-ref="cite" title="Citarla donde está el cursor"><i class="codicon codicon-quote"></i></button>' +
          '<button data-ref="edit" title="Editar sus datos"><i class="codicon codicon-edit"></i></button>' +
          '<button data-ref="del" title="Quitarla de la bibliografía"><i class="codicon codicon-trash"></i></button></div>') +
      '</div>'
    );
  };
  const order = (): typeof sources => {
    const n = (s: (typeof sources)[number]): number => cited.get(s.key)?.n ?? 0;
    if (refSort === 'az') return [...sources].sort((a, b) => a.key.localeCompare(b.key, 'es'));
    if (refSort === 'cited') return [...sources].sort((a, b) => n(b) - n(a));
    if (refSort === 'unused') return [...sources].sort((a, b) => Number(n(a) > 0) - Number(n(b) > 0));
    return sources;
  };
  const sortBox =
    `<select class="ref-sort" title="Orden de la lista">${(
      [['doc', 'Como en la bibliografía'], ['az', 'Por clave (A → Z)'], ['cited', 'Más citadas primero'], ['unused', 'Sin citar primero']] as const
    )
      .map(([v, label]) => `<option value="${v}"${refSort === v ? ' selected' : ''}>${label}</option>`)
      .join('')}</select>`;
  setNav(
    navHead() +
      '<div class="ref-tools">' +
      '<button data-cmd="add-source" title="Agregar una fuente escribiendo sus datos"><i class="codicon codicon-add"></i>Añadir</button>' +
      '<button data-cmd="add-doi" title="Traer una fuente de doi.org por su DOI"><i class="codicon codicon-link-external"></i>DOI</button>' +
      '<button data-cmd="cite-zotero" title="Elegir referencias en Zotero"><i class="codicon codicon-folder-library"></i>Zotero</button></div>' +
      (sources.length
        ? `<input class="ref-search" type="search" placeholder="Buscar por autor, título o clave…" value="${escHtml(refFilter)}" spellcheck="false">` +
          `<div class="ref-bar"><span class="ref-sum">${sources.length} ${sources.length === 1 ? 'referencia' : 'referencias'}${unused ? ` · ${unused} sin citar` : ''}</span>${sources.length > 1 ? sortBox : ''}</div>` +
          `<div class="ref-list">${order().map(item).join('')}</div>`
        : '<div class="nav-empty">Este documento aún no tiene referencias.<br>Añade la primera con <b>Añadir</b>, con su <b>DOI</b> o desde <b>Zotero</b>.</div>') +
      (missing.length
        ? `<div class="ref-sum warn">Citas sin referencia</div><div class="ref-list">${missing
            .map(
              (k) =>
                `<div class="ref-item missing${refTurn?.key === k ? ' on' : ''}" data-key="${escHtml(k)}" data-n="${times(cited.get(k)?.n ?? 0)}"><button class="ref-main" data-ref="go" title="Ir a la cita"><span class="ref-key">${escHtml(k)}</span><span class="ref-count">${counter(k, cited.get(k)?.n ?? 0)}</span><span class="ref-label">No está en la bibliografía</span></button>` +
                (uncite(k) ? `<div class="ref-acts">${uncite(k)}</div>` : '') +
                '</div>',
            )
            .join('')}</div>`
        : ''),
  );
  if (typing) {
    // el documento se ha redibujado mientras se escribía en el buscador: el cursor sigue en él
    const box = navEl.querySelector<HTMLInputElement>('.ref-search');
    box?.focus();
    box?.setSelectionRange(refFilter.length, refFilter.length);
  }
}

function setNavMode(mode: NavMode): void {
  navMode = mode;
  refAsk = '';
  if (!navOpen) run('nav');
  else updateOutline();
}

navEl.addEventListener('input', (e) => {
  const box = e.target as HTMLInputElement;
  if (!box.classList?.contains('ref-search')) return;
  refFilter = box.value;
  const q = plainQuery();
  // se filtra sin volver a dibujar la lista: el cuadro no pierde el foco
  navEl.querySelectorAll<HTMLElement>('.ref-item[data-key]:not(.missing)').forEach((it) => {
    const s = sources.find((x) => x.key === it.dataset.key);
    it.classList.toggle('out', !s || !refMatches(s, q));
  });
});

/** por qué cita de qué fuente va el recorrido del panel */
let refTurn: { key: string; at: number; done?: boolean } | undefined;

/** Cada sitio del documento donde se cita `key`, en orden (una cita con varias claves cuenta para cada una). */
function citeSpots(key: string): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>('[data-tex*="cite"]')).filter((a) => {
    if (a.closest('.bib, .is-preamble') || a.querySelector('[data-tex*="cite"]')) return false;
    return [...(a.getAttribute('data-tex') ?? '').matchAll(CITE)].some((m) => m[1].split(',').some((k) => k.trim() === key));
  });
}

/** Lo que hace cada botón de una referencia del panel. */
function refAction(act: string, key: string): void {
  const s = sources.find((x) => x.key === key);
  // hacer algo con otra fuente termina el recorrido por las citas de la anterior
  if (refTurn && refTurn.key !== key) refTurn = undefined;
  if (act === 'go') {
    // cada clic lleva a la cita siguiente de esa fuente, y tras la última vuelve a la primera
    const spots = citeSpots(key);
    const first = citations().get(key)?.first;
    const fallback = first === undefined ? undefined : els[first];
    if (!spots.length && !fallback) {
      post({ type: 'info', text: `«${key}» todavía no se cita en el documento. Pon el cursor donde la quieras y pulsa el botón de citar.` });
      return;
    }
    // (sin un sitio concreto al que ir no hay «esta cita» que quitar: -1)
    refTurn = refTurn?.key === key && spots.length ? { key, at: (refTurn.at + 1) % spots.length } : { key, at: spots.length ? 0 : -1 };
    const spot = spots[refTurn.at] as HTMLElement | undefined;
    const target = spot ?? (fallback as HTMLElement);
    const box = vrect(target);
    window.scrollTo({ top: window.scrollY + box.top - Math.max((window.innerHeight - box.height) / 3, toolbar.offsetHeight + 40), behavior: 'smooth' });
    const el = target.closest('.block') as BlockEl | null;
    if (el) select(el);
    root.querySelectorAll('.cite-here').forEach((x) => x.classList.remove('cite-here'));
    if (spot) {
      spot.classList.add('cite-here');
      window.setTimeout(() => spot.classList.remove('cite-here'), 2600);
    }
    // en el panel, por cuál va («2 de 3») y el botón para quitar esa cita
    renderRefs();
    if (!navDocked() && spots.length <= 1) run('nav');
  } else if (act === 'uncite' && !readOnly && refTurn?.key === key && refTurn.at >= 0 && !refTurn.done) {
    // quitar del texto la cita a la que se ha ido, sin tocar la bibliografía
    const spots = citeSpots(key);
    const spot = spots[refTurn.at] as HTMLElement | undefined;
    const el = spot?.closest('.block') as BlockEl | null | undefined;
    if (!spot || !el) return;
    if (active) flush(active);
    const r = blockRange(el);
    const next = r ? removeCite(r.src, key, spots.filter((x) => x.closest('.block') === el).indexOf(spot)) : undefined;
    if (!r || next === undefined) {
      post({ type: 'info', text: `No se encuentra esa cita de «${key}» en el código del bloque: quítala desde el código.` });
      return;
    }
    dropActive();
    nextFocus = undefined;
    // el siguiente clic en la fuente lleva a la cita que venía detrás de la quitada
    refTurn = { key, at: refTurn.at - 1, done: true };
    if (next.trim()) sendFull(r.s, r.lines, next.split('\n'));
    else {
      const gone = removal(r);
      sendFull(r.s, gone.expect, gone.lines);
    }
  } else if (act === 'cite' && !readOnly) run('cite', key);
  else if (act === 'del' || act === 'no') {
    refAsk = act === 'del' ? key : '';
    renderRefs();
  } else if (act === 'yes' && !readOnly) {
    refAsk = '';
    if (active) flush(active);
    post({ type: 'setSource', key, text: '' });
  } else if (act === 'edit' && s?.raw !== undefined && !readOnly) {
    form(
      `Editar la referencia ${key}`,
      [{ id: 'raw', label: s.where === 'bib' ? 'Entrada en el archivo .bib' : 'Entrada en la lista de referencias del documento', type: 'textarea', value: s.raw }],
      (v) => {
        if (!v.raw.trim() || v.raw.trim() === s.raw?.trim()) return;
        if (active) flush(active);
        post({ type: 'setSource', key, text: v.raw });
      },
    );
  }
}

// ---- la tercera cara: una presentación hecha sola con los apartados que se elijan

/** apartados que no entran en la presentación (los nuevos entran solos) */
const deckOff = new Set<string>();

/** Apartados del documento, cada uno con lo que hay entre su título y el siguiente. */
function deckSections(all = false): DeckSection[] {
  const out: DeckSection[] = [];
  let cur: DeckSection | undefined;
  for (const el of els) {
    if (el.classList.contains('is-preamble') || el._b?.kind === 'ro') continue;
    const c = content(el);
    const head = c.querySelector(':scope > [data-k="head"]') as HTMLElement | null;
    if (!head) {
      cur?.blocks.push(c);
      continue;
    }
    const num = head.querySelector('.secnum')?.textContent ?? '';
    const title = headText(head);
    cur = { key: headKey(num, title), num, title, level: HEAD_LEVEL[head.dataset.level ?? ''] ?? 1, blocks: [] };
    out.push(cur);
  }
  // el nivel más alto del documento es el 0: en un artículo, las secciones
  const base = Math.min(...out.map((s) => s.level), 3);
  for (const s of out) s.level -= base;
  return all ? out : out.filter((s) => !deckOff.has(s.key));
}

/** La portada del documento (\maketitle), si la tiene. */
const deckCover = (): HTMLElement | undefined =>
  els.map((el) => content(el).querySelector<HTMLElement>('div.titleblock[data-role="title"]')).find((x): x is HTMLElement => x !== null);

/** Proyecta la presentación (desde el apartado `from`, si se da). */
function present(from?: string): void {
  if (active) deactivate();
  const cover = deckCover();
  const sections = deckSections();
  const slides = sections.length ? buildSlides(sections, deckOpts, cover, deckCoverText) : [];
  if (!slides.length) {
    post({ type: 'info', text: 'No hay nada que presentar: elige algún apartado en el panel lateral (cara «Presentación»).' });
    return;
  }
  const start = from ? Math.max(slides.findIndex((x) => x.key === from), 0) : 0;
  // toda la pantalla, como en PowerPoint: la ventana la prepara la extensión
  post({ type: 'presentMode', on: true });
  openDeck(slides, deckOpts, deckFooter(), start, () => post({ type: 'presentMode', on: false }));
}

let deckCountTimer = 0;
/** Cuántas diapositivas saldrían (se calcula aparte: copiar el documento cuesta). */
function countSlides(): void {
  window.clearTimeout(deckCountTimer);
  deckCountTimer = window.setTimeout(() => {
    const sum = navEl.querySelector('.deck-sum');
    if (!sum || navMode !== 'deck') return;
    const all = deckSections(true);
    const on = all.filter((s) => !deckOff.has(s.key));
    const n = on.length ? buildSlides(on, deckOpts, deckCover(), deckCoverText).length : 0;
    sum.textContent = `${n} ${n === 1 ? 'diapositiva' : 'diapositivas'} · ${on.length} de ${all.length} apartados`;
  }, 200);
}

/** Pie de las diapositivas: el título de la portada, el propio o el del documento. */
const deckFooter = (): string => deckCoverText.title ?? plainOf(coverOf(deckCover()).title, document);

/** Una diapositiva en pequeño, con el estilo elegido (para la vista previa de los formularios). */
const deckPreview = (slide: Slide): string =>
  `<div class="deck-vars deck-${deckOpts.theme} deck-preview"><div class="deck-preview-in">${slideHtml(slide, 0, 1, deckFooter())}</div></div>`;

/** Textos de la portada: los que se dejan como en el documento siguen al documento. */
function editCover(): void {
  const cover = deckCover();
  const doc = coverOf(cover);
  const plain = (html: string): string => plainOf(html, document);
  const fromDoc: Record<keyof CoverText, string> = { title: plain(doc.title), subtitle: '', author: plain(doc.author), institute: plain(doc.institute), date: plain(doc.date) };
  const own = (v: Record<string, string>): CoverText => {
    const out: CoverText = {};
    for (const k of Object.keys(fromDoc) as (keyof CoverText)[]) if (v[k] !== undefined && v[k].trim() !== fromDoc[k]) out[k] = v[k].trim();
    return out;
  };
  const value = (k: keyof CoverText): string => deckCoverText[k] ?? fromDoc[k];
  form(
    'Portada de la presentación',
    [
      { id: 'title', label: 'Título', value: value('title') },
      { id: 'subtitle', label: 'Subtítulo', value: value('subtitle'), placeholder: 'Por ejemplo: Defensa del trabajo de fin de máster' },
      { id: 'author', label: 'Autor', value: value('author') },
      { id: 'institute', label: 'Institución o curso', value: value('institute'), placeholder: 'Universidad, facultad, asignatura…' },
      { id: 'date', label: 'Fecha', value: value('date') },
    ],
    (v) => {
      deckCoverText = own(v);
      post({ type: 'deckCover', value: deckCoverText });
      renderDeckPanel();
    },
    (v) => deckPreview({ kind: 'cover', title: '', num: '', points: [], html: coverHtml(cover, own(v)) }),
  );
}

/** Textos del cierre (valen para todas las presentaciones); el contacto, por omisión, el autor. */
function editClosing(): void {
  const author = deckCoverText.author ?? plainOf(coverOf(deckCover()).author, document);
  const end = deckOpts.end ?? {};
  const own = (v: Record<string, string>): DeckOptions['end'] => {
    const out: DeckOptions['end'] = {};
    if (v.title.trim() !== CLOSING_DEFAULTS.title) out.title = v.title.trim();
    if (v.subtitle.trim() !== CLOSING_DEFAULTS.subtitle) out.subtitle = v.subtitle.trim();
    if (v.contact.trim() !== author) out.contact = v.contact.trim();
    return out;
  };
  form(
    'Cierre de la presentación',
    [
      { id: 'title', label: 'Título', value: end.title ?? CLOSING_DEFAULTS.title },
      { id: 'subtitle', label: 'Subtítulo', value: end.subtitle ?? CLOSING_DEFAULTS.subtitle, placeholder: 'Vacío: sin subtítulo' },
      { id: 'contact', label: 'Contacto o autor', value: end.contact ?? author, placeholder: 'Nombre, correo, web…' },
    ],
    (v) => {
      deckOpts.end = own(v);
      savePrefs({ deck: { ...deckOpts } });
      renderDeckPanel();
    },
    (v) => {
      const e = own(v);
      return deckPreview({ kind: 'end', title: e.title ?? CLOSING_DEFAULTS.title, num: '', points: [], html: closingHtml(e, author) });
    },
  );
}

function renderDeckPanel(): void {
  const all = deckSections(true);
  const chip = (id: keyof DeckOptions, label: string, title: string): string =>
    `<button class="deck-chip${deckOpts[id] ? ' on' : ''}" data-opt="${id}" title="${title}" aria-pressed="${deckOpts[id] ? 'true' : 'false'}">${label}</button>`;
  const seg = (id: 'text' | 'theme', value: string, label: string, title: string): string =>
    `<button class="deck-seg${deckOpts[id] === value ? ' on' : ''}" data-opt="${id}" data-val="${value}" title="${title}" aria-pressed="${deckOpts[id] === value ? 'true' : 'false'}">${label}</button>`;
  const edit = (what: string, title: string): string => `<button class="deck-edit" data-deck-edit="${what}" title="${title}"><i class="codicon codicon-edit"></i></button>`;
  const anyOn = all.some((s) => !deckOff.has(s.key));
  setNav(
    navHead() +
      '<div class="deck-start">' +
      `<button class="deck-go" data-deck-go=""${anyOn ? '' : ' disabled'} title="Proyectar la presentación (en ella: ← → para avanzar, Esc para salir)"><i class="codicon codicon-play"></i>Presentar</button>` +
      '<div class="deck-sum">…</div></div>' +
      '<div class="deck-group"><div class="deck-label">Texto de cada párrafo</div><div class="deck-segs">' +
      seg('text', 'key', 'Idea clave', 'La primera frase de cada párrafo, como viñeta') +
      seg('text', 'full', 'Completo', 'Los párrafos enteros (el texto se encoge si no cabe)') +
      seg('text', 'none', 'Nada', 'Solo títulos, listas, figuras, tablas y ecuaciones') +
      '</div></div>' +
      '<div class="deck-group"><div class="deck-label">Incluir</div><div class="deck-chips">' +
      chip('lists', 'Listas', 'Cada elemento de una lista, una viñeta') +
      chip('figures', 'Figuras', 'Imágenes y figuras TikZ') +
      chip('tables', 'Tablas', 'Cada tabla en su diapositiva') +
      chip('math', 'Ecuaciones', 'Las ecuaciones destacadas') +
      '</div></div>' +
      '<div class="deck-group"><div class="deck-label">Inicio y final</div><div class="deck-chips">' +
      chip('cover', 'Portada', 'Diapositiva de inicio: título, subtítulo, autor, institución y fecha') +
      edit('cover', 'Personalizar la portada: título, subtítulo, autor, institución y fecha') +
      chip('agenda', 'Índice', 'Diapositiva con los apartados que se van a presentar') +
      chip('closing', 'Cierre', 'Diapositiva final: «¡Gracias! ¿Preguntas?» y un contacto') +
      edit('closing', 'Personalizar el cierre: título, subtítulo y contacto') +
      '</div></div>' +
      '<div class="deck-group"><div class="deck-label">Estilo</div><div class="deck-segs">' +
      seg('theme', 'light', 'Claro', 'Fondo blanco') +
      seg('theme', 'dark', 'Oscuro', 'Fondo oscuro, para salas con poca luz') +
      seg('theme', 'blue', 'Azul', 'Títulos sobre una banda de color, al estilo de Beamer') +
      '</div></div>' +
      (all.length
        ? '<div class="deck-pick-head"><span class="deck-label">Apartados</span><span><button data-deck-all="1">Todos</button><button data-deck-all="0">Ninguno</button></span></div>' +
          `<div class="deck-list">${all
            .map((s) => {
              const on = !deckOff.has(s.key);
              return (
                `<label class="deck-item dl-${Math.min(s.level, 3)}${on ? ' on' : ''}" data-key="${escHtml(s.key)}">` +
                `<input type="checkbox"${on ? ' checked' : ''}><span class="deck-num">${escHtml(s.num)}</span><span class="deck-text">${escHtml(s.title)}</span>` +
                (on ? `<button class="deck-from" data-deck-go="${escHtml(s.key)}" title="Presentar desde este apartado"><i class="codicon codicon-play"></i></button>` : '') +
                '</label>'
              );
            })
            .join('')}</div>`
        : '<div class="nav-empty">Los títulos del documento serán los apartados de la presentación.<br>Usa los estilos <b>Título 1</b>, <b>Título 2</b>… de la pestaña Inicio.</div>'),
  );
  countSlides();
}

/** Marca o desmarca un apartado, y con él los que cuelgan de él. */
function toggleDeckSection(key: string, on: boolean): void {
  const all = deckSections(true);
  const k = all.findIndex((s) => s.key === key);
  if (k < 0) return;
  for (let j = k; j < all.length && (j === k || all[j].level > all[k].level); j++) {
    if (on) deckOff.delete(all[j].key);
    else deckOff.add(all[j].key);
  }
  renderDeckPanel();
}

function setDeckOption(id: string, value?: string): void {
  if (id === 'text' && (value === 'key' || value === 'full' || value === 'none')) deckOpts.text = value;
  else if (id === 'theme' && (value === 'light' || value === 'dark' || value === 'blue')) deckOpts.theme = value;
  else if (id in DECK_DEFAULTS && typeof deckOpts[id as keyof DeckOptions] === 'boolean') {
    const flag = id as 'lists' | 'figures' | 'tables' | 'math' | 'cover' | 'agenda' | 'closing';
    deckOpts[flag] = !deckOpts[flag];
  } else return;
  savePrefs({ deck: { ...deckOpts } });
  renderDeckPanel();
}

navEl.addEventListener('mousedown', (e) => {
  // (el foco no sale del documento, salvo para escribir en el buscador de referencias o elegir en sus listas)
  if (!(e.target as HTMLElement).closest('input, select')) e.preventDefault();
});
navEl.addEventListener('change', (e) => {
  const t = e.target as HTMLElement;
  if (t instanceof HTMLSelectElement && t.classList.contains('ref-sort')) {
    refSort = t.value === 'az' || t.value === 'cited' || t.value === 'unused' ? t.value : 'doc';
    renderRefs();
  } else if (t instanceof HTMLInputElement && t.type === 'checkbox') {
    const key = (t.closest('.deck-item') as HTMLElement | null)?.dataset.key;
    if (key !== undefined) toggleDeckSection(key, t.checked);
  }
});
navEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('[data-cmd="nav"]')) {
    run('nav');
    return;
  }
  const mode = (t.closest('.nav-tab') as HTMLElement | null)?.dataset.mode;
  if (mode) {
    setNavMode(mode === 'refs' || mode === 'deck' ? mode : 'outline');
    return;
  }
  const fold = (t.closest('[data-fold]') as HTMLElement | null)?.dataset.fold;
  if (fold !== undefined) {
    if (!navShut.delete(fold)) navShut.add(fold);
    updateOutline();
    return;
  }
  const foldAllBtn = (t.closest('[data-fold-all]') as HTMLElement | null)?.dataset.foldAll;
  if (foldAllBtn !== undefined) {
    foldAll(foldAllBtn === '1');
    return;
  }
  const go = t.closest('[data-deck-go]') as HTMLElement | null;
  if (go) {
    e.preventDefault();
    present(go.dataset.deckGo || undefined);
    return;
  }
  const editWhat = (t.closest('[data-deck-edit]') as HTMLElement | null)?.dataset.deckEdit;
  if (editWhat) {
    if (editWhat === 'cover') editCover();
    else editClosing();
    return;
  }
  const opt = t.closest('[data-opt]') as HTMLElement | null;
  if (opt) {
    setDeckOption(opt.dataset.opt as string, opt.dataset.val);
    return;
  }
  const every = (t.closest('[data-deck-all]') as HTMLElement | null)?.dataset.deckAll;
  if (every !== undefined) {
    deckOff.clear();
    if (every === '0') for (const s of deckSections(true)) deckOff.add(s.key);
    renderDeckPanel();
    return;
  }
  const cmdBtn = t.closest('.ref-tools [data-cmd]') as HTMLElement | null;
  if (cmdBtn) {
    run(cmdBtn.dataset.cmd as string);
    return;
  }
  const refBtn = t.closest('[data-ref]') as HTMLElement | null;
  const refKey = (t.closest('.ref-item') as HTMLElement | null)?.dataset.key;
  if (refBtn && refKey) {
    refAction(refBtn.dataset.ref as string, refKey);
    return;
  }
  const item = t.closest('.nav-item') as HTMLElement | null;
  const el = item ? els[Number(item.dataset.i)] : undefined;
  if (!el) return;
  window.scrollTo({ top: window.scrollY + vrect(el).top - toolbar.offsetHeight - 18, behavior: 'smooth' });
  select(el);
  // flotando taparía justo lo que se ha pedido ver
  if (!navDocked()) run('nav');
});
document.addEventListener('mousedown', (e) => {
  if (navOpen && !navDocked() && !(e.target as HTMLElement).closest('#nav, #status')) run('nav');
});

// ------------------------------------------------------------------ avisos del documento

const issuesEl = document.createElement('div');
issuesEl.id = 'issues';
issuesEl.hidden = true;
document.body.appendChild(issuesEl);
const ISSUE_LABEL = { ref: 'Referencia sin definir', cite: 'Cita sin fuente', label: 'Etiqueta repetida', image: 'Imagen que no se encuentra' };

function toggleIssues(): void {
  if (!issuesEl.hidden || !issues.length) {
    issuesEl.hidden = true;
    return;
  }
  issuesEl.innerHTML =
    '<div class="nav-head"><span>Avisos del documento</span><button data-close="1" title="Cerrar"><i class="codicon codicon-close"></i></button></div>' +
    issues.map((x, k) => `<button class="issue" data-i="${k}"><b>${ISSUE_LABEL[x.kind]}</b><span>${escHtml(x.text)}</span></button>`).join('');
  issuesEl.hidden = false;
}
issuesEl.addEventListener('mousedown', (e) => e.preventDefault());
issuesEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const item = t.closest<HTMLElement>('.issue');
  const issue = item ? issues[Number(item.dataset.i)] : undefined;
  const el = issue ? els.find((x) => x._b && x._b.s <= issue.line && x._b.e >= issue.line) ?? els.find((x) => x._b && x._b.s >= issue.line) : undefined;
  if (el) {
    window.scrollTo({ top: window.scrollY + vrect(el).top - toolbar.offsetHeight - 40, behavior: 'smooth' });
    select(el);
  }
  if (t.closest('[data-close]') || el) issuesEl.hidden = true;
});

// ------------------------------------------------------------------ cambios e historial (git)

interface GitCommit {
  hash: string;
  short: string;
  date: string;
  author: string;
  subject: string;
}

interface GitChange {
  kind: 'add' | 'mod' | 'del';
  s: number;
  n: number;
  old: string[];
  now: string[];
}

const GIT_WIDTH = 290;
const gitEl = document.createElement('div');
gitEl.id = 'git';
document.body.appendChild(gitEl);
/** detalle de un cambio: qué había y qué hay, palabra a palabra */
const popEl = document.createElement('div');
popEl.id = 'chgpop';
popEl.hidden = true;
document.body.appendChild(popEl);
let gitOpen = false;
let popShownAt = 0;
const gitState: { repo: boolean; loaded: boolean; commits: GitCommit[]; more: boolean; viewing: string; ref: string; missing: boolean; changes: GitChange[]; others: { path: string; name: string }[] } = {
  repo: true, loaded: false, commits: [], more: false, viewing: '', ref: 'HEAD', missing: false, changes: [], others: [],
};

/** Texto de un trozo de LaTeX sin sus órdenes, para comparar lo que se lee y no el código. */
function readable(tex: string): string {
  return tex
    .replace(/(^|[^\\])%.*$/gm, '$1')
    .replace(/\\(?:cite[a-z]*|ref|eqref|label|autoref|cref|pageref)\*?\s*(?:\[[^\]]*\])*\s*\{([^}]*)\}/g, '[$1]')
    .replace(/\\(?:begin|end)\s*\{[^}]*\}(?:\[[^\]]*\])?/g, '')
    .replace(/\\[a-zA-Z@]+\*?\s*(?:\[[^\]]*\])?/g, '')
    .replace(/\\(.)/g, '$1')
    .replace(/[{}]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** El panel de cambios ocupa una columna propia si hay sitio; si no, flota sobre el documento. */
function gitDocked(): boolean {
  return gitOpen && document.documentElement.clientWidth >= 760 + (navDocked() ? NAV_WIDTH : 0);
}

/** Ancho que los paneles laterales le quitan al documento. */
function sideWidth(): number {
  return (navDocked() ? NAV_WIDTH : 0) + (gitDocked() ? GIT_WIDTH : 0);
}

function toggleGit(): void {
  gitOpen = !gitOpen;
  document.body.classList.toggle('git-open', gitOpen);
  popEl.hidden = true;
  if (!gitOpen) {
    gitState.changes = [];
    markChanges();
  } else gitState.ref = readOnly ? '' : 'HEAD';
  post({ type: 'gitPanel', open: gitOpen });
  renderGit();
  applyZoom();
  updateStatus();
}

function onGitLog(m: { repo: boolean; commits: GitCommit[]; skip: number; more: boolean; viewing: string }): void {
  gitState.repo = m.repo;
  gitState.loaded = true;
  gitState.commits = m.skip ? [...gitState.commits, ...m.commits] : m.commits;
  gitState.more = m.more;
  gitState.viewing = m.viewing;
  renderGit();
}

function onGitDiff(m: { ref: string; missing: boolean; changes: GitChange[] }): void {
  if (!gitOpen) return;
  gitState.ref = m.ref;
  gitState.missing = m.missing;
  gitState.changes = m.changes;
  popEl.hidden = true;
  markChanges();
  renderGit();
  updateStatus();
}

/** Bloques a los que afecta un cambio: los que ocupan sus líneas o, si es un borrado, el que le sigue. */
function blocksOfChange(c: GitChange): BlockEl[] {
  const real = els.filter((el) => el._b && el._b.kind !== 'ro');
  if (c.kind === 'del' || c.n === 0) {
    const next = real.find((el) => (el._b as Block).s >= c.s) ?? real[real.length - 1];
    return next ? [next] : [];
  }
  return real.filter((el) => (el._b as Block).e >= c.s && (el._b as Block).s < c.s + c.n);
}

/** Barra de color al margen de cada bloque que cambia respecto a la versión con la que se compara. */
function markChanges(): void {
  root.querySelectorAll('.chg-bar').forEach((b) => b.remove());
  for (const el of els) delete el.dataset.chg;
  if (!gitOpen) return;
  gitState.changes.forEach((c, k) => {
    for (const el of blocksOfChange(c)) {
      if (el.classList.contains('is-preamble')) continue;
      const bar = document.createElement('span');
      bar.className = `chg-bar ${c.kind}`;
      bar.dataset.chg = String(k);
      bar.contentEditable = 'false';
      bar.title = c.kind === 'add' ? 'Añadido · clic para ver el detalle' : c.kind === 'mod' ? 'Modificado · clic para ver qué cambió' : 'Aquí se borró texto · clic para verlo';
      el.prepend(bar);
      // (un bloque puede llevar un borrado delante y además estar cambiado: manda el cambio propio)
      if (c.kind !== 'del' || !el.dataset.chg) el.dataset.chg = c.kind;
    }
  });
}

const KIND_LABEL = { add: 'Añadido', mod: 'Modificado', del: 'Borrado' };
/** Texto corto que identifica un cambio en la lista: el del bloque, o lo que se borró. */
function changeLabel(c: GitChange): string {
  const el = c.kind === 'del' ? undefined : blocksOfChange(c).find((e) => !e.classList.contains('is-preamble'));
  const text = el ? (content(el).textContent ?? '') : c.kind === 'del' ? c.old.join(' ') : c.now.join(' ');
  const clean = text.replace(/­/g, '').replace(/\s+/g, ' ').trim();
  if (!el && c.kind !== 'del') return 'Preámbulo';
  return clean.slice(0, 70) || (el?.querySelector('img, canvas, svg') ? 'Figura' : 'Bloque sin texto');
}

/** Círculo con las iniciales del autor de un commit, de un color propio de cada persona. */
function avatar(author: string): string {
  const words = author.trim().split(/\s+/).filter(Boolean);
  const initials = ((words[0]?.[0] ?? '') + (words.length > 1 ? words[words.length - 1][0] : '')).toUpperCase() || '·';
  let hue = 0;
  for (const ch of author) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return `<span class="git-av" style="background:hsl(${hue} 42% 42%)" title="${escHtml(author)}">${escHtml(initials)}</span>`;
}

/** «hace 3 días», «ayer», «hace 2 horas»... a partir de una fecha «AAAA-MM-DD HH:MM». */
function ago(date: string): string {
  const then = new Date(date.replace(' ', 'T')).getTime();
  if (Number.isNaN(then)) return date;
  const min = Math.round((Date.now() - then) / 60000);
  if (min < 1) return 'ahora mismo';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} ${h === 1 ? 'hora' : 'horas'}`;
  const d = Math.round(h / 24);
  if (d === 1) return 'ayer';
  if (d < 31) return `hace ${d} días`;
  const mo = Math.round(d / 30.4);
  if (mo < 12) return `hace ${mo} ${mo === 1 ? 'mes' : 'meses'}`;
  return date.slice(0, 10);
}

function renderGit(): void {
  if (!gitOpen) {
    gitEl.innerHTML = '';
    return;
  }
  const head = '<div class="nav-head"><span>Cambios</span><button data-cmd="git" title="Cerrar el panel"><i class="codicon codicon-close"></i></button></div>';
  if (!gitState.loaded) {
    gitEl.innerHTML = `${head}<div class="nav-empty">Leyendo el historial…</div>`;
    return;
  }
  if (!gitState.repo) {
    gitEl.innerHTML = `${head}<div class="nav-empty">Este documento no está en un repositorio de git (o git no está instalado).<br><br>Cuando lo esté, aquí verás qué párrafos has cambiado desde el último <i>commit</i> y cómo estaba el documento en cada uno.</div>`;
    return;
  }
  const chosen = gitState.commits.find((c) => gitState.ref.startsWith(c.hash));
  const against = readOnly
    ? `Lo que cambió en esta versión${gitState.viewing ? ` (${escHtml(gitState.viewing.slice(0, 7))})` : ''}`
    : gitState.ref === 'HEAD' ? 'Desde el último commit' : chosen ? `Desde «${escHtml(chosen.subject.slice(0, 40))}»` : 'Comparando…';
  const changes = gitState.changes.length
    ? gitState.changes.map((c, k) => `<button class="git-chg ${c.kind}" data-chg="${k}"><b>${KIND_LABEL[c.kind]}</b><span>${escHtml(changeLabel(c))}</span></button>`).join('')
    : `<div class="nav-empty">${gitState.missing ? 'El documento no existía en esa versión: todo es nuevo.' : 'Sin cambios respecto a esa versión.'}</div>`;
  const item = (ref: string, title: string, meta: string, open: string, author = ''): string =>
    `<div class="git-commit${gitState.ref === ref ? ' on' : ''}">${avatar(author)}<button class="git-pick" data-ref="${ref}" title="Ver qué ha cambiado desde esta versión"><b>${escHtml(title)}</b><span>${escHtml(meta)}</span></button>` +
    (open ? `<button class="git-open" data-open="${open}" title="Ver el documento como estaba en esta versión"><i class="codicon codicon-eye"></i></button>` : '') +
    '</div>';
  const history = readOnly
    ? ''
    : '<div class="git-title">Historial</div>' +
      (gitState.commits.length
        ? gitState.commits.map((c, k) => item(k === 0 ? 'HEAD' : c.hash, c.subject || '(sin mensaje)', `${ago(c.date)} · ${c.author}${k === 0 ? ' · último' : ''}`, c.hash, c.author)).join('') +
          (gitState.more ? '<button class="git-more" data-more="1">Ver más antiguos…</button>' : '')
        : '<div class="nav-empty">Este documento todavía no tiene ningún commit.</div>');
  // guardar en git lo que hay sin confirmar, sin salir del documento
  const dirty = !readOnly && gitState.ref === 'HEAD' && (gitState.changes.length > 0 || gitState.others.length > 0);
  const draft = (gitEl.querySelector<HTMLTextAreaElement>('#git-msg')?.value ?? '').replace(/[&<>]/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const commit = dirty
    ? `<div class="git-commit-box"><textarea id="git-msg" rows="2" placeholder="Qué has cambiado (mensaje del commit)" spellcheck="false">${draft}</textarea><div class="git-commit-row">${gitState.others.length ? '<label title="Guardar también los demás archivos .tex y .bib del proyecto que hayan cambiado"><input type="checkbox" id="git-all" checked> y los otros archivos</label>' : '<span></span>'}<button data-commit="1" class="primary">Hacer commit</button></div></div>`
    : '';
  const others = gitState.others.length && !readOnly
    ? `<div class="git-title">Otros archivos con cambios</div><div class="git-list">${gitState.others.map((f, k) => `<button class="git-other" data-other="${k}"><i class="codicon codicon-file"></i> ${escHtml(f.name)}</button>`).join('')}</div>`
    : '';
  gitEl.innerHTML = `${head}<div class="git-title">${against} <span class="git-count">${gitState.changes.length || ''}</span></div><div class="git-list">${changes}</div>${commit}${others}${history}`;
}

/** Muestra junto a un bloque qué cambió en él: lo quitado tachado y lo añadido subrayado. */
function showChange(index: number, anchor?: BlockEl): void {
  const c = gitState.changes[index];
  if (!c) return;
  const el = anchor ?? blocksOfChange(c)[0];
  // se compara el texto que se lee; si no cambia (solo cambió el formato), el código
  const plainOld = readable(c.old.join('\n'));
  const plainNow = c.kind === 'del' ? '' : readable(c.now.join('\n'));
  const code = plainOld === plainNow;
  const parts = code ? diffWords(c.old.join('\n'), c.kind === 'del' ? '' : c.now.join('\n')) : diffWords(plainOld, plainNow);
  const body = parts.map(([kind, text]) => (kind === 0 ? escHtml(text) : kind < 0 ? `<del>${escHtml(text)}</del>` : `<ins>${escHtml(text)}</ins>`)).join('');
  const restore = readOnly ? '' : `<button data-restore="${index}" title="Dejar este tramo como estaba en esa versión">${c.kind === 'add' ? 'Quitar lo añadido' : c.kind === 'del' ? 'Recuperar lo borrado' : 'Restaurar como estaba'}</button>`;
  popEl.innerHTML = `<div class="pop-head"><b>${KIND_LABEL[c.kind]}</b><span class="pop-sp"></span>${restore}<button data-close="1" title="Cerrar"><i class="codicon codicon-close"></i></button></div><div class="pop-body${code ? ' code' : ''}">${code ? '<div class="pop-note">El texto es el mismo: cambia el formato o el código.</div>' : ''}${body}</div>`;
  popEl.hidden = false;
  popShownAt = Date.now();
  if (el) {
    const r = vrect(el);
    if (r.top < toolbar.offsetHeight + 10 || r.top > window.innerHeight - 160) window.scrollTo({ top: window.scrollY + r.top - toolbar.offsetHeight - 60 });
    const at = vrect(el);
    const width = Math.min(520, document.documentElement.clientWidth - 24);
    popEl.style.width = `${width}px`;
    popEl.style.left = `${Math.max(12, Math.min(at.left, document.documentElement.clientWidth - (gitDocked() ? GIT_WIDTH : 0) - width - 12))}px`;
    const below = at.bottom + 6;
    popEl.style.top = `${below + 220 > window.innerHeight ? Math.max(toolbar.offsetHeight + 6, at.top - popEl.offsetHeight - 6) : below}px`;
    select(el);
  }
}

gitEl.addEventListener('mousedown', (e) => {
  // (el cuadro del mensaje y su casilla sí toman el foco)
  if (!(e.target as HTMLElement).closest('textarea, input, label')) e.preventDefault();
});
gitEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('[data-commit]')) {
    const box = gitEl.querySelector<HTMLTextAreaElement>('#git-msg');
    const message = box?.value.trim() ?? '';
    if (!message) {
      box?.focus();
      return;
    }
    if (active) deactivate();
    post({ type: 'gitCommit', message, all: gitEl.querySelector<HTMLInputElement>('#git-all')?.checked === true });
    if (box) box.value = '';
    return;
  }
  const other = t.closest<HTMLElement>('[data-other]');
  if (other) return post({ type: 'openPath', path: gitState.others[Number(other.dataset.other)]?.path });
  if (t.closest('[data-cmd="git"]')) return run('git');
  const open = t.closest<HTMLElement>('[data-open]');
  if (open) return post({ type: 'gitOpen', ref: open.dataset.open });
  const pick = t.closest<HTMLElement>('[data-ref]');
  if (pick) {
    gitState.ref = pick.dataset.ref as string;
    renderGit();
    return post({ type: 'gitCompare', ref: gitState.ref });
  }
  if (t.closest('[data-more]')) return post({ type: 'gitMore', skip: gitState.commits.length });
  const chg = t.closest<HTMLElement>('.git-chg');
  if (chg) showChange(Number(chg.dataset.chg));
});
root.addEventListener('click', (e) => {
  const bar = (e.target as HTMLElement | null)?.closest?.<HTMLElement>('.chg-bar');
  if (!bar) return;
  e.preventDefault();
  e.stopPropagation();
  showChange(Number(bar.dataset.chg), bar.parentElement as BlockEl);
}, true);
popEl.addEventListener('mousedown', (e) => e.preventDefault());
popEl.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const restore = t.closest<HTMLElement>('[data-restore]');
  if (restore) {
    // lo que se esté escribiendo se guarda antes: el tramo se sustituye sobre el documento al día
    if (active) deactivate();
    post({ type: 'gitRestore', index: Number(restore.dataset.restore) });
    popEl.hidden = true;
  } else if (t.closest('[data-close]')) popEl.hidden = true;
});
document.addEventListener('mousedown', (e) => {
  const t = e.target as HTMLElement;
  if (!popEl.hidden && !t.closest('#chgpop, #git, .chg-bar')) popEl.hidden = true;
  if (gitOpen && !gitDocked() && !t.closest('#git, #status, #chgpop, .chg-bar')) run('git');
});
window.addEventListener('scroll', () => {
  // (el desplazamiento que lleva hasta el bloque al abrir el detalle no lo cierra)
  if (Date.now() - popShownAt > 500) popEl.hidden = true;
}, { passive: true });

/** Resalta en el esquema la sección que se está viendo y calcula la página actual. */
function trackScroll(): void {
  viewAnchor = anchorNow();
  const line = toolbar.offsetHeight + 60;
  let current: Element | undefined;
  navEl.querySelectorAll<HTMLElement>('.nav-item').forEach((item) => {
    const el = els[Number(item.dataset.i)];
    if (el && vrect(el).top <= line) current = item;
    item.classList.remove('on');
  });
  current?.classList.add('on');
  const mid = window.innerHeight / 2;
  const sheets = Array.from(sheetsEl.children);
  const page = document.body.classList.contains('grid')
    ? Math.max(1, sheets.findIndex((s) => vrect(s).bottom > mid) + 1)
    : 1 + Array.from(root.querySelectorAll('.block.page-start, .pg-split')).filter((b) => vrect(b).top < mid).length;
  if (page !== currentPage) {
    currentPage = page;
    updateStatus();
  }
}

let scrollTick = false;
window.addEventListener('scroll', () => {
  lastScrollAt = performance.now();
  hideBubble();
  if (scrollTick) return;
  scrollTick = true;
  requestAnimationFrame(() => {
    scrollTick = false;
    trackScroll();
  });
});
/** Coloca un menú desplegable bajo su botón, sin que se salga de la ventana. */
function placeMenu(dd: HTMLElement): void {
  const btn = dd.querySelector('.dd-btn') as HTMLElement;
  const menu = dd.querySelector('.menu') as HTMLElement;
  const r = btn.getBoundingClientRect();
  menu.style.maxHeight = `${Math.max(160, window.innerHeight - r.bottom - 44)}px`;
  menu.style.top = `${Math.round(r.bottom + 3)}px`;
  menu.style.left = `${Math.round(Math.max(6, Math.min(r.left, document.documentElement.clientWidth - menu.offsetWidth - 6)))}px`;
}

/**
 * Con poco ancho la cinta se compacta; si aun así no cabe, aparecen flechas en los bordes para
 * desplazarla (también vale la rueda del ratón).
 */
function fitRibbon(): void {
  toolbar.classList.toggle('compact', toolbar.clientWidth < 940);
  const p = toolbar.querySelector<HTMLElement>('.panel.on');
  if (!p) return;
  const edge = (side: string, show: boolean): void => {
    const b = toolbar.querySelector<HTMLElement>(`.rb-more[data-scroll="${side}"]`);
    if (!b) return;
    b.hidden = !show;
    b.style.top = `${p.offsetTop}px`;
    b.style.height = `${p.offsetHeight}px`;
  };
  edge('-1', p.scrollLeft > 4);
  edge('1', p.scrollLeft + p.clientWidth < p.scrollWidth - 4);
}
toolbar.addEventListener(
  'wheel',
  (e) => {
    const t = e.target as HTMLElement;
    const p = t.closest('.panel, .tabs') as HTMLElement | null;
    if (!p || t.closest('.menu') || p.scrollWidth <= p.clientWidth) return;
    // la rueda desplaza la cinta en horizontal cuando no cabe entera
    p.scrollLeft += e.deltaY || e.deltaX;
    e.preventDefault();
    closeMenus();
  },
  { passive: false },
);
// el desplazamiento de un panel no burbujea: se escucha en la fase de captura
toolbar.addEventListener('scroll', fitRibbon, true);
// la cinta cambia de alto con cada pestaña: el panel lateral empieza justo debajo
new ResizeObserver(() => {
  document.body.style.setProperty('--tb-h', `${toolbar.offsetHeight}px`);
  fitRibbon();
}).observe(toolbar);

// ------------------------------------------------------------------ barra flotante de selección

const bubbleEl = document.createElement('div');
bubbleEl.id = 'bubble';
bubbleEl.hidden = true;
bubbleEl.innerHTML = (
  [
    ['bold', '', 'bold', 'Negrita'], ['italic', '', 'italic', 'Cursiva'], ['underline', '', '', 'Subrayado'], ['code', '', 'code', 'Monoespaciado'],
    ['-'], ['wrap', 'sup', '', 'Superíndice'], ['wrap', 'sub', '', 'Subíndice'], ['-'],
    ['ins-link', '', 'link', 'Convertir en enlace'], ['to-math', '', 'symbol-operator', 'Convertir en fórmula'],
  ] as string[][]
)
  .map(([cmd, arg, icon, title]) => {
    if (cmd === '-') return '<span class="bb-sep"></span>';
    const face = icon ? `<i class="codicon codicon-${icon}"></i>` : cmd === 'underline' ? '<u>S</u>' : arg === 'sup' ? 'x<sup>2</sup>' : 'x<sub>2</sub>';
    return `<button data-cmd="${cmd}" data-arg="${arg}" title="${title}">${face}</button>`;
  })
  .join('');
document.body.appendChild(bubbleEl);
bubbleEl.addEventListener('mousedown', (e) => e.preventDefault());
bubbleEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button[data-cmd]') as HTMLElement | null;
  if (b) run(b.dataset.cmd as string, b.dataset.arg || undefined);
});

function hideBubble(): void {
  bubbleEl.hidden = true;
}

/** Muestra la barra sobre el texto seleccionado dentro del bloque en edición. */
function showBubble(): void {
  if (xdrag) {
    // todavía se está arrastrando
    hideBubble();
    return;
  }
  if (xsel && xselAt && !modal && !spellHit) {
    // selección de varios bloques: junto al punto donde se soltó el ratón
    bubbleEl.hidden = false;
    const w = bubbleEl.offsetWidth;
    const above = xselAt.y - bubbleEl.offsetHeight - 14;
    bubbleEl.style.top = `${Math.round(above < toolbar.offsetHeight + 4 ? xselAt.y + 18 : above)}px`;
    bubbleEl.style.left = `${Math.round(Math.min(Math.max(xselAt.x - w / 2, 8), document.documentElement.clientWidth - w - 8))}px`;
    return;
  }
  const sel = selection();
  if (!active || modal || slash || spellHit || sel.isCollapsed || !sel.rangeCount || !active.el.contains(sel.anchorNode) || !sel.toString().trim()) {
    hideBubble();
    return;
  }
  const rect = vrect(sel.getRangeAt(0));
  if (!rect.width && !rect.height) {
    hideBubble();
    return;
  }
  bubbleEl.hidden = false;
  const w = bubbleEl.offsetWidth;
  const h = bubbleEl.offsetHeight;
  const above = rect.top - h - 8;
  const top = above < toolbar.offsetHeight + 4 ? rect.bottom + 8 : above;
  bubbleEl.style.top = `${Math.round(top)}px`;
  bubbleEl.style.left = `${Math.round(Math.min(Math.max(rect.left + rect.width / 2 - w / 2, 8), document.documentElement.clientWidth - w - 8))}px`;
}

let bubbleTimer: number | undefined;
function scheduleBubble(): void {
  window.clearTimeout(bubbleTimer);
  // con un pequeño retraso para no parpadear mientras se arrastra la selección
  bubbleTimer = window.setTimeout(showBubble, 160);
}

// ------------------------------------------------------------------ comandos con «/»

interface SlashItem {
  icon: string;
  label: string;
  hint: string;
  /** palabras por las que se puede buscar */
  keys: string;
  cmd: string;
  arg?: string;
}

const SLASH_ITEMS: SlashItem[] = [
  { icon: 'symbol-text', label: 'Título 1', hint: 'Sección', keys: 'titulo seccion section h1', cmd: 'style', arg: 'section' },
  { icon: 'symbol-text', label: 'Título 2', hint: 'Subsección', keys: 'titulo subseccion subsection h2', cmd: 'style', arg: 'subsection' },
  { icon: 'symbol-text', label: 'Título 3', hint: 'Subsubsección', keys: 'titulo subsubseccion h3', cmd: 'style', arg: 'subsubsection' },
  { icon: 'list-unordered', label: 'Lista con viñetas', hint: 'itemize', keys: 'lista vinetas itemize puntos', cmd: 'list', arg: 'itemize' },
  { icon: 'list-ordered', label: 'Lista numerada', hint: 'enumerate', keys: 'lista numerada enumerate numeros', cmd: 'list', arg: 'enumerate' },
  { icon: 'symbol-operator', label: 'Ecuación', hint: 'Editor de ecuaciones', keys: 'ecuacion formula math equation', cmd: 'ins-equation' },
  { icon: 'symbol-operator', label: 'Fórmula en línea', hint: 'Dentro del texto', keys: 'formula linea inline math', cmd: 'ins-math' },
  { icon: 'table', label: 'Tabla', hint: 'Filas y columnas', keys: 'tabla table tabular', cmd: 'ins-table' },
  { icon: 'file-media', label: 'Imagen', hint: 'Desde un archivo', keys: 'imagen figura foto image figure', cmd: 'ins-image' },
  { icon: 'graph-line', label: 'Gráfica', hint: 'Dibujo TikZ de una función', keys: 'grafica dibujo tikz plot', cmd: 'ins-tikz', arg: 'plot' },
  { icon: 'quote', label: 'Cita textual', hint: 'quote', keys: 'cita textual quote', cmd: 'ins-quote' },
  { icon: 'code', label: 'Bloque de código', hint: 'verbatim', keys: 'codigo code verbatim', cmd: 'ins-code' },
  { icon: 'note', label: 'Nota al pie', hint: 'footnote', keys: 'nota pie footnote', cmd: 'ins-footnote' },
  { icon: 'link', label: 'Enlace', hint: 'href', keys: 'enlace link url', cmd: 'ins-link' },
  { icon: 'references', label: 'Referencia cruzada', hint: 'ref', keys: 'referencia cruzada ref', cmd: 'ins-ref' },
  { icon: 'book', label: 'Cita bibliográfica', hint: 'cite', keys: 'cita bibliografia cite fuente', cmd: 'ins-cite' },
  { icon: 'link-external', label: 'Cita desde un DOI', hint: 'Los datos se traen de doi.org', keys: 'cita doi referencia articulo fuente', cmd: 'add-doi' },
  { icon: 'folder-library', label: 'Cita de Zotero', hint: 'Better BibTeX', keys: 'cita zotero referencia fuente', cmd: 'cite-zotero' },
  { icon: 'list-tree', label: 'Índice', hint: 'Tabla de contenido', keys: 'indice contenido toc', cmd: 'ins-toc' },
  { icon: 'fold-down', label: 'Salto de página', hint: 'newpage', keys: 'salto pagina newpage', cmd: 'ins-newpage' },
];

const slashEl = document.createElement('div');
slashEl.id = 'slash';
slashEl.hidden = true;
document.body.appendChild(slashEl);
let slash: { node: Text; offset: number; index: number; items: SlashItem[] } | undefined;

const plainKey = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Texto escrito tras la barra, o `undefined` si el cursor ya no está en el comando. */
function slashQuery(): string | undefined {
  const sel = selection();
  if (!slash || sel.anchorNode !== slash.node || slash.node.data[slash.offset] !== '/' || sel.anchorOffset <= slash.offset) return undefined;
  const q = slash.node.data.slice(slash.offset + 1, sel.anchorOffset);
  return q.length > 24 ? undefined : q;
}

/** Se acaba de teclear «/»: abre el menú si está al principio del bloque o tras un espacio. */
function openSlash(): void {
  const sel = selection();
  const node = sel.anchorNode;
  if (!active || !node || node.nodeType !== 3 || !sel.isCollapsed) return;
  const offset = sel.anchorOffset - 1;
  const before = (node as Text).data.slice(0, offset);
  if ((node as Text).data[offset] !== '/' || (before !== '' && !/[\s ]$/.test(before))) return;
  slash = { node: node as Text, offset, index: 0, items: SLASH_ITEMS };
  hideBubble();
  renderSlash();
}

function closeSlash(): void {
  slash = undefined;
  slashEl.hidden = true;
}

function renderSlash(): void {
  const q = slashQuery();
  if (!slash || q === undefined) {
    closeSlash();
    return;
  }
  const words = plainKey(q).split(/\s+/).filter(Boolean);
  slash.items = SLASH_ITEMS.filter((it) => words.every((w) => plainKey(`${it.label} ${it.keys}`).includes(w)));
  if (!slash.items.length) {
    closeSlash();
    return;
  }
  slash.index = Math.min(slash.index, slash.items.length - 1);
  slashEl.innerHTML =
    '<div class="menu-title">Insertar</div>' +
    slash.items
      .map((it, k) => `<button data-k="${k}" class="${k === slash?.index ? 'on' : ''}"><i class="codicon codicon-${it.icon}"></i><span><b>${it.label}</b><small>${it.hint}</small></span></button>`)
      .join('');
  slashEl.hidden = false;
  const r = document.createRange();
  r.setStart(slash.node, slash.offset);
  r.setEnd(slash.node, slash.offset + 1);
  const rect = vrect(r);
  const below = rect.bottom + 6;
  const h = slashEl.offsetHeight;
  slashEl.style.top = `${Math.round(below + h > window.innerHeight - 30 ? Math.max(rect.top - h - 6, toolbar.offsetHeight + 4) : below)}px`;
  slashEl.style.left = `${Math.round(Math.min(rect.left, document.documentElement.clientWidth - slashEl.offsetWidth - 8))}px`;
  slashEl.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
}

/** Ejecuta el comando elegido tras borrar lo tecleado («/tab...»). */
function execSlash(index = slash?.index ?? 0): void {
  const s = slash;
  const sel = selection();
  const it = s?.items[index];
  if (!s || !it || !active) return;
  const end = sel.anchorNode === s.node ? sel.anchorOffset : s.node.length;
  s.node.deleteData(s.offset, Math.max(end - s.offset, 1));
  const r = document.createRange();
  r.setStart(s.node, s.offset);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  active.dirty = true;
  active.el._html = null;
  closeSlash();
  run(it.cmd, it.arg);
}

/** Teclas del menú «/»; devuelve true si la tecla ya se ha atendido. */
function slashKey(e: KeyboardEvent): boolean {
  if (!slash) return false;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    slash.index = (slash.index + (e.key === 'ArrowDown' ? 1 : slash.items.length - 1)) % slash.items.length;
    renderSlash();
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') {
    execSlash();
    return true;
  }
  if (e.key === 'Escape') {
    closeSlash();
    return true;
  }
  return false;
}

slashEl.addEventListener('mousedown', (e) => e.preventDefault());
slashEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button[data-k]') as HTMLElement | null;
  if (b) execSlash(Number(b.dataset.k));
});
document.addEventListener('mousedown', (e) => {
  if (slash && !(e.target as HTMLElement).closest('#slash')) closeSlash();
});

// ------------------------------------------------------------------ atajos tipo Markdown

/**
 * Al escribir al principio de un párrafo «# », «## », «### », «- », «1. » o «> » y pulsar espacio,
 * el párrafo se convierte en título, lista o cita. Devuelve true si aplicó algún atajo.
 */
function markdownShortcut(): boolean {
  const a = active;
  const sel = selection();
  const node = sel.anchorNode;
  if (!a || !node || node.nodeType !== 3 || !sel.isCollapsed) return false;
  const c = content(a.el);
  if (c.firstChild !== node || !isPlain(c)) return false;
  const m = /^(#{1,3}|[-*]|1[.)]|>)[  ]$/.exec((node as Text).data.slice(0, sel.anchorOffset));
  if (!m) return false;
  (node as Text).deleteData(0, sel.anchorOffset);
  const r = document.createRange();
  r.setStart(node, 0);
  r.collapse(true);
  sel.removeAllRanges();
  sel.addRange(r);
  a.dirty = true;
  a.el._html = null;
  const key = m[1];
  if (key.startsWith('#')) setStyle(['section', 'subsection', 'subsubsection'][key.length - 1]);
  else if (key === '>') commitFull(`\\begin{quote}\n${serializeBlock(c)}\n\\end{quote}`, { line: a.rs + a.lead, offset: 0 });
  else toggleList(key.startsWith('1') ? 'enumerate' : 'itemize');
  return true;
}

// ------------------------------------------------------------------ selección de varios bloques

/*
 * Cada bloque es un área de edición propia y el navegador no deja que una selección salga de la
 * suya. Cuando el arrastre (o Mayús+clic, o Ctrl+A) pasa de un bloque a otro, la selección la lleva
 * Mars: son dos puntos (bloque y posición dentro de él) y se pinta con la API de resaltados de CSS,
 * sin tocar el documento. Sobre ella funcionan borrar, copiar, cortar, pegar, escribir y el formato.
 */
interface XPoint {
  el: BlockEl;
  /** posición en unidades dentro del contenido del bloque (ver caret.ts) */
  off: number;
}
interface XRange {
  /** bloques seleccionados, de arriba abajo */
  list: BlockEl[];
  /** dónde empieza en el primero y dónde acaba en el último */
  from: number;
  to: number;
}

const XEND = Number.MAX_SAFE_INTEGER;
let xsel: { a: XPoint; f: XPoint } | undefined;
/** edición propia tras la que la selección debe seguir en su sitio (dar formato) */
let xselKeep = -1;
/** punto de la ventana donde terminó el arrastre: ahí aparece la barra flotante */
let xselAt: { x: number; y: number } | undefined;
let pendingPaste: { html: string; text: string } | undefined;
const xselMark = typeof Highlight === 'undefined' ? undefined : new Highlight();
if (xselMark) CSS.highlights.set('mars-select', xselMark);

const isRich = (el: BlockEl): boolean => el._b?.kind === 'rich';
/** El preámbulo y las notas al pie no forman parte del texto que se puede seleccionar. */
const selectable = (el: BlockEl): boolean => !el.classList.contains('is-preamble') && el._b !== undefined && el._b.kind !== 'ro';

function xselRange(): XRange | undefined {
  if (!xsel) return undefined;
  const ia = els.indexOf(xsel.a.el);
  const ib = els.indexOf(xsel.f.el);
  if (ia < 0 || ib < 0) return undefined;
  const [s, e] = ia < ib || (ia === ib && xsel.a.off <= xsel.f.off) ? [xsel.a, xsel.f] : [xsel.f, xsel.a];
  const list = els.slice(Math.min(ia, ib), Math.max(ia, ib) + 1).filter(selectable);
  return list.length ? { list, from: s.off, to: e.off } : undefined;
}

/** Parte seleccionada de un bloque de texto. */
function xselPart(x: XRange, el: BlockEl): Range {
  const c = content(el);
  const r = document.createRange();
  r.selectNodeContents(c);
  if (el === x.list[0]) {
    const p = pointAt(c, x.from);
    r.setStart(p.node, p.offset);
  }
  if (el === x.list[x.list.length - 1]) {
    const p = pointAt(c, x.to);
    r.setEnd(p.node, p.offset);
  }
  return r;
}

/** ¿La selección abarca el bloque entero? */
function xselWhole(x: XRange, el: BlockEl): boolean {
  return (el !== x.list[0] || x.from === 0) && (el !== x.list[x.list.length - 1] || x.to >= units(content(el)));
}

function paintXsel(): void {
  root.querySelectorAll('.block.xs').forEach((b) => b.classList.remove('xs'));
  xselMark?.clear();
  const x = xselRange();
  document.body.classList.toggle('has-xsel', x !== undefined);
  if (!x) return;
  for (const el of x.list) {
    if (isRich(el)) xselMark?.add(xselPart(x, el));
    else el.classList.add('xs'); // una ecuación, una figura...: se marca el bloque entero
  }
}

function clearXsel(): void {
  if (!xsel) return;
  xsel = undefined;
  xselAt = undefined;
  paintXsel();
  hideBubble();
  updateToolbar();
}

function setXsel(a: XPoint, f: XPoint): void {
  if (active) deactivate();
  selection().removeAllRanges();
  // sin área de edición enfocada: las teclas las atiende la selección, no el navegador
  (document.activeElement as HTMLElement | null)?.blur?.();
  xsel = { a, f };
  paintXsel();
  updateToolbar();
}

function selectAllBlocks(): void {
  const list = els.filter(selectable);
  if (list.length) setXsel({ el: list[0], off: 0 }, { el: list[list.length - 1], off: XEND });
}

/** Punto de un bloque que corresponde a una posición de la ventana. */
function xpoint(el: BlockEl, x: number, y: number): XPoint {
  if (!isRich(el)) return { el, off: 0 };
  const c = content(el);
  const r = document.caretRangeFromPoint(x, y);
  if (r && c.contains(r.startContainer)) return { el, off: offsetOf(c, r.startContainer, r.startOffset) };
  const box = vrect(el);
  return { el, off: y < box.top + box.height / 2 ? 0 : units(c) };
}

/** Bloque que hay bajo un punto de la ventana; entre dos bloques o en el margen, el más cercano. */
function blockAt(x: number, y: number): BlockEl | undefined {
  const hit = (document.elementFromPoint(x, y) as HTMLElement | null)?.closest('.block') as BlockEl | null;
  if (hit && els.includes(hit) && selectable(hit)) return hit;
  let best: BlockEl | undefined;
  let dist = Infinity;
  for (const el of els) {
    if (!selectable(el)) continue;
    const r = vrect(el);
    const d = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    if (d < dist) {
      dist = d;
      best = el;
    }
  }
  return best;
}

/** Código LaTeX de lo seleccionado. */
function xselLatex(): string {
  const x = xselRange();
  if (!x) return '';
  const parts: string[] = [];
  for (const el of x.list) {
    if (isRich(el) && !xselWhole(x, el)) {
      const tex = tidy(serializeChildren(xselPart(x, el).cloneContents()));
      if (tex) parts.push(tex);
    } else if (el._b) parts.push(el._b.src);
  }
  return parts.join('\n\n');
}

interface Splice {
  s: number;
  d: number;
  expect: string[];
  lines: string[];
  /** en una inserción, las líneas vecinas que se espera encontrar */
  prev?: string;
  next?: string;
}

// ------------------------------------------------------------------ mover, duplicar y arrastrar bloques

/** Bloques que se pueden cambiar de sitio: los del texto, ya dibujados. */
const movable = (el: BlockEl | undefined): el is BlockEl => el !== undefined && els.includes(el) && selectable(el) && !el.classList.contains('pending');

/** Bloques sobre los que actúan las órdenes de mover: los seleccionados, o el del cursor. */
function blockTargets(): BlockEl[] {
  const x = xselRange();
  if (x) return x.list.filter(movable);
  const el = active?.el ?? (lastEl?.isConnected ? lastEl : undefined);
  return movable(el) ? [el] : [];
}

/** Selección de varios bloques que hay que recuperar, por sus líneas, cuando llegue el documento movido. */
let moveKeep: { from: number; to: number } | undefined;

/**
 * Lleva (o copia) el código de unos bloques a otro punto del documento, tal cual está escrito y en
 * una sola edición: un único paso de deshacer. Devuelve en qué línea queda y cuántas se añaden allí.
 */
function relocate(list: BlockEl[], dest: { line: number; gap: Gap }, copy: boolean): { line: number; added: number; cut: number } | undefined {
  const exts = list.map((el) => extent(el)).filter((x): x is Extent => x !== undefined && x.lines.length > 0);
  if (!exts.length) return undefined;
  const batch: Splice[] = [];
  let cut = 0;
  if (!copy) {
    for (const x of exts) {
      const gone = removal(x);
      // el destino no puede caer dentro de lo que se quita
      if (dest.line > x.s && dest.line < x.s + gone.expect.length) return undefined;
      batch.push({ s: x.s, d: gone.expect.length, expect: gone.expect, lines: gone.lines });
      if (x.s < dest.line) cut += gone.expect.length - gone.lines.length;
    }
  }
  const lead = dest.gap.before ? [] : [''];
  const lines = [...lead, ...exts.map((x) => x.lines.join('\n')).join('\n\n').split('\n'), ...(dest.gap.after ? [] : [''])];
  batch.push({ s: dest.line, d: 0, expect: [], lines, prev: dest.gap.prev, next: dest.gap.next });
  dropActive();
  pickedImage = undefined;
  post({ type: 'splices', list: batch, seq: ++seq });
  transitAt = Date.now();
  return { line: dest.line - cut + lead.length, added: lines.length, cut };
}

/** Deja el cursor (o la selección de varios bloques) en lo que se acaba de mover. */
function keepOn(list: BlockEl[], from: number, to: number, offset?: number): void {
  clearXsel();
  if (list.length > 1) moveKeep = { from, to };
  else nextFocus = { line: from, offset };
}

/** Sube o baja un puesto los bloques elegidos: en el código, cambian de sitio con su vecino. */
function moveBlocks(dir: -1 | 1, list = blockTargets()): boolean {
  if (readOnly || !list.length) return false;
  const offset = active && list.length === 1 && active.el === list[0] ? caretOffset(content(active.el)) : undefined;
  if (active) flush(active);
  const first = extent(list[0]);
  const last = extent(list[list.length - 1]);
  const other = els[dir < 0 ? els.indexOf(list[0]) - 1 : els.indexOf(list[list.length - 1]) + 1];
  if (!first || !last || !movable(other)) return false;
  // quien cambia de lado es el vecino: así el grupo viaja entero, con lo que haya entre sus bloques
  const done = relocate([other], dir < 0 ? afterOf(last) : beforeOf(first), false);
  if (!done) return false;
  const delta = dir < 0 ? -done.cut : done.added;
  keepOn(list, first.s + delta, last.s + delta, offset);
  return true;
}

/** Copia los bloques elegidos justo debajo. */
function duplicateBlocks(list = blockTargets()): boolean {
  if (readOnly || !list.length) return false;
  if (active) flush(active);
  const last = extent(list[list.length - 1]);
  const done = last ? relocate(list, afterOf(last), true) : undefined;
  if (!done) return false;
  keepOn(list, done.line, done.line + done.added - 1);
  return true;
}

/** Código LaTeX de los bloques elegidos, al portapapeles; `cut` además los quita. */
function clipBlocks(cut: boolean): void {
  const list = blockTargets();
  if (!list.length) return;
  if (active) flush(active);
  const tex = list.map((el) => extent(el)?.lines.join('\n') ?? '').filter(Boolean).join('\n\n');
  void navigator.clipboard.writeText(tex).then(
    () => {
      if (!cut || readOnly) return;
      if (list.length > 1) deleteXsel();
      else deleteBlock(list[0]);
    },
    () => post({ type: 'info', text: 'El editor no tiene permiso para escribir en el portapapeles: usa Ctrl+C.' }),
  );
}

document.addEventListener(
  'keydown',
  (e) => {
    if (isDialogOpen() || readOnly || e.getModifierState('AltGraph')) return;
    const t = e.target as HTMLElement | null;
    if (t && (findEl.contains(t) || toolbar.contains(t) || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    const arrow = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0;
    let done: boolean;
    // Alt+flechas mueve el bloque; con Mayús lo duplica (como en el editor de código), igual que Ctrl+D
    if (e.altKey && !e.ctrlKey && !e.metaKey && arrow) done = e.shiftKey ? duplicateBlocks() : moveBlocks(arrow);
    else if ((e.ctrlKey || e.metaKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'd') done = duplicateBlocks();
    else return;
    if (!done && !blockTargets().length) return;
    e.preventDefault();
    e.stopPropagation();
  },
  true,
);

/** Arrastre de un bloque con el ratón, desde su asa. */
let bdrag: { el: BlockEl; to?: { el: BlockEl; before: boolean }; moved: boolean; y: number } | undefined;
const dropEl = document.createElement('div');
dropEl.id = 'dropline';
dropEl.hidden = true;
document.body.appendChild(dropEl);

function endBlockDrag(): void {
  bdrag?.el.classList.remove('dragging');
  bdrag = undefined;
  dropEl.hidden = true;
  document.body.classList.remove('bdrag', 'bdrag-copy');
}

/** ¿Soltar ahí dejaría el bloque donde ya estaba? */
function sameSpot(el: BlockEl, to: { el: BlockEl; before: boolean }): boolean {
  if (to.el === el) return true;
  const i = els.indexOf(el);
  return to.before ? els[i + 1] === to.el : els[i - 1] === to.el;
}

root.addEventListener(
  'mousedown',
  (e) => {
    const grip = (e.target as HTMLElement).closest('.tools [data-act="drag"]');
    const el = grip?.closest('.block') as BlockEl | null | undefined;
    if (!el || e.button !== 0 || readOnly || !movable(el)) return;
    e.preventDefault();
    e.stopPropagation();
    if (active) deactivate();
    bdrag = { el, moved: false, y: e.clientY };
  },
  true,
);
document.addEventListener('mousemove', (e) => {
  const d = bdrag;
  if (!d) return;
  if (!(e.buttons & 1)) {
    endBlockDrag();
    return;
  }
  if (!d.moved && Math.abs(e.clientY - d.y) < 4) return;
  if (!d.moved) {
    d.moved = true;
    d.el.classList.add('dragging');
    document.body.classList.add('bdrag');
  }
  document.body.classList.toggle('bdrag-copy', e.ctrlKey);
  // dentro de la hoja aunque el ratón vaya por el margen: se mira a la altura del ratón, en la columna del bloque
  const box = vrect(d.el);
  const over = blockAt(Math.min(Math.max(e.clientX, box.left + 4), box.right - 4), e.clientY);
  const to = over && movable(over) ? { el: over, before: e.clientY < vrect(over).top + vrect(over).height / 2 } : undefined;
  d.to = to && (e.ctrlKey || !sameSpot(d.el, to)) ? to : undefined;
  dropEl.hidden = d.to === undefined;
  if (d.to) {
    const r = vrect(d.to.el);
    dropEl.style.left = `${Math.round(r.left)}px`;
    dropEl.style.width = `${Math.round(r.width)}px`;
    dropEl.style.top = `${Math.round((d.to.before ? r.top : r.bottom) - 1)}px`;
  }
  if (e.clientY > window.innerHeight - 56) window.scrollBy(0, 22);
  else if (e.clientY < toolbar.offsetHeight + 30) window.scrollBy(0, -22);
});
document.addEventListener('mouseup', (e) => {
  const d = bdrag;
  if (!d) return;
  endBlockDrag();
  if (!d.moved || !d.to) return;
  dropBlock(d.el, d.to.el, d.to.before, e.ctrlKey);
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && bdrag) endBlockDrag();
});

/** Suelta `el` antes o después de `target`; con `copy`, deja también el original. */
function dropBlock(el: BlockEl, target: BlockEl, before: boolean, copy: boolean): boolean {
  if (readOnly || !movable(el) || !movable(target) || (!copy && sameSpot(el, { el: target, before }))) return false;
  if (active) flush(active);
  const x = extent(target);
  const done = x ? relocate([el], before ? beforeOf(x) : afterOf(x), copy) : undefined;
  if (!done) return false;
  keepOn([el], done.line, done.line);
  return true;
}

/**
 * Borra lo seleccionado. De los bloques de los extremos queda lo que no estaba seleccionado (si
 * ambos son párrafos, se unen en uno, como en un procesador de textos); los intermedios desaparecen.
 */
function deleteXsel(): boolean {
  const x = xselRange();
  clearXsel();
  if (!x) return false;
  const first = x.list[0];
  const last = x.list[x.list.length - 1];
  const before = new Map(x.list.map((el) => [el, extent(el)] as const));
  const cut = (el: BlockEl): string => {
    // seleccionado entero: el bloque desaparece (y no queda, por ejemplo, un título vacío)
    if (xselWhole(x, el)) return '';
    xselPart(x, el).deleteContents();
    el._html = null;
    return serializeChildren(content(el));
  };
  // lo que queda de cada extremo, tal cual (con los espacios que hubiera junto al corte)
  const head = isRich(first) ? cut(first) : '';
  const tail = last !== first && isRich(last) ? cut(last) : '';
  const keep = new Map<BlockEl, string>([[first, tidy(head)]]);
  if (last !== first) keep.set(last, tidy(tail));
  if (last !== first && tidy(head) && tidy(tail) && isPlain(content(first)) && isPlain(content(last))) {
    // si había espacio a ambos lados del corte, queda uno solo
    const joint = /[ \t]$/.test(head) && /^[ \t]/.test(tail) ? head + tail.replace(/^[ \t]+/, '') : head + tail;
    keep.set(first, tidy(joint));
    keep.set(last, '');
  }
  const batch: Splice[] = [];
  for (const el of x.list) {
    const ext = before.get(el);
    if (!ext) continue;
    const rest = keep.get(el);
    if (rest) {
      if (rest !== ext.lines.join('\n')) batch.push({ s: ext.s, d: ext.lines.length, expect: ext.lines, lines: rest.split('\n') });
    } else {
      const gone = removal(ext);
      batch.push({ s: ext.s, d: gone.expect.length, expect: gone.expect, lines: gone.lines });
    }
  }
  if (!batch.length) return false;
  // el cursor queda en el punto de unión; si el primer bloque ha desaparecido, al principio de lo que siga
  const at = before.get(first) as Extent;
  nextFocus = keep.get(first) ? { line: at.s, offset: x.from } : { line: at.s, atStart: true, forward: true, thenWrite: true };
  post({ type: 'splices', list: batch, seq: ++seq });
  transitAt = Date.now();
  return true;
}

/** Aplica un formato de carácter a todo el texto seleccionado, bloque a bloque, en una sola edición. */
function wrapXsel(make: () => HTMLElement, already: string, packages?: string[]): void {
  const x = xselRange();
  if (!x) return;
  const batch: Splice[] = [];
  for (const el of x.list) {
    const ext = isRich(el) ? extent(el) : undefined;
    if (!ext) continue;
    // sin las marcas de división: el formato debe envolver cada palabra entera, no sus sílabas
    unhyphenate(content(el));
    el._hy = '';
    wrapRange(xselPart(x, el), make, already);
    el._html = null;
    const lines = serializeBlock(content(el)).split('\n');
    if (lines.join('\n') !== ext.lines.join('\n')) batch.push({ s: ext.s, d: ext.lines.length, expect: ext.lines, lines });
  }
  if (!batch.length) return;
  xselKeep = ++seq;
  post({ type: 'splices', list: batch, seq, packages });
}

/** Punto donde está el cursor dentro del bloque en edición. */
function caretPoint(): XPoint | undefined {
  if (!active || !els.includes(active.el)) return undefined;
  const off = caretOffset(content(active.el));
  return off === undefined ? undefined : { el: active.el, off };
}

let xdrag: { el: BlockEl; node: Node; offset: number; a?: XPoint } | undefined;

pageEl.addEventListener('mousedown', (e) => {
  const t = e.target as HTMLElement;
  if (e.button !== 0 || t.closest('.tools')) return;
  const el = t.closest('.block') as BlockEl | null;
  if (!el || !els.includes(el) || !selectable(el)) {
    clearXsel();
    return;
  }
  if (e.shiftKey) {
    // Mayús+clic en otro bloque: desde donde estaba el cursor (o la selección) hasta aquí
    const a = xsel?.a ?? caretPoint();
    if (a && a.el !== el) {
      e.preventDefault();
      setXsel(a, xpoint(el, e.clientX, e.clientY));
      xselAt = { x: e.clientX, y: e.clientY };
      scheduleBubble();
      return;
    }
  }
  clearXsel();
  const pos = document.caretRangeFromPoint(e.clientX, e.clientY);
  xdrag = { el, node: pos?.startContainer ?? content(el), offset: pos?.startOffset ?? 0 };
});
document.addEventListener('mousemove', (e) => {
  if (!xdrag) return;
  if (!(e.buttons & 1)) {
    xdrag = undefined;
    return;
  }
  const over = blockAt(e.clientX, e.clientY);
  if (!over) return;
  if (over === xdrag.el) {
    if (xsel) {
      // de vuelta en el bloque de partida: la selección vuelve a ser la normal del navegador
      const a = xsel.a;
      clearXsel();
      document.body.classList.remove('xdrag');
      const q = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (isRich(a.el) && q && content(a.el).contains(q.startContainer)) {
        activateEl(a.el);
        const p = pointAt(content(a.el), a.off);
        selection().setBaseAndExtent(p.node, p.offset, q.startContainer, q.startOffset);
      }
    }
    return;
  }
  if (!xdrag.a) {
    const c = content(xdrag.el);
    xdrag.a = { el: xdrag.el, off: isRich(xdrag.el) && c.contains(xdrag.node) ? offsetOf(c, xdrag.node, xdrag.offset) : 0 };
  }
  document.body.classList.add('xdrag');
  setXsel(xdrag.a, xpoint(over, e.clientX, e.clientY));
  xselAt = { x: e.clientX, y: e.clientY };
  e.preventDefault();
  // cerca del borde de la ventana el documento se desplaza, como en un arrastre normal
  if (e.clientY > window.innerHeight - 56) window.scrollBy(0, 26);
  else if (e.clientY < toolbar.offsetHeight + 30) window.scrollBy(0, -26);
});
document.addEventListener('mouseup', () => {
  if (!xdrag) return;
  xdrag = undefined;
  document.body.classList.remove('xdrag');
  if (xsel) scheduleBubble();
});

document.addEventListener(
  'keydown',
  (e) => {
    if (!xsel || isDialogOpen()) return;
    const mod = (e.ctrlKey || e.metaKey || e.altKey) && !e.getModifierState('AltGraph');
    if (e.key === 'Escape') clearXsel();
    else if (!mod && (e.key === 'Delete' || e.key === 'Backspace' || e.key === 'Enter')) deleteXsel();
    else if (!mod && e.key.length === 1) {
      // escribir encima sustituye lo seleccionado
      if (deleteXsel()) typeAhead += e.key;
    } else if (!mod && !e.shiftKey && e.key.startsWith('Arrow')) {
      // las flechas dejan el cursor al principio o al final de lo que estaba seleccionado
      const x = xselRange();
      clearXsel();
      if (x) {
        const up = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
        const el = up ? x.list[0] : x.list[x.list.length - 1];
        if (isRich(el)) {
          activateEl(el);
          setCaretOffset(content(el), up ? x.from : Math.min(x.to, units(content(el))));
        } else select(el);
      }
    } else return; // Ctrl+C, Ctrl+B...: siguen su camino
    e.preventDefault();
    e.stopPropagation();
  },
  true,
);
document.addEventListener('copy', (e) => {
  if (!xsel || !e.clipboardData) return;
  e.clipboardData.setData('text/plain', xselLatex());
  e.preventDefault();
});
document.addEventListener('cut', (e) => {
  if (!xsel || !e.clipboardData) return;
  e.clipboardData.setData('text/plain', xselLatex());
  e.preventDefault();
  deleteXsel();
});
document.addEventListener('paste', (e) => {
  if (!xsel || !e.clipboardData) return;
  // lo pegado sustituye a lo seleccionado: se inserta cuando el cursor ya está en el hueco
  e.preventDefault();
  const stash = { html: e.clipboardData.getData('text/html'), text: e.clipboardData.getData('text/plain') };
  if (deleteXsel()) pendingPaste = stash;
});

// ------------------------------------------------------------------ ortografía

let spellInfo: SpellInfo = { enabled: false, choice: 'auto', langs: [] };
let spellCount = 0;
const spell = new SpellChecker({
  post,
  contents: () => Array.from(root.querySelectorAll<HTMLElement>('.block.k-rich > .content')),
  changed: () => {
    const n = spell.list().length;
    if (n !== spellCount) {
      spellCount = n;
      updateStatus();
    }
  },
});

/** Refleja en la pestaña Revisar si el corrector está activo y con qué idioma. */
function updateSpellUi(): void {
  toolbar.querySelectorAll<HTMLElement>('button[data-cmd="spell-toggle"]').forEach((b) => b.classList.toggle('on', spellInfo.enabled));
  toolbar.querySelectorAll<HTMLElement>('button[data-cmd="spell-lang"]').forEach((b) => b.classList.toggle('checked', b.dataset.arg === spellInfo.choice));
}

const spellEl = document.createElement('div');
spellEl.id = 'spellmenu';
spellEl.hidden = true;
document.body.appendChild(spellEl);
let spellHit: Hit | undefined;
let suggestId = 0;

function closeSpellMenu(): void {
  spellHit = undefined;
  spellEl.hidden = true;
}

/** Contenido del menú: las sugerencias (o el aviso de que se están buscando) y las acciones fijas. */
function renderSpellMenu(list: string[] | undefined): void {
  if (!spellHit) return;
  const word = escHtml(spellHit.word);
  const top =
    list === undefined
      ? '<div class="menu-empty">Buscando sugerencias…</div>'
      : list.length
        ? list.map((s) => `<button data-fix="${escHtml(s)}"><b>${escHtml(s)}</b></button>`).join('')
        : '<div class="menu-empty">Sin sugerencias</div>';
  spellEl.innerHTML =
    `${top}<hr>` +
    `<button data-act="add"><i class="codicon codicon-add"></i><span>Añadir «${word}» al diccionario</span></button>` +
    '<button data-act="ignore"><i class="codicon codicon-eye-closed"></i><span>Omitir en esta sesión</span></button>';
}

/** Coloca el menú junto al punto (x, y) sin que se salga de la ventana. */
function placeSpellMenu(x: number, y: number): void {
  const w = spellEl.offsetWidth;
  const h = spellEl.offsetHeight;
  const below = y + 8;
  spellEl.style.top = `${Math.round(below + h > window.innerHeight - 30 ? Math.max(y - h - 8, toolbar.offsetHeight + 4) : below)}px`;
  spellEl.style.left = `${Math.round(Math.max(8, Math.min(x, document.documentElement.clientWidth - w - 8)))}px`;
}

function openSpellMenu(hit: Hit, x: number, y: number): void {
  closeSlash();
  hideBubble();
  spellHit = hit;
  spellEl.hidden = false;
  spellEl.dataset.x = String(x);
  spellEl.dataset.y = String(y);
  renderSpellMenu(undefined);
  placeSpellMenu(x, y);
  post({ type: 'spellSuggest', id: ++suggestId, word: hit.word });
}

function onSuggestions(id: number, list: string[]): void {
  if (id !== suggestId || !spellHit) return;
  renderSpellMenu(list);
  placeSpellMenu(Number(spellEl.dataset.x), Number(spellEl.dataset.y));
}

/** Sustituye una palabra del documento por `text`, como si se hubiera tecleado. */
function replaceWord(hit: Hit, text: string): void {
  const el = (hit.range.startContainer.parentElement?.closest('.block') ?? null) as BlockEl | null;
  if (!el) return;
  if (active?.el !== el) activateEl(el);
  if (active?.el !== el) return;
  const sel = selection();
  sel.removeAllRanges();
  sel.addRange(hit.range);
  if (!document.execCommand('insertText', false, text)) {
    hit.range.deleteContents();
    hit.range.insertNode(document.createTextNode(text));
  }
  markDirty(true);
  spell.schedule();
}

spellEl.addEventListener('mousedown', (e) => e.preventDefault());
spellEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button') as HTMLElement | null;
  const hit = spellHit;
  if (!b || !hit) return;
  closeSpellMenu();
  if (b.dataset.fix !== undefined) replaceWord(hit, b.dataset.fix);
  else {
    if (b.dataset.act === 'add') post({ type: 'spellAdd', word: hit.word });
    spell.accept(hit.word);
  }
});
document.addEventListener('mousedown', (e) => {
  if (spellHit && !(e.target as HTMLElement).closest('#spellmenu')) closeSpellMenu();
});
document.addEventListener(
  'keydown',
  (e) => {
    if (spellHit && e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeSpellMenu();
    }
  },
  true,
);
window.addEventListener(
  'wheel',
  (e) => {
    if (spellHit && !(e.target as HTMLElement).closest?.('#spellmenu')) closeSpellMenu();
  },
  { passive: true },
);
// clic derecho sobre una palabra subrayada: sugerencias en lugar del menú de VS Code
document.addEventListener('contextmenu', (e) => {
  const hit = spell.enabled ? spell.at(e.clientX, e.clientY) : undefined;
  if (hit) {
    e.preventDefault();
    openSpellMenu(hit, e.clientX, e.clientY);
    return;
  }
  const t = e.target as HTMLElement;
  if (!t.closest('#root') || isDialogOpen()) return;
  e.preventDefault();
  openContext(t, e.clientX, e.clientY);
});

// ------------------------------------------------------------------ menú del botón derecho e imágenes

const ctxEl = document.createElement('div');
ctxEl.id = 'ctxmenu';
ctxEl.hidden = true;
document.body.appendChild(ctxEl);
document.addEventListener('mousedown', (e) => {
  if (!ctxEl.hidden && !(e.target as HTMLElement).closest('#ctxmenu')) ctxEl.hidden = true;
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') ctxEl.hidden = true;
});
window.addEventListener('scroll', () => (ctxEl.hidden = true), { passive: true });
ctxEl.addEventListener('mousedown', (e) => e.preventDefault());
ctxEl.addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest('button[data-cmd]') as HTMLElement | null;
  if (!b) return;
  ctxEl.hidden = true;
  run(b.dataset.cmd as string, b.dataset.arg || undefined);
});

/** Órdenes del menú contextual: sobre una imagen, las suyas; sobre el texto, las del portapapeles. */
function contextItems(onImage: boolean): ([cmd: string, icon: string, label: string, arg?: string] | null)[] {
  if (onImage) {
    return [
      ['img-copy', 'copy', 'Copiar imagen'], ['img-cut', 'clippy', 'Cortar imagen'], ['clip-paste', 'clippy', 'Pegar'], null,
      ['img-align', 'arrow-left', 'A la izquierda', 'l'], ['img-align', 'layout-centered', 'Centrada', 'c'], ['img-align', 'arrow-right', 'A la derecha', 'r'],
      ['img-wrap', 'layout-sidebar-right', 'Con el texto alrededor', 'r'], null,
      ['img-crop', 'screen-normal', 'Recortar…'], ['img-change', 'file-media', 'Cambiar imagen…'], ['img-source', 'code', 'Editar su código LaTeX'], null,
      ['img-size', 'symbol-ruler', 'Tamaño y giro…'], ['img-natural', 'screen-full', 'Tamaño original'], null,
      ...BLOCK_ITEMS, null,
      ['img-delete', 'trash', 'Eliminar'],
    ];
  }
  return [
    ['clip-cut', 'clippy', 'Cortar'], ['clip-copy', 'copy', 'Copiar'], ['clip-paste', 'clippy', 'Pegar'], null,
    ...BLOCK_ITEMS, ['blk-copy', 'copy', 'Copiar el bloque (su código)'], ['blk-cut', 'clippy', 'Cortar el bloque'], null,
    ['ins-image', 'file-media', 'Insertar imagen…'], ['find', 'search', 'Buscar y reemplazar…'],
  ];
}

const BLOCK_ITEMS: [cmd: string, icon: string, label: string][] = [
  ['blk-up', 'arrow-up', 'Subir el bloque  (Alt+↑)'], ['blk-down', 'arrow-down', 'Bajar el bloque  (Alt+↓)'], ['blk-dup', 'copy', 'Duplicar el bloque  (Ctrl+D)'],
];

function openContext(target: HTMLElement, x: number, y: number): void {
  const img = target.closest('.atom.img, figure img, figure canvas');
  const el = target.closest('#root > .block') as BlockEl | null;
  const onImage = img !== null && el !== null && /\\includegraphics\b/.test(el._b?.src ?? '');
  if (onImage) {
    pickedImage = el;
    pickedIndex = imageIndexOf(target);
    select(el);
    updateToolbar();
  } else if (el && movable(el) && !xsel && active?.el !== el) {
    // las órdenes de bloque del menú actúan sobre el que se ha pulsado
    if (active) deactivate();
    select(el);
  }
  closeSlash();
  hideBubble();
  ctxEl.innerHTML = contextItems(onImage)
    .map((it) => (it ? `<button data-cmd="${it[0]}" data-arg="${it[3] ?? ''}"><i class="codicon codicon-${it[1]}"></i>${it[2]}</button>` : '<hr>'))
    .join('');
  ctxEl.hidden = false;
  ctxEl.style.left = `${Math.max(6, Math.min(x, document.documentElement.clientWidth - ctxEl.offsetWidth - 8))}px`;
  ctxEl.style.top = `${Math.max(6, Math.min(y, window.innerHeight - ctxEl.offsetHeight - 8))}px`;
}

function deleteBlock(el: BlockEl | undefined): void {
  const r = el ? blockRange(el) : undefined;
  if (!r) return;
  const gone = removal(r);
  dropActive();
  pickedImage = undefined;
  sendFull(r.s, gone.expect, gone.lines);
}

/** Sustituye el archivo de la imagen elegida, conservando sus medidas, su pie y su posición. */
function replaceImage(path: string): void {
  editImage((src) => src.replace(/(\\includegraphics\s*(?:\[[^\]]*\])?\s*\{)[^}]*\}/, (_, head: string) => `${head}${path}}`));
}

/**
 * Copia la imagen elegida al portapapeles como imagen (para pegarla en cualquier programa) y, a la
 * vez, su código LaTeX como texto: pegada de vuelta en Mars sale la misma figura.
 */
async function copyImage(cut: boolean): Promise<boolean> {
  const el = imageBlock();
  const r = el ? blockRange(el) : undefined;
  if (!el || !r) return false;
  const pic = el.querySelector<HTMLImageElement | HTMLCanvasElement>('img, canvas.pdfimg');
  let done = false;
  try {
    const canvas = document.createElement('canvas');
    if (pic instanceof HTMLCanvasElement) {
      canvas.width = pic.width;
      canvas.height = pic.height;
      canvas.getContext('2d')?.drawImage(pic, 0, 0);
    } else if (pic) {
      // el archivo se vuelve a pedir: dibujar la imagen ya cargada «mancharía» el lienzo y no dejaría leerlo
      const bitmap = await createImageBitmap(await (await fetch(pic.src)).blob());
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    }
    const png = await new Promise<Blob | null>((ok) => canvas.toBlob(ok, 'image/png'));
    if (png && canvas.width) {
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png, 'text/plain': new Blob([r.src], { type: 'text/plain' }) })]);
      done = true;
    }
  } catch {
    done = false;
  }
  if (!done) {
    // sin acceso al portapapeles desde aquí: al menos el código, y que la extensión lo intente con el archivo
    await navigator.clipboard.writeText(r.src).catch(() => undefined);
    const file = /\\includegraphics\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/.exec(r.src)?.[1];
    if (file) post({ type: 'copyImage', path: file });
  }
  lastImageCopy = done ? 'image' : 'text';
  if (cut) deleteBlock(el);
  return done;
}
/** Cómo terminó la última copia de una imagen (lo consultan las pruebas). */
let lastImageCopy = '';

/** «Pegar» del menú contextual: lo mismo que Ctrl+V, leyendo el portapapeles. */
async function pasteFromClipboard(): Promise<void> {
  try {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const kind = item.types.find((t) => t.startsWith('image/'));
      const plain = item.types.includes('text/plain') ? await (await item.getType('text/plain')).text() : '';
      if (kind && !plain.trim()) {
        storeImage(await item.getType(kind));
        return;
      }
      const html = item.types.includes('text/html') ? await (await item.getType('text/html')).text() : '';
      if (!plain && !html) continue;
      if (!active) {
        const p = insertionPoint();
        openPending(p.line, p.gap, p.after);
      }
      pasteHtml(html, plain);
      return;
    }
  } catch {
    post({ type: 'info', text: 'Para pegar, usa Ctrl+V: el editor no tiene permiso para leer el portapapeles desde el menú.' });
  }
}

/** Lleva a la siguiente palabra sin reconocer a partir del cursor y abre sus sugerencias. */
function nextMisspelling(): void {
  const list = spell.list();
  if (!list.length) return;
  const sel = selection();
  let from: Range | undefined;
  if (sel.rangeCount && root.contains(sel.anchorNode)) {
    from = sel.getRangeAt(0).cloneRange();
    from.collapse(false);
  }
  const hit = (from && list.find((h) => h.range.compareBoundaryPoints(Range.START_TO_START, from as Range) >= 0)) || list[0];
  const el = hit.range.startContainer.parentElement?.closest('.block') as BlockEl | null;
  if (el && active?.el !== el) activateEl(el);
  sel.removeAllRanges();
  sel.addRange(hit.range.cloneRange());
  let rect = vrect(hit.range);
  if (rect.top < toolbar.offsetHeight + 20 || rect.bottom > window.innerHeight - 60) {
    window.scrollTo({ top: window.scrollY + rect.top - window.innerHeight / 2 });
    rect = vrect(hit.range);
  }
  openSpellMenu(hit, rect.left, rect.bottom);
}

// ------------------------------------------------------------------ tamaño de las imágenes

/** Fija el ancho de una imagen como fracción del ancho de texto, en la vista y en el código. */
function setImageWidth(img: HTMLElement, frac: number): void {
  const at = img.closest('.atom') as HTMLElement | null;
  const el = img.closest('.block') as BlockEl | null;
  const tex = at?.getAttribute('data-tex');
  if (!at || !el || !tex || el._b?.kind !== 'rich') return;
  const f = Math.round(Math.min(Math.max(frac, 0.05), 1) * 100) / 100;
  retagImage(at, [`width=${f}\\textwidth`]);
  img.style.width = `${f * 100}%`;
  img.style.height = '';
  activate(el);
  if (active) active.refresh = true;
  markDirty(true);
}

/** Fija el alto de una imagen, en centímetros; el ancho pasa a ser el proporcional. */
function setImageHeight(img: HTMLElement, cm: number): void {
  const at = img.closest('.atom') as HTMLElement | null;
  const el = img.closest('.block') as BlockEl | null;
  if (!at || !el || !at.getAttribute('data-tex') || el._b?.kind !== 'rich') return;
  const h = Math.max(Math.round(cm * 10) / 10, 0.3);
  retagImage(at, [`height=${h}cm`]);
  img.style.height = `calc(${h} * var(--cm, 37.8px))`;
  img.style.width = 'auto';
  activate(el);
  if (active) active.refresh = true;
  markDirty(true);
}

/** Cambia las medidas en el código de una imagen que va dentro de un párrafo: `size` sustituye a las que tuviera. */
function retagImage(at: HTMLElement, size: string[]): void {
  const tex = at.getAttribute('data-tex') ?? '';
  at.setAttribute(
    'data-tex',
    tex.replace(/\\includegraphics\s*(\[[^\]]*\])?/, (_, o: string | undefined) => {
      const opts = splitOptions((o ?? '[]').slice(1, -1)).filter((x) => !/^(width|height|totalheight|scale|keepaspectratio)\s*(=|$)/.test(x));
      return `\\includegraphics[${[...size, ...opts].join(', ')}]`;
    }),
  );
}

const isImage = (t: EventTarget | null): HTMLElement | null => {
  const el = (t as HTMLElement | null)?.closest?.('.atom.img > img, .atom.img > canvas') as HTMLElement | null;
  return el && (el.closest('.block') as BlockEl | null)?._b?.kind === 'rich' ? el : null;
};
/** Borde de la imagen que hay bajo el ratón: el derecho cambia el ancho y el de abajo, el alto. */
const edgeOf = (img: HTMLElement, e: MouseEvent): 'w' | 'h' | undefined => {
  const r = vrect(img);
  return r.right - e.clientX < 14 ? 'w' : r.bottom - e.clientY < 10 ? 'h' : undefined;
};
let resizing: { img: HTMLElement; x: number; y: number; w: number; h: number; mode: 'w' | 'h' } | undefined;
const sizeTip = document.createElement('div');
sizeTip.id = 'sizetip';
sizeTip.hidden = true;
document.body.appendChild(sizeTip);
const cmOf = (px: number): string => (px / PX_PER_CM).toFixed(1).replace('.', ',');

root.addEventListener('mousemove', (e) => {
  const img = isImage(e.target);
  if (!img || resizing) return;
  const edge = readOnly ? undefined : edgeOf(img, e);
  img.style.cursor = edge === 'w' ? 'ew-resize' : edge === 'h' ? 'ns-resize' : '';
});
root.addEventListener('mousedown', (e) => {
  const img = isImage(e.target);
  const mode = img && !readOnly && e.button === 0 ? edgeOf(img, e) : undefined;
  if (!img || !mode) return;
  // arrastrar el borde derecho de la imagen cambia su ancho; el de abajo, su alto
  e.preventDefault();
  resizing = { img, x: e.clientX, y: e.clientY, w: img.offsetWidth, h: img.offsetHeight, mode };
  document.body.classList.add('resizing');
  document.body.classList.toggle('resizing-h', mode === 'h');
});
document.addEventListener('mousemove', (e) => {
  if (!resizing) return;
  const z = currentZoom();
  const { img } = resizing;
  if (resizing.mode === 'w') {
    img.style.width = `${Math.max(resizing.w + ((e.clientX - resizing.x) * 2) / z, 24)}px`;
    img.style.height = '';
  } else {
    img.style.height = `${Math.max(resizing.h + (e.clientY - resizing.y) / z, 12)}px`;
    img.style.width = 'auto';
  }
  // las medidas, a la vista mientras se arrastra
  const pct = Math.round(Math.min(img.offsetWidth / Math.max(root.clientWidth - 28, 1), 1) * 100);
  sizeTip.textContent = resizing.mode === 'w' ? `Ancho: ${pct} % del texto · ${cmOf(img.offsetWidth)} × ${cmOf(img.offsetHeight)} cm` : `Alto: ${cmOf(img.offsetHeight)} cm · ancho ${cmOf(img.offsetWidth)} cm`;
  sizeTip.hidden = false;
  sizeTip.style.left = `${Math.min(e.clientX + 14, document.documentElement.clientWidth - sizeTip.offsetWidth - 8)}px`;
  sizeTip.style.top = `${e.clientY + 16}px`;
});
document.addEventListener('mouseup', () => {
  if (!resizing) return;
  const { img, mode } = resizing;
  resizing = undefined;
  sizeTip.hidden = true;
  document.body.classList.remove('resizing', 'resizing-h');
  if (mode === 'h') setImageHeight(img, img.offsetHeight / PX_PER_CM);
  else setImageWidth(img, img.offsetWidth / Math.max(root.clientWidth - 28, 1));
});
// Atajos: VS Code recibe también estas teclas; la extensión las asocia a comandos propios
// (guardar) o vacíos para que no disparen los atajos globales del editor.
document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === 's') {
    e.preventDefault();
    if (active) flush(active);
    return;
  }
  // dentro de un diálogo las teclas son las del campo de texto (deshacer, seleccionar todo...)
  if (isDialogOpen()) return;
  if (k === 'h') {
    e.preventDefault();
    openFind();
    return;
  }
  // en los cuadros de buscar y reemplazar, las teclas son las suyas
  if (findEl.contains(e.target as Node)) return;
  if (k === 'a') {
    // la primera vez selecciona el contenido del bloque (lo hace el navegador); la segunda, todo el documento
    if (active && !xsel) {
      const c = content(active.el);
      const sel = selection();
      const r = sel.rangeCount && c.contains(sel.anchorNode) ? sel.getRangeAt(0) : undefined;
      const whole = r !== undefined && offsetOf(c, r.startContainer, r.startOffset) === 0 && offsetOf(c, r.endContainer, r.endOffset) >= units(c);
      if (!whole) return;
    }
    e.preventDefault();
    selectAllBlocks();
    return;
  }
  const cmd =
    k === 'b' ? 'bold' : k === 'i' ? 'italic' : k === 'u' ? 'underline' : k === 'z' ? (e.shiftKey ? 'redo' : 'undo') : k === 'y' ? 'redo'
    : k === 'enter' ? 'ins-newpage' /* Ctrl+Enter: salto de página, como en Word */ : '';
  if (cmd) {
    e.preventDefault();
    run(cmd);
  }
});

// ------------------------------------------------------------------ mensajes del host

function scrollToLine(line: number): void {
  if (active || isDialogOpen()) return;
  const i = blocks.findIndex((b) => b.e >= line);
  const el = els[i];
  if (!el) return;
  const b = blocks[i];
  const frac = b.s <= line ? (line - b.s) / (b.e - b.s + 1) : 0;
  const rect = vrect(el);
  window.scrollTo({ top: window.scrollY + rect.top + rect.height * frac - toolbar.offsetHeight - 12 });
}

/** El usuario ha movido el cursor en el editor de código: la edición visual en curso termina. */
function markCursor(line: number): void {
  if (modal) return;
  if (active) deactivate();
  const i = blocks.findIndex((b) => b.s <= line && b.e >= line);
  select(i >= 0 ? els[i] : undefined);
}

/** Acciones usadas por las pruebas de integración para manejar el editor como lo haría el usuario. */
function runTest(action: string, args: Record<string, unknown>): unknown {
  const at = (): BlockEl => els[args.index as number];
  const place = (): void => {
    activateEl(at());
    const c = content(at());
    if (typeof args.offset === 'number') setCaretOffset(c, args.offset);
    else caretToEnd(c);
  };
  switch (action) {
    case 'snapshot': {
      // texto visible que queda a la derecha del cursor en el bloque activo
      let ahead: string | undefined;
      const sel = selection();
      if (active && sel.rangeCount && active.el.contains(sel.anchorNode)) {
        const r = sel.getRangeAt(0).cloneRange();
        r.setEnd(content(active.el), content(active.el).childNodes.length);
        ahead = r.toString().slice(0, 40);
      }
      return {
        ahead,
        active: active ? els.indexOf(active.el) : -1,
        caret: active ? caretOffset(content(active.el)) : undefined,
        dialog: isDialogOpen(),
        // hay un párrafo nuevo, aún sin escribir, esperando texto
        pending: active !== undefined && active.re < active.rs,
        // bloques que pasan enteros a una hoja nueva
        starts: els.map((el, k) => (el.classList.contains('page-start') ? k : -1)).filter((k) => k >= 0),
        // bloques que abren hoja y bloques partidos entre dos hojas (uno por cada corte)
        breaks: els.flatMap((el, k) => [...(el.classList.contains('page-start') ? [k] : []), ...Array.from(el.querySelectorAll('.pg-split')).map(() => k)]),
        splits: Array.from(root.querySelectorAll<HTMLElement>('.pg-split')).map((s) => {
          // el texto del bloque a cada lado del corte (una palabra partida ocupa varios nodos)
          const block = s.closest('.block') as HTMLElement;
          const before = document.createRange();
          before.setStart(block, 0);
          before.setEndBefore(s);
          const after = document.createRange();
          after.setStartAfter(s);
          after.setEnd(block, block.childNodes.length);
          return `${before.toString().slice(-18)}|${after.toString().slice(0, 18)}`;
        }),
        blocks: els.map((el) => ({ kind: el._b?.kind, s: el._b?.s, e: el._b?.e, text: content(el).textContent })),
      };
    }
    case 'roundtrip':
      return els.filter((el) => el._b?.kind === 'rich').map((el) => ({ src: el._b?.src, tex: serializeBlock(content(el)) }));
    case 'type': {
      place();
      const text = String(args.text);
      if (!document.execCommand('insertText', false, text)) {
        const r = selection().getRangeAt(0);
        r.insertNode(document.createTextNode(text));
        r.collapse(false);
      }
      markDirty(true);
      return true;
    }
    case 'enter':
      place();
      handleEnter();
      return true;
    case 'select': {
      activateEl(at());
      const c = content(at());
      setCaretOffset(c, args.from as number);
      const start = selection().getRangeAt(0).cloneRange();
      setCaretOffset(c, args.to as number);
      const end = selection().getRangeAt(0);
      start.setEnd(end.startContainer, end.startOffset);
      selection().removeAllRanges();
      selection().addRange(start);
      return selection().toString();
    }
    case 'caret':
      place();
      return true;
    case 'caretIn': {
      activateEl(at());
      const target = content(at()).querySelectorAll(String(args.selector))[(args.nth as number) ?? 0];
      if (args.start) setCaretOffset(target, 0);
      else caretToEnd(target);
      return target !== undefined;
    }
    case 'cmd':
      run(String(args.name), args.arg as string | undefined);
      return true;
    case 'find': {
      // buscar y reemplazar, como desde su barra
      if (findEl.hidden) openFind();
      findQ.value = String(args.q ?? '');
      findR.value = String(args.r ?? '');
      findCase = Boolean(args.matchCase);
      runFind();
      const found = finds.length;
      if (args.step) stepFind(Number(args.step));
      if (args.replace === 'one' && finds[findAt]) replaceFinds([finds[findAt]]);
      else if (args.replace === 'all') replaceFinds(finds);
      if (args.close) closeFind();
      return { found, at: findAt, label: (findEl.querySelector('#find-n') as HTMLElement).textContent, marks: (findMark?.size ?? 0) + (findCur?.size ?? 0) };
    }
    case 'input': {
      // una pulsación, tal como llega al editor (con el control de cambios puede quedar marcada)
      if (!active) throw new Error('no hay bloque activo');
      const ev = new InputEvent('beforeinput', { inputType: String(args.inputType), data: (args.data as string | undefined) ?? null, bubbles: true, cancelable: true });
      content(active.el).dispatchEvent(ev);
      if (!ev.defaultPrevented) {
        if (args.inputType === 'insertText') document.execCommand('insertText', false, String(args.data));
        else document.execCommand(String(args.inputType).includes('Forward') ? 'forwardDelete' : 'delete');
        markDirty();
      }
      if (active) flush(active);
      return ev.defaultPrevented;
    }
    case 'brush': {
      applyBrush();
      return brush === undefined;
    }
    case 'context': {
      // el menú del botón derecho sobre un bloque (o sobre su imagen)
      const el = els[Number(args.index)];
      const target = (args.image ? el.querySelector('img, canvas') : content(el)) as HTMLElement;
      openContext(target, 200, 200);
      const labels = Array.from(ctxEl.querySelectorAll('button')).map((b) => b.textContent ?? '');
      if (args.pick) (Array.from(ctxEl.querySelectorAll('button')).find((b) => b.textContent === args.pick) as HTMLElement | undefined)?.click();
      else ctxEl.hidden = true;
      return labels;
    }
    case 'copyImage': {
      pickedImage = els[Number(args.index)];
      return copyImage(Boolean(args.cut)).catch(() => false).then((ok) => ({ ok, how: lastImageCopy }));
    }
    case 'pasteImage': {
      // un Ctrl+V con una imagen en el portapapeles, sin ningún bloque en edición
      const bytes = Uint8Array.from(atob(String(args.data)), (ch) => ch.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], 'captura.png', { type: 'image/png' }));
      const ev = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
      document.body.dispatchEvent(ev);
      return ev.defaultPrevented;
    }
    case 'pickImage': {
      pickedImage = els[Number(args.index)];
      pickedIndex = Number(args.image ?? 0);
      updateToolbar();
      return { tab: toolbar.classList.contains('in-image'), turn: pickedImage?.querySelector<HTMLElement>('[data-angle]')?.style.transform ?? '', trim: pickedImage?.querySelector('img')?.dataset.trim ?? '', crop: pickedImage?.querySelector('.crop') !== null };
    }
    case 'colWidth': {
      const td = currentCell();
      if (!td) throw new Error('el cursor no está en una celda');
      setColumnWidth(td, Number(args.cm));
      return true;
    }
    case 'pasteGrid': {
      const grid = gridOf(String(args.text));
      if (!grid) return false;
      pasteGrid(grid);
      if (active) flush(active);
      return true;
    }
    case 'perf': {
      // tiempos del último redibujado y de un reparto en hojas hecho ahora
      // `all`: reparto completo; si no, solo lo pendiente
      if (args.all) dirtyAll = true;
      const t = performance.now();
      paginate();
      // «sig»: el reparto tal como queda en el documento, para comparar uno parcial con uno completo
      const sig = [
        ...els.map((el) =>
          [
            el.classList.contains('page-start') ? el.style.getPropertyValue('--gap') : '',
            el.dataset.page ?? '',
            el.classList.contains('floated') ? el.style.top : '',
            ...Array.from(el.querySelectorAll<HTMLElement>('.pg-split')).map((s) => `${s.style.height}:${s.querySelector<HTMLElement>('.pg-strip')?.dataset.page ?? ''}`),
          ].join('/'),
        ),
        pageNums.join(','),
        tail.style.height,
        JSON.stringify(pageNotes),
      ].join('|');
      return { ...perf, paginate: Math.round(performance.now() - t), blocks: els.length, pages: pageCount, starts: pageStarts.length, nums: pageNums.join(','), sig };
    }
    case 'splitLines': {
      // líneas del párrafo que quedan a cada lado de cada corte de hoja
      const count = (r: Range): number => new Set(Array.from(r.getClientRects()).filter((x) => x.width > 1 && x.height > 4).map((x) => Math.round(x.top / 4))).size;
      return Array.from(root.querySelectorAll<HTMLElement>('.pg-split')).map((s) => {
        const c = s.closest('.content') as HTMLElement;
        const a = document.createRange();
        a.setStart(c, 0);
        a.setEndBefore(s);
        const b = document.createRange();
        b.setStartAfter(s);
        b.setEnd(c, c.childNodes.length);
        return [count(a), count(b)];
      });
    }
    case 'key': {
      if (!active) throw new Error('no hay bloque activo');
      const ev = new KeyboardEvent('keydown', { key: String(args.key), shiftKey: Boolean(args.shift), bubbles: true, cancelable: true });
      content(active.el).dispatchEvent(ev);
      return ev.defaultPrevented;
    }
    case 'formula':
      return formulaProbe(String(args.do ?? ''), (args.arg as number | string) ?? 0, (args.item as number) ?? 0);
    case 'ribbon': {
      if (args.click) (toolbar.querySelector(String(args.click)) as HTMLElement | null)?.click();
      const on = toolbar.querySelector('.panel.on') as HTMLElement | null;
      return {
        tab: currentTab,
        min: toolbar.classList.contains('min'),
        peek: toolbar.classList.contains('peek'),
        panelShown: on !== null && on.offsetHeight > 0,
        barHeight: toolbar.offsetHeight,
        swatches: toolbar.querySelectorAll('#dd-color .swatch').length,
        recent: Array.from(toolbar.querySelectorAll<HTMLElement>('#pal-recent .swatch')).map((b) => b.dataset.arg),
        tabs: Array.from(toolbar.querySelectorAll<HTMLElement>('.tab')).map((t) => t.textContent),
        groups: Array.from(on?.querySelectorAll('.group-label') ?? []).map((g) => g.textContent),
        checked: Array.from(toolbar.querySelectorAll<HTMLElement>('button.checked')).map((b) => b.dataset.arg),
        sources: Array.from(toolbar.querySelectorAll<HTMLElement>('#cite-list button')).map((b) => b.dataset.arg),
        icons: toolbar.querySelectorAll('.codicon').length,
        fonts: document.fonts.status,
        pageWidth: pageEl.style.getPropertyValue('--tw'),
        pageFont: getComputedStyle(pageEl).fontFamily,
        fontBox: [toolbar.querySelector('#dd-font .combo-val')?.textContent ?? '', toolbar.querySelector('#dd-fsize .combo-val')?.textContent ?? ''],
        grid: {
          on: document.body.classList.contains('grid'),
          sheets: sheetsEl.children.length,
          perRow: Array.from(sheetsEl.children).filter((s) => (s as HTMLElement).offsetTop === (sheetsEl.firstElementChild as HTMLElement | null)?.offsetTop).length,
          mirrors: mirrorsEl.children.length,
          clipped: els.filter((el) => el.style.clipPath !== '').length,
        },
        nums: pageNums,
        tracking,
        ustyles: Array.from(toolbar.querySelectorAll<HTMLElement>('#ustyle-list button')).map((b) => b.dataset.arg),
        widowsOn: toolbar.querySelector('button[data-cmd="widows"]')?.classList.contains('on') ?? false,
        furn: {
          head: Array.from(furnEl.querySelectorAll('.pg-head:not(.blank)')).map((h) => Array.from(h.children).map((c) => c.textContent ?? '')),
          foot: Array.from(furnEl.querySelectorAll('.pg-foot:not(.blank)')).map((h) => Array.from(h.children).map((c) => c.textContent ?? '')),
          ruled: furnEl.querySelectorAll('.pg-head.ruled').length,
          notes: pageMeta.map((m) => m.notes.map((i) => i + 1)),
          styles: pageMeta.map((m) => m.style),
          floated: els.map((el, k) => (el.classList.contains('floated') ? k : -1)).filter((k) => k >= 0),
          // hoja (desde 0) en la que queda cada bloque
          pageOf: els.map((el) => sheets.findIndex((page) => page.some((f) => f.el === el))),
          endNotes: Array.from(root.querySelectorAll<HTMLElement>('.footnotes')).filter((n) => n.offsetHeight > 0).length,
        },
        vfill: Array.from(root.querySelectorAll<HTMLElement>('.vfill')).map((f) => f.offsetHeight),
        margins: ['--mt', '--mb', '--ml', '--mr'].map((v) => pageEl.style.getPropertyValue(v)).join(' '),
        rulerMarks: rulerEl.hidden ? 0 : rulerEl.querySelectorAll('.rl-ticks span').length,
        sheet: `${pageEl.style.getPropertyValue('--pw')} x ${pageEl.style.getPropertyValue('--ph')}`,
        pages: pageCount,
        view: viewMode,
        statusIcons: Array.from(statusEl.querySelectorAll<HTMLElement>('.codicon'))
          .filter((i) => getComputedStyle(i, '::before').content === 'none')
          .map((i) => i.className),
        twoCol: root.classList.contains('two-col'),
        debug: {
          zoom: pageEl.style.getPropertyValue('zoom'), client: document.documentElement.clientWidth, page: pageEl.offsetWidth,
          rect: Math.round(pageEl.getBoundingClientRect().width), visible: document.visibilityState, nav: navOpen, mode: String(zoom),
        },
        missingIcons: Array.from(toolbar.querySelectorAll<HTMLElement>('.codicon'))
          .filter((i) => getComputedStyle(i, '::before').content === 'none')
          .map((i) => i.className),
      };
    }
    case 'pasteHtml':
      if (!active) throw new Error('no hay bloque activo');
      pasteHtml(String(args.html), String(args.text ?? ''));
      if (active) flush(active);
      return true;
    case 'resizeImage': {
      const img = root.querySelector('.atom.img > img, .atom.img > canvas') as HTMLElement | null;
      if (!img) throw new Error('no hay ninguna imagen');
      if (args.cm !== undefined) {
        setImageHeight(img, Number(args.cm));
        return img.style.height;
      }
      setImageWidth(img, Number(args.frac));
      return img.style.width;
    }
    case 'refs': {
      // el panel de referencias, como con el ratón
      if (args.open) setNavMode('refs');
      if (args.filter !== undefined) {
        const box = navEl.querySelector<HTMLInputElement>('.ref-search');
        if (box) {
          box.value = String(args.filter);
          box.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
      if (args.act) (navEl.querySelector(`.ref-item[data-key="${String(args.key)}"] [data-ref="${String(args.act)}"]`) as HTMLElement | null)?.click();
      return {
        mode: navOpen ? navMode : 'closed',
        sum: navEl.querySelector('.ref-sum')?.textContent ?? '',
        items: Array.from(navEl.querySelectorAll<HTMLElement>('.ref-item:not(.out)')).map((it) => `${it.dataset.key}|${it.querySelector('.ref-count')?.textContent ?? ''}${it.classList.contains('missing') ? '|falta' : ''}`),
        asking: navEl.querySelector('.ref-ask') !== null,
        turn: refTurn ? `${refTurn.key}:${refTurn.at}` : '',
        here: Array.from(root.querySelectorAll<HTMLElement>('.cite-here')).map((x) => `${els.indexOf(x.closest('.block') as BlockEl)}:${x.getAttribute('data-tex')}`),
        on: (navEl.querySelector('.ref-item.on .ref-count') as HTMLElement | null)?.textContent ?? '',
        acts: Array.from(navEl.querySelectorAll<HTMLElement>('.ref-item.on .ref-acts [data-ref]')).map((b) => b.dataset.ref),
      };
    }
    case 'deck': {
      // la cara «Presentación» del panel y la presentación proyectada
      if (args.open) setNavMode('deck');
      if (typeof args.toggle === 'string') toggleDeckSection(args.toggle, Boolean(args.on));
      if (typeof args.opt === 'string') setDeckOption(args.opt, typeof args.val === 'string' ? args.val : undefined);
      if (args.edit === 'cover') editCover();
      else if (args.edit === 'closing') editClosing();
      if (args.present) present(typeof args.from === 'string' ? args.from : undefined);
      const deck = document.getElementById('deck');
      if (deck && typeof args.key === 'string') window.dispatchEvent(new KeyboardEvent('keydown', { key: args.key, bubbles: true, cancelable: true }));
      const slide = document.querySelector('#deck .deck-stage > .slide');
      return {
        mode: navOpen ? navMode : 'closed',
        sections: deckSections(true).map((s) => `${deckOff.has(s.key) ? '-' : '+'}${s.num}|${s.title}|${s.level}`),
        slides: buildSlides(deckSections(), deckOpts, deckCover(), deckCoverText).map((x) => `${x.kind}:${x.title}${x.points.length ? `:${x.points.length}` : ''}${x.media ? ':media' : ''}`),
        open: isDeckOpen(),
        // texto de la portada y del cierre, tal como salen
        ends: ((): string[] => {
          const all = buildSlides(deckSections(), { ...deckOpts, cover: true, closing: true }, deckCover(), deckCoverText);
          return [all[0], all[all.length - 1]].map((x) => plainOf(`${x.title} | ${(x.html ?? '').replace(/<\/div>/g, ' | </div>')}`, document).replace(/\s+/g, ' ').replace(/[ |]+$/, ''));
        })(),
        count: document.querySelector('#deck .deck-count')?.textContent ?? '',
        slide: slide ? `${slide.className}|${slide.querySelector('h1')?.textContent ?? ''}` : '',
        fits: slide ? Array.from(slide.querySelectorAll<HTMLElement>('.s-body')).every((b) => b.scrollHeight <= b.clientHeight + 2) : true,
      };
    }
    case 'editVar': {
      // doble clic sobre una variable del bloque
      const v = at().querySelectorAll<HTMLElement>('.atom.var')[Number(args.n ?? 0)];
      if (!v) throw new Error('el bloque no tiene variables');
      editAtom(v, at());
      return { name: v.getAttribute('data-tex'), shown: v.textContent, fields: Array.from(document.querySelectorAll<HTMLInputElement>('.dialog [data-field]')).map((f) => `${f.dataset.field}=${f.value}`) };
    }
    case 'dropBlock':
      return dropBlock(els[Number(args.index)], els[Number(args.target)], Boolean(args.before), Boolean(args.copy));
    case 'blockKey': {
      // tecla de mover o duplicar, como llega del teclado
      const ev = new KeyboardEvent('keydown', { key: String(args.key), altKey: Boolean(args.alt), ctrlKey: Boolean(args.ctrl), shiftKey: Boolean(args.shift), bubbles: true, cancelable: true });
      (active ? content(active.el) : document.body).dispatchEvent(ev);
      return ev.defaultPrevented;
    }
    case 'ui': {
      if (args.gitPick !== undefined) (gitEl.querySelectorAll('.git-pick')[Number(args.gitPick)] as HTMLElement | undefined)?.click();
      if (args.gitOpen !== undefined) (gitEl.querySelectorAll('.git-open')[Number(args.gitOpen)] as HTMLElement | undefined)?.click();
      if (args.gitShow !== undefined) showChange(Number(args.gitShow));
      if (typeof args.gitCommit === 'string') {
        const box = gitEl.querySelector<HTMLTextAreaElement>('#git-msg');
        if (box) box.value = args.gitCommit;
        gitEl.querySelector<HTMLElement>('[data-commit]')?.click();
      }
      if (typeof args.recase === 'string') return recase(args.recase, String(args.mode ?? 'upper'));
      if (args.issues) toggleIssues();
      if (args.incDbl !== undefined) root.querySelectorAll<HTMLElement>('.inc-block')[Number(args.incDbl)]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      if (args.plotPreview) return plotPreview(args.plotPreview as Record<string, string>);
      if (args.plot) return plotTex(args.plot as Record<string, string>);
      if (args.gitRestore !== undefined) {
        showChange(Number(args.gitRestore));
        popEl.querySelector<HTMLElement>('[data-restore]')?.click();
      }
      if (args.bubble) showBubble();
      if (args.slashPick !== undefined) execSlash(Number(args.slashPick));
      if (args.navClick !== undefined) (navEl.querySelectorAll('.nav-item')[Number(args.navClick)] as HTMLElement | undefined)?.click();
      return {
        slash: slash ? slash.items.map((it) => it.label) : undefined,
        slashVisible: !slashEl.hidden,
        bubble: !bubbleEl.hidden,
        bubbleButtons: bubbleEl.querySelectorAll('button').length,
        navOpen,
        prefs: { paper, zoom, view: viewMode, ribbonMin },
        outline: Array.from(navEl.querySelectorAll<HTMLElement>('.nav-item')).map((b) => `${b.className.replace('nav-item ', '').replace(' on', '')}:${b.querySelector('.nav-num')?.textContent ?? ''}${b.querySelector('.nav-text')?.textContent ?? ''}`),
        selected: els.findIndex((el) => el.classList.contains('sel')),
        templates: emptyEl.querySelectorAll('.tpl').length,
        readonly: readOnly,
        selectedText: root.querySelector('.block.sel')?.textContent ?? '',
        paper,
        issues: issues.map((x) => `${x.kind}:${x.text}`),
        issueList: issuesEl.hidden ? [] : Array.from(issuesEl.querySelectorAll('.issue')).map((b) => b.textContent ?? ''),
        incBlocks: Array.from(root.querySelectorAll('.included')).map((i) => i.querySelectorAll('.inc-block').length),
        navWords: Array.from(navEl.querySelectorAll('.nav-words')).map((b) => Number(b.textContent)),
        git: {
          open: gitOpen, repo: gitState.repo, ref: gitState.ref, commits: gitState.commits.map((c) => c.subject),
          changes: gitState.changes.map((c) => `${c.kind}:${c.s}+${c.n}`),
          marks: els.map((el, k) => (el.dataset.chg ? `${k}:${el.dataset.chg}` : '')).filter(Boolean),
          list: Array.from(gitEl.querySelectorAll('.git-chg')).map((b) => b.textContent ?? ''),
          pop: popEl.hidden ? '' : popEl.textContent ?? '',
          others: gitState.others.map((f) => f.name),
          commitBox: gitEl.querySelector('#git-msg') !== null,
        },
        part: partOf,
        included: Array.from(root.querySelectorAll<HTMLElement>('.inc-bar')).map((b) => b.dataset.file ?? ''),
        missingIcons: Array.from(document.querySelectorAll<HTMLElement>('#bubble .codicon, #slash .codicon, #nav .codicon, #empty .codicon'))
          .filter((i) => getComputedStyle(i, '::before').content === 'none')
          .map((i) => i.className),
      };
    }
    case 'paste':
      if (!active) throw new Error('no hay bloque activo');
      pasteText(String(args.text));
      if (active) flush(active);
      return true;
    case 'xsel': {
      const pt = (p: { index: number; offset?: number }): XPoint => ({ el: els[p.index], off: p.offset ?? XEND });
      if (args.from && args.to) setXsel(pt(args.from as { index: number; offset?: number }), pt(args.to as { index: number; offset?: number }));
      if (args.all) selectAllBlocks();
      if (args.key) document.body.dispatchEvent(new KeyboardEvent('keydown', { key: String(args.key), bubbles: true, cancelable: true }));
      if (args.paste) {
        const data = new DataTransfer();
        data.setData('text/plain', String(args.paste));
        document.body.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
      }
      const x = xselRange();
      return {
        on: x !== undefined,
        blocks: x ? x.list.map((el) => els.indexOf(el)) : [],
        latex: xselLatex(),
        text: x ? x.list.filter(isRich).map((el) => xselPart(x, el).toString()) : [],
        marks: xselMark?.size ?? -1,
        tinted: root.querySelectorAll('.block.xs').length,
      };
    }
    case 'spell': {
      if (args.menu !== undefined) {
        const hit = spell.list().find((h) => h.word === args.menu);
        if (!hit) throw new Error(`«${String(args.menu)}» no está subrayada`);
        const r = vrect(hit.range);
        openSpellMenu(hit, r.left, r.bottom);
      }
      if (args.fix !== undefined) (spellEl.querySelectorAll<HTMLElement>('button[data-fix]')[Number(args.fix)] as HTMLElement | undefined)?.click();
      if (args.act !== undefined) (spellEl.querySelector<HTMLElement>(`button[data-act="${String(args.act)}"]`) as HTMLElement | null)?.click();
      if (args.next) nextMisspelling();
      return {
        ...spellInfo,
        pending: spell.pending,
        bad: spell.list().map((h) => h.word),
        count: spellCount,
        selected: selection().toString(),
        menu: spellEl.hidden
          ? undefined
          : {
              loading: spellEl.querySelector('.menu-empty')?.textContent?.startsWith('Buscando') ?? false,
              suggestions: Array.from(spellEl.querySelectorAll<HTMLElement>('button[data-fix]')).map((b) => b.dataset.fix),
            },
        highlights: typeof Highlight !== 'undefined' ? (CSS.highlights.get('mars-spell')?.size ?? 0) : -1,
      };
    }
    case 'media':
      return {
        pdf: Array.from(document.querySelectorAll<HTMLCanvasElement>('canvas.pdfimg')).map((c) => `${c.dataset.done}:${c.width}x${c.height}:${c.title}`),
        tikz: document.querySelectorAll('.tikz svg').length,
        tikzError: Array.from(document.querySelectorAll('.tikz-error')).map((e) => e.textContent),
        img: Array.from(document.querySelectorAll<HTMLImageElement>('.content img')).map((i) => i.naturalWidth),
      };
    case 'tool':
      (at().querySelector(`.tools [data-act="${String(args.act)}"]`) as HTMLElement).click();
      return true;
    case 'dialog':
      // `cancel`: cierra el diálogo que haya quedado abierto, sin aceptar nada
      if (args.cancel) {
        if (isDialogOpen()) closeDialog();
        return true;
      }
      return fillDialog(args.values as Record<string, string>);
    case 'blur':
      deactivate();
      return true;
    case 'typeMore': {
      const sel = selection();
      if (!active || !sel.rangeCount || !active.el.contains(sel.anchorNode)) throw new Error('el cursor no está en el bloque activo');
      const text = String(args.text);
      if (!document.execCommand('insertText', false, text)) {
        const r = sel.getRangeAt(0);
        r.insertNode(document.createTextNode(text));
        r.collapse(false);
      }
      markDirty(true);
      return true;
    }
  }
  return undefined;
}

window.addEventListener('message', (e) => {
  const m = e.data;
  switch (m.type) {
    case 'update':
      onUpdate(m as UpdateMsg);
      break;
    case 'scroll':
      scrollToLine(m.line);
      break;
    case 'cursor':
      markCursor(m.line);
      // (desde el PDF o desde otro archivo: además se lleva a la vista y se destaca un momento)
      if (m.scroll) {
        const el = root.querySelector<HTMLElement>('.block.sel');
        if (el) {
          window.scrollTo({ top: window.scrollY + vrect(el).top - toolbar.offsetHeight - 60, behavior: 'smooth' });
          el.classList.remove('flash');
          void el.offsetWidth;
          el.classList.add('flash');
        }
      }
      break;
    case 'cmd':
      run(m.cmd, m.arg);
      break;
    case 'imagePicked':
      if (m.replace) replaceImage(m.path);
      else onImagePicked(m.path);
      break;
    case 'prefs':
      if (m.prefs && typeof m.prefs === 'object') applyPrefs(m.prefs as Prefs);
      break;
    case 'spellResult':
      spell.onResult(m.id, m.bad ?? []);
      break;
    case 'spellSuggestions':
      onSuggestions(m.id, m.list ?? []);
      break;
    case 'spellLearned':
      if (typeof m.word === 'string') spell.accept(m.word);
      break;
    case 'gitLog':
      onGitLog(m);
      break;
    case 'gitDiff':
      onGitDiff(m);
      break;
    case 'gitOthers':
      gitState.others = Array.isArray(m.files) ? m.files : [];
      renderGit();
      break;
    case 'test': {
      let result: unknown;
      let error: string | undefined;
      try {
        result = runTest(m.action, m.args ?? {});
      } catch (err) {
        error = String((err as Error)?.stack ?? err);
      }
      // una acción puede tardar (copiar al portapapeles): se responde cuando termina
      void Promise.resolve(result).then(
        (value) => post({ type: 'testResult', id: m.id, result: value, error }),
        (err) => post({ type: 'testResult', id: m.id, error: String(err) }),
      );
      break;
    }
  }
});

buildToolbar();
closeDialog();
post({ type: 'ready' });
