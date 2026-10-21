import katex from 'katex';
// fórmulas químicas (\ce, \pu): la extensión de KaTeX se registra sola al cargarla
import 'katex/contrib/mhchem';
import { type BibEntry, citeAuthors, citeYear, parseBibtex, referenceAuthors } from '../citations';
import { FONTS, cssLength, documentLanguage, lineHeightFor, toCm } from './layout';
import { Expander, uncomment } from './expand';
import { type MathContext, SI_COMMANDS, keyValues, mathMacros, pairedDelimiters, prepareMath, siSetup, siUnits } from './mathext';
import { Conditions, effectiveSource } from './preamble';

/*
 * Renderizador LaTeX -> HTML tolerante a errores (no compila nada).
 *
 * El HTML que produce va anotado para que el webview pueda volver a LaTeX:
 *   - data-tex="..."            átomo: se serializa tal cual (fórmulas, comandos, entornos opacos)
 *   - data-o="..." data-c="..." envoltorio editable: abre + contenido serializado + cierra
 *   - data-skip                 decoración (números, viñetas): no se serializa
 *   - data-k="list|item|table|row|cell|head"  estructuras con serialización canónica
 */

/** Lo que el preámbulo del documento aporta a las figuras TikZ. */
export interface TikzPreamble {
  libraries: string;
  packages: string[];
  /** definiciones (\tikzset, \pgfplotsset, colores, macros) */
  extra: string;
}

export interface RenderOptions {
  /** URI de la imagen; con el sufijo `#mars-pdf` si es un PDF que hay que dibujar en un canvas */
  resolveImage?: (path: string) => string | undefined;
  readInput?: (path: string) => string | undefined;
  /** contenido de un archivo .bib (por su nombre, con o sin extensión) */
  readBib?: (name: string) => string | undefined;
  /** SVG de una figura TikZ si ya está calculado; `undefined` mientras se dibuja en segundo plano */
  renderTikz?: (source: string, preamble: TikzPreamble) => { svg?: string; error?: string } | undefined;
  /**
   * El archivo es una parte de otro documento (un capítulo traído con \input o \include): «text»
   * es el documento principal e «isSelf» dice si una ruta de \input nombra a este archivo. Se
   * dibuja con el preámbulo, la numeración, las etiquetas y las citas del principal.
   */
  root?: { text: string; isSelf: (path: string) => boolean };
}

/** Paquetes que el motor TikZ incorporado sabe cargar. */
const TIKZ_PACKAGES = ['pgfplots', 'circuitikz', 'tikz-cd', 'chemfig', 'tikz-3dplot', 'amsmath', 'amssymb', 'amsfonts', 'array'];
const TIKZ_ENVS = new Set(['tikzpicture', 'circuitikz', 'tikzcd']);

export type BlockKind = 'rich' | 'atom' | 'ro';

export interface Block {
  /** primera línea del bloque en el documento (base 0) */
  s: number;
  /** última línea (incluida) */
  e: number;
  html: string;
  kind: BlockKind;
  src: string;
  /** hay una línea en blanco (o el principio del archivo) justo antes del bloque */
  gb: boolean;
  /** hay una línea en blanco justo después del bloque */
  ga: boolean;
  /**
   * `\pagenumbering` y `\thispagestyle` escritos justo antes, en una línea propia (que no dibuja
   * nada y por eso no es un bloque): valen para la hoja donde caiga este
   */
  pagenum?: string;
  pagestyle?: string;
  /** `\pagestyle` escrito justo antes, en una línea propia: vale desde la hoja de este bloque en adelante */
  pagestyleFrom?: string;
  /** interlineado propio (`\singlespacing`, `\doublespacing`... en el cuerpo); sin él, el del documento */
  lh?: number;
  /** entradas del índice (`\addcontentsline`) escritas justo antes, en líneas que no dibujan nada */
  anchors?: string[];
}

export interface DocMeta {
  title?: string;
  author?: string;
  date?: string;
}

export interface RenderResult {
  blocks: Block[];
  /** línea donde se inserta contenido nuevo al final del documento */
  insertLine: number;
  /** la línea anterior a `insertLine` está en blanco */
  tailGap: boolean;
  macros: Record<string, string>;
  labels: string[];
  meta: DocMeta;
  hasDocument: boolean;
  /** el documento cita por autor y año (natbib, biblatex): las citas nuevas van con \citep */
  authorYear: boolean;
  /** encabezado y pie de las hojas */
  furniture: Furniture;
  /** cosas que LaTeX avisaría al compilar: referencias y citas sin definir, etiquetas repetidas, imágenes que faltan */
  issues: Issue[];
  /** lo que el preámbulo cambia en las fórmulas (babel en español, physics, siunitx): el editor las dibuja igual */
  math: MathContext;
}

export interface Issue {
  kind: 'ref' | 'cite' | 'label' | 'image';
  text: string;
  /** línea del bloque donde está */
  line: number;
}

/**
 * Encabezado y pie de página. Cada parte es HTML con marcas que el reparto en hojas sustituye en
 * cada una: `\u0002PAGE\u0002` (su número), `\u0002LAST\u0002` (el de la última), `\u0002LM\u0002`
 * y `\u0002RM\u0002` (título de la sección y de la subsección en curso).
 */
export interface Furniture {
  /** estilo de las hojas normales; las que abren capítulo o llevan el título usan «plain» */
  style: 'plain' | 'empty' | 'fancy' | 'headings';
  head: [string, string, string];
  foot: [string, string, string];
  headRule: boolean;
  footRule: boolean;
  /** el código LaTeX de cada parte (para editarlas): el de fancyhdr o el que equivale al estilo de la clase */
  src: { head: [string, string, string]; foot: [string, string, string] };
}

const PAGE_MARK = '\u0002PAGE\u0002';
/** Etiquetas que los paquetes lastpage y totpages ponen en la última hoja. */
const LAST_PAGE = /^(?:LastPage|lastpage|TotPages)$/;

interface Cmd {
  html: string;
  end: number;
  /** el html ya viene anotado (átomo o envoltorio) */
  pre?: boolean;
  /** contiene contenido editable en sitio */
  rich?: boolean;
  /** átomo de bloque */
  block?: boolean;
  cls?: string;
  /** declaración (\bfseries, \centering...): envuelve el resto del grupo */
  decl?: [tag: string, attrs: string];
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
const attr = (s: string): string => esc(s).replace(/\n/g, '&#10;');
const enc = (s: string): string => encodeURIComponent(s.trim());

function atom(src: string, html: string, cls = '', block = false, extra = ''): string {
  const tag = block ? 'div' : 'span';
  const c = ['atom', block ? 'blk' : '', cls, html === '' && cls !== 'anc' ? 'hid' : ''].filter(Boolean).join(' ');
  return `<${tag} class="${c}"${extra} data-tex="${attr(src)}" contenteditable="false">${html}</${tag}>`;
}

function wrap(tag: string, o: string, c: string, inner: string, attrs = ''): string {
  return `<${tag}${attrs} data-o="${attr(o)}" data-c="${attr(c)}">${inner}</${tag}>`;
}

const skip = (html: string, cls = ''): string =>
  `<span class="deco${cls ? ' ' + cls : ''}" data-skip contenteditable="false">${html}</span>`;

const HIDDEN_ATOM = /<span class="atom (?:hid|anc)"[^>]*><\/span>/g;

// ---------------------------------------------------------------- lectura de argumentos

function readGroup(s: string, i: number): { content: string; end: number } | undefined {
  if (s[i] !== '{') return undefined;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') j++;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return { content: s.slice(i + 1, j), end: j + 1 };
  }
  return undefined;
}

function readBracket(s: string, i: number): { content: string; end: number } | undefined {
  if (s[i] !== '[') return undefined;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') j++;
    else if (c === '{') {
      const g = readGroup(s, j);
      if (!g) return undefined;
      j = g.end - 1;
    } else if (c === '[') depth++;
    else if (c === ']' && --depth === 0) return { content: s.slice(i + 1, j), end: j + 1 };
  }
  return undefined;
}

/** Salta espacios y como mucho un salto de línea (nunca una línea en blanco). */
function skipWs(s: string, i: number): number {
  while (s[i] === ' ' || s[i] === '\t') i++;
  if (s[i] === '\n') {
    let j = i + 1;
    while (s[j] === ' ' || s[j] === '\t') j++;
    if (s[j] !== '\n') i = j;
  }
  return i;
}

const TOKEN = /\\(?:[a-zA-Z]+|[\s\S])/y;
const NAME = /[a-zA-Z]+/y;

class Cursor {
  constructor(public s: string, public p: number) {}

  ws(): void {
    this.p = skipWs(this.s, this.p);
  }

  opt(): string | undefined {
    const j = skipWs(this.s, this.p);
    const r = readBracket(this.s, j);
    if (!r) return undefined;
    this.p = r.end;
    return r.content;
  }

  /** Argumento entre llaves, o undefined (sin consumir nada) si no lo hay. */
  group(): string | undefined {
    const j = skipWs(this.s, this.p);
    const r = readGroup(this.s, j);
    if (!r) return undefined;
    this.p = r.end;
    return r.content;
  }

  /** Argumento obligatorio: grupo, comando o un solo carácter. */
  arg(): string {
    const g = this.group();
    if (g !== undefined) return g;
    this.ws();
    const s = this.s;
    if (this.p >= s.length) return '';
    if (s[this.p] === '{') {
      this.p++;
      return '';
    }
    if (s[this.p] === '\\') {
      TOKEN.lastIndex = this.p;
      const m = TOKEN.exec(s);
      if (m) {
        this.p += m[0].length;
        return m[0];
      }
    }
    return s[this.p++];
  }
}

/** Divide por `\\` o `&` de nivel superior (fuera de llaves, entornos anidados y comentarios). */
function splitTop(s: string, sep: '\\\\' | '&'): string[] {
  const out: string[] = [];
  let depth = 0;
  let env = 0;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      if (s.startsWith('\\begin{', i)) env++;
      else if (s.startsWith('\\end{', i)) env--;
      else if (s[i + 1] === '\\' && sep === '\\\\' && depth === 0 && env === 0) {
        out.push(s.slice(last, i));
        i += 2;
        if (s[i] === '*') i++;
        let j = i;
        while (s[j] === ' ' || s[j] === '\t') j++;
        const b = readBracket(s, j);
        if (b) i = b.end;
        last = i;
        i--;
        continue;
      }
      i++;
    } else if (c === '%') {
      const j = s.indexOf('\n', i);
      i = j < 0 ? s.length : j;
    } else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '&' && sep === '&' && depth === 0 && env === 0) {
      out.push(s.slice(last, i));
      last = i + 1;
    }
  }
  out.push(s.slice(last));
  return out;
}

const ITEM = /\\item(?![a-zA-Z])/y;

interface Item {
  label?: string;
  /** contenido del elemento (sin `\item`) */
  text: string;
  /** espacio en blanco que lo separa del elemento anterior */
  lead: string;
  /** código exacto del elemento, desde `\item` */
  raw: string;
}

/**
 * Trocea el cuerpo de una lista conservando el formato original: `pre` es lo que hay antes del
 * primer elemento y `tail` el espacio final antes de `\end`.
 */
function splitList(body: string, marks: { at: number; content: number; label?: string }[]): { pre: string; items: Item[]; tail: string } {
  if (!marks.length) return { pre: body, items: [], tail: '' };
  const ws = (s: string): string => s.slice(s.trimEnd().length);
  const head = body.slice(0, marks[0].at);
  let lead = ws(head);
  const items: Item[] = [];
  marks.forEach((m, k) => {
    const chunk = body.slice(m.at, k + 1 < marks.length ? marks[k + 1].at : body.length);
    const raw = chunk.trimEnd();
    items.push({ label: m.label, lead, raw, text: raw.slice(Math.min(m.content - m.at, raw.length)) });
    lead = ws(chunk);
  });
  return { pre: head.trimEnd(), items, tail: lead };
}

function itemMarks(body: string): { at: number; content: number; label?: string }[] {
  return splitItems(body).map((it) => ({ at: it.at, content: it.start, label: it.label }));
}

function splitItems(body: string): { label?: string; text: string; at: number; start: number }[] {
  const items: { label?: string; text: string; at: number; start: number }[] = [];
  let env = 0;
  let brace = 0;
  let cur: { label?: string; start: number; at: number } | undefined;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{') brace++;
    else if (ch === '}') brace--;
    else if (ch === '%') {
      const j = body.indexOf('\n', i);
      i = j < 0 ? body.length : j;
    } else if (ch === '\\') {
      if (body.startsWith('\\begin{', i)) env++;
      else if (body.startsWith('\\end{', i)) env--;
      else if (env === 0 && brace <= 0) {
        ITEM.lastIndex = i;
        if (ITEM.test(body)) {
          if (cur) items.push({ label: cur.label, text: body.slice(cur.start, i), at: cur.at, start: cur.start });
          const c = new Cursor(body, i + 5);
          const label = c.opt();
          if (body[c.p] === ' ') c.p++;
          cur = { label, start: c.p, at: i };
          i = c.p - 1;
          continue;
        }
      }
      i++;
    }
  }
  if (cur) items.push({ label: cur.label, text: body.slice(cur.start), at: cur.at, start: cur.start });
  return items;
}

/** Filas de una tabla con su terminador exacto (`\\`, `\\[2pt]`...). */
function splitRows(s: string): { text: string; term: string }[] {
  const out: { text: string; term: string }[] = [];
  let depth = 0;
  let env = 0;
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\') {
      if (s.startsWith('\\begin{', i)) env++;
      else if (s.startsWith('\\end{', i)) env--;
      else if (s[i + 1] === '\\' && depth === 0 && env === 0) {
        let j = i + 2;
        if (s[j] === '*') j++;
        let k = j;
        while (s[k] === ' ' || s[k] === '\t') k++;
        const b = readBracket(s, k);
        if (b) j = b.end;
        out.push({ text: s.slice(last, i), term: s.slice(i, j) });
        last = j;
        i = j - 1;
        continue;
      }
      i++;
    } else if (c === '%') {
      const j = s.indexOf('\n', i);
      i = j < 0 ? s.length : j;
    } else if (c === '{') depth++;
    else if (c === '}') depth--;
  }
  out.push({ text: s.slice(last), term: '' });
  return out;
}

function parseSpec(spec: string): string[] {
  const out: string[] = [];
  const c = new Cursor(spec, 0);
  /** lo que «>{...}» pone delante de la columna siguiente: puede cambiar su alineación */
  let pre = '';
  const push = (align: string): void => {
    out.push(/\\centering\b/.test(pre) ? 'center' : /\\raggedleft\b/.test(pre) ? 'right' : /\\raggedright\b/.test(pre) ? 'left' : align);
    pre = '';
  };
  while (c.p < spec.length) {
    const ch = spec[c.p++];
    if (ch === 'l' || ch === 'X' || ch === 'L' || ch === 'p' || ch === 'm' || ch === 'b') {
      push('left');
      if ('pmb'.includes(ch)) c.group();
    } else if (ch === 'c' || ch === 'C') push('center');
    else if (ch === 'r' || ch === 'R') push('right');
    else if (ch === 'S' || ch === 's') {
      // columna de números de siunitx, con sus opciones: S[table-format=2.1]
      c.opt();
      push('right');
    } else if (ch === 'w' || ch === 'W') {
      // w{c}{2cm} (array): alineación y ancho
      const a = c.group() ?? '';
      c.group();
      push(a === 'c' ? 'center' : a === 'r' ? 'right' : 'left');
    } else if (ch === 'D') {
      // D{.}{,}{2} (dcolumn): números alineados por la coma
      c.group();
      c.group();
      c.group();
      push('right');
    } else if (ch === '>') pre = c.group() ?? '';
    else if (ch === '@' || ch === '<' || ch === '!') c.group();
    else if (ch === '*') {
      const n = Math.min(parseInt(c.arg(), 10) || 0, 50);
      const sub = parseSpec(c.arg());
      for (let k = 0; k < n; k++) out.push(...sub);
    }
  }
  return out;
}

/** Ancho que la especificación de una tabla fija a cada columna (las «p{3cm}», «m{...}», «b{...}»). */
function specWidths(spec: string): (string | undefined)[] {
  const out: (string | undefined)[] = [];
  const c = new Cursor(spec, 0);
  while (c.p < spec.length) {
    const ch = spec[c.p++];
    if ('pmb'.includes(ch)) out.push(c.group());
    else if ('lXLcCrR'.includes(ch)) out.push(undefined);
    else if (ch === 'S' || ch === 's') {
      c.opt();
      out.push(undefined);
    } else if (ch === 'w' || ch === 'W') {
      c.group();
      out.push(c.group());
    } else if (ch === 'D') {
      c.group();
      c.group();
      c.group();
      out.push(undefined);
    } else if (ch === '@' || ch === '>' || ch === '<' || ch === '!') c.group();
    else if (ch === '*') {
      const n = Math.min(parseInt(c.arg(), 10) || 0, 50);
      const sub = specWidths(c.arg());
      for (let k = 0; k < n; k++) out.push(...sub);
    }
  }
  return out;
}

/**
 * Etiqueta corta de una lista numerada, como las del paquete enumerate: en «a)», «(i)» o «1.» la
 * primera de las letras A, a, I, i o el 1 (fuera de llaves) dice cómo se numera, y el resto se
 * escribe tal cual delante y detrás.
 */
function shortLabel(opt: string): { kind: string; pre: string; suf: string } | undefined {
  const kinds: Record<string, string> = { A: 'upper-alpha', a: 'lower-alpha', I: 'upper-roman', i: 'lower-roman', 1: 'decimal' };
  let depth = 0;
  for (let k = 0; k < opt.length; k++) {
    const ch = opt[k];
    if (ch === '\\') k += (/^\\[a-zA-Z]+\s*/.exec(opt.slice(k))?.[0].length ?? 2) - 1;
    else if (ch === '{') depth++;
    else if (ch === '}') depth--;
    else if (depth === 0 && kinds[ch]) return { kind: kinds[ch], pre: opt.slice(0, k), suf: opt.slice(k + 1) };
  }
  return undefined;
}
/** Opciones de enumitem que van sin valor: no son una etiqueta corta. */
const LIST_FLAGS = /^(?:noitemsep|nosep|nolistsep|wide|inline|resume\*?|series|fullwidth|leftmargin|itemsep|topsep|partopsep|parsep)\b/;

/** Marca de cada nivel de una lista sin etiqueta propia: las de LaTeX y las que pone babel en español. */
const BULLET_LEVELS = { en: ['', '–', '∗', '·'], es: ['▪', '•', '◦', '⋄'] };
/**
 * Numeración de cada nivel: [estilo, delante, detrás, cursiva]. El primero («1.») es el de siempre;
 * babel en español escribe en cursiva la letra del segundo nivel (\emph{\alph{enumii}}).
 */
const NUMBER_LEVELS: Record<'en' | 'es', [string, string, string, boolean?][]> = {
  en: [['decimal', '', '.'], ['lower-alpha', '(', ')'], ['lower-roman', '', '.'], ['upper-alpha', '', '.']],
  es: [['decimal', '', '.'], ['lower-alpha', '', ')', true], ['decimal', '', ')'], ['lower-alpha', '', '′']],
};

/** Clase de una fila según las reglas que lleva encima: fina (\hline, \midrule) o gruesa (\toprule de booktabs). */
function rowClass(rules: string): string {
  const cls = [/\\(hline|midrule|cline|cmidrule)/.test(rules) ? 'rule' : '', /\\(toprule|bottomrule)/.test(rules) ? 'rule heavy' : ''].filter(Boolean).join(' ');
  return cls ? ` class="${cls}"` : '';
}

/** Fondo de una fila (\rowcolor{gray!20}, de colortbl) como color de CSS. */
function rowColor(rules: string): string {
  const m = /\\rowcolor\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/.exec(rules);
  if (!m) return '';
  // «color!30» de xcolor: ese color al 30 %, mezclado con blanco
  const mix = /^([a-zA-Z]+)!(\d+)$/.exec(m[2].trim());
  const css = cssColor(m[1], m[2]) || (mix ? `color-mix(in srgb, ${mix[1].toLowerCase()} ${mix[2]}%, white)` : '');
  return css ? ` style="background:${css}"` : '';
}

/** Viñetas habituales escritas en LaTeX -> el carácter con que se dibujan. */
const BULLETS: Record<string, string> = {
  '$\\bullet$': '•', '\\textbullet': '•', '$\\circ$': '○', '--': '–', '\\textendash': '–', '---': '—', '$-$': '−', '-': '-',
  '$\\ast$': '∗', '*': '∗', '$\\cdot$': '·', '$\\star$': '⋆', '\\checkmark': '✓', '$\\checkmark$': '✓', '$\\blacksquare$': '■',
  '$\\square$': '□', '$\\triangleright$': '▹', '$\\diamond$': '⋄', '$\\rightarrow$': '→', '$\\Rightarrow$': '⇒',
};
const COUNTER_STYLE: Record<string, string> = { arabic: 'decimal', alph: 'lower-alpha', Alph: 'upper-alpha', roman: 'lower-roman', Roman: 'upper-roman' };
/** Texto como cadena de CSS entre comillas. */
const cssString = (s: string): string => "'" + s.replace(/[\\']/g, '\\$&').replace(/[<>&"]/g, '') + "'";


/** Familias de letra de `\fontfamily{...}`: código de LaTeX -> fuentes con las que se imita. */
const FAMILY_CSS: Record<string, string> = {
  ...Object.fromEntries(Object.values(FONTS).map((f) => [f.family, f.css])),
  lmss: FONTS.sans.css, pcr: "'Courier New', Courier, monospace", cmtt: 'KaTeX_Typewriter, monospace', lmtt: 'KaTeX_Typewriter, monospace',
};

type Rgb = [number, number, number];
/** Colores básicos de xcolor (no coinciden con los de CSS: su «green» es el verde puro). */
const XCOLORS: Record<string, Rgb> = {
  red: [255, 0, 0], green: [0, 255, 0], blue: [0, 0, 255], cyan: [0, 255, 255], magenta: [255, 0, 255], yellow: [255, 255, 0],
  black: [0, 0, 0], white: [255, 255, 255], gray: [128, 128, 128], darkgray: [64, 64, 64], lightgray: [191, 191, 191],
  brown: [191, 128, 64], lime: [191, 255, 0], olive: [128, 128, 0], orange: [255, 128, 0], pink: [255, 191, 191],
  purple: [191, 0, 64], teal: [0, 128, 128], violet: [128, 0, 128],
};
/** Colores que define el documento (`\definecolor`, `\colorlet`); se vacía en cada dibujado. */
let userColors = new Map<string, Rgb>();

/** Color escrito en un modelo de xcolor: HTML, rgb (0–1), RGB (0–255), gray o cmyk. */
function modelColor(model: string, v: string): Rgb | undefined {
  const p = v.split(',').map((x) => parseFloat(x));
  const ok = (n: number, max: number): boolean => p.length === n && p.every((x) => x >= 0 && x <= max);
  if (model === 'HTML' && /^[0-9a-fA-F]{6}$/.test(v.trim())) return [0, 2, 4].map((k) => parseInt(v.trim().slice(k, k + 2), 16)) as Rgb;
  if (model === 'rgb' && ok(3, 1)) return p.map((x) => Math.round(x * 255)) as Rgb;
  if (model === 'RGB' && ok(3, 255)) return p.map((x) => Math.round(x)) as Rgb;
  if (model === 'gray' && ok(1, 1)) return [0, 0, 0].map(() => Math.round(p[0] * 255)) as Rgb;
  if (model === 'cmyk' && ok(4, 1)) return [0, 1, 2].map((k) => Math.round(255 * (1 - Math.min(1, p[k] + p[3])))) as Rgb;
  return undefined;
}

/** Expresión de color de xcolor: un nombre o una mezcla (`blue!20`, `green!60!black`, `red!50!blue!30`). */
function namedColor(expr: string): Rgb | undefined {
  const parts = expr.split('!').map((x) => x.trim());
  const base = (name: string): Rgb | undefined => userColors.get(name) ?? XCOLORS[name] ?? XCOLORS[name.toLowerCase()];
  let cur = base(parts[0]);
  if (!cur) return undefined;
  for (let k = 1; k < parts.length; k += 2) {
    const pct = Math.min(Math.max(parseFloat(parts[k]), 0), 100) / 100;
    const other = parts[k + 1] === undefined ? XCOLORS.white : base(parts[k + 1]);
    if (Number.isNaN(pct) || !other) return undefined;
    cur = cur.map((x, q) => Math.round(x * pct + other[q] * (1 - pct))) as Rgb;
  }
  return cur;
}

function cssColor(model: string | undefined, v: string): string {
  v = v.trim();
  const rgb = model ? modelColor(model, v) : namedColor(v);
  if (rgb) return `rgb(${rgb.join(',')})`;
  // un nombre que xcolor no trae de serie (dvipsnames, svgnames): suele coincidir con el de CSS
  return !model && /^[a-zA-Z]+$/.test(v) ? v.toLowerCase() : '';
}

// ---------------------------------------------------------------- comentarios y división en bloques

const VERBATIM = new Set([
  'verbatim', 'verbatim*', 'lstlisting', 'minted', 'Verbatim', 'alltt', 'comment',
  // código de otros lenguajes y archivos que el documento escribe al compilar: su contenido no es LaTeX
  'filecontents', 'filecontents*', 'luacode', 'luacode*', 'pycode', 'sagesilent',
]);
/** Marca de línea que solo contenía un comentario (no cuenta como línea en blanco). */
const COMMENT_LINE = '​';

/** Copia de las líneas sin comentarios, solo para detectar la estructura. */
export function stripComments(lines: string[]): string[] {
  let verb: string | undefined;
  return lines.map((line) => {
    if (verb) {
      if (line.includes(`\\end{${verb}}`)) verb = undefined;
      return line;
    }
    let out = line;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\') i++;
      else if (line[i] === '%') {
        out = line.slice(0, i);
        break;
      }
    }
    const m = /\\begin\{([a-zA-Z]+\*?)\}/.exec(out);
    if (m && VERBATIM.has(m[1])) {
      if (!line.includes(`\\end{${m[1]}}`, m.index)) verb = m[1];
      return line;
    }
    return out.trim() === '' && line.trim() !== '' ? COMMENT_LINE : out;
  });
}

const STARTER =
  /^\s*(?:\\(?:begin\s*\{|\[|(?:part|chapter|section|subsection|subsubsection)\*?\s*[[{]|maketitle\b|tableofcontents\b|newpage\b|clearpage\b|input\s*\{|include\s*\{|bibliography\s*\{|printbibliography\b)|\$\$)/;

interface RawBlock {
  s: number;
  e: number;
}

function splitBlocks(clean: string[], from: number, to: number): RawBlock[] {
  const out: RawBlock[] = [];
  let start = -1;
  let depth = 0;
  let verb: string | undefined;
  let dollars = false;
  let single = false;
  /**
   * llaves abiertas sin cerrar: el argumento de una orden que ocupa varias líneas (el cuerpo de un
   * \foreach, una definición, \block{...}{...}) no se parte aunque lleve líneas en blanco
   */
  let brace = 0;
  const flush = (end: number): void => {
    if (start >= 0 && end >= start) out.push({ s: start, e: end });
    start = -1;
    single = false;
    brace = 0;
  };
  for (let i = from; i < to; i++) {
    const line = clean[i];
    if (verb) {
      if (line.includes(`\\end{${verb}}`)) {
        verb = undefined;
        if (--depth <= 0) {
          depth = 0;
          flush(i);
        }
      }
      continue;
    }
    // (una llave que no se cierra en 400 líneas es un error del documento: no se espera más)
    if (brace > 0 && i - start > 400) brace = 0;
    if (depth === 0 && brace <= 0) {
      if (line.trim() === '') {
        flush(i - 1);
        continue;
      }
      if (start >= 0 && STARTER.test(line)) flush(i - 1);
    }
    if (start < 0) {
      start = i;
      single = STARTER.test(line);
    }
    for (let j = 0; j < line.length; j++) {
      const c = line[j];
      if (c === '\\') {
        if (line.startsWith('\\begin{', j)) {
          const name = line.slice(j + 7, line.indexOf('}', j));
          if (VERBATIM.has(name)) {
            if (!line.includes(`\\end{${name}}`, j)) {
              verb = name;
              depth++;
            }
            break;
          }
          if (name !== 'document') depth++;
        } else if (line.startsWith('\\end{', j)) {
          if (!line.startsWith('\\end{document}', j)) depth--;
        } else if (line[j + 1] === '[') depth++;
        else if (line[j + 1] === ']') depth--;
        j++;
      } else if (c === '$' && line[j + 1] === '$') {
        depth += dollars ? -1 : 1;
        dollars = !dollars;
        j++;
      } else if (c === '{') brace++;
      else if (c === '}') brace--;
    }
    if (depth < 0) depth = 0;
    if (brace < 0) brace = 0;
    if (depth === 0 && brace === 0 && single && !verb) flush(i);
  }
  flush(to - 1);
  return out;
}

// ---------------------------------------------------------------- tablas de comandos

const L10N = {
  en: {
    figure: 'Figure', table: 'Table', abstract: 'Abstract', contents: 'Contents', refs: 'References',
    proof: 'Proof', chapter: 'Chapter', part: 'Part', notes: 'Notes', locale: 'en-US', appendix: 'Appendix', listing: 'Listing',
    // títulos de los índices de figuras y de tablas, si el documento los cambia (vacío: los de siempre)
    lof: '', lot: '',
  },
  es: {
    figure: 'Figura', table: 'Tabla', abstract: 'Resumen', contents: 'Índice', refs: 'Referencias',
    proof: 'Demostración', chapter: 'Capítulo', part: 'Parte', notes: 'Notas', locale: 'es-ES', appendix: 'Apéndice', listing: 'Listing',
    lof: '', lot: '',
  },
};

/**
 * Nombre con que se cita cada cosa numerada. `auto` son los de \autoref (hyperref); `cref`, los de
 * cleveref: [singular, plural] y, en inglés, sus abreviaturas («fig.», «eq.»), que \Cref no usa.
 */
const REF_NAMES = {
  en: {
    auto: {
      equation: 'Equation', footnote: 'footnote', enumi: 'item', figure: 'Figure', table: 'Table', part: 'Part', appendix: 'Appendix', chapter: 'chapter',
      section: 'section', subsection: 'subsection', subsubsection: 'subsubsection', theorem: 'Theorem', algorithm: 'Algorithm', listing: 'Listing',
    } as Record<string, string>,
    cref: {
      equation: ['equation', 'equations'], figure: ['figure', 'figures'], table: ['table', 'tables'], part: ['part', 'parts'], chapter: ['chapter', 'chapters'],
      section: ['section', 'sections'], appendix: ['appendix', 'appendices'], enumi: ['item', 'items'], footnote: ['footnote', 'footnotes'],
      theorem: ['theorem', 'theorems'], lemma: ['lemma', 'lemmas'], corollary: ['corollary', 'corollaries'], proposition: ['proposition', 'propositions'],
      definition: ['definition', 'definitions'], result: ['result', 'results'], example: ['example', 'examples'], remark: ['remark', 'remarks'],
      note: ['note', 'notes'], algorithm: ['algorithm', 'algorithms'], listing: ['listing', 'listings'],
    } as Record<string, [string, string]>,
    abbrev: { equation: ['eq.', 'eqs.'], figure: ['fig.', 'figs.'] } as Record<string, [string, string]>,
    and: ' and ', to: ' to ',
  },
  es: {
    auto: {
      equation: 'Ecuación', footnote: 'Nota a pie de página', enumi: 'Elemento', figure: 'Figura', table: 'Tabla', part: 'Parte', appendix: 'Apéndice',
      chapter: 'Capítulo', section: 'Sección', subsection: 'Subsección', subsubsection: 'Subsubsección', theorem: 'Teorema', algorithm: 'Algoritmo',
      listing: 'Listado',
    } as Record<string, string>,
    cref: {
      equation: ['ecuación', 'ecuaciones'], figure: ['figura', 'figuras'], table: ['cuadro', 'cuadros'], part: ['parte', 'partes'],
      chapter: ['capítulo', 'capítulos'], section: ['apartado', 'apartados'], appendix: ['apéndice', 'apéndices'], enumi: ['punto', 'puntos'],
      footnote: ['nota', 'notas'], theorem: ['teorema', 'teoremas'], lemma: ['lema', 'lemas'], corollary: ['corolario', 'corolarios'],
      proposition: ['proposición', 'proposiciones'], definition: ['definición', 'definiciones'], result: ['resultado', 'resultados'],
      example: ['ejemplo', 'ejemplos'], remark: ['observación', 'observaciones'], note: ['nota', 'notas'], algorithm: ['algoritmo', 'algoritmos'],
      listing: ['listado', 'listados'],
    } as Record<string, [string, string]>,
    abbrev: {} as Record<string, [string, string]>,
    and: ' y ', to: ' a ',
  },
};
/** Palabras clave de algorithm2e: las de serie y las que pone su opción `spanish`. */
const ALGO2E = {
  en: {
    in: 'Input', out: 'Output', data: 'Data', result: 'Result', if: 'if', then: 'then', else: 'else', elseif: 'else if', for: 'for', foreach: 'foreach',
    forall: 'forall', do: 'do', while: 'while', repeat: 'repeat', until: 'until', begin: 'begin', end: 'end', return: 'return', switch: 'switch',
    case: 'case', other: 'otherwise', to: 'to',
  },
  es: {
    in: 'Entrada', out: 'Salida', data: 'Datos', result: 'Resultado', if: 'si', then: 'entonces', else: 'en otro caso', elseif: 'en otro caso, si',
    for: 'para', foreach: 'para cada', forall: 'para todo', do: 'hacer', while: 'mientras', repeat: 'repetir', until: 'hasta que', begin: 'inicio',
    end: 'fin', return: 'devolver', switch: 'seleccionar', case: 'caso', other: 'en otro caso', to: 'a',
  },
};
/** Órdenes de algorithm2e que abren un bloque con condición -> su palabra clave. */
const ALGO2E_BLOCKS = new Map<string, 'if' | 'elseif' | 'for' | 'foreach' | 'forall' | 'while' | 'switch' | 'case'>([
  ['If', 'if'], ['ElseIf', 'elseif'], ['For', 'for'], ['ForEach', 'foreach'], ['ForAll', 'forall'], ['ForPar', 'for'], ['While', 'while'],
  ['Switch', 'switch'], ['Case', 'case'],
]);

/** Entornos de teorema con nombre en español -> el tipo con que los conoce cleveref. */
const THEOREM_TYPES: Record<string, string> = {
  teorema: 'theorem', lema: 'lemma', corolario: 'corollary', proposicion: 'proposition', definicion: 'definition', ejemplo: 'example',
  observacion: 'remark', nota: 'note', teo: 'theorem', thm: 'theorem', lem: 'lemma', cor: 'corollary', prop: 'proposition', defn: 'definition',
  defi: 'definition', ex: 'example', rem: 'remark',
};

/** Número romano en mayúsculas (cadena vacía para cero o negativos, como en LaTeX). */
function roman(n: number): string {
  let out = '';
  for (const [v, s] of [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']] as [number, string][]) {
    while (n >= v) {
      out += s;
      n -= v;
    }
  }
  return out;
}

/** Órdenes de LaTeX que guardan cada nombre: clave de `L10N` -> orden (sin la barra). */
const NAMES: Record<string, string> = {
  figure: 'figurename', table: 'tablename', abstract: 'abstractname', contents: 'contentsname', refs: 'refname',
  proof: 'proofname', chapter: 'chaptername', part: 'partname', appendix: 'appendixname', listing: 'lstlistingname',
  lof: 'listfigurename', lot: 'listtablename',
};
/** Lo mismo al revés, con los otros nombres de una misma cosa: orden -> clave de `L10N`. */
const NAME_KEYS: Record<string, string> = { ...Object.fromEntries(Object.entries(NAMES).map(([k, v]) => [v, k])), bibname: 'refs', listingscaption: 'listing' };

const STYLE: Record<string, [string, string]> = {
  textbf: ['strong', ''], textit: ['i', ''], emph: ['em', ''], underline: ['u', ''], uline: ['u', ''],
  texttt: ['code', ''], textsc: ['span', ' class="sc"'], textsf: ['span', ' class="sf"'],
  textrm: ['span', ' class="rm"'], textsl: ['i', ''], textnormal: ['span', ''], textup: ['span', ''],
  textmd: ['span', ''], mbox: ['span', ''], hbox: ['span', ''], text: ['span', ''],
  textsuperscript: ['sup', ''], textsubscript: ['sub', ''], sout: ['s', ''],
  fbox: ['span', ' class="fbox"'], framebox: ['span', ' class="fbox"'], centerline: ['div', ' class="center"'],
};

/** Resaltados y subrayados de soul y ulem (el documento puede tener órdenes propias con estos nombres). */
const DECOR: Record<string, [string, string]> = {
  hl: ['mark', ''], ul: ['u', ''], st: ['s', ''], so: ['span', ' class="spaced"'], caps: ['span', ' class="sc"'], uuline: ['u', ' class="uu"'],
  uwave: ['u', ' class="uwave"'], xout: ['s', ''], dashuline: ['u', ' class="udash"'], dotuline: ['u', ' class="udot"'],
};

const SIZE: Record<string, number> = {
  tiny: 0.6, scriptsize: 0.7, footnotesize: 0.8, small: 0.9, normalsize: 1, large: 1.2,
  Large: 1.44, LARGE: 1.73, huge: 2.07, Huge: 2.49,
};

const DECL: Record<string, [string, string]> = {
  bf: ['strong', ''], bfseries: ['strong', ''], it: ['i', ''], itshape: ['i', ''], em: ['i', ''],
  sl: ['i', ''], slshape: ['i', ''], tt: ['code', ''], ttfamily: ['code', ''],
  sc: ['span', ' class="sc"'], scshape: ['span', ' class="sc"'], sf: ['span', ' class="sf"'],
  sffamily: ['span', ' class="sf"'], rm: ['span', ''], rmfamily: ['span', ''], normalfont: ['span', ''],
  upshape: ['span', ''], mdseries: ['span', ''], centering: ['div', ' class="center"'],
  raggedright: ['div', ' class="left"'], raggedleft: ['div', ' class="right"'],
};
for (const [k, v] of Object.entries(SIZE)) DECL[k] = ['span', ` style="font-size:${v}em"`];

const SYMBOL: Record<string, string> = {
  LaTeX: 'L<span class="la">a</span>T<span class="te">e</span>X', TeX: 'T<span class="te">e</span>X',
  LaTeXe: 'L<span class="la">a</span>T<span class="te">e</span>X 2ε',
  ldots: '…', dots: '…', textellipsis: '…', textbackslash: '\\', textasciitilde: '~', textasciicircum: '^',
  textbar: '|', textless: '&lt;', textgreater: '&gt;', S: '§', P: '¶', copyright: '©', pounds: '£',
  euro: '€', texteuro: '€', textdegree: '°', ss: 'ß', o: 'ø', O: 'Ø', ae: 'æ', AE: 'Æ', aa: 'å', AA: 'Å',
  l: 'ł', L: 'Ł', i: 'ı', j: 'ȷ', textquotedblleft: '“', textquotedblright: '”', textquoteleft: '‘',
  textquoteright: '’', textendash: '–', textemdash: '—', textbullet: '•', dag: '†', ddag: '‡',
  quad: ' ', qquad: '  ', enspace: ' ', thinspace: ' ', slash: '/',
  textregistered: '®', texttrademark: '™', checkmark: '✓', textexclamdown: '¡', textquestiondown: '¿',
  guillemotleft: '«', guillemotright: '»', and: '   ', textperiodcentered: '·', textunderscore: '_',
  // ordinales, unidades y otros símbolos de texto (textcomp, gensymb, babel)
  textordmasculine: 'º', textordfeminine: 'ª', degree: '°', celsius: '°C', textcelsius: '°C', textmu: 'µ', micro: 'µ', ohm: 'Ω', textohm: 'Ω',
  perthousand: '‰', textperthousand: '‰', textonehalf: '½', textonequarter: '¼', textthreequarters: '¾', texttimes: '×', textdiv: '÷',
  textpm: '±', textcopyright: '©', textcent: '¢', textyen: '¥', textsterling: '£', textdollar: '$', textsection: '§', textparagraph: '¶',
  textdagger: '†', textdaggerdbl: '‡', textasteriskcentered: '∗', textbraceleft: '{', textbraceright: '}', textvisiblespace: '␣',
  textquotesingle: "'", textquotedbl: '&quot;', textminus: '−', textrightarrow: '→', textleftarrow: '←', textuparrow: '↑', textdownarrow: '↓',
  textnumero: '№', textlangle: '⟨', textrangle: '⟩', textcurrency: '¤', guillemetleft: '«', guillemetright: '»', guilsinglleft: '‹',
  guilsinglright: '›', quotedblbase: '„', quotesinglbase: '‚', dh: 'ð', DH: 'Ð', th: 'þ', TH: 'Þ', oe: 'œ', OE: 'Œ',
  lq: '‘', rq: '’', textopenbullet: '◦', textbigcircle: '◯', textmusicalnote: '♪', textestimated: '℮',
  // textgreek: letras griegas en el texto
  ...Object.fromEntries(
    Object.entries({
      alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ', lambda: 'λ', nu: 'ν',
      xi: 'ξ', pi: 'π', rho: 'ρ', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω', Gamma: 'Γ', Delta: 'Δ',
      Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
    }).map(([k, v]) => [`text${k}`, v]),
  ),
};

/** Comandos sin efecto visible: nombre -> nº de argumentos obligatorios que consumen. */
const IGNORE: Record<string, number> = {
  usepackage: 1, documentclass: 1, title: 1, author: 1, date: 1, thanks: 1, vspace: 1, hspace: 1,
  setlength: 2, addtolength: 2, setcounter: 2, addtocounter: 2, stepcounter: 1, refstepcounter: 1,
  pagestyle: 1, thispagestyle: 1, bibliographystyle: 1, geometry: 1, hypersetup: 1, graphicspath: 1,
  theoremstyle: 1, numberwithin: 2, linespread: 1, definecolor: 3, lstset: 1, captionsetup: 1,
  pagenumbering: 1, selectlanguage: 1, phantom: 1, vphantom: 1, hphantom: 1, index: 1, nocite: 1,
  addcontentsline: 3, markboth: 2, markright: 1, enlargethispage: 1, rule: 2, addbibresource: 1,
  usetikzlibrary: 1, pgfplotsset: 1, institute: 1, subtitle: 1, usetheme: 1, usecolortheme: 1,
  noindent: 0, indent: 0, hfil: 0, vfill: 0, vfil: 0, appendix: 0, frontmatter: 0, mainmatter: 0,
  backmatter: 0, sloppy: 0, protect: 0, hline: 0, toprule: 0, midrule: 0, bottomrule: 0, relax: 0,
  makeatletter: 0, makeatother: 0, nopagebreak: 0, allowbreak: 0, null: 0, strut: 0, par: 0,
  flushbottom: 0, raggedbottom: 0, item: 0,
  // eso-pic: dibujos fijos en la hoja (marcas, números de página a medida), no forman parte del texto
  AddToShipoutPicture: 1, AddToShipoutPictureFG: 1, AddToShipoutPictureBG: 1, ClearShipoutPicture: 0, ClearShipoutPictureFG: 0, ClearShipoutPictureBG: 0,
  displaystyle: 0, titlepage: 0, pause: 0, leavevmode: 0, ignorespaces: 0, unskip: 0,
  // KOMA-Script, tcolorbox, índices, tablas y ajustes de composición que no dibujan nada
  KOMAoptions: 1, KOMAoption: 2, addtokomafont: 2, setkomafont: 2, RedeclareSectionCommand: 1, RedeclareSectionCommands: 1,
  DeclareTOCStyleEntry: 2, clearpairofpagestyles: 0, ihead: 1, ohead: 1, chead: 1, ifoot: 1, cfoot: 1, ofoot: 1,
  automark: 1, setheadsepline: 1, setfootsepline: 1, tcbuselibrary: 1, tcbset: 1, makeindex: 0, makeglossaries: 0,
  makenoidxglossaries: 0, glsaddall: 0, signature: 1, address: 1, telephone: 1, location: 1, xpatchcmd: 5, patchcmd: 5,
  pretocmd: 4, apptocmd: 4, rowcolor: 1, cellcolor: 1, columncolor: 1, rowcolors: 3, addlinespace: 0, specialrule: 3,
  qedhere: 0, columnbreak: 0, lstlistoflistings: 0, listofalgorithms: 0, allowdisplaybreaks: 0, phantomsection: 0,
  medbreak: 0, bigbreak: 0, smallbreak: 0, goodbreak: 0, newblock: 0, frenchspacing: 0, nonfrenchspacing: 0,
  arraybackslash: 0, begingroup: 0, endgroup: 0, bgroup: 0, egroup: 0, xspace: 0, headmark: 0, pagemark: 0,
  leftmark: 0, rightmark: 0, thepage: 0, tikzset: 1, tikzstyle: 0, externaldocument: 1, column: 1,
  printanswers: 0, noprintanswers: 0, pointsinmargin: 0, bracketedpoints: 0, IEEEoverridecommandlockouts: 0,
  IEEEpeerreviewmaketitle: 0, glsresetall: 0, loadglsentries: 1, floatname: 2, restylefloat: 1, floatstyle: 1,
  algrenewcommand: 2, algnewcommand: 2, usebeamertemplate: 1, setbeamertemplate: 2, setbeamercolor: 2, setbeamerfont: 2,
  usefonttheme: 1, useinnertheme: 1, useoutertheme: 1, beamertemplatenavigationsymbolsempty: 0, titlegraphic: 1,
  subject: 1, keywords: 1, logo: 1, usetitlestyle: 1, useblockstyle: 1, usebackgroundstyle: 1, tikzposterlatexaffectionproofoff: 0,
  microtypesetup: 1, usefont: 4, ExplSyntaxOn: 0, ExplSyntaxOff: 0, obeylines: 0, setmainfont: 1, setsansfont: 1,
  setmonofont: 1, defaultfontfeatures: 1, AtBeginDocument: 1, AtEndDocument: 1, lstdefinestyle: 2, lstdefinelanguage: 2,
  DeclarePairedDelimiter: 3, crefname: 3, Crefname: 3, setlist: 1, setitemize: 1, setenumerate: 1, newlist: 3,
  // ajustes de siunitx, tabularray, babel en español y algorithm2e
  sisetup: 1, DeclareSIUnit: 2, SetCell: 1, SetRow: 1, SetColumn: 1, crefformat: 2, spanishdecimal: 1, decimalpoint: 0, decimalcomma: 0,
  unaccentedoperators: 0, accentedoperators: 0, spanishoperators: 1, DontPrintSemicolon: 0, SetAlgoLined: 0, LinesNumbered: 0, RestyleAlgo: 1,
  SetKwInOut: 2, SetKwInput: 2, SetKw: 2, SetKwFunction: 2, SetKwData: 2, SetKwProg: 4, listoflistings: 0, acsetup: 1, DeclareAcronym: 2,
};

/** Parámetros de TeX que se asignan en el texto (`\parindent=0pt`, `\parskip 1em`): no dibujan nada. */
const TEX_PARAMS = new Set([
  'parindent', 'parskip', 'baselineskip', 'tolerance', 'emergencystretch', 'widowpenalty', 'clubpenalty', 'interfootnotelinepenalty',
  'multicolsep', 'columnsep', 'columnseprule', 'intextsep', 'abovecaptionskip', 'belowcaptionskip', 'fboxsep', 'fboxrule', 'tabcolsep',
  'arrayrulewidth', 'textfloatsep', 'floatsep', 'hfuzz', 'vfuzz', 'hbadness', 'vbadness', 'linewidth', 'textwidth', 'columnwidth',
  'textheight', 'paperwidth', 'paperheight', 'topskip', 'footskip', 'headheight', 'headsep', 'pretolerance', 'linepenalty', 'catcode',
  'newcount', 'newdimen', 'newskip', 'newtoks', 'newbox', 'newif',
]);

const SWALLOW_ALL = new Set([
  'newcommand', 'renewcommand', 'providecommand', 'newenvironment', 'renewenvironment', 'newtheorem',
  'DeclareMathOperator', 'newcounter', 'newlength', 'DeclareRobustCommand', 'newcolumntype',
  'titleformat', 'titlespacing', 'titlecontents', 'dottedcontents', 'NewDocumentCommand', 'RenewDocumentCommand',
  'ProvideDocumentCommand', 'DeclareDocumentCommand', 'NewDocumentEnvironment', 'RenewDocumentEnvironment', 'newtcolorbox',
  'renewtcolorbox', 'newtcbtheorem', 'newglossaryentry', 'longnewglossaryentry', 'newacronym', 'newfloat', 'DeclareCaptionFormat',
  'DeclareCaptionLabelFormat', 'cmidrule', 'define@key',
]);

const ACCENT: Record<string, string> = {
  "'": '́', '`': '̀', '^': '̂', '"': '̈', '~': '̃', '=': '̄', '.': '̇',
  c: '̧', v: '̌', u: '̆', H: '̋', r: '̊', k: '̨', d: '̣', b: '̱',
};

const LEVEL: Record<string, number> = {
  part: -1, chapter: 0, section: 1, subsection: 2, subsubsection: 3, paragraph: 4, subparagraph: 5,
};

const MATH_ENVS = new Set([
  'equation', 'align', 'gather', 'multline', 'flalign', 'alignat', 'eqnarray', 'displaymath', 'math',
]);

const TRANSPARENT = new Set([
  'document', 'spacing', 'singlespace', 'doublespace', 'onehalfspace', 'sloppypar', 'samepage', 'columns',
  'column', 'multicols', 'titlepage', 'appendices', 'subequations', 'small', 'footnotesize',
  'large', 'block', 'appendix', 'refsection', 'raggedright', 'raggedleft', 'overprint', 'onlyenv', 'scope', 'threeparttable',
  'lrbox', 'preview', 'standalone', 'vplace', 'titlingpage', 'dedication', 'acknowledgments', 'acknowledgements', 'resumen',
  'preface', 'subfiles', 'multicols*', 'refcontext', 'sidewaystable', 'Form',
]);

const COMMON_THEOREMS = new Set([
  'theorem', 'lemma', 'corollary', 'proposition', 'definition', 'example', 'remark', 'exercise', 'claim',
  'conjecture', 'teorema', 'lema', 'corolario', 'proposicion', 'definicion', 'ejemplo', 'observacion',
  'ejercicio', 'nota', 'note', 'notation', 'axiom', 'problem', 'observation', 'assumption', 'hypothesis', 'property', 'fact',
  'question', 'answer', 'problema', 'axioma', 'propiedad', 'hipotesis', 'solucion', 'notacion',
]);

const PLAIN = /[^\\{}$~\n\-`'&%?!<>"]+/y;
const BLANK = /\n[ \t]*\n\s*/y;

const mathCache = new Map<string, string>();

/** Tope de órdenes propias que se expanden en un dibujado: ningún documento normal se acerca, y así ninguno puede colgarlo. */
const MAX_EXPANSIONS = 150_000;
/** Tamaño máximo del cuerpo de una orden propia, ya con sus argumentos puestos. */
const MAX_EXPANSION_SIZE = 2_000_000;

/** Trocea el cuerpo de una ecuación de varias filas por sus `\intertext{...}`: filas, texto, filas... */
function intertext(body: string): { math: string; text?: string }[] {
  const out: { math: string; text?: string }[] = [];
  let last = 0;
  for (const m of body.matchAll(/\\(?:short)?intertext\s*(?=\{)/g)) {
    const g = readGroup(body, m.index + m[0].length);
    if (!g || m.index < last) continue;
    out.push({ math: body.slice(last, m.index) }, { math: '', text: g.content });
    last = g.end;
  }
  out.push({ math: body.slice(last) });
  return out;
}

// ---------------------------------------------------------------- renderizador

class Renderer {
  private L = L10N.en;
  private depth = 0;
  private rich = false;
  private sec = [0, 0, 0, 0];
  private secId = 0;
  private eq = 0;
  private fig = 0;
  private tab = 0;
  private current = '';
  private labels = new Map<string, string>();
  private bib = new Map<string, number>();
  private toc: { level: number; num: string; title: string; id: string }[] = [];
  private footnotes: string[] = [];
  private floats: { type: 'figure' | 'table' | 'listing'; sub: boolean; n: number; num?: string }[] = [];
  private macros = new Map<string, { n: number; body: string }>();
  private kmacros: Record<string, string> = {};
  private kmKey = '';
  private theorems = new Map<string, { title: string; star: boolean }>();
  private thmCount = new Map<string, number>();
  private hasChapter = false;
  private graphicsPaths = [''];
  private meta: DocMeta = {};
  /** lo que el documento genera con bucles, condiciones y cálculos se ejecuta antes de dibujarlo */
  private program = new Expander({ counter: (name) => this.counter(name) });
  /** datos de una carta (clase letter) y de la portada de una presentación o un póster */
  private letter: { signature?: string; address?: string } = {};
  private institute = '';
  /** glosario del documento (paquete glossaries) y términos de su índice alfabético */
  private glossary = new Map<string, { name: string; description: string; plural?: string }>();
  private indexTerms: string[] = [];
  private algorithms = 0;
  /** contadores que vuelven a empezar con cada capítulo o sección (\numberwithin; por defecto, en informes y libros) */
  private within: Record<string, string> = {};
  /** títulos de figuras y tablas, para sus índices */
  private captions: { type: 'figure' | 'table'; num: string; html: string; id: string }[] = [];
  private issues: Issue[] = [];
  /** línea del bloque que se está dibujando (-1 fuera de los bloques del documento) */
  private blockLine = -1;
  private docClass = '';
  /** clase propia del documento (un .cls junto a él) que se ha leído en lugar de `docClass` */
  private customClass = '';
  private inputDepth = 0;
  /** archivo que se dibuja como parte de otro, y sus bloques una vez que el principal llega a él */
  private part: { raw: string[]; clean: string[]; blocks?: Block[] } | undefined;
  private expandDepth = 0;
  private tikz: TikzPreamble = { libraries: '', packages: [], extra: '' };
  /** tamaño de letra base del documento, en puntos */
  private basePt = 10;
  /** los números de sección llevan punto detrás («1. Introducción») */
  private secDot = false;
  /** citas por autor y año (natbib, biblatex) en vez de numéricas */
  private authorYear = false;
  /** las referencias numéricas van por orden de cita (unsrt, ieeetr) o alfabético */
  private byCitation = false;
  private bibNames: string[] = [];
  /** entradas de los archivos .bib: `undefined` = sin leer; `null` = no hay ninguno al alcance */
  private bibData: Map<string, BibEntry> | null | undefined;
  private cited: string[] = [];
  private citeAll = false;
  /** formato de los títulos fijado con titlesec */
  private heads: Record<string, { suffix?: string; size?: number; labelSize?: number; center?: boolean; italic?: boolean; before?: string; after?: string; color?: string }> = {};
  /** interlineado que fija una orden en el cuerpo (\singlespacing, \doublespacing...); sin ella, el del preámbulo */
  private stretch: number | undefined;
  /** títulos del índice, de los índices de figuras y tablas y de la bibliografía tal como valen donde se piden */
  private titleAt: { toc?: string; figure?: string; table?: string; refs?: string } = {};
  private tocAnchors = 0;
  /** babel en español escribe los números romanos en mayúsculas */
  private upperRoman = false;
  /** con titlesec cada título lleva un puntal: su línea ocupa siempre el alto del interlineado */
  private strut = false;
  private furniture: Furniture = { style: 'plain', head: ['', '', ''], foot: ['', PAGE_MARK, ''], headRule: false, footRule: false, src: { head: ['', '', ''], foot: ['', '\\thepage', ''] } };
  /** interruptores del documento (\newif, \newboolean, \newtoggle) y evaluación de sus condicionales */
  private cond = new Conditions();
  /** contadores definidos con \newcounter */
  private counters = new Map<string, number>();
  /** longitudes definidas con \newlength y fijadas con \setlength */
  private lengths = new Map<string, string>();
  /** paquetes que carga el documento, con sus opciones */
  private packages = new Map<string, string>();
  /** lo que el preámbulo cambia en las fórmulas, y las macros de KaTeX que le corresponden */
  private mathCtx: MathContext = {};
  private xmacros: Record<string, string> = mathMacros();
  /** babel en español: las listas llevan sus propias marcas y «<<» y «>>» son comillas latinas */
  private esLists = false;
  private guillemets = false;
  /** niveles de lista abiertos (LaTeX los cuenta por separado) y último número de la numerada más reciente */
  private listDepth = { itemize: 0, enumerate: 0 };
  private lastEnum = 0;
  /** tras \appendix los títulos se numeran con letras; en un libro, lo de antes y después del cuerpo va sin número */
  private appendix = false;
  private matter: '' | 'front' | 'main' | 'back' = '';
  private parts = 0;
  /** qué es lo último numerado (para \autoref y \cref) y cómo se titula (para \nameref) */
  private currentKind = '';
  private currentTitle = '';
  private labelKinds = new Map<string, string>();
  private labelTitles = new Map<string, string>();
  /** nombres de cleveref que cambia el documento: tipo -> [\cref singular, plural, \Cref singular, plural] */
  private crefNames = new Map<string, [string?, string?, string?, string?]>();
  /** llamadas a nota (\footnotemark) que esperan su texto */
  private pendingNotes: number[] = [];
  /** siglas (paquetes acronym y acro) y cuáles se han escrito ya enteras */
  private acronyms = new Map<string, { short: string; long: string }>();
  private acUsed = new Set<string>();
  /** tipos de columna propios (\newcolumntype) */
  private columnTypes = new Map<string, { n: number; spec: string }>();
  /** algorithm2e: palabras, funciones y datos que nombra el documento (\SetKw, \SetKwFunction...) */
  private algoWords = new Map<string, { kind: string; text: string }>();
  private dontPrintSemicolon = false;
  private listings = 0;
  /** entorno subequations abierto: el número que comparten sus ecuaciones y cuántas van */
  private subEq: { base: string; n: number } | undefined;
  /** macros que se están expandiendo y cuántas expansiones lleva el dibujado */
  private expanding: string[] = [];
  private expansions = 0;
  private cyclic = new Map<string, boolean>();

  constructor(private opts: RenderOptions) {}

  /** Longitud de LaTeX como medida de CSS; entiende también las longitudes propias del documento. */
  private len(v: string, axis: 'x' | 'y' = 'x', depth = 0): string | undefined {
    const direct = cssLength(v, axis);
    if (direct) return direct;
    const m = /^(-?[\d.]*)\s*\\([a-zA-Z@]+)$/.exec(v.trim().split(/\s+(?:plus|minus)\b/)[0].trim());
    const value = m ? this.lengths.get(m[2]) : undefined;
    if (!m || value === undefined || depth > 4) return undefined;
    const k = m[1] === '' ? 1 : m[1] === '-' ? -1 : parseFloat(m[1]);
    // el valor guardado, por el factor que lo acompaña: «0.5\margen» con \margen = 3cm es 1.5cm
    const part = /^(-?[\d.]*)\s*(\\[a-zA-Z@]+|[a-z]{2})$/.exec(value.trim());
    if (!part || Number.isNaN(k)) return undefined;
    const n = part[1] === '' ? 1 : part[1] === '-' ? -1 : parseFloat(part[1]);
    return this.len(`${+(k * n).toFixed(5)}${part[2]}`, axis, depth + 1);
  }

  /** Valor de un contador: los del documento y los que Mars lleva (secciones, ecuaciones, figuras). */
  private counter(name: string): number | undefined {
    switch (name) {
      case 'chapter': return this.sec[0];
      case 'section': return this.sec[1];
      case 'subsection': return this.sec[2];
      case 'subsubsection': return this.sec[3];
      case 'equation': return this.eq;
      case 'figure': return this.fig;
      case 'table': return this.tab;
      case 'footnote': return this.footnotes.length;
      default: return this.counters.get(name);
    }
  }

  private setCounter(name: string, n: number): void {
    switch (name) {
      case 'chapter': this.sec[0] = n; break;
      case 'section': this.sec[1] = n; break;
      case 'subsection': this.sec[2] = n; break;
      case 'subsubsection': this.sec[3] = n; break;
      case 'equation': this.eq = n; break;
      case 'figure': this.fig = n; break;
      case 'table': this.tab = n; break;
      default: this.counters.set(name, n);
    }
  }

  /** De quién depende un contador: el capítulo en informes y libros, o lo que diga \numberwithin. */
  private parentOf(counter: string): string | undefined {
    return this.within[counter] ?? (this.hasChapter && this.bookish ? 'chapter' : undefined);
  }

  /** Número impreso de una ecuación, figura o tabla: «3», o «2.3» si se cuenta dentro del capítulo. */
  private numbered(counter: 'equation' | 'figure' | 'table', n: number): string {
    const parent = this.parentOf(counter);
    if (parent === 'chapter' && this.sec[0] > 0) return `${this.secNumber(0)}.${n}`;
    if (parent === 'section' && this.sec[1] > 0) return `${this.secNumber(1)}.${n}`;
    return String(n);
  }

  /** Número de un título hasta ese nivel: «2.1» o, en los apéndices, «A.1». */
  private secNumber(level: number): string {
    const from = this.hasChapter ? 0 : 1;
    const parts = this.sec.slice(from, level + 1).map(String);
    if (this.appendix && parts.length) parts[0] = this.sec[from] >= 1 && this.sec[from] <= 26 ? String.fromCharCode(64 + this.sec[from]) : parts[0];
    return parts.join('.');
  }

  /** \appendix: lo que sigue son apéndices, que se cuentan desde la A. */
  private startAppendix(): void {
    if (this.appendix) return;
    this.appendix = true;
    for (let k = this.hasChapter ? 0 : 1; k < 4; k++) this.sec[k] = 0;
  }

  /** La clase tiene capítulos (informe, libro, tesis). */
  private get bookish(): boolean {
    return /^(report|book|scrreprt|scrbook|memoir|amsbook)$/.test(this.docClass);
  }

  private get lang(): 'en' | 'es' {
    return this.L.locale.startsWith('es') ? 'es' : 'en';
  }

  /** Número que da una expresión sencilla de contador: «3», «\value{x}», «\value{x}+1». */
  private count(expr: string): number {
    const s = expr.replace(/\\value\s*\{([^}]*)\}/g, (_, k: string) => String(this.counter(k.trim()) ?? 0)).replace(/\s+/g, '');
    if (!/^[-+*\d()]+$/.test(s)) return parseInt(s, 10) || 0;
    let total = 0;
    for (const term of s.match(/[-+]?\d+/g) ?? []) total += parseInt(term, 10);
    return total;
  }

  render(text: string): RenderResult {
    const raw = text.split(/\r?\n/);
    const clean = stripComments(raw);
    const begin = clean.findIndex((l) => l.includes('\\begin{document}'));
    if (begin < 0 && this.opts.root && !clean.some((l) => /\\documentclass\b/.test(l))) {
      const part = this.renderPart(raw, clean);
      if (part) return part;
    }
    let end = -1;
    for (let i = clean.length - 1; i > begin; i--) {
      if (clean[i].includes('\\end{document}')) {
        end = i;
        break;
      }
    }
    // el preámbulo se lee ya resuelto: condicionales evaluados y la clase o los paquetes propios incorporados
    const eff = effectiveSource(text, (name) => this.opts.readInput?.(name));
    this.cond = eff.cond;
    this.customClass = eff.customClass ?? '';
    const at = begin >= 0 ? /^[ \t]*\\begin\{document\}/m.exec(eff.text) : null;
    this.prescan(at ? eff.text.slice(0, at.index) + clean.slice(begin).join('\n') : clean.join('\n'));
    this.chaptersInInputs(clean.join('\n'));
    if (begin > 0) this.program.load(raw.slice(0, begin).join('\n'));

    const from = begin >= 0 ? begin + 1 : 0;
    const to = end >= 0 ? end : raw.length;
    const blocks: Block[] = [];
    const blank = (i: number): boolean => i >= 0 && i < raw.length && raw[i].trim() === '';
    if (begin >= 0) {
      blocks.push({
        s: 0, e: begin, kind: 'atom', src: raw.slice(0, begin + 1).join('\n'), gb: true, ga: blank(begin + 1),
        html: `<div class="preamble" data-role="preamble">Preámbulo · ${esc(this.customClass ? `${this.customClass} (${this.docClass})` : this.docClass || 'documento')} · ${begin + 1} líneas</div>`,
      });
    }
    blocks.push(...this.blocksOf(raw, clean, from, to));
    return this.result(blocks, raw, to, begin >= 0);
  }

  /** Con los capítulos en archivos aparte, el principal no lleva ningún \chapter a la vista. */
  private chaptersInInputs(body: string): void {
    if (this.hasChapter) return;
    const gather = (text: string, depth: number): boolean => {
      if (depth > 3) return false;
      for (const m of text.matchAll(/\\(?:input|include|subfile)\s*\{([^}]*)\}/g)) {
        const t = this.opts.readInput?.(m[1].trim());
        if (t === undefined) continue;
        const c = stripComments(t.split(/\r?\n/)).join('\n');
        if (/\\chapter\*?\s*[[{]/.test(c) || gather(c, depth + 1)) return true;
      }
      return false;
    };
    this.hasChapter = gather(body, 0);
  }

  /**
   * Un archivo que es parte de otro: se recorre el documento principal entero para llevar sus
   * contadores, etiquetas y citas, y al llegar a la línea que trae este archivo se dibujan sus
   * bloques, que son los que se devuelven (con sus propios números de línea).
   */
  private renderPart(raw: string[], clean: string[]): RenderResult | undefined {
    const text = this.opts.root?.text ?? '';
    const rraw = text.split(/\r?\n/);
    const rclean = stripComments(rraw);
    const begin = rclean.findIndex((l) => l.includes('\\begin{document}'));
    if (begin < 0) return undefined;
    let end = rraw.length;
    for (let i = rclean.length - 1; i > begin; i--) {
      if (rclean[i].includes('\\end{document}')) {
        end = i;
        break;
      }
    }
    const eff = effectiveSource(text, (name) => this.opts.readInput?.(name));
    this.cond = eff.cond;
    this.customClass = eff.customClass ?? '';
    const at = /^[ \t]*\\begin\{document\}/m.exec(eff.text);
    this.prescan((at ? eff.text.slice(0, at.index) : '') + rclean.slice(begin).join('\n') + '\n' + clean.join('\n'));
    this.chaptersInInputs(rclean.join('\n'));
    this.program.load(rraw.slice(0, begin).join('\n'));
    this.part = { raw, clean };
    for (const r of splitBlocks(rclean, begin + 1, end)) {
      this.rich = false;
      this.depth = 0;
      try {
        this.inline(rraw.slice(r.s, r.e + 1).join('\n'));
      } catch {
        // lo que falle en otro archivo no impide dibujar este
      }
    }
    // (si el principal no llega a traerlo —un \includeonly, un condicional—, se dibuja al final)
    const blocks = this.part.blocks ?? this.partBlocks();
    return this.result(blocks, raw, raw.length, false);
  }

  private partBlocks(): Block[] {
    const p = this.part;
    if (!p) return [];
    const saved = { depth: this.depth, rich: this.rich, inputDepth: this.inputDepth };
    // las notas al pie de la hoja son las de este archivo
    this.footnotes = [];
    this.pendingNotes = [];
    this.inputDepth = 0;
    p.blocks = [];
    p.blocks = this.blocksOf(p.raw, p.clean, 0, p.raw.length);
    Object.assign(this, saved);
    return p.blocks;
  }

  private result(blocks: Block[], raw: string[], to: number, hasDocument: boolean): RenderResult {
    this.numberReferences();
    for (const b of blocks) {
      // referencias y citas que no llevan a ningún sitio (LaTeX las dejaría como «??»)
      for (const m of b.html.replace(/\u0001N[a-zA-Z][^\u0001]*\u0001/g, '').matchAll(/\u0001([RC])([^\u0001]*)\u0001/g)) {
        const key = decodeURIComponent(m[2]);
        if (m[1] === 'R' && !this.labels.has(key)) this.issues.push({ kind: 'ref', text: key, line: b.s });
        else if (m[1] === 'C' && this.bib.size > 0 && !this.bib.has(key)) this.issues.push({ kind: 'cite', text: key, line: b.s });
      }
      // (\autoref, \cref, \nameref y \pageref pueden nombrar varias etiquetas a la vez)
      for (const m of b.html.matchAll(/\u0001N[a-zA-Z]([^\u0001]*)\u0001/g)) {
        for (const key of decodeURIComponent(m[1]).split(',').map((k) => k.trim()).filter(Boolean)) {
          // (\pageref{LastPage} no nombra una etiqueta del documento: es su última hoja)
          if (!this.labels.has(key) && !LAST_PAGE.test(key)) this.issues.push({ kind: 'ref', text: key, line: b.s });
        }
      }
      for (const m of b.html.matchAll(/class="cite-missing"[^>]*>([^<?]*)/g)) this.issues.push({ kind: 'cite', text: m[1], line: b.s });
      b.html = this.resolve(b.html);
    }
    const seen = new Set<string>();
    const issues = this.issues.filter((x) => !seen.has(`${x.kind}|${x.text}|${x.line}`) && seen.add(`${x.kind}|${x.text}|${x.line}`));
    return {
      issues,
      blocks,
      insertLine: to,
      tailGap: to === 0 || (to - 1 < raw.length && raw[to - 1].trim() === ''),
      macros: this.kmacros,
      labels: [...this.labels.keys()],
      meta: this.meta,
      hasDocument,
      authorYear: this.authorYear,
      furniture: this.furniture,
      math: this.mathCtx,
    };
  }

  /** Bloques de un tramo de líneas de un archivo, más el de sus notas al pie. */
  private blocksOf(raw: string[], clean: string[], from: number, to: number): Block[] {
    const blocks: Block[] = [];
    // líneas en blanco de verdad: una que solo lleva un comentario no separa párrafos
    const blank = (i: number): boolean => i >= 0 && i < raw.length && raw[i].trim() === '';
    const gaps = (s: number, e: number): { gb: boolean; ga: boolean } => ({ gb: s === 0 || blank(s - 1), ga: blank(e + 1) });
    let carry: { pagenum?: string; pagestyle?: string; pagestyleFrom?: string; anchors?: string[] } = {};
    for (const r of splitBlocks(clean, from, to)) {
      const src = raw.slice(r.s, r.e + 1).join('\n');
      this.rich = false;
      this.depth = 0;
      this.listDepth = { itemize: 0, enumerate: 0 };
      this.blockLine = r.s;
      let html: string;
      try {
        // bucles, condiciones y cálculos: se ejecutan y se dibuja lo que generan (que no se edita
        // en sitio: es resultado del código); las definiciones solo se anotan
        const mode = this.program.needs(src);
        const generated = mode ? this.program.run(src) : undefined;
        // (si al ejecutarlo no cambia nada, el bloque se dibuja y se edita como cualquier otro)
        if (mode === 'program' && generated !== undefined && generated.trim() !== uncomment(src).trim()) {
          const inner = generated.trim() ? this.plain(generated) : '';
          html = inner.replace(HIDDEN_ATOM, '').trim() ? atom(src, inner, 'gen', true) : inner;
          this.rich = false;
        } else html = this.inline(src);
      } catch (err) {
        html = atom(src, `<div class="tex-error">${esc(String(err))}</div>`, '', true);
        this.rich = false;
      }
      if (!html.replace(HIDDEN_ATOM, '').trim()) {
        // no dibuja nada, pero puede fijar la numeración o el estilo de la hoja de lo que venga detrás
        carry.pagenum = / data-pagenum="([^"]*)"/.exec(html)?.[1] ?? carry.pagenum;
        carry.pagestyle = / data-pagestyle="([^"]*)"/.exec(html)?.[1] ?? carry.pagestyle;
        carry.pagestyleFrom = / data-pagestyle-from="([^"]*)"/.exec(html)?.[1] ?? carry.pagestyleFrom;
        const ids = [...html.matchAll(/ id="(toc-\d+)"/g)].map((m) => m[1]);
        if (ids.length) carry.anchors = [...(carry.anchors ?? []), ...ids];
        continue;
      }
      const lh = this.stretch === undefined ? {} : { lh: Math.round(this.stretch * 1000) / 1000 };
      blocks.push({ s: r.s, e: r.e, html, kind: this.rich ? 'rich' : 'atom', src, ...gaps(r.s, r.e), ...carry, ...lh });
      carry = {};
    }
    this.blockLine = -1;
    if (this.footnotes.length) {
      const items = this.footnotes.map((f) => `<li>${f}</li>`).join('');
      blocks.push({
        s: Math.max(to - 1, 0), e: Math.max(to - 1, 0), kind: 'ro', src: '', gb: false, ga: false,
        html: `<div class="footnotes"><ol>${items}</ol></div>`,
      });
    }
    return blocks;
  }

  // -------------------------------------------------- bibliografía en archivos .bib

  private bibEntries(): Map<string, BibEntry> | null {
    if (this.bibData === undefined) {
      const map = new Map<string, BibEntry>();
      let any = false;
      for (const name of this.bibNames) {
        const text = this.opts.readBib?.(name);
        if (text === undefined) continue;
        any = true;
        for (const e of parseBibtex(text)) if (!map.has(e.key)) map.set(e.key, e);
      }
      this.bibData = any ? map : null;
    }
    return this.bibData;
  }

  /** Entradas citadas, en el orden en que van en la lista de referencias. */
  private references(): BibEntry[] {
    const data = this.bibEntries();
    if (!data) return [];
    const list = this.citeAll ? [...data.values()] : this.cited.map((k) => data.get(k)).filter((e): e is BibEntry => e !== undefined);
    if (this.byCitation && !this.authorYear) return list;
    const sortKey = (e: BibEntry): string => `${citeAuthors(e)} ${citeYear(e)} ${e.fields.title ?? ''}`.toLowerCase();
    return [...list].sort((a, b) => sortKey(a).localeCompare(sortKey(b), 'es'));
  }

  /** En citas numéricas, el número de cada referencia es su posición en la lista. */
  private numberReferences(): void {
    if (this.authorYear) return;
    this.references().forEach((e, k) => {
      if (!this.bib.has(e.key)) this.bib.set(e.key, k + 1);
    });
  }

  /** Una referencia con el formato de la lista (autores, año, título y dónde se publicó). */
  private reference(e: BibEntry): string {
    const f = e.fields;
    const p = (s: string | undefined): string => (s ? this.plain(s) : '');
    const em = (s: string): string => (s ? `<i>${s}</i>` : '');
    const join = (parts: string[], sep = ', '): string => parts.filter(Boolean).join(sep);
    const title = p(f.title);
    let rest: string;
    switch (e.type) {
      case 'article':
        rest = `${title}. ${join([em(p(f.journal)), join([p(f.volume) + (f.number ? `(${p(f.number)})` : ''), p(f.pages)], ':')])}.`;
        break;
      case 'book': case 'booklet': case 'manual':
        rest = `${em(title)}. ${join([p(f.publisher), p(f.address), f.edition ? `${p(f.edition)} edition` : ''])}.`;
        break;
      case 'inproceedings': case 'incollection': case 'conference':
        rest = `${title}. In ${join([em(p(f.booktitle)), f.pages ? `pages ${p(f.pages)}` : ''])}.${f.publisher ? ` ${p(f.publisher)}.` : ''}`;
        break;
      case 'phdthesis':
        rest = `${em(title)}. ${join([p(f.type) || 'PhD thesis', p(f.school), p(f.address)])}.`;
        break;
      case 'mastersthesis':
        rest = `${title}. ${join([p(f.type) || "Master's thesis", p(f.school), p(f.address)])}.`;
        break;
      case 'techreport':
        rest = `${title}. ${join([join([p(f.type) || 'Technical report', p(f.number)], ' '), p(f.institution)])}.`;
        break;
      default:
        rest = `${title}.${f.howpublished ? ` ${p(f.howpublished)}.` : ''}`;
    }
    if (f.note) rest += ` ${p(f.note)}.`;
    const who = p(referenceAuthors(e));
    const lead = this.authorYear ? `${who} (${esc(citeYear(e))}). ` : `${who}. `;
    const tail = this.authorYear ? '' : ` ${esc(citeYear(e))}.`;
    return (lead + rest + tail).replace(/\s+([.,])/g, '$1').replace(/\.{2,}/g, '.').replace(/,\./g, '.');
  }

  private referencesHtml(): string {
    const items = this.references().map((e) => `<li id="bib-${enc(e.key)}">${this.reference(e)}</li>`);
    const body = items.length
      ? `<ol class="bib refs${this.authorYear ? ' authoryear' : ''}">${items.join('')}</ol>`
      : '<div class="note">Aquí aparecerán las referencias que se citen en el texto.</div>';
    return `<div class="bib-title"${this.listTitleStyle()}>${this.titleAt.refs ?? this.L.refs}</div>${body}`;
  }

  /**
   * Cita en el texto. Con un archivo .bib y estilo de autor y año (natbib, biblatex) se escribe
   * como la compone LaTeX: «(Codd, 1970)» o «Codd (1970)»; si no, numérica.
   */
  private citation(name: string, keys: string[], first: string | undefined, second: string | undefined): string {
    // un argumento opcional es la nota de detrás; con dos, [delante][detrás]
    const before = second !== undefined && first ? this.plain(first) + ' ' : '';
    const after = second !== undefined ? second : first;
    const post = after ? ', ' + this.plain(after) : '';
    for (const k of keys) if (!this.cited.includes(k)) this.cited.push(k);
    const data = this.bibEntries();
    if (!this.authorYear || !data) return `[${keys.map((k) => `\u0001C${enc(k)}\u0001`).join(', ')}${post}]`;
    const part = (k: string, form: (who: string, year: string) => string): string => {
      const e = data.get(k);
      if (!e) return `<span class="cite-missing" title="No está en el archivo .bib">${esc(k)}?</span>`;
      return `<a class="ref" href="#bib-${enc(k)}">${form(this.plain(citeAuthors(e)), esc(citeYear(e)))}</a>`;
    };
    const all = (form: (who: string, year: string) => string, sep = '; '): string => keys.map((k) => part(k, form)).join(sep);
    switch (name) {
      case 'citeauthor': return all((who) => who, ', ');
      case 'citeyear': return all((_, year) => year, ', ');
      case 'citeyearpar': return `(${before}${all((_, year) => year, ', ')}${post})`;
      case 'citealt': return all((who, year) => `${who} ${year}`) + post;
      case 'citealp': return before + all((who, year) => `${who}, ${year}`) + post;
      case 'citep': case 'parencite': case 'autocite': case 'footcite':
        return `(${before}${all((who, year) => `${who}, ${year}`)}${post})`;
      default:
        // \citet, \textcite y \cite: el autor en el texto y el año entre paréntesis
        return keys.map((k, i) => part(k, (who, year) => `${who} (${before}${year}${i === keys.length - 1 ? post : ''})`)).join('; ');
    }
  }

  // -------------------------------------------------- análisis previo

  private prescan(text: string): void {
    const cls = /\\documentclass\s*(\[[^\]]*\])?\s*\{([^}]*)\}/.exec(text);
    this.docClass = cls?.[2] ?? '';
    const preamble = text.split('\\begin{document}')[0];
    for (const m of preamble.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/g)) {
      for (const p of m[2].split(',')) this.packages.set(p.trim(), m[1] ?? '');
    }
    if (documentLanguage(preamble) === 'spanish' || /\\selectlanguage\{spanish\}/.test(text) || /spanish/.test(cls?.[1] ?? '')) {
      this.L = L10N.es;
      // babel en español pone un punto tras el número de las secciones, salvo con es-nosectiondot
      this.secDot = /\{babel\}/.test(preamble) && !/es-(?:nosectiondot|nolayout|minimal|sloppy)/.test(preamble);
    }
    // lo que babel cambia en español además de los nombres: las marcas de las listas, las comillas
    // latinas con «<<» y «>>», la coma decimal de las fórmulas y los operadores (\sen, lím, máx...)
    const esBabel = this.lang === 'es' && this.packages.has('babel');
    const esOpts = `${this.packages.get('babel') ?? ''},${cls?.[1] ?? ''}`;
    const bare = /es-(?:minimal|sloppy)/.test(esOpts);
    this.esLists = esBabel && !bare && !/es-(?:nolists|nolayout)/.test(esOpts);
    this.guillemets = (esBabel && !bare && !/es-(?:noquoting|noshorthands)/.test(esOpts)) || /\bT1\b/.test(this.packages.get('fontenc') ?? '');
    this.upperRoman = esBabel && !/es-lcroman/.test(esOpts);
    const si = siSetup(text);
    const units = siUnits(text);
    const paired = pairedDelimiters(text);
    this.mathCtx = {
      ...(esBabel ? { spanish: true } : {}),
      ...(esBabel && !bare && !/es-nodecimaldot|mexico/.test(esOpts) && !/\\decimalpoint\b|\\spanishdecimal\s*\{\s*\.\s*\}/.test(text) ? { decimalComma: true } : {}),
      ...(esBabel && /\\unaccentedoperators\b/.test(text) ? { unaccented: true } : {}),
      ...(this.packages.has('physics') ? { physics: true } : {}),
      ...(Object.keys(si).length ? { si } : {}),
      ...(Object.keys(units).length ? { units } : {}),
      ...(Object.keys(paired).length ? { paired } : {}),
    };
    this.xmacros = mathMacros(this.mathCtx);
    this.hasChapter = /\\chapter\*?\s*[[{]/.test(text);
    // hasta qué nivel se numeran los títulos y cuáles entran en el índice: en informes y libros, uno menos
    this.counters.set('secnumdepth', this.bookish ? 2 : 3);
    this.counters.set('tocdepth', this.bookish ? 2 : 3);
    // en informes y libros la lista de referencias se titula «Bibliografía»
    if (this.bookish) this.L = { ...this.L, refs: this.lang === 'es' ? 'Bibliografía' : 'Bibliography' };
    const size = /(\d+(?:\.\d+)?)pt/.exec(cls?.[1] ?? '')?.[1] ?? /\\usepackage\s*\[[^\]]*fontsize\s*=\s*(\d+(?:\.\d+)?)pt[^\]]*\]\s*\{scrextend\}/.exec(preamble)?.[1];
    if (size && !/poster/.test(this.docClass)) this.basePt = parseFloat(size);

    // citas: por autor y año con natbib o biblatex (y un estilo que lo admita); si no, numéricas
    const natbib = /\\usepackage\s*(?:\[([^\]]*)\])?\s*\{natbib\}/.exec(preamble);
    const biblatex = /\\usepackage\s*(?:\[([^\]]*)\])?\s*\{biblatex\}/.exec(preamble);
    const style = /\\bibliographystyle\s*\{([^}]*)\}/.exec(text)?.[1] ?? '';
    this.authorYear =
      (natbib !== null && !/\b(numbers|super)\b/.test(natbib[1] ?? '') && (style === '' || /nat|apa|chicago|harv|agsm|kluwer|dcu|authoryear|named|astron/i.test(style))) ||
      (biblatex !== null && /style\s*=\s*(apa|authoryear|chicago-authordate|mla)/.test(biblatex[1] ?? ''));
    this.byCitation = /unsrt|ieeetr|IEEEtran|^acm$/i.test(style);
    for (const m of text.matchAll(/\\(?:bibliography|addbibresource)\s*\{([^}]*)\}/g)) {
      this.bibNames.push(...m[1].split(',').map((x) => x.trim()).filter(Boolean));
    }

    // titlesec: tamaño de los títulos, punto tras el número y espacio antes y después
    this.strut = /\\usepackage\s*(?:\[[^\]]*\])?\s*\{titlesec\}/.test(preamble);
    for (const m of preamble.matchAll(/\\titleformat(\*?)\s*\{\\(chapter|section|subsection|subsubsection)\}/g)) {
      const c = new Cursor(preamble, m.index + m[0].length);
      c.opt();
      const format = c.group() ?? '';
      const label = m[1] ? undefined : c.group() ?? '';
      // \titleformat{orden}[forma]{formato}{etiqueta}{separación}{antes del título}: lo último puede
      // dar al título un tamaño distinto del de su etiqueta («Capítulo 1» grande y el título algo menos)
      if (!m[1]) c.group();
      const before = m[1] ? '' : c.group() ?? '';
      const sizeOf = (tex: string): number | undefined => {
        const sizes = [...tex.matchAll(/\\(tiny|scriptsize|footnotesize|small|normalsize|large|Large|LARGE|huge|Huge)\b/g)];
        return sizes.length ? SIZE[sizes[sizes.length - 1][1]] : undefined;
      };
      const own = sizeOf(before);
      this.heads[m[2]] = {
        ...this.heads[m[2]],
        // la etiqueta que se escriba manda: «\thesection» a secas va sin el punto que pone babel en español
        suffix: label === undefined ? undefined : /\\the[a-z]+\s*\./.test(label) ? '.' : '',
        size: own ?? sizeOf(format),
        labelSize: own !== undefined ? sizeOf(format) : undefined,
        center: /\\centering\b|\\filcenter\b/.test(format) || undefined,
        italic: /\\itshape\b|\\slshape\b/.test(format + before) || undefined,
      };
    }
    for (const m of preamble.matchAll(/\\titlespacing\*?\s*\{\\(chapter|section|subsection|subsubsection)\}/g)) {
      const c = new Cursor(preamble, m.index + m[0].length);
      c.group();
      const before = c.group();
      const after = c.group();
      this.heads[m[1]] = { ...this.heads[m[1]], before: before ? this.len(before, 'y') : undefined, after: after ? this.len(after, 'y') : undefined };
    }

    for (const key of ['title', 'author', 'date'] as const) {
      const m = new RegExp(`\\\\${key}\\s*(?=[\\[{])`).exec(text);
      if (m) {
        const c = new Cursor(text, m.index + m[0].length);
        c.opt();
        this.meta[key] = c.arg();
      }
    }

    for (const m of preamble.matchAll(/\\numberwithin\s*\{(equation|figure|table)\}\s*\{(chapter|section)\}/g)) this.within[m[1]] = m[2];

    // colores propios, en el orden en que se definen (uno puede mezclar otro anterior)
    userColors = new Map();
    for (const m of text.matchAll(/\\(definecolor|providecolor|colorlet)\s*\{([^}#]*)\}\s*\{([^}#]*)\}(?:\s*\{([^}#]*)\})?/g)) {
      const rgb = m[1] === 'colorlet' ? namedColor(m[3]) : modelColor(m[3].trim(), m[4] ?? '');
      if (rgb) userColors.set(m[2].trim(), rgb);
    }

    // color de los títulos: KOMA-Script (\addtokomafont{section}{\color{...}}) y titlesec (\titleformat)
    const headColor = (kind: string, format: string): void => {
      const m = /\\color\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/.exec(format);
      const col = m ? cssColor(m[1], m[2]) : '';
      if (col) this.heads[kind] = { ...this.heads[kind], color: col };
    };
    for (const m of preamble.matchAll(/\\(?:addtokomafont|setkomafont)\s*\{(chapter|section|subsection|subsubsection|disposition)\}\s*(?=\{)/g)) {
      const format = readGroup(preamble, m.index + m[0].length)?.content ?? '';
      for (const kind of m[1] === 'disposition' ? ['chapter', 'section', 'subsection', 'subsubsection'] : [m[1]]) headColor(kind, format);
    }
    for (const m of preamble.matchAll(/\\titleformat\*?\s*\{\\(chapter|section|subsection|subsubsection)\}/g)) {
      const c = new Cursor(preamble, m.index + m[0].length);
      c.opt();
      headColor(m[1], c.group() ?? '');
    }

    // carta (remitente y firma), institución de una presentación o un póster, y glosario
    const one = (cmd: string): string | undefined => {
      const m = new RegExp(`\\\\${cmd}\\s*(?=\\{)`).exec(text);
      return m ? readGroup(text, m.index + m[0].length)?.content : undefined;
    };
    this.letter = { signature: one('signature'), address: one('address') };
    this.institute = one('institute') ?? '';
    for (const m of text.matchAll(/\\(?:newglossaryentry|longnewglossaryentry)\s*\{([^}]*)\}\s*(?=\{)/g)) {
      const g = readGroup(text, m.index + m[0].length);
      if (!g) continue;
      const field = (k: string): string | undefined => new RegExp(`(?:^|,)\\s*${k}\\s*=\\s*(\\{(?:[^{}]|\\{[^{}]*\\})*\\}|[^,]*)`).exec(g.content)?.[1].trim().replace(/^\{([\s\S]*)\}$/, '$1');
      this.glossary.set(m[1].trim(), { name: field('name') ?? m[1].trim(), description: field('description') ?? '', plural: field('plural') });
    }
    for (const m of text.matchAll(/\\newacronym\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}\s*\{([^}]*)\}\s*\{([^}]*)\}/g)) {
      this.glossary.set(m[1].trim(), { name: m[2], description: m[3] });
    }
    // siglas de los paquetes acronym (\acro{clave}[sigla]{nombre completo}) y acro (\DeclareAcronym)
    for (const m of text.matchAll(/\\(?:acro|acrodef|newacro)\s*\{([^}]*)\}\s*(?:\[([^\]]*)\])?\s*(?=\{)/g)) {
      const g = readGroup(text, m.index + m[0].length);
      if (g) this.acronyms.set(m[1].trim(), { short: m[2] ?? m[1].trim(), long: g.content });
    }
    for (const m of text.matchAll(/\\DeclareAcronym\s*\{([^}]*)\}\s*(?=\{)/g)) {
      const fields = keyValues(readGroup(text, m.index + m[0].length)?.content ?? '');
      this.acronyms.set(m[1].trim(), { short: fields.short ?? m[1].trim(), long: fields.long ?? '' });
    }
    // nombres con que cleveref cita cada tipo, si el documento los cambia
    for (const m of text.matchAll(/\\(c|C)refname\s*\{([^}]*)\}\s*\{([^}]*)\}\s*\{([^}]*)\}/g)) {
      const names = this.crefNames.get(m[2].trim()) ?? [];
      names[m[1] === 'c' ? 0 : 2] = m[3];
      names[m[1] === 'c' ? 1 : 3] = m[4];
      this.crefNames.set(m[2].trim(), names);
    }
    // algorithm2e: \SetKwInOut{Input}{Entrada}, \SetKwFunction{FMain}{Main}, \SetKwProg{Fn}{Function}{:}{end}...
    for (const m of text.matchAll(/\\SetKw(InOut|Input|Function|Data|Array|Prog|)\s*\{\s*\\?([a-zA-Z]+)\s*\}\s*\{([^}]*)\}/g)) {
      this.algoWords.set(m[2], { kind: m[1], text: m[3] });
    }
    this.dontPrintSemicolon = /\\DontPrintSemicolon\b/.test(preamble);
    // tipos de columna propios: \newcolumntype{L}[1]{>{\raggedright\arraybackslash}p{#1}}
    for (const m of text.matchAll(/\\newcolumntype\s*\{\s*([a-zA-Z])\s*\}\s*(?:\[(\d)\])?\s*(?=\{)/g)) {
      const g = readGroup(text, m.index + m[0].length);
      if (g) this.columnTypes.set(m[1], { n: parseInt(m[2] ?? '0', 10), spec: g.content });
    }

    const gp = /\\graphicspath\s*\{((?:\s*\{[^}]*\})+)\s*\}/.exec(text);
    if (gp) for (const m of gp[1].matchAll(/\{([^}]*)\}/g)) this.graphicsPaths.push(m[1]);

    for (const m of text.matchAll(/\\(?:re|provide)?newcommand\*?\s*/g)) {
      const c = new Cursor(text, m.index + m[0].length);
      const name = c.arg().trim();
      let n = parseInt(c.opt() ?? '0', 10) || 0;
      const def = c.opt();
      let body = c.group();
      if (!/^\\[a-zA-Z]+$/.test(name) || body === undefined) continue;
      if (def !== undefined && n > 0) {
        // argumento opcional: se fija a su valor por defecto
        body = body.replace(/#(\d)/g, (_, d: string) => (d === '1' ? def : '#' + (parseInt(d, 10) - 1)));
        n--;
      }
      this.macros.set(name.slice(1), { n, body });
      this.kmacros[name] = body;
    }
    for (const m of text.matchAll(/\\def\s*(\\[a-zA-Z]+)\s*(?=\{)/g)) {
      const g = readGroup(text, m.index + m[0].length);
      if (g) {
        this.macros.set(m[1].slice(1), { n: 0, body: g.content });
        this.kmacros[m[1]] = g.content;
      }
    }
    for (const m of text.matchAll(/\\DeclareMathOperator(\*?)\s*/g)) {
      const c = new Cursor(text, m.index + m[0].length);
      const name = c.arg().trim();
      const body = c.group();
      // (con asterisco, los límites van debajo, como en \lim)
      if (/^\\[a-zA-Z]+$/.test(name) && body !== undefined) this.kmacros[name] = `\\operatorname${m[1]}{${body}}`;
    }
    this.kmKey = JSON.stringify([this.kmacros, this.mathCtx]);

    // contadores propios, con el valor que les dé el preámbulo
    for (const m of preamble.matchAll(/\\newcounter\s*\{([^}]*)\}/g)) this.counters.set(m[1].trim(), 0);
    for (const m of preamble.matchAll(/\\setcounter\s*\{([^}]*)\}\s*\{([^}]*)\}/g)) {
      if (this.counters.has(m[1].trim())) this.counters.set(m[1].trim(), this.count(m[2]));
    }

    // longitudes propias del documento: \newlength{\margen} \setlength{\margen}{3cm}
    for (const m of preamble.matchAll(/\\newlength\s*\{?\s*\\([a-zA-Z@]+)\s*\}?/g)) this.lengths.set(m[1], '0pt');
    for (const m of preamble.matchAll(/\\setlength\s*\{?\s*\\([a-zA-Z@]+)\s*\}?\s*\{([^}]*)\}/g)) {
      if (this.lengths.has(m[1])) this.lengths.set(m[1], m[2].trim());
    }

    // nombres que pone LaTeX («Índice», «Figura», «Referencias»...) y que el documento puede cambiar
    const babel = /\{babel\}/.test(preamble);
    // en español babel llama «Cuadro» a las tablas, salvo con la opción es-tabla
    if (this.lang === 'es' && babel && !/es-tabla/.test(preamble)) this.L = { ...this.L, table: 'Cuadro' };
    // con babel solo valen los cambios hechos dentro de \addto\captions..., o ya en el cuerpo:
    // al empezar el documento babel vuelve a poner los suyos
    // (un cambio escrito en el cuerpo vale desde donde está: se aplica al llegar a él, no aquí)
    let scope = preamble;
    if (babel) {
      scope = '';
      for (const m of preamble.matchAll(/\\(?:addto\s*\\captions[a-zA-Z]+|AtBeginDocument)\s*(?=\{)/g)) {
        scope += '\n' + (readGroup(preamble, m.index + m[0].length)?.content ?? '');
      }
    }
    for (const [key, name] of Object.entries(NAMES)) {
      // (en informes y libros la lista de referencias toma su título de \bibname)
      const cmd = key === 'refs' && this.bookish ? 'bibname' : key === 'listing' ? '(?:lstlistingname|listingscaption)' : name;
      const re = new RegExp(`\\\\(?:(?:re|provide)?newcommand\\*?\\s*\\{?\\s*\\\\${cmd}\\s*\\}?|def\\s*\\\\${cmd})\\s*(?=\\{)`, 'g');
      // el nombre de los listados de código no lo lleva babel: vale donde se cambie
      const where = key === 'listing' ? preamble : scope;
      let last: RegExpMatchArray | undefined;
      for (const m of where.matchAll(re)) last = m;
      const g = last ? readGroup(where, (last.index ?? 0) + last[0].length) : undefined;
      if (g) this.L = { ...this.L, [key]: this.plain(g.content) };
    }
    this.readFurniture(text);
    for (const m of preamble.matchAll(/\\setlocalecaption\s*\{[^}]*\}\s*\{([a-z]+)\}\s*(?=\{)/g)) {
      const g = readGroup(preamble, m.index + m[0].length);
      const key = Object.keys(NAMES).find((k) => NAMES[k].startsWith(m[1]));
      if (g && key) this.L = { ...this.L, [key]: this.plain(g.content) };
    }

    // preámbulo para las figuras TikZ
    const head = text.split('\\begin{document}')[0];
    const libs: string[] = [];
    for (const m of text.matchAll(/\\usetikzlibrary\s*\{([^}]*)\}/g)) libs.push(m[1].replace(/\s+/g, ''));
    this.tikz.libraries = libs.join(',');
    for (const m of head.matchAll(/\\usepackage\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
      for (const p of m[1].split(',').map((x) => x.trim())) {
        if (TIKZ_PACKAGES.includes(p) && !this.tikz.packages.includes(p)) this.tikz.packages.push(p);
      }
    }
    const extra: string[] = [];
    for (const m of head.matchAll(/\\(tikzset|pgfplotsset|definecolor|colorlet|tikzstyle|(?:re)?newcommand\*?|DeclareMathOperator\*?)(?![a-zA-Z])/g)) {
      const c = new Cursor(head, m.index + m[0].length);
      if (m[1] === 'tikzstyle') {
        const end = head.indexOf('\n', c.p);
        extra.push(head.slice(m.index, end < 0 ? head.length : end));
        continue;
      }
      c.ws();
      if (head[c.p] === '\\') c.arg();
      while (c.group() !== undefined || c.opt() !== undefined) { /* consumir argumentos */ }
      const piece = head.slice(m.index, c.p);
      // una macro con código Lua no la entiende el motor de las figuras (y sus «%d» le cortarían la línea)
      if (!/\\directlua|\\luaexec|\\csname|\\ExplSyntax/.test(piece)) extra.push(piece);
    }
    this.tikz.extra = extra.join('\n');

    for (const m of text.matchAll(/\\newtheorem(\*?)\s*\{([^}]*)\}\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g)) {
      this.theorems.set(m[2], { title: m[3], star: m[1] === '*' });
    }
  }

  /** Estilo de página del documento: el de la clase, `\pagestyle{...}` y lo que configure fancyhdr. */
  private readFurniture(text: string): void {
    // el estilo de partida es el del preámbulo; un \pagestyle del cuerpo vale desde su hoja (lo aplica
    // el reparto en hojas) y, dentro de un entorno, solo en él. El aspecto de «fancy» se lee aunque
    // el documento solo lo active más adelante
    let style = '';
    for (const m of text.split('\\begin{document}')[0].matchAll(/\\pagestyle\s*\{([a-z]+)\}/g)) style = m[1];
    const fancy = /\\pagestyle\s*\{fancy\}/.test(text);
    const html = (tex: string): string =>
      this.plain(
        tex
          // (con el {} que se pone detrás para que no se coman el espacio siguiente)
          .replace(/\\thepage(?![a-zA-Z])(?:\{\})?/g, PAGE_MARK)
          .replace(/\\pageref\*?\s*\{(?:LastPage|lastpage|TotPages)\}/g, '\u0002LAST\u0002')
          .replace(/\\leftmark(?![a-zA-Z])(?:\{\})?/g, '\u0002LM\u0002')
          .replace(/\\rightmark(?![a-zA-Z])(?:\{\})?/g, '\u0002RM\u0002'),
      ).trim();
    const none = (): [string, string, string] => ['', '', ''];
    if (style === 'empty') this.furniture = { style: 'empty', head: none(), foot: none(), headRule: false, footRule: false, src: { head: none(), foot: none() } };
    else if (style === 'headings' || style === 'myheadings') {
      const lm = style === 'headings';
      this.furniture = {
        style: 'headings', head: [lm ? '<i>\u0002LM\u0002</i>' : '', '', PAGE_MARK], foot: none(), headRule: false, footRule: false,
        src: { head: [lm ? '\\textit{\\leftmark}' : '', '', '\\thepage'], foot: none() },
      };
    }
    if (!fancy) return;
    const f = this.furniture;
    // fancyhdr: por defecto, los títulos en curso arriba, el número abajo y una raya bajo el encabezado
    if (style === 'fancy') f.style = 'fancy';
    f.head = ['<i>\u0002LM\u0002</i>', '', '<i>\u0002RM\u0002</i>'];
    f.foot = ['', PAGE_MARK, ''];
    f.src = { head: ['\\textit{\\leftmark}', '', '\\textit{\\rightmark}'], foot: ['', '\\thepage', ''] };
    f.headRule = true;
    const srcOf = (part: string[]): string[] => (part === f.head ? f.src.head : f.src.foot);
    const AT = 'LCR';
    for (const m of text.matchAll(/\\(fancyhf|fancyhead|fancyfoot|[lcr]head|[lcr]foot)(?![a-zA-Z])\s*(?:\[([^\]]*)\])?\s*(?=\{)/g)) {
      const g = readGroup(text, m.index + m[0].length);
      if (!g) continue;
      const short = /^([lcr])(head|foot)$/.exec(m[1]);
      const value = html(g.content);
      const raw = g.content.trim();
      if (short) {
        const part = short[2] === 'head' ? f.head : f.foot;
        part[AT.indexOf(short[1].toUpperCase())] = value;
        srcOf(part)[AT.indexOf(short[1].toUpperCase())] = raw;
        continue;
      }
      // [LE,RO]: lado (L, C, R) y, opcionalmente, páginas pares o impares (E, O) y encabezado o pie (H, F)
      const specs = (m[2] ?? '').split(',').map((x) => x.trim().toUpperCase()).filter(Boolean);
      for (const part of [...(m[1] !== 'fancyfoot' ? [f.head] : []), ...(m[1] !== 'fancyhead' ? [f.foot] : [])]) {
        const isHead = part === f.head;
        if (!specs.length) {
          part.fill(value);
          srcOf(part).fill(raw);
        }
        for (const sp of specs) {
          // el documento se ve a una cara: todas las hojas cuentan como impares
          if (sp.includes('E') && !sp.includes('O')) continue;
          if ((sp.includes('H') && !isHead) || (sp.includes('F') && isHead)) continue;
          const sides = [...sp].filter((ch) => AT.includes(ch));
          for (const ch of sides.length ? sides : [...AT]) {
            part[AT.indexOf(ch)] = value;
            srcOf(part)[AT.indexOf(ch)] = raw;
          }
        }
      }
    }
    const width = (name: string): number | undefined => {
      let last: string | undefined;
      for (const m of text.matchAll(new RegExp(`\\\\renewcommand\\*?\\s*\\{?\\s*\\\\${name}\\s*\\}?\\s*\\{([^}]*)\\}`, 'g'))) last = m[1];
      return last === undefined ? undefined : parseFloat(last) || 0;
    };
    f.headRule = (width('headrulewidth') ?? 0.4) > 0;
    f.footRule = (width('footrulewidth') ?? 0) > 0;
  }

  private resolve(html: string): string {
    if (!html.includes('\u0001')) return html;
    return html
      .replace(/\u0001TOC\u0001/g, () => this.tocHtml())
      .replace(/\u0001BIB\u0001/g, () => this.referencesHtml())
      .replace(/\u0001IDX\u0001/g, () => this.indexHtml())
      .replace(/\u0001LO([FT])\u0001/g, (_, k: string) => this.listOf(k === 'F' ? 'figure' : 'table'))
      .replace(/\u0001N([a-zA-Z])([^\u0001]*)\u0001/g, (_, mode: string, k: string) => this.namedRef(mode, decodeURIComponent(k).split(',').map((x) => x.trim()).filter(Boolean)))
      .replace(/\u0001([RC])([^\u0001]*)\u0001/g, (_, kind: string, k: string) => {
        const key = decodeURIComponent(k);
        if (kind === 'R') return `<a class="ref" href="#lbl-${k}">${esc(this.labels.get(key) ?? '??')}</a>`;
        const n = this.bib.get(key);
        return n !== undefined ? `<a class="ref" href="#bib-${k}">${n}</a>` : esc(key);
      });
  }

  /** Tipo con que cleveref conoce lo que lleva una etiqueta, a partir de lo que era al ponerla. */
  private refType(kind: string): string {
    if (kind === 'subsection' || kind === 'subsubsection') return 'section';
    if (kind === 'subfigure') return 'figure';
    return THEOREM_TYPES[kind] ?? kind;
  }

  /**
   * Referencia con nombre. `mode`: «a» \autoref («Figura 3»), «c» y «C» \cref y \Cref (varias a la
   * vez: «figuras 1 y 2»), «r» \crefrange, «n» \nameref (el título) y «p» \pageref (la página, que
   * pone el editor al repartir el documento en hojas).
   */
  private namedRef(mode: string, keys: string[]): string {
    const link = (k: string, text: string, extra = ''): string => `<a class="ref${extra}" href="#lbl-${enc(k)}">${text}</a>`;
    const num = (k: string): string => esc(this.labels.get(k) ?? '??');
    if (mode === 'n') return keys.map((k) => link(k, this.labelTitles.get(k) || num(k))).join(', ');
    if (mode === 's') return keys.map((k) => link(k, `(${esc((this.labels.get(k) ?? '??').replace(/^[\dA-Z.]+(?=[a-z])/, ''))})`)).join(', ');
    if (mode === 'p') return keys.map((k) => `<a class="ref pageref" href="#lbl-${enc(k)}" data-ref="${enc(k)}">?</a>`).join(', ');
    const t = REF_NAMES[this.lang];
    const theorem = (kind: string): string | undefined => this.theorems.get(kind)?.title;
    const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);
    if (mode === 'a') {
      return keys
        .map((k) => {
          const kind = this.labelKinds.get(k) ?? '';
          const type = kind === 'item' ? 'enumi' : THEOREM_TYPES[kind] ?? kind;
          // el documento puede cambiar el nombre: \renewcommand{\figureautorefname}{Fig.}
          const own = this.macros.get(`${kind}autorefname`)?.body;
          const title = theorem(kind);
          const name = own !== undefined ? this.plain(own) : t.auto[type] ?? (title !== undefined ? this.plain(title) : t.cref[type] ? cap(t.cref[type][0]) : '');
          return link(k, `${name ? `${name}&nbsp;` : ''}${num(k)}`);
        })
        .join(', ');
    }
    // cleveref: las etiquetas seguidas del mismo tipo comparten nombre, en plural
    const big = mode === 'C' || mode === 'R';
    const range = mode === 'r' || mode === 'R';
    const upper = big || /capitali[sz]e/.test(this.packages.get('cleveref') ?? '');
    const abbreviate = !big && !/noabbrev/.test(this.packages.get('cleveref') ?? '');
    const groups: { type: string; kind: string; keys: string[] }[] = [];
    for (const k of keys) {
      const kind = this.labelKinds.get(k) ?? '';
      const type = this.refType(kind === 'item' ? 'enumi' : kind);
      const last = groups[groups.length - 1];
      if (last && last.type === type) last.keys.push(k);
      else groups.push({ type, kind, keys: [k] });
    }
    const one = (k: string, type: string): string => link(k, type === 'equation' ? `(${num(k)})` : num(k));
    const parts = groups.map((g) => {
      const plural = g.keys.length > 1 ? 1 : 0;
      const own = this.crefNames.get(g.type) ?? this.crefNames.get(g.kind);
      let name = own?.[big ? plural + 2 : plural] ?? own?.[plural];
      if (name === undefined) {
        const std = (abbreviate ? t.abbrev[g.type] : undefined) ?? t.cref[g.type];
        // un teorema con nombre propio (\newtheorem{teo}{Teorema}) se cita con ese nombre
        const title = theorem(g.kind);
        name = std ? std[plural] : title !== undefined ? this.plain(title).toLowerCase() + (plural ? 's' : '') : '';
        if (upper) name = cap(name);
      } else name = this.plain(name);
      const list = g.keys.map((k) => one(k, g.type));
      const joined = range && list.length === 2 ? list.join(t.to) : list.length > 2 ? `${list.slice(0, -1).join(', ')}${t.and}${list[list.length - 1]}` : list.join(t.and);
      return `${name ? `${name}&nbsp;` : ''}${joined}`;
    });
    return parts.length > 2 ? `${parts.slice(0, -1).join(', ')}${t.and}${parts[parts.length - 1]}` : parts.join(t.and);
  }

  /** Índice de figuras o de tablas: el número y el título de cada una. */
  private listOf(type: 'figure' | 'table'): string {
    const en = this.lang === 'en';
    const title = type === 'figure' ? (en ? 'List of Figures' : 'Índice de figuras') : en ? 'List of Tables' : `Índice de ${this.L.table.toLowerCase()}s`;
    const items = this.captions.filter((x) => x.type === type).map((x) => `<div class="toc-item lof-item"><a href="#${x.id}"><span class="secnum">${x.num}</span>${x.html.replace(/ data-(o|c|tex)="[^"]*"/g, '').replace(/ id="[^"]*"/g, '')}</a><span class="toc-fill"></span><a class="toc-page" href="#${x.id}" data-page-of="${x.id}"></a></div>`);
    return `<div class="toc lof"><div class="toc-title"${this.listTitleStyle()}>${this.titleAt[type] || title}</div>${items.join('') || `<div class="note">${en ? 'No captions yet.' : 'Aparecerán aquí al poner título (\\caption) a las figuras y tablas.'}</div>`}</div>`;
  }

  /** Índice alfabético: los términos marcados con \index, ordenados (sin páginas: Mars no las fija). */
  private indexHtml(): string {
    const terms = [...new Set(this.indexTerms)].sort((a, b) => a.localeCompare(b, this.L.locale));
    const items = terms.map((t) => `<div class="idx-item">${this.plain(t)}</div>`).join('');
    const title = this.lang === 'en' ? 'Index' : 'Índice alfabético';
    return `<div class="bib-title">${title}</div><div class="idx">${items || '<div class="note">Sin términos marcados con \\index.</div>'}</div>`;
  }

  /** Lista de términos del glosario, por orden alfabético. */
  private glossaryHtml(title: string): string {
    const entries = [...this.glossary].sort((a, b) => a[1].name.localeCompare(b[1].name, this.L.locale));
    const items = entries.map(([key, e]) => `<dt id="gls-${enc(key)}">${this.plain(e.name)}</dt><dd>${this.plain(e.description)}</dd>`).join('');
    return `<div class="bib-title">${this.plain(title)}</div><dl class="glossary">${items}</dl>`;
  }

  /**
   * Pseudocódigo de `algorithmic` (algpseudocode, algorithmicx): una línea por orden, con la
   * sangría de los bloques que abren `\If`, `\For`, `\While`, `\Procedure`...
   */
  private algorithmic(body: string, numbered: boolean): string {
    const marks = [...body.matchAll(/\\(State|Statex|If|ElsIf|Else|EndIf|ForAll|For|EndFor|While|EndWhile|Repeat|Until|Loop|EndLoop|Procedure|EndProcedure|Function|EndFunction|Require|Ensure|Input|Output)(?![a-zA-Z])/g)];
    const lines: { depth: number; html: string; blank?: boolean }[] = [];
    let depth = 0;
    const kw = (t: string): string => `<b>${t}</b>`;
    // órdenes que van dentro de una línea
    const within = (text: string): string => {
      let out = '';
      let p = 0;
      const re = /\\(Call|Comment|Return)(?![a-zA-Z])/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        out += text.slice(p, m.index);
        const c = new Cursor(text, m.index + m[0].length);
        if (m[1] === 'Call') out += `\\textsc{${c.arg()}}(${c.arg()})`;
        else if (m[1] === 'Comment') out += `\\hfill\\textit{$\\triangleright$ ${c.arg()}}`;
        else out += '\\textbf{return} ';
        p = c.p;
        re.lastIndex = p;
      }
      return this.plain((out + text.slice(p)).trim());
    };
    marks.forEach((m, k) => {
      const c = new Cursor(body, m.index + m[0].length);
      const end = k + 1 < marks.length ? marks[k + 1].index : body.length;
      const rest = (): string => within(body.slice(c.p, end));
      const push = (html: string, blank = false): void => void lines.push({ depth, html, blank });
      switch (m[1]) {
        case 'State': push(rest()); break;
        case 'Statex': push(rest(), true); break;
        case 'Require': push(`${kw('Require:')} ${rest()}`, true); break;
        case 'Ensure': push(`${kw('Ensure:')} ${rest()}`, true); break;
        case 'Input': push(`${kw('Input:')} ${rest()}`, true); break;
        case 'Output': push(`${kw('Output:')} ${rest()}`, true); break;
        case 'If': push(`${kw('if')} ${within(c.arg())} ${kw('then')} ${rest()}`); depth++; break;
        case 'ElsIf': depth = Math.max(depth - 1, 0); push(`${kw('else if')} ${within(c.arg())} ${kw('then')} ${rest()}`); depth++; break;
        case 'Else': depth = Math.max(depth - 1, 0); push(`${kw('else')} ${rest()}`); depth++; break;
        case 'For': case 'ForAll': push(`${kw(m[1] === 'For' ? 'for' : 'for all')} ${within(c.arg())} ${kw('do')} ${rest()}`); depth++; break;
        case 'While': push(`${kw('while')} ${within(c.arg())} ${kw('do')} ${rest()}`); depth++; break;
        case 'Repeat': push(kw('repeat')); depth++; break;
        case 'Until': depth = Math.max(depth - 1, 0); push(`${kw('until')} ${within(c.arg())}`); break;
        case 'Loop': push(kw('loop')); depth++; break;
        case 'Procedure': case 'Function': {
          const name = c.arg();
          push(`${kw(m[1].toLowerCase())} ${this.plain(`\\textsc{${name}}`)}(${within(c.arg())})`);
          depth++;
          break;
        }
        default:
          // \EndIf, \EndFor, \EndWhile, \EndLoop, \EndProcedure, \EndFunction
          depth = Math.max(depth - 1, 0);
          push(kw(`end ${m[1].slice(3).toLowerCase()}`));
      }
    });
    let n = 0;
    const rows = lines.map((l) => `<div class="algo-line" style="--d:${l.depth}"><span class="algo-n">${numbered && !l.blank ? `${++n}:` : ''}</span><span>${l.html}</span></div>`);
    return `<div class="algo">${rows.join('')}</div>`;
  }

  /**
   * Pseudocódigo de algorithm2e: cada línea acaba en «\;» y los bloques (\If, \While, \For...) llevan
   * su contenido entre llaves. Con la opción `spanish` del paquete, las palabras clave van en español.
   */
  private algorithm2e(body: string): string {
    const options = this.packages.get('algorithm2e') ?? '';
    const K = ALGO2E[/\bspanish\b/.test(options) ? 'es' : 'en'];
    const semicolon = !/\\DontPrintSemicolon\b/.test(body) && !this.dontPrintSemicolon;
    const numbered = /\\LinesNumbered\b/.test(body) || /linesnumbered/.test(options);
    const lines: { depth: number; html: string; blank?: boolean }[] = [];
    const kw = (t: string): string => `<b>${t}</b>`;
    /**
     * Palabras que van dentro de una línea: \Return, \KwTo y las que nombra el documento con \SetKw
     * (en negrita), \SetKwFunction (nombre y argumentos) y \SetKwData.
     */
    const words = (t: string): string =>
      t.replace(/\\([a-zA-Z]+)(?![a-zA-Z])(\s*\{(?:[^{}]|\{[^{}]*\})*\})?/g, (all: string, name: string, g: string | undefined) => {
        const arg = g === undefined ? undefined : words(g.trim().slice(1, -1));
        if (name === 'Return' || name === 'KwRet') return `\\textbf{${K.return}} ${arg ?? ''}`;
        if (name === 'KwTo') return `\\textbf{${K.to}} ${g ?? ''}`;
        const own = this.algoWords.get(name);
        if (!own || own.kind === 'Prog' || own.kind === 'Input' || own.kind === 'InOut') return all;
        if (own.kind === 'Function') return `\\texttt{${own.text}}(${arg ?? ''})`;
        if (own.kind === 'Data' || own.kind === 'Array') return `\\textsf{${own.text}}${arg === undefined ? '' : own.kind === 'Array' ? `[${arg}]` : `(${arg})`}`;
        return `\\textbf{${own.text}} ${arg ?? ''}`;
      });
    const draw = (t: string): string => this.plain(words(t));
    /** una instrucción escrita dentro de otra orden (\lIf{...}{x \gets 1}): sin su «\;» */
    const stmt = (t: string): string => draw(t.replace(/\\;/g, '').trim()) + (semicolon ? ';' : '');
    const walk = (text: string, depth: number): void => {
      const c = new Cursor(text, 0);
      let cur = '';
      const flush = (end = false): void => {
        const t = cur.trim();
        cur = '';
        if (!t) return;
        const html = draw(t);
        // lo que no dibuja nada (una etiqueta) no es una línea: se queda con la anterior
        if (html.replace(HIDDEN_ATOM, '').trim()) lines.push({ depth, html: html + (end && semicolon ? ';' : '') });
        else if (lines.length) lines[lines.length - 1].html += html;
        else lines.push({ depth, html, blank: true });
      };
      /** bloque con cabecera: su contenido va sangrado y, si lo lleva, se cierra con «end» */
      const block = (head: string, inner: string, end: string | undefined): void => {
        flush();
        lines.push({ depth, html: head });
        walk(inner, depth + 1);
        if (end) lines.push({ depth, html: kw(end) });
      };
      while (c.p < text.length) {
        const ch = text[c.p];
        if (ch === '$') {
          // una fórmula va entera a su línea
          let j = c.p + 1;
          while (j < text.length && text[j] !== '$') j += text[j] === '\\' ? 2 : 1;
          cur += text.slice(c.p, j + 1);
          c.p = j + 1;
          continue;
        }
        if (ch === '{') {
          const g = readGroup(text, c.p);
          if (g) {
            cur += text.slice(c.p, g.end);
            c.p = g.end;
            continue;
          }
        }
        if (ch !== '\\') {
          cur += ch === '\n' ? ' ' : ch;
          c.p++;
          continue;
        }
        if (text[c.p + 1] === ';' || text[c.p + 1] === '\\') {
          flush(text[c.p + 1] === ';');
          c.p += 2;
          continue;
        }
        const m = /^\\([a-zA-Z]+)(\*?)/.exec(text.slice(c.p, c.p + 40));
        if (!m) {
          cur += text.slice(c.p, c.p + 2);
          c.p += 2;
          continue;
        }
        const at = c.p;
        const name = m[1];
        c.p += m[0].length;
        // en una sola línea (\lIf, \lFor...), sin «end» (\uIf, \uElse...) o completo
        const short = /^l[A-Z]/.test(name);
        const open = /^u[A-Z]/.test(name);
        const core = short || open ? name.slice(1) : name;
        const own = this.algoWords.get(name);
        const key = ALGO2E_BLOCKS.get(core);
        const word = key ? K[key] : undefined;
        const tail = core === 'If' || core === 'ElseIf' ? K.then : K.do;
        if (word !== undefined) {
          // \If{condición}{bloque}, \For{...}{...}, \While{...}{...}, \Switch{...}{...}, \Case{...}{...}
          const head = `${kw(word)} ${draw(c.arg())} ${kw(tail)}`;
          const inner = c.arg();
          if (short) {
            flush();
            lines.push({ depth, html: `${head} ${stmt(inner)}` });
          } else block(head, inner, open ? undefined : K.end);
        } else if (name === 'eIf') {
          // \eIf{condición}{si se cumple}{si no}
          const head = `${kw(K.if)} ${draw(c.arg())} ${kw(K.then)}`;
          block(head, c.arg(), undefined);
          block(kw(K.else), c.arg(), K.end);
        } else if (core === 'Else' || core === 'Other' || name === 'Begin') {
          const head = kw(core === 'Else' ? K.else : core === 'Other' ? K.other : K.begin);
          const inner = c.arg();
          if (short) {
            flush();
            lines.push({ depth, html: `${head} ${stmt(inner)}` });
          } else block(head, inner, open ? undefined : K.end);
        } else if (name === 'Repeat') {
          // \Repeat{condición}{bloque}: la condición se escribe al final
          const cond = draw(c.arg());
          block(kw(K.repeat), c.arg(), undefined);
          lines.push({ depth, html: `${kw(K.until)} ${cond}${semicolon ? ';' : ''}` });
        } else if (/^Kw(In|Out|Data|Result)$/.test(name) || own?.kind === 'Input' || own?.kind === 'InOut') {
          // datos de entrada y de salida, cada uno con su rótulo
          flush();
          const label = own?.text ?? { KwIn: K.in, KwOut: K.out, KwData: K.data, KwResult: K.result }[name as 'KwIn'] ?? name;
          lines.push({ depth, html: `${kw(`${this.plain(label)}:`)} ${draw(c.arg())}`, blank: true });
        } else if (name === 'tcc' || name === 'tcp') {
          // comentario: en su línea o, con asterisco, al final de la que está escrita
          const note = this.plain(c.arg());
          const html = `<span class="algo-cmt">${name === 'tcc' ? `/* ${note} */` : `// ${note}`}</span>`;
          if (m[2] && cur.trim()) {
            const before = draw(cur.trim()) + (semicolon ? ';' : '');
            cur = '';
            lines.push({ depth, html: `${before} <span class="hfill"></span>${html}` });
          } else {
            flush();
            lines.push({ depth, html, blank: true });
          }
        } else if (name === 'BlankLine') {
          flush();
          lines.push({ depth, html: '&nbsp;', blank: true });
        } else if (name === 'Indp' || name === 'Indm') {
          flush();
          depth = Math.max(depth + (name === 'Indp' ? 1 : -1), 0);
        } else if (own?.kind === 'Prog') {
          // \SetKwProg{Fn}{Function}{:}{end}: \Fn{nombre(argumentos)}{cuerpo}
          const head = `${kw(this.plain(own.text))} ${draw(c.arg())}`;
          block(head, c.arg(), K.end);
        } else if (/^(Set[A-Z]|DontPrintSemicolon$|PrintSemicolon$|LinesNumbered$|LinesNotNumbered$|RestyleAlgo$|IncMargin$|DecMargin$|nl$|nllabel$|NoCaptionOfAlgo$|TitleOfAlgo$)/.test(name)) {
          // ajustes de composición del paquete: no dibujan nada
          while (c.group() !== undefined) { /* consumir argumentos */ }
        } else cur += text.slice(at, c.p);
      }
      flush();
    };
    walk(body, 0);
    let n = 0;
    const rows = lines.map((l) => `<div class="algo-line" style="--d:${l.depth}"><span class="algo-n">${numbered && !l.blank ? `${++n}` : ''}</span><span>${l.html}</span></div>`);
    return `<div class="algo">${rows.join('')}</div>`;
  }

  private tocHtml(): string {
    const dot = this.secDot ? '.' : '';
    // el nivel más alto (el capítulo, o la sección si no hay capítulos) va en negrita y sin puntos guía
    const top = this.hasChapter ? 0 : 1;
    const items = this.toc
      .map((t) => {
        const title = t.title.replace(/ data-(o|c|tex)="[^"]*"/g, '');
        // la página la pone el editor al repartir el documento en hojas, igual que la de \pageref
        return (
          `<div class="toc-item toc-l${Math.max(t.level - top, 0) + 1}"><a href="#${t.id}">${t.num ? `<span class="secnum">${t.num}${dot}</span>` : ''}${title}</a>` +
          `<span class="toc-fill"></span><a class="toc-page" href="#${t.id}" data-page-of="${t.id}"></a></div>`
        );
      })
      .join('');
    return `<div class="toc"><div class="toc-title"${this.listTitleStyle()}>${this.titleAt.toc ?? this.L.contents}</div>${items}</div>`;
  }

  /**
   * Formato del título de un índice o de la bibliografía: es un título de capítulo (o de sección, en
   * un artículo), así que toma el tamaño y el centrado que titlesec le dé.
   */
  private listTitleStyle(): string {
    const f = (this.bookish ? this.heads.chapter : this.heads.section) ?? {};
    const css = [f.size ? `font-size:${f.size}em` : '', f.center ? 'text-align:center' : '', f.color ? `color:${f.color}` : ''].filter(Boolean).join(';');
    return css ? ` style="${css}"` : '';
  }

  // -------------------------------------------------- matemáticas

  private math(tex: string, display: boolean): string {
    tex = tex
      .replace(/\\label\s*\{[^}]*\}/g, '')
      .replace(/\\eqref\s*\{([^}]*)\}/g, (_, k: string) => `(\\text{${this.labels.get(k.trim()) ?? '??'}})`)
      .replace(/\\ref\s*\{([^}]*)\}/g, (_, k: string) => `\\text{${this.labels.get(k.trim()) ?? '??'}}`)
      .replace(/\\mbox\b/g, '\\text');
    const key = (display ? 'D' : 'I') + this.kmKey + tex;
    let html = mathCache.get(key);
    if (html === undefined) {
      try {
        // siunitx, physics y la coma decimal del español se pasan a LaTeX corriente; lo que define el documento manda
        const ready = prepareMath(tex, this.mathCtx, (name) => this.kmacros[`\\${name}`] !== undefined);
        html = katex.renderToString(ready, {
          displayMode: display, throwOnError: false, strict: 'ignore', output: 'html', trust: false,
          macros: { ...this.xmacros, ...this.kmacros },
        });
      } catch {
        html = `<span class="tex-error">${esc(tex)}</span>`;
      }
      if (mathCache.size > 5000) mathCache.clear();
      mathCache.set(key, html);
    }
    return html;
  }

  private mathEnv(base: string, star: boolean, src: string, body: string): string {
    let anchors = '';
    const number = (row: string): string => {
      let label: string | undefined;
      row = row.replace(/\\label\s*\{([^}]*)\}/g, (_, k: string) => {
        label = k.trim();
        return '';
      });
      const no = /\\(nonumber|notag)\b/.test(row);
      row = row.replace(/\\(nonumber|notag)\b/g, '');
      if (!star && !no && !/\\tag\b/.test(row) && row.trim()) {
        // dentro de subequations todas comparten número y se distinguen con una letra: (2a), (2b)
        this.current = this.subEq ? this.subEq.base + String.fromCharCode(96 + ++this.subEq.n) : this.numbered('equation', ++this.eq);
        this.currentKind = 'equation';
        row += ` \\tag{${this.current}}`;
      }
      if (label) {
        this.setLabel(label, 'equation');
        anchors += `<a id="lbl-${enc(label)}"></a>`;
      }
      return row;
    };
    const rows = (b: string): string => splitTop(b, '\\\\').map(number).join(' \\\\ ');
    let tex = '';
    let display = true;
    /** entorno de varias filas: su nombre en KaTeX y lo que lleva delante de la primera */
    let multi: { env: string; pre: string; body: string } | undefined;
    switch (base) {
      case 'math':
        display = false;
        tex = body;
        break;
      case 'displaymath':
        tex = body;
        break;
      case 'equation':
        tex = number(body);
        break;
      case 'multline':
        tex = `\\begin{gather*}${number(body)}\\end{gather*}`;
        break;
      case 'eqnarray':
        multi = { env: 'align*', pre: '', body: body.replace(/&([^&\\]*)&/g, '&$1') };
        break;
      case 'alignat': {
        const g = readGroup(body, skipWs(body, 0));
        multi = { env: 'alignat*', pre: g ? `{${g.content}}` : '', body: g ? body.slice(g.end) : body };
        break;
      }
      case 'gather':
        multi = { env: 'gather*', pre: '', body };
        break;
      default:
        multi = { env: 'align*', pre: '', body };
    }
    if (multi) {
      const { env, pre } = multi;
      const build = (b: string): string => `\\begin{${env}}${pre}${rows(b)}\\end{${env}}`;
      // \intertext{...}: un texto entre dos filas. KaTeX no lo tiene: la ecuación se parte ahí
      const parts = intertext(multi.body);
      if (parts.length > 1) {
        const html = parts.map((p) => (p.text !== undefined ? `<div class="intertext">${this.plain(p.text)}</div>` : p.math.trim() ? this.math(build(p.math), true) : '')).join('');
        return atom(src, anchors + html, 'math', true);
      }
      tex = build(multi.body);
    }
    return atom(src, anchors + this.math(tex, display), 'math', display);
  }

  /** Anota una etiqueta: el número que le toca, qué numera y cómo se titula. */
  private setLabel(key: string, kind = this.currentKind): void {
    this.labels.set(key, this.current);
    this.labelKinds.set(key, kind);
    this.labelTitles.set(key, this.currentTitle);
  }

  /** Lo último numerado: a eso se referirá la próxima etiqueta. */
  private setCurrent(num: string, kind: string, title = ''): void {
    this.current = num;
    this.currentKind = kind;
    this.currentTitle = title;
  }

  /** Número de un flotante: el de su título o, si aún no lo ha puesto, el que le tocará. */
  private floatNumber(f: { type: 'figure' | 'table' | 'listing'; num?: string }): string {
    if (f.num !== undefined) return f.num;
    return f.type === 'listing' ? String(this.listings + 1) : this.numbered(f.type, (f.type === 'table' ? this.tab : this.fig) + 1);
  }

  /** Título y etiqueta que un listado de código lleva en sus opciones (`caption=`, `label=`). */
  private listingCaption(options: string): string {
    const o = keyValues(options);
    if (o.caption === undefined && o.label === undefined) return '';
    const n = String(++this.listings);
    // con [título corto]{título largo}, se dibuja el largo
    const text = (o.caption ?? '').replace(/^\[[^\]]*\]\s*/, '').replace(/^\{([\s\S]*)\}$/, '$1');
    this.setCurrent(n, 'listing', text);
    let anchor = '';
    if (o.label) {
      this.setLabel(o.label);
      anchor = `<a id="lbl-${enc(o.label)}"></a>`;
    }
    return o.caption === undefined ? anchor : `${anchor}<div class="lst-cap"><b>${this.L.listing} ${n}:</b> ${this.plain(text)}</div>`;
  }

  /** Lista de siglas: la sigla y lo que significa. */
  private acronymsHtml(list: [string, { short: string; long: string }][], title?: string): string {
    const items = list.map(([key, e]) => `<dt id="acr-${enc(key)}">${this.plain(e.short)}</dt><dd>${this.plain(e.long)}</dd>`).join('');
    return `${title ? `<div class="bib-title">${this.plain(title)}</div>` : ''}<dl class="glossary">${items}</dl>`;
  }

  // -------------------------------------------------- texto en línea

  private inline(s: string): string {
    this.depth++;
    try {
      return this.inline0(s);
    } finally {
      this.depth--;
    }
  }

  private inline0(s: string): string {
    const top = this.depth === 1;
    const n = s.length;
    let out = '';
    let i = 0;
    while (i < n) {
      PLAIN.lastIndex = i;
      const pm = PLAIN.exec(s);
      if (pm) {
        if (top && !this.rich && /\S/.test(pm[0])) this.rich = true;
        out += pm[0];
        i += pm[0].length;
        continue;
      }
      const c = s[i];
      if (c === '\\') {
        const r = this.command(s, i);
        const src = s.slice(i, r.end);
        if (r.decl) {
          if (top) this.rich = true;
          const rest = s.slice(r.end);
          let attrs = r.decl[1];
          // Un cambio de tamaño solo cambia el interlineado si el párrafo termina dentro del grupo
          // (con \par o una línea en blanco); si no, la línea conserva el del texto que la rodea.
          if (attrs.includes('font-size:')) {
            const ownSpacing = /\\par(?![a-zA-Z])|\n[ \t]*\n/.test(rest);
            attrs = attrs.replace('font-size:', `line-height:${ownSpacing ? 1.2 : 0.95};font-size:`);
          }
          return out + atom(src, '') + wrap(r.decl[0], '', '', this.inline(rest), attrs);
        }
        if (r.pre) {
          if (r.rich && top) this.rich = true;
          out += r.html;
        } else out += atom(src, r.html, r.cls ?? '', r.block);
        i = r.end;
      } else if (c === '{') {
        const g = readGroup(s, i);
        if (g) {
          if (top) this.rich = true;
          out += wrap('span', '{', '}', this.inline(g.content));
          i = g.end;
        } else i++;
      } else if (c === '}') {
        i++;
      } else if (c === '$') {
        const dbl = s[i + 1] === '$';
        let close = -1;
        if (dbl) close = s.indexOf('$$', i + 2);
        else {
          for (let j = i + 1; j < n; j++) {
            if (s[j] === '\\') j++;
            else if (s[j] === '$') {
              close = j;
              break;
            }
          }
        }
        if (close < 0) {
          out += '$';
          i++;
        } else {
          const w = dbl ? 2 : 1;
          out += atom(s.slice(i, close + w), this.math(s.slice(i + w, close), dbl), 'math', dbl);
          i = close + w;
        }
      } else if (c === '%') {
        let end = s.indexOf('\n', i);
        if (end < 0) end = n;
        else if (i > 0 && !/\s/.test(s[i - 1])) {
          // un comentario pegado al texto también se come el salto de línea
          let k = end + 1;
          while (s[k] === ' ' || s[k] === '\t') k++;
          if (s[k] !== '\n') end = k;
        }
        out += atom(s.slice(i, end), '');
        i = end;
      } else if (c === '\n') {
        BLANK.lastIndex = i;
        const bm = BLANK.exec(s);
        if (bm) {
          out += atom(bm[0], '<span class="parbreak"></span>', 'pb');
          i += bm[0].length;
        } else {
          out += '\n';
          i++;
        }
      } else if (c === '~') {
        out += atom('~', '&nbsp;');
        i++;
      } else if (c === '-') {
        if (s.startsWith('---', i)) {
          out += '—';
          i += 3;
        } else if (s[i + 1] === '-') {
          out += '–';
          i += 2;
        } else {
          out += '-';
          i++;
        }
      } else if (c === '`') {
        if (s[i + 1] === '`') {
          out += '“';
          i += 2;
        } else {
          out += '‘';
          i++;
        }
      } else if (c === "'") {
        if (s[i + 1] === "'") {
          out += '”';
          i += 2;
        } else {
          out += '’';
          i++;
        }
      } else if ((c === '?' || c === '!') && s[i + 1] === '`') {
        out += c === '?' ? '¿' : '¡';
        i += 2;
      } else if ((c === '<' || c === '>') && s[i + 1] === c && this.guillemets) {
        // comillas latinas: las pone babel en español (y la codificación T1) al escribir «<<» y «>>»
        if (top) this.rich = true;
        out += atom(c + c, c === '<' ? '«' : '»');
        i += 2;
      } else {
        if (top) this.rich = true;
        out += esc(c);
        i++;
      }
    }
    return out;
  }

  private symbol(s: string, i: number, ch: string): Cmd {
    const end = i + 2;
    switch (ch) {
      case '\\': {
        let p = end;
        if (s[p] === '*') p++;
        let q = p;
        while (s[q] === ' ' || s[q] === '\t') q++;
        const b = readBracket(s, q);
        if (!b) return { html: '<br>', end: p };
        // \\[10pt]: salto de línea con espacio de más debajo
        const gap = this.len(b.content, 'y');
        return { html: `<br>${gap ? `<span class="vskip" style="height:${gap}"></span>` : ''}`, end: b.end };
      }
      case '(': {
        const j = s.indexOf('\\)', end);
        if (j < 0) return { html: '', end };
        return { html: this.math(s.slice(end, j), false), end: j + 2, cls: 'math' };
      }
      case '[': {
        const j = s.indexOf('\\]', end);
        if (j < 0) return { html: '', end };
        return { html: this.math(s.slice(end, j), true), end: j + 2, cls: 'math', block: true };
      }
      case ',':
        return { html: ' ', end };
      case ';': case ':': case ' ': case '\n': case '\t':
        return { html: ' ', end };
      case '!': case '-': case '/': case '@':
        return { html: '', end };
      case '%': case '&': case '$': case '#': case '_':
        // se muestran como texto normal; el serializador los vuelve a escapar
        return { html: esc(ch), end, pre: true, rich: true };
      default:
        if (ACCENT[ch]) return this.accent(new Cursor(s, end), ACCENT[ch]);
        return { html: esc(ch), end };
    }
  }

  private accent(c: Cursor, comb: string): Cmd {
    let a = c.arg();
    if (a === '\\i') a = 'i';
    else if (a === '\\j') a = 'j';
    const html = a ? esc((a[0] + comb).normalize('NFC') + a.slice(1)) : '';
    return { html, end: c.p };
  }

  private command(s: string, i: number): Cmd {
    const ch = s[i + 1];
    if (ch === undefined) return { html: '', end: i + 1 };
    if (!/[a-zA-Z]/.test(ch)) return this.symbol(s, i, ch);
    NAME.lastIndex = i + 1;
    const name = NAME.exec(s)![0];
    const c = new Cursor(s, i + 1 + name.length);
    let star = false;
    if (s[c.p] === '*') {
      star = true;
      c.p++;
    }
    // presentaciones: \only<2>{...}, \textbf<3>{...}, \includegraphics<1->{...}. En qué capa sale cada cosa no se dibuja
    if (s[c.p] === '<' && this.docClass === 'beamer') c.p += /^<[^<>{}\\\n]*>/.exec(s.slice(c.p, c.p + 40))?.[0].length ?? 0;
    const done = (html: string, block = false, cls = ''): Cmd => ({ html, end: c.p, block, cls });
    const pre = (html: string, rich = true): Cmd => ({ html, end: c.p, pre: true, rich });
    /** Envoltorio editable alrededor del siguiente argumento entre llaves. */
    const edit = (tag: string, attrs = '', before = ''): Cmd => {
      const a = c.group();
      if (a === undefined) return done('');
      return pre(wrap(tag, s.slice(i, c.p - a.length - 1), '}', before + this.inline(a), attrs));
    };

    // condicionales e interruptores del documento: se dibuja la rama que LaTeX usaría
    if (this.cond.handles(name)) {
      const r = this.cond.at(s, i);
      if (r) {
        c.p = r.end;
        if (!r.text.trim()) return done('');
        const block = /\n[ \t]*\n|\\begin\s*\{|\\(?:part|chapter|section|subsection)\b/.test(r.text);
        return done(this.plain(r.text), block);
      }
    }
    const state = this.stateful(name, c);
    if (state !== undefined) return done(state);

    if (STYLE[name]) return edit(STYLE[name][0], STYLE[name][1]);
    if (DECL[name]) {
      c.ws();
      return { html: '', end: c.p, decl: DECL[name] };
    }
    // (un símbolo que el documento redefine vale lo que diga su definición)
    if (Object.prototype.hasOwnProperty.call(SYMBOL, name) && !this.macros.has(name)) {
      c.ws();
      return done(SYMBOL[name]);
    }
    if (LEVEL[name] !== undefined) return this.section(name, star, c, s, i);
    if (name === 'renewcommand' || name === 'def' || name === 'providecommand' || name === 'newcommand') {
      // «\renewcommand{\chaptername}{ANEXO}» en mitad del documento: el nombre cambia desde aquí
      const target = /^\s*\{?\s*\\([a-zA-Z]+)\s*\}?\s*(?=\{)/.exec(s.slice(c.p, c.p + 80));
      const key = target && Object.prototype.hasOwnProperty.call(NAME_KEYS, target[1]) ? NAME_KEYS[target[1]] : undefined;
      const body = target && key ? readGroup(s, c.p + target[0].length) : undefined;
      // (la lista de referencias se titula con \bibname en informes y libros, y con \refname en artículos)
      if (target && key && body && (key !== 'refs' || (target[1] === 'bibname') === this.bookish)) this.L = { ...this.L, [key]: this.plain(body.content) };
    }
    if (SWALLOW_ALL.has(name)) {
      c.ws();
      if (s[c.p] === '\\') c.arg();
      while (c.group() !== undefined || c.opt() !== undefined) { /* consumir */ }
      return done('');
    }

    // siunitx: números y unidades, compuestos como dentro de una fórmula
    if (Object.prototype.hasOwnProperty.call(SI_COMMANDS, name) && !this.macros.has(name)) {
      const from = c.p;
      c.opt();
      let ok = true;
      for (let k = 0; k < SI_COMMANDS[name] && ok; k++) {
        // \SI{número}[unidad delante]{unidad}
        if (name === 'SI' && k === 1) c.opt();
        ok = c.group() !== undefined;
      }
      if (ok) return done(this.math(s.slice(i, c.p), false), false, 'math');
      c.p = from;
    }

    switch (name) {
      case 'begin': {
        const envName = c.arg();
        const f = this.findEnd(s, c.p, envName);
        const r = this.environment(envName, s.slice(i, f.end), s.slice(c.p, f.bodyEnd), f.closed);
        c.p = f.end;
        return pre(r.html, r.rich);
      }
      case 'end':
        c.group();
        return done('');
      case 'maketitle':
        return done(this.titleHtml(), true, 'titleblock');
      case 'titlepage':
        // en una presentación, \titlepage (o \frame{\titlepage}) dibuja la diapositiva de título
        c.ws();
        return this.docClass === 'beamer' ? done(this.titleHtml(), true, 'titleblock') : done('');
      case 'MarsComputed': {
        // lo pone el intérprete de macros donde el documento escribe algo que solo se sabe al compilar
        const what = c.arg();
        const label = what === 'Lua' ? 'resultado de Lua' : `\\${what}`;
        return done(`<span class="tex-computed" title="LaTeX calcula este contenido al compilar (${what === 'Lua' ? 'código Lua' : 'expl3'}); Mars no ejecuta ese código">${esc(label)}</span>`);
      }
      case 'definecolor': case 'providecolor': case 'colorlet': {
        // un color definido (o cambiado) en mitad del documento vale desde aquí
        c.opt();
        const id = c.arg().trim();
        const second = c.arg();
        const rgb = name === 'colorlet' ? namedColor(second) : modelColor(second.trim(), c.arg());
        if (rgb) userColors.set(id, rgb);
        return done('');
      }
      // ---- partes del documento
      case 'appendix':
        c.ws();
        this.startAppendix();
        return done('');
      case 'frontmatter': case 'mainmatter': case 'backmatter': {
        // libro: lo de antes del cuerpo se pagina en romanos, y sus capítulos (como los del final) van sin número
        this.matter = name === 'frontmatter' ? 'front' : name === 'mainmatter' ? 'main' : 'back';
        if (name === 'backmatter') {
          c.ws();
          return done('');
        }
        return pre(atom(s.slice(i, c.p), '', '', false, ` data-pagenum="${name === 'frontmatter' ? 'roman' : 'arabic'}"`), false);
      }
      case 'addcontentsline': {
        // entrada puesta a mano en el índice (la de un título sin número, por ejemplo)
        const file = c.arg().trim();
        const kind = c.arg().trim();
        const title = c.arg().replace(/\\protect(?![a-zA-Z])/g, '');
        const level = Object.prototype.hasOwnProperty.call(LEVEL, kind) ? LEVEL[kind] : undefined;
        if (file === 'toc' && level !== undefined && level <= (this.counters.get('tocdepth') ?? 3)) {
          const numbered = /^\s*\\numberline\s*(?=\{)/.exec(title);
          const g = numbered ? readGroup(title, numbered[0].length) : undefined;
          const num = g ? this.plain(g.content).replace(/<[^>]*>/g, '').trim() : '';
          // la entrada apunta a este mismo sitio: su página es la de la hoja donde cae esta orden
          const id = `toc-${++this.tocAnchors}`;
          this.toc.push({ level: Math.max(level, 0), num, title: this.plain(g ? title.slice(g.end) : title), id });
          return pre(atom(s.slice(i, c.p), '', 'anc', false, ` id="${id}"`), false);
        }
        return done('');
      }
      // ---- interlineado desde aquí (setspace): vale para lo que sigue, hasta la próxima orden
      case 'singlespacing': case 'onehalfspacing': case 'doublespacing': case 'setstretch': {
        const factor = name === 'setstretch' ? parseFloat(c.arg()) || 1 : 1;
        if (name !== 'setstretch') c.ws();
        // (dentro de un grupo o de otra orden solo afectaría a ese tramo: ahí no se sigue)
        if (this.depth === 1) this.stretch = name === 'setstretch' ? lineHeightFor(this.basePt, '1') * factor : lineHeightFor(this.basePt, name === 'singlespacing' ? '1' : name === 'onehalfspacing' ? '1.5' : '2');
        return done('');
      }
      // ---- notas al pie con la llamada y el texto por separado (en tablas y títulos)
      case 'footnotemark': {
        const o = c.opt();
        if (o !== undefined) {
          const n = this.count(o);
          if (n === this.footnotes.length + 1) this.footnotes.push('');
          return done(`<sup class="fn">${n}</sup>`, false, 'fnote');
        }
        c.ws();
        this.footnotes.push('');
        this.pendingNotes.push(this.footnotes.length - 1);
        return done(`<sup class="fn">${this.footnotes.length}</sup>`, false, 'fnote');
      }
      case 'footnotetext': {
        const o = c.opt();
        const html = this.plain(c.arg());
        // sin número, es el texto de la llamada más antigua que aún no lo tiene
        const at = o !== undefined ? this.count(o) - 1 : this.pendingNotes.shift() ?? this.footnotes.length - 1;
        if (at >= 0 && at < this.footnotes.length) this.footnotes[at] = this.footnotes[at] ? `${this.footnotes[at]} ${html}` : html;
        else this.footnotes.push(html);
        return done('');
      }
      // ---- letras voladas, fracciones y adornos del texto
      case 'sptext':
        // abreviatura con letra volada del español: 1.er, 3.ª
        return done(`.<sup>${this.plain(c.arg())}</sup>`);
      case 'up': case 'ier': case 'iere': case 'ieme':
        if (this.macros.has(name)) break;
        return done(`<sup>${name === 'up' ? this.plain(c.arg()) : name === 'ier' ? 'er' : name === 'iere' ? 're' : 'e'}</sup>`);
      case 'nicefrac': case 'sfrac': case 'textfrac': case 'slashfrac': {
        if (this.macros.has(name)) break;
        c.opt();
        const a = this.plain(c.arg());
        c.opt();
        return done(`<span class="nicefrac"><sup>${a}</sup>⁄<sub>${this.plain(c.arg())}</sub></span>`);
      }
      case 'lettrine': {
        // letra capitular: la inicial a dos líneas y el resto de la palabra en versalitas
        c.opt();
        const a = this.plain(c.arg());
        return done(`<span class="dropcap">${a}</span><span class="sc">${this.plain(c.arg())}</span>`);
      }
      case 'hl': case 'ul': case 'st': case 'so': case 'caps': case 'uuline': case 'uwave': case 'xout': case 'dashuline': case 'dotuline':
        // resaltados y subrayados de soul y ulem
        if (this.macros.has(name)) break;
        return edit(DECOR[name][0], DECOR[name][1]);
      case 'textquote': case 'foreignquote': case 'hyphenquote': case 'foreigntextquote': case 'hyphentextquote':
        // csquotes: cita en línea, con las comillas del idioma
        if (/^(foreign|hyphen)/.test(name)) c.arg();
        if (name.endsWith('textquote')) {
          c.opt();
          c.opt();
        }
        return edit('span', ` class="enquote${this.lang === 'es' ? ' es' : ''}${star ? ' inner' : ''}"`);
      case 'blockquote': case 'foreignblockquote': case 'hyphenblockquote':
        if (name !== 'blockquote') c.arg();
        c.opt();
        c.opt();
        return edit('blockquote', '');
      // ---- siglas (paquetes acronym y acro)
      case 'ac': case 'Ac': case 'acs': case 'acl': case 'Acl': case 'acf': case 'Acf': case 'acp': case 'Acp': case 'acsp': case 'aclp': case 'acfp': case 'iac':
      case 'Iac': case 'acused': case 'acresetall': {
        if (this.macros.has(name)) break;
        if (name === 'acresetall') {
          c.ws();
          this.acUsed.clear();
          return done('');
        }
        const key = c.arg().trim();
        if (name === 'acused') {
          this.acUsed.add(key);
          return done('');
        }
        const term = this.glossary.get(key);
        const e = this.acronyms.get(key) ?? (term ? { short: term.name, long: term.description } : undefined);
        // (con otra clase además de la de las citas: no es una cita sin fuente, y no se avisa como tal)
        if (!e) return done(`<span class="cite-missing acr" title="Sigla sin definir">${esc(key)}?</span>`);
        // \acs la sigla, \acl el nombre completo, \acf los dos; \ac, los dos la primera vez y después solo la sigla
        const form = name.toLowerCase().replace(/^i/, '').replace(/^(ac[slf]?)p$/, '$1');
        const s2 = /^i?ac[slf]?p$/i.test(name) ? 's' : '';
        const first = !this.acUsed.has(key);
        if (form === 'ac' || form === 'acf') this.acUsed.add(key);
        const long = /^[AI]/.test(name) ? e.long.charAt(0).toUpperCase() + e.long.slice(1) : e.long;
        const text = form === 'acs' ? e.short + s2 : form === 'acl' ? long + s2 : form === 'acf' || first ? `${long}${s2} (${e.short}${s2})` : e.short + s2;
        return done(this.plain(text));
      }
      // ---- química (mhchem)
      case 'ce': case 'pu': {
        const a = this.macros.has(name) ? undefined : c.group();
        if (a === undefined) break;
        return done(this.math(`\\${name}{${a}}`, false), false, 'math');
      }
      // ---- pdfpages: las páginas de otro PDF, cada una en su hoja (se enseña la primera)
      case 'includepdf': {
        const o = c.opt() ?? '';
        const file = c.arg().trim();
        const pages = /(?:^|,)\s*pages\s*=\s*(\{[^}]*\}|[^,]*)/.exec(o)?.[1].replace(/[{}]/g, '').trim();
        const note = `${esc(file)}${pages && pages !== '1' ? ` · ${this.lang === 'es' ? 'páginas' : 'pages'} ${esc(pages)}` : ''}`;
        return done(`<div class="incpdf">${this.image('width=\\linewidth', file)}<div class="incpdf-note">${note}</div></div>`, true);
      }
      // ---- código traído de un archivo
      case 'lstinputlisting': case 'inputminted': case 'verbatiminput': {
        const o = c.opt() ?? '';
        if (name === 'inputminted') c.arg();
        const file = c.arg().trim();
        const code = this.opts.readInput?.(file);
        if (code === undefined) return done(`<div class="note">\\${name}{${esc(file)}}</div>`, true);
        return done(this.listingCaption(o) + `<pre><code>${esc(code.replace(/\s+$/, ''))}</code></pre>`, true, 'code');
      }
      // ---- subfiguras escritas como orden (paquetes subfig y subfigure)
      case 'subfloat': case 'subfigure': case 'subtable': {
        if (this.macros.has(name)) break;
        const list = c.opt();
        const cap = list !== undefined ? c.opt() ?? list : undefined;
        const a = c.group();
        if (a === undefined) break;
        const parent = this.floats[this.floats.length - 1];
        const letter = parent ? String.fromCharCode(96 + ++parent.n) : '';
        // la etiqueta puede ir en el título o en el contenido: en los dos casos nombra a esta subfigura
        if (parent) this.setCurrent(this.floatNumber(parent) + letter, 'subfigure');
        const title = cap !== undefined ? `<span class="subcap">${letter ? `(${letter}) ` : ''}${this.plain(cap)}</span>` : '';
        return done(`<span class="subfloat">${this.plain(a)}${title}</span>`);
      }
      // ---- figura TikZ en línea: \tikz \draw ...; o \tikz{...}
      case 'tikz': {
        if (this.macros.has(name) || !this.opts.renderTikz) break;
        const o = c.opt();
        let body = c.group();
        if (body === undefined) {
          const j = s.indexOf(';', c.p);
          if (j < 0) break;
          body = s.slice(c.p, j + 1);
          c.p = j + 1;
        }
        const r = this.opts.renderTikz(`\\begin{tikzpicture}${o !== undefined ? `[${o}]` : ''}\n${body}\n\\end{tikzpicture}`, this.tikz);
        if (!r) return done('<span class="placeholder tikz-wait">…</span>', false, 'tikz');
        return done(r.svg ? `<span class="tikz inline">${r.svg}</span>` : `<span class="placeholder tikz-error" title="${esc(r.error ?? '')}">tikz</span>`, false, 'tikz');
      }
      // ---- presentaciones (beamer): lo que se muestra por capas se dibuja entero
      case 'only': case 'uncover': case 'visible': case 'onslide': case 'alert': case 'structure': case 'invisible': {
        if (this.macros.has(name) || this.docClass !== 'beamer') break;
        if (s[skipWs(s, c.p)] !== '{') {
          c.ws();
          return done('');
        }
        return edit('span', name === 'alert' ? ' class="alert"' : name === 'structure' ? ' class="structure"' : name === 'invisible' ? ' class="invisible"' : '');
      }
      case 'alt': case 'temporal': {
        if (this.macros.has(name) || this.docClass !== 'beamer') break;
        // \alt<2>{en esa capa}{en las demás}, \temporal<2>{antes}{durante}{después}
        const a = c.arg();
        const b = c.arg();
        if (name === 'temporal') c.arg();
        return done(this.plain(name === 'alt' ? a : b));
      }
      // ---- referencias con nombre (hyperref, cleveref, varioref)
      case 'autoref': case 'cref': case 'Cref': case 'nameref': case 'pageref': case 'cpageref': case 'Cpageref': case 'vpageref': {
        const mode = name === 'autoref' ? 'a' : name === 'Cref' ? 'C' : name === 'cref' ? 'c' : name === 'nameref' ? 'n' : 'p';
        return done(`\u0001N${mode}${enc(c.arg())}\u0001`);
      }
      case 'crefrange': case 'Crefrange': {
        const a = c.arg();
        return done(`\u0001N${name === 'crefrange' ? 'r' : 'R'}${enc(`${a},${c.arg()}`)}\u0001`);
      }
      case 'namecref': case 'nameCref': case 'lcnamecref': {
        // solo el nombre de lo que lleva la etiqueta: «figura»
        const key = c.arg().trim();
        const type = this.refType(this.labelKinds.get(key) === 'item' ? 'enumi' : this.labelKinds.get(key) ?? '');
        const word = this.crefNames.get(type)?.[0] ?? REF_NAMES[this.lang].cref[type]?.[0] ?? '';
        return done(esc(name === 'nameCref' ? word.charAt(0).toUpperCase() + word.slice(1) : word));
      }
      case 'hyperref': {
        // \hyperref[etiqueta]{texto}: enlace interno con el texto que se quiera
        const label = c.opt();
        if (label === undefined) return done('');
        return edit('a', ` class="ref" href="#lbl-${enc(label)}"`);
      }
      case 'hypertarget': case 'hyperlink':
        c.arg();
        return edit('span');
      case 'resizebox': case 'scalebox': case 'rotatebox': case 'adjustbox': case 'raisebox': {
        // cajas que solo cambian la escala o la posición de lo que contienen: se dibuja el contenido
        if (name === 'rotatebox') c.opt();
        if (star) c.ws();
        c.arg();
        if (name === 'resizebox') c.arg();
        if (name === 'scalebox' || name === 'raisebox') {
          c.opt();
          c.opt();
        }
        return edit('span', ' class="box-thru"');
      }
      case 'makebox': case 'framebox': {
        c.opt();
        c.opt();
        return edit('span', name === 'framebox' ? ' class="fbox"' : '');
      }
      case 'parbox': {
        c.opt();
        c.opt();
        c.opt();
        const width = this.len(c.arg());
        return edit('span', ` class="parbox"${width ? ` style="width:${width}"` : ''}`);
      }
      case 'fcolorbox': {
        const line = cssColor(undefined, c.arg());
        const back = cssColor(undefined, c.arg());
        return edit('span', ` class="fbox" style="${line ? `border-color:${line};` : ''}${back ? `background:${back}` : ''}"`);
      }
      case 'makecell': case 'thead': case 'shortstack':
        // celda con varias líneas (\\ dentro)
        c.opt();
        return edit('span', ` class="makecell${name === 'thead' ? ' thead' : ''}"`);
      case 'diagbox': {
        // celda partida en diagonal: el rótulo de las filas abajo a la izquierda y el de las columnas arriba a la derecha
        c.opt();
        const a = this.plain(c.arg());
        const b = this.plain(c.arg());
        return done(`<span class="diagbox"><span>${b}</span><span>${a}</span></span>`);
      }
      case 'hrule':
        return done('<div class="hrule"></div>', true);
      case 'hrulefill': case 'dotfill':
        c.ws();
        return done(`<span class="${name}"></span>`);
      case 'vskip': case 'hskip': case 'kern': {
        // espacio de TeX: \vskip 1cm, \hskip 2em plus 1em
        const m = /\s*=?\s*(-?[\d.]*\s*(?:pt|cm|mm|em|ex|in|bp|pc|\\[a-zA-Z]+))(?:\s*(?:plus|minus)\s*-?[\d.]*\s*(?:pt|cm|mm|em|ex|in|bp|pc|fil+|\\[a-zA-Z]+))*/y;
        m.lastIndex = c.p;
        const r = m.exec(s);
        if (!r) return done('');
        c.p += r[0].length;
        return name === 'kern' ? done('') : done(this.plain(`\\${name === 'vskip' ? 'vspace' : 'hspace'}{${r[1].replace(/\s+/g, '')}}`), name === 'vskip');
      }
      case 'tablename': case 'figurename': case 'contentsname': case 'refname': case 'bibname': case 'abstractname': case 'chaptername': case 'proofname': case 'partname': {
        c.ws();
        const key = { tablename: 'table', figurename: 'figure', contentsname: 'contents', refname: 'refs', bibname: 'refs', abstractname: 'abstract', chaptername: 'chapter', proofname: 'proof', partname: 'part' }[name] as keyof typeof L10N.en;
        return done(this.L[key]);
      }
      case 'lstinline': case 'mintinline': case 'path': case 'nolinkurl': {
        if (name !== 'lstinline' && name !== 'mintinline' && this.macros.has(name)) break;
        c.opt();
        if (name === 'mintinline') c.arg();
        if (s[c.p] === '{') return done(`<code>${esc(c.arg())}</code>`);
        const delim = s[c.p];
        const j = delim === undefined ? -1 : s.indexOf(delim, c.p + 1);
        if (j < 0) return done('');
        const code = s.slice(c.p + 1, j);
        c.p = j + 1;
        return done(`<code>${esc(code)}</code>`);
      }
      case 'ensuremath':
        return done(this.math(c.arg(), false), false, 'math');
      case 'enquote':
        // comillas del idioma del documento; con asterisco, las de dentro de otra cita
        return edit('span', ` class="enquote${this.lang === 'es' ? ' es' : ''}${star ? ' inner' : ''}"`);
      case 'foreignlanguage': case 'oldstylenums': case 'textnormal':
        if (name === 'foreignlanguage') c.arg();
        return edit('span');
      case 'og':
        c.ws();
        return done('« ');
      case 'fg':
        return done(' »');
      case 'captionof':
        c.arg();
        return this.caption(star, c, s, i);
      case 'subcaption':
        return edit('span', ' class="subcap"');
      case 'subcaptionbox': {
        const cap = c.arg();
        c.opt();
        c.opt();
        return done(`<span class="subfloat">${this.plain(c.arg())}<span class="subcap">${this.plain(cap)}</span></span>`);
      }
      // ---- carta (clase letter)
      case 'opening':
        return edit('span', ' class="letter-opening"');
      case 'closing': {
        const a = c.group();
        if (a === undefined) return done('');
        const sign = this.letter.signature ? skip(this.plain(this.letter.signature), 'letter-sign') : '';
        return pre(wrap('span', s.slice(i, c.p - a.length - 1), '}', this.inline(a) + sign, ' class="letter-closing"'));
      }
      case 'ps': case 'cc': case 'encl':
        if (this.macros.has(name)) break;
        return edit('span', ' class="letter-ps"', name === 'ps' ? '' : skip(name === 'cc' ? 'c. c.: ' : 'Adjunto: '));
      // ---- presentaciones (beamer) y pósteres (tikzposter)
      case 'frame': {
        // \frame{...}: una diapositiva escrita como orden
        if (this.macros.has(name)) break;
        c.opt();
        const a = c.group();
        return a === undefined ? done('') : done(`<div class="frame">${this.plain(a)}</div>`, true);
      }
      case 'block': case 'innerblock': case 'coloredbox': {
        // bloque de un póster: \block{título}{contenido}
        if (this.macros.has(name)) break;
        c.opt();
        const title = name === 'coloredbox' ? '' : c.arg();
        const a = c.group();
        if (a === undefined) return done('');
        return done(`<div class="tcb poster">${title.trim() ? `<span class="deco tcb-title">${this.plain(title)}</span>` : ''}${this.plain(a)}</div>`, true);
      }
      // ---- IEEEtran
      case 'IEEEauthorblockN': case 'IEEEauthorblockA':
        return edit('span', ` class="ieee-author${name.endsWith('A') ? ' aff' : ''}"`);
      case 'IEEEPARstart': {
        const a = c.arg();
        const b = c.arg();
        return done(this.plain(a + b));
      }
      // ---- glosario e índice alfabético
      case 'gls': case 'Gls': case 'GLS': case 'glspl': case 'Glspl': case 'acrshort': case 'acrlong': case 'acrfull': case 'glsdesc': case 'glsentryname': case 'glsentrydesc': {
        c.opt();
        const key = c.arg().trim();
        const e = this.glossary.get(key);
        if (!e) return done(`<span class="cite-missing" title="No está en el glosario">${esc(key)}?</span>`);
        let text = name === 'acrlong' || name === 'glsdesc' || name === 'glsentrydesc' ? e.description : name === 'acrfull' ? `${e.description} (${e.name})` : /pl$/.test(name) ? e.plural ?? `${e.name}s` : e.name;
        if (name === 'Gls' || name === 'Glspl') text = text.charAt(0).toUpperCase() + text.slice(1);
        if (name === 'GLS') text = text.toUpperCase();
        return done(`<a class="ref gls" href="#gls-${enc(key)}">${this.plain(text)}</a>`);
      }
      case 'printglossary': case 'printglossaries': case 'printacronyms': case 'printnoidxglossary': case 'printnoidxglossaries': {
        const o = c.opt() ?? '';
        const own = /title\s*=\s*(\{[^}]*\}|[^,\]]*)/.exec(o)?.[1].replace(/^\{(.*)\}$/, '$1');
        // paquete acro: la lista de las siglas declaradas con \DeclareAcronym
        if (name === 'printacronyms' && this.acronyms.size) return done(this.acronymsHtml([...this.acronyms], own ?? (this.lang === 'es' ? 'Siglas' : 'Acronyms')), true);
        return done(this.glossaryHtml(own ?? (this.lang === 'es' ? 'Glosario' : 'Glossary')), true);
      }
      case 'index': {
        c.opt();
        // «entrada!subentrada», «orden@texto» y «texto|see{...}»: se queda el texto de la entrada
        const term = c.arg().split('|')[0].split('!').map((x) => x.split('@').pop() ?? x).join(', ').trim();
        if (term) this.indexTerms.push(term);
        return done('');
      }
      case 'printindex':
        c.opt();
        return done('\u0001IDX\u0001', true);
      case 'import': case 'subimport': {
        // paquete import: carpeta y archivo
        const dir = c.arg().trim();
        const file = c.arg().trim();
        return done(this.plain(`\\input{${dir}${dir && !dir.endsWith('/') ? '/' : ''}${file}}`), true);
      }
      case 'thispagestyle': case 'pagenumbering': case 'pagestyle': {
        // lo aplica el reparto en hojas a la página donde caiga esta orden (\pagestyle, también a
        // las que siguen; dentro de un entorno, solo hasta que este se cierra)
        let v = c.arg().trim();
        // babel en español escribe los romanos en mayúsculas (salvo con es-lcroman)
        if (name === 'pagenumbering' && v === 'roman' && this.upperRoman) v = 'Roman';
        const key = name === 'pagenumbering' ? 'pagenum' : name === 'pagestyle' ? 'pagestyle-from' : 'pagestyle';
        return pre(atom(s.slice(i, c.p), '', '', false, ` data-${key}="${esc(v)}"`), false);
      }
      case 'added':
        // paquete changes: texto añadido, eliminado y sustituido, a la vista hasta que se acepte o se rechace
        c.opt();
        return edit('ins', ' class="chg"');
      case 'deleted':
        c.opt();
        return edit('del', ' class="chg"');
      case 'replaced': {
        c.opt();
        const fresh = c.group();
        const old = c.group();
        if (fresh === undefined || old === undefined) return done('');
        const o = s.slice(i, c.p - old.length - 2 - fresh.length - 1);
        return pre(wrap('ins', o, `}{${old}}`, this.inline(fresh) + skip(`<del class="chg">${this.plain(old)}</del>`), ' class="chg"'));
      }
      case 'highlight':
        c.opt();
        return edit('mark', '');
      case 'todo': case 'marginpar': case 'marginnote': case 'comment': {
        // comentario al margen: se dibuja fuera de la caja de texto, a la altura de su línea
        const opts = c.opt() ?? '';
        const body = this.plain(c.arg());
        if (name === 'todo' && /\binline\b/.test(opts)) return done(`<span class="mnote inline">${body}</span>`, true, 'cmt');
        return done(`<span class="mnote" title="Comentario al margen">${body}</span>`, false, 'cmt');
      }
      case 'MakeUppercase': case 'uppercase': case 'MakeTextUppercase':
        return edit('span', ' style="text-transform:uppercase"');
      case 'MakeLowercase': case 'lowercase': case 'MakeTextLowercase':
        return edit('span', ' style="text-transform:lowercase"');
      case 'nouppercase':
        return edit('span', ' style="text-transform:none"');
      case 'tableofcontents':
        // (el índice se compone al final, con todas sus entradas; su título es el que vale aquí)
        this.titleAt.toc = this.L.contents;
        return done('\u0001TOC\u0001', true);
      case 'listoffigures': case 'listoftables':
        c.ws();
        if (name === 'listoffigures') this.titleAt.figure = this.L.lof;
        else this.titleAt.table = this.L.lot;
        return done(name === 'listoffigures' ? '\u0001LOF\u0001' : '\u0001LOT\u0001', true);
      case 'newpage': case 'clearpage': case 'cleardoublepage': case 'pagebreak':
        return done('<span class="pagebreak"></span>', true);
      case 'vspace': {
        // espacio vertical a la escala de la hoja; admite centímetros, puntos, em y fracciones de \textheight
        const arg = c.arg().trim();
        const h = this.len(arg, 'y');
        if (!h) return done('');
        // un espacio negativo acerca lo que sigue: se dibuja como margen
        return done(`<span class="vskip" style="${arg.startsWith('-') ? 'margin-top' : 'height'}:${h}"></span>`, true);
      }
      case 'vfill': case 'vfil':
        // espacio elástico: al repartir en hojas ocupa lo que quede libre en la suya
        c.ws();
        return done('<span class="vfill"></span>', true);
      case 'hspace': {
        const w = this.len(c.arg(), 'x');
        return done(w ? `<span class="hskip" style="width:${w}"></span>` : '');
      }
      case 'fontfamily': {
        // {\fontfamily{ptm}\selectfont texto}: otro tipo de letra para lo que queda del grupo
        const css = FAMILY_CSS[c.arg().trim()];
        this.selectfont(c);
        return { html: '', end: c.p, decl: ['span', css ? ` style="font-family:${css}"` : ''] };
      }
      case 'fontsize': {
        // {\fontsize{14}{17}\selectfont texto}: tamaño en puntos, relativo al del documento
        const pt = parseFloat(c.arg());
        c.arg();
        this.selectfont(c);
        return { html: '', end: c.p, decl: ['span', pt > 0 ? ` style="font-size:${+(pt / this.basePt).toFixed(3)}em"` : ''] };
      }
      case 'selectfont':
        c.ws();
        return done('');
      case 'nocite': {
        const keys = c.arg().split(',').map((k) => k.trim()).filter(Boolean);
        if (keys.includes('*')) this.citeAll = true;
        for (const k of keys) if (k !== '*' && !this.cited.includes(k)) this.cited.push(k);
        return done('');
      }
      case 'smallskip': case 'medskip': case 'bigskip':
        return done(`<span class="vskip ${name}"></span>`, true);
      case 'newline': case 'linebreak':
        return done('<br>');
      case 'hfill':
        return done('<span class="hfill"></span>');
      case 'today':
        c.ws();
        return done(esc(new Date().toLocaleDateString(this.L.locale, { day: 'numeric', month: 'long', year: 'numeric' })));
      case 'label': {
        const k = c.arg().trim();
        if (this.labels.has(k) && this.blockLine >= 0) this.issues.push({ kind: 'label', text: k, line: this.blockLine });
        this.setLabel(k);
        return pre(atom(s.slice(i, c.p), '', 'anc', false, ` id="lbl-${enc(k)}"`), false);
      }
      case 'ref': case 'vref': case 'Vref': case 'labelcref': case 'fref': case 'Fref':
        return done(`\u0001R${enc(c.arg())}\u0001`);
      case 'subref':
        // la letra de una subfigura, sin el número de la figura: «(a)»
        return done(`\u0001Ns${enc(c.arg())}\u0001`);
      case 'eqref':
        return done(`(\u0001R${enc(c.arg())}\u0001)`);
      case 'cite': case 'citep': case 'citet': case 'citealp': case 'citealt': case 'citeauthor': case 'citeyear': case 'citeyearpar':
      case 'parencite': case 'textcite': case 'autocite': case 'footcite': {
        const first = c.opt();
        const second = c.opt();
        const keys = c.arg().split(',').map((k) => k.trim()).filter(Boolean);
        return done(this.citation(name, keys, first, second), false, 'cite');
      }
      case 'footnote': {
        c.opt();
        const html = this.plain(c.arg());
        this.footnotes.push(html);
        const tip = html.replace(/<[^>]*>/g, '').replace(/\u0001[^\u0001]*\u0001/g, '');
        return done(`<sup class="fn" title="${tip}">${this.footnotes.length}</sup>`, false, 'fnote');
      }
      case 'href': {
        const url = c.arg().trim();
        const safe = /^(https?:|mailto:)/i.test(url) ? esc(url) : '#';
        return edit('a', ` href="${safe}" title="${esc(url)}"`);
      }
      case 'url': {
        const url = c.arg().trim();
        const safe = /^(https?:|mailto:)/i.test(url) ? esc(url) : '#';
        return done(`<a href="${safe}" class="url">${esc(url)}</a>`);
      }
      case 'textcolor': case 'colorbox': {
        const col = cssColor(c.opt(), c.arg());
        const prop = name === 'colorbox' ? 'background' : 'color';
        return edit('span', col ? ` style="${prop}:${col}"` : '');
      }
      case 'color': {
        const col = cssColor(c.opt(), c.arg());
        return { html: '', end: c.p, decl: ['span', col ? ` style="color:${col}"` : ''] };
      }
      case 'includegraphics':
        return done(this.image(c.opt() ?? '', c.arg().trim()), false, 'img');
      case 'caption':
        return this.caption(star, c, s, i);
      case 'frametitle': case 'framesubtitle':
        return edit(name === 'frametitle' ? 'h3' : 'h4', ' class="frametitle"');
      case 'verb': {
        const delim = s[c.p];
        const j = delim === undefined ? -1 : s.indexOf(delim, c.p + 1);
        if (j < 0) return done('');
        const code = s.slice(c.p + 1, j);
        c.p = j + 1;
        return done(`<code>${esc(code)}</code>`);
      }
      case 'input': case 'include': case 'subfile': {
        const file = c.arg().trim();
        if (this.part && !this.part.blocks && this.opts.root?.isSelf(file)) {
          // el archivo que se está editando: aquí, con los contadores como los deja lo anterior, van sus bloques
          this.partBlocks();
          return done('');
        }
        const text = this.inputDepth < 5 ? this.opts.readInput?.(file) : undefined;
        if (text === undefined) return done(`<div class="note">\\${name}{${esc(file)}}</div>`, true);
        this.inputDepth++;
        // por bloques, cada uno con su línea: así desde el principal se puede saltar al párrafo exacto
        const lines = text.split(/\r?\n/);
        const saved = this.blockLine;
        this.blockLine = -1;
        const html = splitBlocks(stripComments(lines), 0, lines.length)
          .map((r) => {
            const part = this.plain(lines.slice(r.s, r.e + 1).join('\n'));
            return part.replace(HIDDEN_ATOM, '').trim() ? `<div class="inc-block" data-line="${r.s}">${part}</div>` : part;
          })
          .join('');
        this.blockLine = saved;
        this.inputDepth--;
        const bar = `<div class="inc-bar" data-file="${esc(file)}" title="Abrir este archivo para editarlo"><i class="codicon codicon-go-to-file"></i> ${esc(/\.\w+$/.test(file) ? file : `${file}.tex`)}</div>`;
        return done(`<div class="included" title="${esc(file)}">${bar}${html}</div>`, true);
      }
      case 'bibliography': case 'printbibliography': {
        const file = name === 'bibliography' ? c.arg() : (c.opt(), '');
        // con el archivo .bib al alcance se dibuja la lista de referencias citadas (se resuelve al final)
        this.titleAt.refs = this.L.refs;
        if (this.bibEntries()) return done('\u0001BIB\u0001', true, 'biblio');
        return done(`<div class="note">${this.L.refs}${file ? ` · ${esc(file)}.bib` : ''}</div>`, true);
      }
      case 'def': {
        const j = s.indexOf('{', c.p);
        if (j >= 0) {
          c.p = j;
          c.group();
        }
        return done('');
      }
      case 'multicolumn': {
        c.arg();
        c.arg();
        return edit('span');
      }
      case 'multirow': {
        c.arg();
        c.opt();
        c.arg();
        return edit('span');
      }
      case 'c': case 'v': case 'u': case 'H': case 'r': case 'k': case 'd': case 'b':
        return this.accent(c, ACCENT[name]);
    }

    if (TEX_PARAMS.has(name) && !this.macros.has(name)) {
      // asignación de TeX: \parindent=0pt, \tolerance 1000, \newcount\x, \catcode`\@=11
      const m = /\s*(?:`\\?[\s\S]\s*)?(?:\\[a-zA-Z@]+)?\s*=?\s*(?:-?[\d.]+\s*(?:pt|cm|mm|em|ex|in|bp|pc)?(?:\s*(?:plus|minus)\s*-?[\d.]*\s*[a-z]+)*)?/y;
      m.lastIndex = c.p;
      c.p += m.exec(s)?.[0].length ?? 0;
      return done('');
    }
    if (IGNORE[name] !== undefined) {
      c.opt();
      for (let k = 0; k < IGNORE[name]; k++) c.arg();
      if (name === 'par') return done('<span class="parbreak"></span>', false, 'pb');
      if (name === 'item') return done('• ');
      if (IGNORE[name] === 0) c.ws();
      return done('');
    }

    const macro = this.macros.get(name);
    // Una orden que se llama a sí misma no tiene fin (LaTeX se quedaría sin memoria): no se sigue. Y
    // el dibujado entero tiene un tope de expansiones, para que ningún documento pueda colgarlo.
    const loops = macro !== undefined && this.expanding.includes(name) && this.recursive(name);
    if (macro && !loops && this.expandDepth < 30 && this.expansions < MAX_EXPANSIONS) {
      this.expansions++;
      /** Dibuja el cuerpo de la orden, anotando que está abierta. */
      const expand = (body: string): string => {
        this.expandDepth++;
        this.expanding.push(name);
        try {
          return this.plain(body);
        } finally {
          this.expanding.pop();
          this.expandDepth--;
        }
      };
      // un estilo propio (\newcommand{\destacado}[1]{\textbf{\color{red}#1}}): su texto se edita en sitio
      if (macro.n === 1 && macro.body.split('#1').length === 2 && s[skipWs(s, c.p)] === '{') {
        const MARK = '\uE000';
        const shell = expand(macro.body.replace('#1', MARK));
        const at = shell.indexOf(MARK);
        const a = at >= 0 && !/<(div|table|ul|ol|figure|h\d|li|td)\b/.test(shell) ? c.group() : undefined;
        if (a !== undefined) {
          // lo que la orden pone alrededor no es código del documento: no se serializa
          const thru = (h: string): string =>
            h.replace(HIDDEN_ATOM, '').replace(/ data-o="[^"]*" data-c="[^"]*"/g, ' data-thru').replace(/ data-tex="[^"]*"/g, ' data-skip');
          const o = s.slice(i, c.p - a.length - 1);
          return pre(wrap('span', o, '}', thru(shell.slice(0, at)) + this.inline(a) + thru(shell.slice(at + 1)), ' class="ustyle"'));
        }
      }
      const args: string[] = [];
      for (let k = 0; k < macro.n; k++) args.push(c.arg());
      if (macro.n === 0) c.ws();
      const body = macro.body.replace(/#(\d)/g, (_, d: string) => args[parseInt(d, 10) - 1] ?? '');
      // (un cuerpo que crece sin medida al sustituir sus argumentos tampoco se dibuja)
      const html = body.length > MAX_EXPANSION_SIZE ? '' : expand(body);
      // una orden sin argumentos que solo guarda un texto (el título, el autor, el año...) es una «variable»
      return done(html, false, macro.n === 0 && html.trim() !== '' && !/<(div|table|ul|ol|figure|h\d)\b/.test(html) ? 'var' : '');
    }

    c.p = i + 1 + name.length + (star ? 1 : 0);
    return done(`<span class="tex-unknown" title="Comando sin vista previa">\\${esc(name)}</span>`);
  }

  /**
   * Contadores y longitudes del documento: órdenes que cambian su valor (no dibujan nada) y las
   * que lo escriben (`\thecapitulo`, `\arabic{x}`, `\Roman{x}`...). `undefined` si no es una de ellas.
   */
  private stateful(name: string, c: Cursor): string | undefined {
    switch (name) {
      case 'newcounter': {
        const k = c.arg().trim();
        c.opt();
        if (!this.counters.has(k)) this.counters.set(k, 0);
        return '';
      }
      case 'setcounter': case 'addtocounter': {
        const k = c.arg().trim();
        const n = this.count(c.arg());
        this.setCounter(k, name === 'setcounter' ? n : (this.counter(k) ?? 0) + n);
        return '';
      }
      case 'stepcounter': case 'refstepcounter': {
        const k = c.arg().trim();
        const n = (this.counter(k) ?? 0) + 1;
        this.setCounter(k, n);
        if (name === 'refstepcounter') this.setCurrent(String(n), k);
        return '';
      }
      case 'arabic': case 'roman': case 'Roman': case 'alph': case 'Alph': case 'value': {
        const n = this.counter(c.arg().trim()) ?? 0;
        if (name === 'roman' || name === 'Roman') return name === 'roman' ? roman(n).toLowerCase() : roman(n);
        if (name === 'alph' || name === 'Alph') return n >= 1 && n <= 26 ? String.fromCharCode((name === 'alph' ? 96 : 64) + n) : String(n);
        return String(n);
      }
      case 'newlength': {
        const k = c.arg().trim().replace(/^\\/, '');
        if (!this.lengths.has(k)) this.lengths.set(k, '0pt');
        return '';
      }
      case 'setlength': {
        const k = c.arg().trim().replace(/^\\/, '');
        const v = c.arg().trim();
        if (this.lengths.has(k)) this.lengths.set(k, v);
        return '';
      }
    }
    // \thealgo: el valor del contador «algo», si existe y el documento no ha definido esa orden
    if (name.startsWith('the') && name.length > 3 && !this.macros.has(name)) {
      const k = name.slice(3);
      if (this.counters.has(k)) {
        c.ws();
        return String(this.counters.get(k));
      }
      const level = ['chapter', 'section', 'subsection', 'subsubsection'].indexOf(k);
      if (level >= 0) {
        c.ws();
        return this.secNumber(level);
      }
      if (k === 'equation' || k === 'figure' || k === 'table') {
        c.ws();
        return String(this.counter(k));
      }
    }
    return undefined;
  }

  /** Consume el `\selectfont` que sigue a `\fontfamily` o `\fontsize`. */
  private selectfont(c: Cursor): void {
    c.ws();
    if (c.s.startsWith('\\selectfont', c.p) && !/[a-zA-Z]/.test(c.s[c.p + 11] ?? '')) c.p += 11;
    if (c.s[c.p] === ' ') c.p++;
  }

  /** Renderiza sin que cuente para decidir si el bloque es editable en sitio. */
  private plain(s: string): string {
    this.depth++;
    try {
      return this.inline(s);
    } finally {
      this.depth--;
    }
  }

  private section(kind: string, star: boolean, c: Cursor, s: string, i: number): Cmd {
    c.opt();
    const t = c.group();
    if (t === undefined) return { html: '', end: c.p };
    const o = s.slice(i, c.p - t.length - 1);
    const level = LEVEL[kind];
    if (level >= 4) {
      return { html: wrap('strong', o, '}', this.inline(t), ' class="runin"') + ' ', end: c.p, pre: true, rich: true };
    }
    let num = '';
    // Sin número van los títulos con asterisco, los que quedan por debajo de `secnumdepth` (en un
    // informe o un libro, las subsubsecciones) y los capítulos de antes y de después del cuerpo de un libro.
    const counted = !star && level <= (this.counters.get('secnumdepth') ?? 3) && !(level === 0 && (this.matter === 'front' || this.matter === 'back'));
    if (counted && level >= 0) {
      this.sec[level]++;
      for (let k = level + 1; k < 4; k++) this.sec[k] = 0;
      // lo que se numera dentro del capítulo (o de la sección) vuelve a empezar con él
      const unit = level === 0 ? 'chapter' : level === 1 ? 'section' : '';
      if (unit && this.parentOf('equation') === unit) this.eq = 0;
      if (unit && this.parentOf('figure') === unit) this.fig = 0;
      if (unit && this.parentOf('table') === unit) this.tab = 0;
      num = this.secNumber(level);
      // (un título de apéndice se cita como tal: «apéndice A»)
      this.setCurrent(num, this.appendix && level === (this.hasChapter ? 0 : 1) ? 'appendix' : kind);
    } else if (counted) {
      // las partes llevan su propia cuenta, en números romanos
      num = roman(++this.parts);
      this.setCurrent(num, 'part');
    }
    const id = `sec-${++this.secId}`;
    const title = this.inline(t);
    this.currentTitle = title.replace(/<[^>]*>/g, '').replace(/\u0001[^\u0001]*\u0001/g, '').trim();
    // al índice van los títulos sin asterisco, hasta el nivel que diga `tocdepth`
    if (!star && level <= (this.counters.get('tocdepth') ?? 3)) this.toc.push({ level: Math.max(level, 0), num, title, id });
    // titlesec puede cambiar el tamaño del título, poner un punto tras el número y fijar los espacios
    const fmt = this.heads[kind] ?? {};
    let deco = num ? skip(num + (fmt.suffix ?? (this.secDot ? '.' : '')), 'secnum') : '';
    if (level === 0 && num) {
      // «Capítulo 1» sobre el título; titlesec puede darle un tamaño propio
      const scale = fmt.labelSize && fmt.size ? ` style="font-size:${+(fmt.labelSize / fmt.size).toFixed(3)}em"` : '';
      deco = `<span class="deco chapnum" data-skip contenteditable="false"${scale}>${this.appendix ? this.L.appendix : this.L.chapter} ${num}</span>`;
    }
    if (level === -1) deco = num ? skip(`${this.L.part} ${num}`, 'chapnum') : '';
    const tag = `h${Math.max(level, 0) + 1}`;
    const css = [
      fmt.size ? `font-size:${fmt.size}em` : '', fmt.before ? `margin-top:${fmt.before}` : '', fmt.after ? `margin-bottom:${fmt.after}` : '',
      fmt.color ? `color:${fmt.color}` : '', fmt.center ? 'text-align:center' : '', fmt.italic ? 'font-style:italic' : '',
    ].filter(Boolean).join(';');
    return {
      html: wrap(tag, o, '}', deco + title, ` id="${id}" data-k="head" data-level="${kind}"${this.strut ? ' data-strut' : ''}${level === 0 ? ' data-pagestyle="plain"' : ''}${css ? ` style="${css}"` : ''}`),
      end: c.p, pre: true, rich: true,
    };
  }

  private caption(star: boolean, c: Cursor, s: string, i: number): Cmd {
    c.opt();
    const t = c.group();
    if (t === undefined) return { html: '', end: c.p };
    const o = s.slice(i, c.p - t.length - 1);
    const f = this.floats[this.floats.length - 1];
    let deco = '';
    /** entrada del índice de figuras o de tablas que le corresponde */
    let listed: { type: 'figure' | 'table'; num: string; id: string } | undefined;
    if (f?.sub) {
      const parent = this.floats[this.floats.length - 2] ?? f;
      const letter = String.fromCharCode(96 + ++parent.n);
      // quien cita una subfigura escribe el número de su figura y la letra: «2a»
      this.setCurrent(this.floatNumber(parent) + letter, 'subfigure');
      deco = skip(`(${letter}) `);
    } else if (f && !star) {
      const n = f.type === 'listing' ? String(++this.listings) : this.numbered(f.type, f.type === 'table' ? ++this.tab : ++this.fig);
      f.num = n;
      this.setCurrent(n, f.type);
      const id = `cap-${f.type}-${this.captions.length + 1}`;
      deco = skip(`<b${f.type === 'listing' ? '' : ` id="${id}"`}>${f.type === 'table' ? this.L.table : f.type === 'listing' ? this.L.listing : this.L.figure} ${n}:</b> `);
      if (f.type !== 'listing') listed = { type: f.type, num: n, id };
    }
    // (el título se dibuja una sola vez: lo que lleve dentro —una nota al pie— no debe contarse dos)
    const inner = this.inline(t);
    this.currentTitle = inner.replace(/<[^>]*>/g, '').replace(/\u0001[^\u0001]*\u0001/g, '').trim();
    if (listed) this.captions.push({ ...listed, html: inner });
    return { html: wrap('figcaption', o, '}', deco + inner), end: c.p, pre: true, rich: true };
  }

  /** Una orden propia cuyo cuerpo acaba llamándola a ella misma, directamente o a través de otras. */
  private recursive(name: string): boolean {
    const known = this.cyclic.get(name);
    if (known !== undefined) return known;
    const seen = new Set<string>();
    const reach = (from: string, depth: number): boolean => {
      const body = this.macros.get(from)?.body;
      if (body === undefined || depth > 40) return false;
      for (const m of body.matchAll(/\\([a-zA-Z]+)/g)) {
        if (m[1] === name) return true;
        if (seen.has(m[1]) || !this.macros.has(m[1])) continue;
        seen.add(m[1]);
        if (reach(m[1], depth + 1)) return true;
      }
      return false;
    };
    const loops = reach(name, 0);
    this.cyclic.set(name, loops);
    return loops;
  }

  private image(optArg: string, path: string): string {
    let src: string | undefined;
    for (const dir of this.graphicsPaths) {
      src = this.opts.resolveImage?.(dir + path);
      if (src) break;
    }
    if (!src) {
      if (this.blockLine >= 0 && this.opts.resolveImage) this.issues.push({ kind: 'image', text: path, line: this.blockLine });
      return `<span class="img-missing">Imagen: ${esc(path)}</span>`;
    }
    // resolución declarada en el archivo (la añade quien resuelve la imagen): decide su tamaño natural
    const dpi = /#mars-dpi=(\d+)$/.exec(src);
    if (dpi) src = src.slice(0, dpi.index);
    // sus píxeles (los da también quien la resuelve): con ellos el navegador le guarda el sitio desde el principio
    const px = /#mars-size=(\d+)x(\d+)$/.exec(src);
    if (px) src = src.slice(0, px.index);
    const dims = px ? ` width="${px[1]}" height="${px[2]}"` : '';
    // medidas como las entiende graphicx: width, height (con cualquier unidad) y scale
    const opt = (name: string): string | undefined => new RegExp(`(?:^|,)\\s*${name}\\s*=\\s*([^,]+)`).exec(optArg)?.[1].trim();
    const width = this.len(opt('width') ?? '', 'x');
    const height = this.len(opt('height') ?? opt('totalheight') ?? '', 'y');
    const css: string[] = [];
    if (width) css.push(`width:${width}`);
    if (height) css.push(`height:${height}`);
    if (width && height) css.push(`object-fit:${/keepaspectratio/.test(optArg) ? 'contain' : 'fill'}`);
    const style = css.length ? ` style="${css.join(';')}"` : '';
    // sin medidas, LaTeX usa el tamaño natural de la imagen (por `scale`); lo fija el webview al cargarla
    const scale = parseFloat(opt('scale') ?? '1');
    let natural = css.length ? '' : ` data-scale="${scale > 0 ? scale : 1}"${dpi ? ` data-dpi="${dpi[1]}"` : ''}`;
    // trim=izq abajo der arriba (en puntos «bp» si no se dice otra cosa) con clip: recorta la imagen
    const trim = (opt('trim') ?? '').replace(/[{}]/g, '').trim().split(/\s+/).map((v) => (/^-?[\d.]+$/.test(v) ? parseFloat(v) : ((toCm(v) ?? 0) / 2.54) * 72));
    if (/(?:^|,)\s*clip\b/.test(optArg) && trim.length === 4 && trim.some((v) => v > 0)) {
      natural += ` data-trim="${trim.map((v) => +v.toFixed(2)).join(' ')}"${dpi && css.length ? ` data-dpi="${dpi[1]}"` : ''}`;
    }
    // angle=grados (antihorario): la gira el webview, que conoce el sitio que ocupa
    const angle = parseFloat(opt('angle') ?? '');
    if (angle % 360) natural += ` data-angle="${+(angle % 360).toFixed(2)}"`;
    if (src.endsWith('#mars-pdf')) {
      // los PDF los dibuja el webview con pdf.js
      return `<canvas class="pdfimg" data-pdf="${esc(src.slice(0, -9))}" title="${esc(path)}"${style}${natural}></canvas>`;
    }
    return `<img src="${esc(src)}" alt="${esc(path)}"${dims}${style}${natural}>`;
  }

  private titleHtml(): string {
    const { title, author, date } = this.meta;
    const d = date === undefined ? '\\today' : date;
    return (
      `<div class="titleblock" data-role="title" data-pagestyle="plain">` +
      `<div class="doctitle">${title ? this.plain(title) : '<span class="ph">Sin título</span>'}</div>` +
      (author ? `<div class="docauthor">${this.plain(author)}</div>` : '') +
      (this.institute ? `<div class="docauthor docinst">${this.plain(this.institute)}</div>` : '') +
      (d.trim() ? `<div class="docdate">${this.plain(d)}</div>` : '') +
      `</div>`
    );
  }

  // -------------------------------------------------- entornos

  private findEnd(s: string, p: number, name: string): { bodyEnd: number; end: number; closed: boolean } {
    const closeTag = `\\end{${name}}`;
    if (VERBATIM.has(name)) {
      const j = s.indexOf(closeTag, p);
      return j < 0 ? { bodyEnd: s.length, end: s.length, closed: false } : { bodyEnd: j, end: j + closeTag.length, closed: true };
    }
    const re = new RegExp(`\\\\(begin|end)\\s*\\{${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\}`, 'g');
    re.lastIndex = p;
    let depth = 1;
    let m: RegExpExecArray | null;
    while ((m = re.exec(s))) {
      if (m[1] === 'begin') depth++;
      else if (--depth === 0) return { bodyEnd: m.index, end: re.lastIndex, closed: true };
    }
    return { bodyEnd: s.length, end: s.length, closed: false };
  }

  private environment(name: string, src: string, body: string, closed: boolean): { html: string; rich: boolean } {
    const base = name.replace(/\*$/, '');
    const star = base !== name;
    const c = new Cursor(body, 0);
    const close = closed ? `\\end{${name}}` : '';
    const open = (): string => `\\begin{${name}}` + body.slice(0, c.p);
    const inner = (): string => body.slice(c.p);
    const w = (tag: string, attrs: string, before = '', after = ''): { html: string; rich: boolean } => ({
      html: wrap(tag, open(), close, before + this.inline(inner()) + after, attrs),
      rich: true,
    });
    const opaque = (html: string, cls = ''): { html: string; rich: boolean } => ({
      html: atom(src, html, cls, true),
      rich: false,
    });

    if (MATH_ENVS.has(base)) return { html: this.mathEnv(base, star, src, body), rich: false };

    switch (base) {
      case 'itemize': case 'enumerate': case 'description': {
        // enumitem: \begin{itemize}[label=$\circ$], \begin{enumerate}[label=(\alph*)]
        const opt = c.opt() ?? '';
        const label = /label\s*=\s*((?:\{[^}]*\}|[^,\]])+)/.exec(opt)?.[1].trim().replace(/^\{(.*)\}$/, '$1');
        const tag = base === 'enumerate' ? 'ol' : 'ul';
        // LaTeX cuenta por separado los niveles de las listas con marca y de las numeradas
        const depth = base === 'description' ? 0 : ++this.listDepth[base];
        const text = (tex: string): string => this.plain(tex).replace(/<[^>]*>/g, '').trim();
        let look = '';
        let lbl = '';
        /** numeración con formato propio: estilo del contador y lo que lleva delante y detrás */
        let numbering: [string, string, string, boolean?] | undefined;
        if (base === 'itemize') {
          // la marca que se pida o, sin ella, la que toca a este nivel (babel en español pone las suyas)
          const mark = label !== undefined ? BULLETS[label] ?? text(label) : BULLET_LEVELS[this.esLists ? 'es' : 'en'][depth - 1] ?? '';
          if (mark) look = ` style="list-style-type:${attr(cssString(mark + ' '))}"`;
        } else if (base === 'enumerate') {
          const m = label === undefined ? null : /^(.*?)\\(arabic|alph|Alph|roman|Roman)\*(.*)$/.exec(label);
          // paquete enumerate (o enumitem con «shortlabels»): [a)], [(i)], [1.]
          const short = label === undefined && opt.trim() && !opt.includes('=') && !LIST_FLAGS.test(opt.trim()) ? shortLabel(opt) : undefined;
          // \arabic{enumi}.\arabic*. (numeración jerárquica: 1.2., 1.2.3.): los números de los niveles de arriba
          if (m && /\\(?:arabic|alph|Alph|roman|Roman)\{enum/.test(m[1])) numbering = ['nested', '', m[3]];
          else if (m) numbering = [COUNTER_STYLE[m[2]], m[1], m[3]];
          else if (short) numbering = [short.kind, text(short.pre), text(short.suf)];
          else if (label === undefined && depth > 1) numbering = NUMBER_LEVELS[this.esLists ? 'es' : 'en'][depth - 1];
        }
        // start=3 empieza en ese número; resume sigue donde acabó la lista numerada anterior
        const start = parseInt(/(?:^|,)\s*start\s*=\s*(\d+)/.exec(opt)?.[1] ?? '', 10);
        const first = base !== 'enumerate' ? 1 : start >= 0 ? start : /(?:^|,)\s*resume\*?\s*(?:,|$)/.test(opt) ? this.lastEnum + 1 : 1;
        if (numbering) {
          lbl = numbering[0] === 'nested' ? ' lbl nested' : ' lbl';
          look = ` style="--kind:${numbering[0]};--pre:${attr(cssString(numbering[1]))};--suf:${attr(cssString(numbering[2]))}${numbering[3] ? ';--num-style:italic' : ''}${first !== 1 ? `;counter-reset:lbl ${first - 1}` : ''}"`;
        } else if (first !== 1) look = ` start="${first}"`;
        let n = first - 1;
        const parts = splitList(inner(), itemMarks(inner()));
        const lis = parts.items.map((it) => {
          n++;
          if (base === 'enumerate') this.setCurrent(String(n), 'item');
          const custom = it.label !== undefined;
          // presentaciones: \item<2-> (la capa en que aparece) va con la orden, no con el texto
          const layer = custom || this.docClass !== 'beamer' ? '' : /^<[^<>{}\\\n]*>\s?/.exec(it.text)?.[0] ?? '';
          const o = custom ? `\\item[${it.label}] ` : `\\item${layer.trimEnd()} `;
          const lbl = custom ? skip(this.plain(it.label!), 'lbl') : '';
          return (
            `<li data-k="item" data-o="${attr(o)}" data-lead="${attr(it.lead)}" data-raw="${attr(it.raw)}"` +
            `${custom ? ' class="custom"' : ''}>${lbl}${this.inline(it.text.slice(layer.length))}</li>`
          );
        });
        if (base !== 'description') this.listDepth[base]--;
        if (base === 'enumerate' && depth === 1) this.lastEnum = n;
        return {
          html:
            `<${tag} data-k="list" data-x class="${base}${lbl}"${look} data-o="${attr(open() + parts.pre)}" ` +
            `data-c="${attr(parts.tail + close)}">${lis.join('')}</${tag}>`,
          rich: true,
        };
      }
      case 'tabular': case 'longtable': case 'tabularx': case 'tabulary': case 'array': case 'supertabular': case 'xtabular': case 'mpsupertabular': case 'tabu':
      case 'longtabu': case 'xltabular': case 'NiceTabular': case 'tblr': case 'longtblr': case 'talltblr': {
        c.opt();
        if (base === 'tabu' || base === 'longtabu') {
          // tabu to \textwidth {...}, tabu spread 2cm {...}
          c.p += /^\s*(?:to|spread)\b[^{]*/.exec(body.slice(c.p))?.[0].length ?? 0;
        } else if (star || base === 'tabularx' || base === 'tabulary' || base === 'xltabular') c.arg();
        c.opt();
        let spec = c.arg();
        let look = '';
        if (base.endsWith('tblr')) {
          // tabularray: las columnas van en «colspec» (o solas), con Q[c] y X[r] donde tabular pone c y r,
          // y las líneas de toda la tabla se piden con «hlines» y «vlines»
          const keys = spec.includes('=') || /^\s*[hv]lines\b/.test(spec) ? keyValues(spec) : { colspec: spec };
          spec = (keys.colspec ?? '').replace(/[QX]\s*\[([^\]]*)\]/g, (_, o: string) => (/(?:^|,)\s*c\b/.test(o) ? 'c' : /(?:^|,)\s*r\b/.test(o) ? 'r' : 'l')).replace(/[QX]/g, 'l');
          if (keys.vlines !== undefined) spec = `|${spec}|`;
          if (keys.hlines !== undefined) look = ' hlines';
        }
        return { html: this.tabular(spec, open(), close, inner(), look), rich: true };
      }
      case 'figure': case 'table': case 'wrapfigure': case 'subfigure': case 'subtable': case 'sidewaysfigure': case 'sidewaystable': {
        const sub = base.startsWith('sub');
        let style = '';
        // dónde deja LaTeX el flotante: «H» lo clava en su sitio; con lo demás puede pasar al principio de otra hoja
        const place = c.opt() ?? 'tbp';
        if (sub) {
          const width = this.len(c.arg()) ?? '';
          if (width) style = ` style="width:${width}"`;
        }
        let wrapAt = '';
        if (base === 'wrapfigure') {
          // \begin{wrapfigure}{r}{0.4\textwidth}: a qué lado va y cuánto ocupa; el texto la rodea
          wrapAt = /[lLiI]/.test(c.arg()) ? 'l' : 'r';
          const width = this.len(c.arg());
          style = ` data-wrap="${wrapAt}"${width ? ` style="width:${width}"` : ''}`;
        }
        const parent = this.floats[this.floats.length - 1];
        const type = sub && parent ? parent.type : base.includes('table') ? 'table' : 'figure';
        this.floats.push({ type, sub, n: 0 });
        const floating = !sub && base !== 'wrapfigure' && !/H/.test(place);
        const r = w(sub ? 'div' : 'figure', ` class="${sub ? 'subfloat' : 'float'}"${floating ? ' data-float' : ''}${style}`);
        this.floats.pop();
        return r;
      }
      case 'center':
        return w('div', ' class="center"');
      case 'flushleft':
        return w('div', ' class="left"');
      case 'flushright':
        return w('div', ' class="right"');
      case 'quote': case 'quotation': case 'verse':
        return w('blockquote', '');
      case 'abstract':
        return w('div', ' class="abstract"', skip(this.L.abstract, 'abstract-title'));
      case 'verbatim': case 'lstlisting': case 'minted': case 'Verbatim': case 'alltt': {
        const o = base !== 'verbatim' ? c.opt() ?? '' : '';
        if (base === 'minted') c.arg();
        const code = inner().replace(/^[ \t]*\n/, '').replace(/\n[ \t]*$/, '');
        // un listado puede llevar su título y su etiqueta en las opciones: [caption={...}, label=...]
        return opaque((base === 'lstlisting' ? this.listingCaption(o) : '') + `<pre><code>${esc(code)}</code></pre>`, 'code');
      }
      case 'appendix': case 'appendices':
        // lo mismo que \appendix, escrito como entorno
        this.startAppendix();
        return w('div', '');
      case 'subequations': {
        // un solo número para todas las ecuaciones de dentro; una etiqueta puesta aquí se refiere a él
        this.subEq = { base: this.numbered('equation', ++this.eq), n: 0 };
        this.setCurrent(this.subEq.base, 'equation');
        try {
          return w('div', '');
        } finally {
          this.subEq = undefined;
        }
      }
      case 'acronym': {
        // lista de siglas (paquete acronym): las \acro{clave}[sigla]{nombre completo} que lleva dentro
        const list = [...body.matchAll(/\\acro(?:def)?\s*\{([^}]*)\}/g)].flatMap((m) => {
          const e = this.acronyms.get(m[1].trim());
          return e ? [[m[1].trim(), e] as [string, { short: string; long: string }]] : [];
        });
        return opaque(this.acronymsHtml(list), 'acr');
      }
      case 'comment':
        return { html: atom(src, ''), rich: false };
      case 'tikzpicture': case 'circuitikz': case 'tikzcd': {
        if (!TIKZ_ENVS.has(name) || !this.opts.renderTikz) return opaque(`<div class="placeholder">${esc(name)} · sin vista previa</div>`);
        const r = this.opts.renderTikz(src, this.tikz);
        if (!r) return opaque(`<div class="placeholder tikz-wait">Dibujando ${esc(name)}…</div>`, 'tikz');
        if (r.svg) return opaque(`<div class="tikz">${r.svg}</div>`, 'tikz');
        return opaque(`<div class="placeholder tikz-error">${esc(name)}: no se pudo dibujar<pre>${esc(r.error ?? '')}</pre></div>`, 'tikz');
      }
      case 'pgfpicture': case 'axis': case 'picture': case 'forest': case 'pspicture': case 'asy': case 'chemfig':
        return opaque(`<div class="placeholder">${esc(name)} · sin vista previa</div>`);
      case 'thebibliography': {
        c.arg();
        const text = inner();
        const re = /\\bibitem\s*(\[[^\]]*\])?\s*\{([^}]*)\}\s*/g;
        const marks = [...text.matchAll(re)];
        const parts = splitList(text, marks.map((m) => ({ at: m.index, content: m.index + m[0].length })));
        const lis = parts.items.map((it, k) => {
          const m = marks[k];
          const key = m[2].trim();
          this.bib.set(key, k + 1);
          return (
            `<li data-k="item" id="bib-${enc(key)}" data-o="${attr(m[0].trimEnd() + ' ')}" data-lead="${attr(it.lead)}" ` +
            `data-raw="${attr(it.raw)}">${this.inline(it.text)}</li>`
          );
        });
        return {
          html:
            skip(this.L.refs, 'bib-title') +
            `<ol data-k="list" data-x class="bib" data-o="${attr(open() + parts.pre)}" data-c="${attr(parts.tail + close)}">${lis.join('')}</ol>`,
          rich: true,
        };
      }
      case 'minipage': {
        c.opt();
        c.opt();
        c.opt();
        const width = this.len(c.arg()) ?? '';
        return w('div', ` class="minipage"${width ? ` style="width:${width}"` : ''}`);
      }
      case 'titlepage':
        // la portada ocupa su propia hoja: lo que sigue empieza en la siguiente
        return w('div', ' class="titlepage"');
      case 'landscape':
        // hoja horizontal (lscape): va en hoja propia con el contenido girado. Con pdflscape el
        // visor de PDF muestra además la hoja apaisada; con lscape la hoja sigue vertical
        return w('div', ` class="landscape" data-land="${this.packages.has('pdflscape') ? 'pdf' : 'print'}"`);
      case 'singlespace': case 'onehalfspace': case 'doublespace': case 'spacing': {
        // interlineado propio de este tramo (paquete setspace)
        const factor = base === 'spacing' ? parseFloat(c.group() ?? '1') || 1 : 1;
        const lh = base === 'spacing' ? lineHeightFor(this.basePt, '1') * factor : lineHeightFor(this.basePt, base === 'singlespace' ? '1' : base === 'onehalfspace' ? '1.5' : '2');
        return w('div', ` class="spacing" style="line-height:${+lh.toFixed(3)}"`);
      }
      case 'adjustwidth': {
        // paquete changepage: margen de más a la izquierda y a la derecha de este tramo
        const left = this.len(c.group() ?? '') ?? '0px';
        const right = this.len(c.group() ?? '') ?? '0px';
        return w('div', ` class="indented" style="margin-left:${left};margin-right:${right}"`);
      }
      case 'frame': {
        // diapositiva: \begin{frame}[opciones]{título}{subtítulo}
        c.opt();
        const title = c.group();
        const sub = title === undefined ? undefined : c.group();
        const head = (title?.trim() ? `<span class="frametitle">${this.plain(title)}</span>` : '') + (sub?.trim() ? `<span class="frametitle sub">${this.plain(sub)}</span>` : '');
        return w('div', ' class="frame"', head ? skip(head, 'frame-head') : '');
      }
      case 'block': case 'alertblock': case 'exampleblock': {
        // bloque con título de una presentación
        const title = c.group() ?? '';
        return w('div', ` class="tcb ${base}"`, title.trim() ? skip(this.plain(title), 'tcb-title') : '');
      }
      case 'tcolorbox': case 'mdframed': case 'framed': case 'shaded': case 'boxedminipage': case 'fshaded': case 'leftbar': {
        // caja con marco (tcolorbox y parecidos): título, color de fondo y del marco
        const o = c.opt() ?? '';
        const option = (k: string): string | undefined =>
          new RegExp(`(?:^|,)\\s*${k}\\s*=\\s*(\\{(?:[^{}]|\\{[^{}]*\\})*\\}|[^,]*)`).exec(o)?.[1].trim().replace(/^\{([\s\S]*)\}$/, '$1');
        if (base === 'boxedminipage') c.group();
        const title = option('title');
        const back = cssColor(undefined, option('colback') ?? option('backgroundcolor') ?? '');
        const frame = cssColor(undefined, option('colframe') ?? option('linecolor') ?? '');
        const style = [back ? `--tcb-back:${back}` : '', frame ? `--tcb-frame:${frame}` : ''].filter(Boolean).join(';');
        return w('div', ` class="tcb"${style ? ` style="${style}"` : ''}`, title?.trim() ? skip(this.plain(title), 'tcb-title') : '');
      }
      case 'algorithm': case 'algorithm2e': {
        // flotante de un algoritmo: título numerado arriba, entre filetes
        c.opt();
        const text = inner();
        const cap = /\\caption\s*(?:\[[^\]]*\])?\s*(?=\{)/.exec(text);
        const g = cap ? readGroup(text, cap.index + cap[0].length) : undefined;
        const n = ++this.algorithms;
        this.setCurrent(String(n), 'algorithm', g?.content ?? '');
        const rest = g && cap ? text.slice(0, cap.index) + text.slice(g.end) : text;
        const word = this.lang === 'en' ? 'Algorithm' : 'Algoritmo';
        // algorithm2e escribe el pseudocódigo directamente dentro, sin entorno algorithmic, y pone dos puntos tras el número
        const own = (this.packages.has('algorithm2e') || base === 'algorithm2e' || /\\(?:KwIn|KwOut|KwData|KwResult|SetAlgoLined|DontPrintSemicolon)\b/.test(rest)) && !/\\begin\s*\{algorithmic\}/.test(rest);
        return opaque(`<div class="algorithm"><div class="algo-cap"><b>${word} ${n}${own ? ':' : ''}</b>${g ? ` ${this.plain(g.content)}` : ''}</div>${own ? this.algorithm2e(rest) : this.plain(rest)}</div>`, 'algo');
      }
      case 'algorithmic': {
        const numbered = c.opt() !== undefined;
        return opaque(this.algorithmic(inner(), numbered), 'algo');
      }
      case 'questions': case 'parts': case 'subparts': case 'subsubparts': case 'choices': case 'oneparchoices': case 'checkboxes': {
        // examen (clase exam): preguntas, apartados y opciones son listas numeradas a su manera
        const label = base === 'questions' ? '' : base === 'parts' ? '[label=(\\alph*)]' : base === 'subparts' ? '[label=\\roman*.]' : base === 'subsubparts' ? '[label=\\Alph*.]' : '[label=\\Alph*.]';
        const points = this.lang === 'en' ? ['point', 'points'] : ['punto', 'puntos'];
        const items = body.replace(/\\(?:question|part|subpart|subsubpart|choice|CorrectChoice|bonusquestion|bonuspart)(?![a-zA-Z])\s*(?:\[([^\]]*)\])?/g, (_, p: string | undefined) =>
          `\\item ${p ? `\\textbf{(${p} ${p.trim() === '1' ? points[0] : points[1]})} ` : ''}`,
        );
        return opaque(this.plain(`\\begin{enumerate}${label}${items}\\end{enumerate}`), 'exam');
      }
      case 'solution': case 'solutionorbox': case 'solutionorlines': {
        c.opt();
        const word = this.lang === 'en' ? 'Solution' : 'Solución';
        return w('div', ' class="solution"', skip(`<b>${word}:</b> `));
      }
      case 'letter': {
        // carta: remitente y fecha a la derecha, destinatario a la izquierda y después el texto
        const to = c.group() ?? '';
        const date = this.plain(this.meta.date ?? '\\today');
        const from = this.letter.address ? `${this.plain(this.letter.address)}<br>` : '';
        const head = `<span class="letter-from">${from}${date}</span><span class="letter-to">${this.plain(to)}</span>`;
        return w('div', ' class="letter"', skip(head, 'letter-head'));
      }
      case 'IEEEkeywords': case 'keywords':
        return w('div', ' class="abstract keywords"', skip(`<i>${base === 'IEEEkeywords' ? 'Index Terms' : this.lang === 'en' ? 'Keywords' : 'Palabras clave'}</i>—`));
      case 'filecontents': case 'luacode': case 'luacodestar': case 'pycode': case 'sagesilent':
        // archivos que el documento escribe al compilar y código de otros lenguajes: no dibujan nada
        return { html: atom(src, ''), rich: false };
      case 'compactitem': case 'compactenum': case 'inparaenum': case 'tablenotes': case 'tasks': case 'itemize*': case 'enumerate*':
        // listas de paralist, threeparttable y parecidos: se dibujan como las normales
        return { html: atom(src, this.plain(`\\begin{${/enum/.test(base) ? 'enumerate' : 'itemize'}}${body}\\end{${/enum/.test(base) ? 'enumerate' : 'itemize'}}`), '', true), rich: false };
      case 'displayquote': case 'savequote': case 'epigraphs':
        return w('blockquote', '');
      case 'otherlanguage': case 'varwidth': case 'adjustbox': case 'CJK':
        c.group();
        if (base === 'CJK') c.group();
        return w('div', '');
      case 'tiny': case 'scriptsize': case 'normalsize': case 'Large': case 'LARGE': case 'huge': case 'Huge':
        return w('div', ` style="font-size:${SIZE[base] ?? 1}em"`);
      case 'wraptable': {
        c.opt();
        c.group();
        c.group();
        this.floats.push({ type: 'table', sub: false, n: 0 });
        const r = w('figure', ' class="float"');
        this.floats.pop();
        return r;
      }
      case 'listing': {
        // flotante de un listado de código (minted): su título dice «Listing», no «Figura»
        c.opt();
        this.floats.push({ type: 'listing', sub: false, n: 0 });
        const r = w('figure', ' class="float"');
        this.floats.pop();
        return r;
      }
      case 'proof': {
        const t = c.opt();
        return w('div', ' class="proof"', skip(`<i>${t ? this.plain(t) : this.L.proof}.</i> `), skip('∎', 'qed'));
      }
    }

    const th = this.theorems.get(base) ?? (COMMON_THEOREMS.has(base) ? { title: base[0].toUpperCase() + base.slice(1), star: false } : undefined);
    if (th) {
      const t = c.opt();
      let head = this.plain(th.title);
      if (!star && !th.star) {
        const n = (this.thmCount.get(base) ?? 0) + 1;
        this.thmCount.set(base, n);
        this.setCurrent(String(n), base, t ?? '');
        head += ` ${n}`;
      }
      return w('div', ' class="theorem"', skip(`<strong>${head}</strong>${t ? ` (${this.plain(t)})` : ''}. `));
    }
    if (TRANSPARENT.has(base)) {
      if (base === 'multicols' || base === 'spacing' || base === 'column') c.group();
      return w('div', '');
    }
    return w('div', ' class="env-unknown"', skip(esc(name), 'env-name'));
  }

  /** Especificación de columnas con los tipos propios del documento (\newcolumntype) ya sustituidos. */
  private columnSpec(spec: string, depth = 0): string {
    if (!this.columnTypes.size || depth > 4) return spec;
    let out = '';
    const c = new Cursor(spec, 0);
    while (c.p < spec.length) {
      const ch = spec[c.p];
      // lo que va entre llaves (un ancho, lo que «>{...}» pone delante) no son columnas
      const g = ch === '{' ? readGroup(spec, c.p) : undefined;
      if (g) {
        out += spec.slice(c.p, g.end);
        c.p = g.end;
        continue;
      }
      c.p++;
      if (ch === '*') {
        // *{3}{Y}: la repetición también puede usar tipos propios
        const n = c.group();
        const sub = c.group();
        out += n !== undefined && sub !== undefined ? `*{${n}}{${this.columnSpec(sub, depth + 1)}}` : '*';
        continue;
      }
      const type = this.columnTypes.get(ch);
      if (!type) {
        out += ch;
        continue;
      }
      const args: string[] = [];
      for (let k = 0; k < type.n; k++) args.push(c.group() ?? '');
      out += this.columnSpec(type.spec.replace(/#(\d)/g, (_, d: string) => args[parseInt(d, 10) - 1] ?? ''), depth + 1);
    }
    return out;
  }

  private tabular(spec: string, open: string, close: string, body: string, look = ''): string {
    spec = this.columnSpec(spec);
    const aligns = parseSpec(spec);
    const widths = specWidths(spec);
    /** columnas ocupadas por una celda de varias filas (\multirow): filas que aún le quedan */
    const under = new Map<number, number>();
    const bordered = spec.includes('|');
    const RULE =
      /^\s*\\(?:hline|toprule|midrule|bottomrule|cline\s*\{[^}]*\}|cmidrule\s*(?:\([^)]*\))?\s*\{[^}]*\}|endhead|endfirsthead|endfoot|endlastfoot|addlinespace(?:\[[^\]]*\])?|noalign\s*\{[^}]*\}|rowcolor\s*(?:\[[^\]]*\])?\s*\{[^}]*\})/;
    const rows: string[] = [];
    let tail = '';
    for (const { text: row, term } of splitRows(body)) {
      let r = row;
      let rules = '';
      let m: RegExpExecArray | null;
      while ((m = RULE.exec(r))) {
        rules += m[0].trim() + '\n';
        r = r.slice(m[0].length);
      }
      if (!r.trim()) {
        // solo reglas o espacio: pertenece al cierre de la tabla, tal cual está escrito
        tail += row + term;
        continue;
      }
      // formato original de la fila: sangría, reglas previas y terminador
      const lead = /^\s*/.exec(row)![0];
      const cellsAt = row.length - r.trimStart().length;
      const pre = row.slice(lead.length, cellsAt);
      const post = term ? ' ' + term : row.slice(row.trimEnd().length);
      const raw = (row + term).slice(lead.length);
      let col = 0;
      const fresh = new Map<number, number>();
      const cells = splitTop(r, '&').map((cell) => {
        let span = 1;
        let align = aligns[col] ?? 'left';
        let extra = '';
        let text = cell;
        const mc = /^\s*\\multicolumn\b/.exec(cell);
        if (mc) {
          const cu = new Cursor(cell, mc[0].length);
          span = Math.max(parseInt(cu.arg(), 10) || 1, 1);
          const a = cu.arg();
          const g = cu.group();
          if (g !== undefined) {
            align = a.includes('c') ? 'center' : a.includes('r') ? 'right' : 'left';
            extra = ` colspan="${span}" data-o="${attr(cell.slice(0, cu.p - g.length - 1).trimStart())}" data-c="}"`;
            text = g;
          }
        }
        // \multirow{n}{*}{texto}: la celda baja n filas; las que quedan debajo (vacías en el código) no se dibujan
        const mr = mc ? null : /^\s*\\multirow\b/.exec(cell);
        let rows = 0;
        if (mr) {
          const cu = new Cursor(cell, mr[0].length);
          const n = parseInt(cu.arg(), 10) || 1;
          cu.opt();
          cu.arg();
          const g = cu.group();
          if (g !== undefined && n > 1) {
            rows = n - 1;
            extra = ` rowspan="${n}" data-o="${attr(cell.slice(0, cu.p - g.length - 1).trimStart())}" data-c="}"`;
            text = g;
          }
        }
        const hidden = (under.get(col) ?? 0) > 0;
        if (rows) fresh.set(col, rows);
        const width = span === 1 && widths[col] ? this.len(widths[col] as string) : undefined;
        col += span;
        return `<td data-k="cell"${extra}${hidden ? ' class="under"' : ''} style="text-align:${align}${width ? `;width:${width};white-space:normal` : ''}">${this.inline(text)}</td>`;
      });
      for (const [k, v] of under) under.set(k, v - 1);
      for (const [k, v] of fresh) under.set(k, v);
      rows.push(
        `<tr data-k="row"${rowClass(rules)}${rowColor(rules)} data-lead="${attr(lead)}" data-pre="${attr(pre)}" ` +
          `data-post="${attr(post)}" data-raw="${attr(raw)}">${cells.join('')}</tr>`,
      );
    }
    return (
      `<table data-k="table" data-x class="${bordered ? 'bordered' : ''}${/\\(hline|bottomrule|midrule|toprule)/.test(tail) ? ' rule-end' : ''}${/\\bottomrule/.test(tail) ? ' heavy-end' : ''}${look}" ` +
      `data-o="${attr(open)}" data-c="${attr(tail + close)}">${rows.join('')}</table>`
    );
  }
}

export function renderLatex(text: string, opts: RenderOptions = {}): RenderResult {
  return new Renderer(opts).render(text);
}
