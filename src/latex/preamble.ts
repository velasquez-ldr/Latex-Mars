/*
 * El preámbulo «efectivo» de un documento. Mars no ejecuta LaTeX, pero muchas plantillas reales
 * deciden cosas con lógica sencilla: un `\IfFileExists`, un `\ifthenelse`, un interruptor
 * `\newif`, una clase propia de la universidad que carga `report` con sus márgenes, un archivo de
 * estilo compartido... Aquí se resuelve esa parte, en orden, como lo haría LaTeX:
 *
 *   - la clase del documento, si es un `.cls` que está junto a él, se sustituye por la clase
 *     estándar que carga más lo que ella misma configura;
 *   - los paquetes `.sty` locales y los `\input` del preámbulo se incorporan en su sitio;
 *   - los condicionales se evalúan y queda solo la rama que se usaría.
 *
 * El resultado solo sirve para LEER la configuración del documento: nunca se escribe en disco.
 */

export type ReadFile = (name: string) => string | undefined;

/** Condicionales con argumentos entre llaves: no se cierran con `\fi`. */
const BRACED = new Set([
  'ifthenelse', 'iftoggle', 'nottoggle', 'ifbool', 'notbool', 'ifdef', 'ifundef', 'ifcsdef', 'ifcsundef', 'ifstrequal', 'ifdefstring', 'ifnumcomp', 'ifblank', 'iff',
  'ifdefempty', 'ifdefvoid', 'ifnumequal', 'ifnumgreater', 'ifnumless', 'ifstrempty',
]);
/** Motores: Mars se comporta como pdfLaTeX. */
const ENGINE: Record<string, boolean> = {
  ifpdf: true, ifpdftex: true, ifPDFTeX: true, ifxetex: false, ifXeTeX: false, ifluatex: false, ifLuaTeX: false, ifLuaHBTeX: false, iftutex: false, ifTUTeX: false,
  ifpTeX: false, ifupTeX: false, ifptex: false, ifuptex: false, iftrue: true, iffalse: false,
};
/** Órdenes que pdfLaTeX define y que los documentos suelen consultar con `\ifdefined`. */
const BUILTIN = new Set(['pdfoutput', 'pdftexversion', 'pdfminorversion', 'documentclass', 'usepackage', 'chapter', 'section']);

function group(s: string, i: number): { content: string; end: number } | undefined {
  while (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r') i++;
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

function bracket(s: string, i: number): { content: string; end: number } | undefined {
  while (s[i] === ' ' || s[i] === '\t') i++;
  if (s[i] !== '[') return undefined;
  const j = s.indexOf(']', i);
  return j < 0 ? undefined : { content: s.slice(i + 1, j), end: j + 1 };
}

const NAME = /[a-zA-Z@]+/y;
function nameAt(s: string, i: number): string {
  if (s[i] !== '\\') return '';
  NAME.lastIndex = i + 1;
  return NAME.exec(s)?.[0] ?? '';
}

/** Quita los comentarios de cada línea (un `%` sin escapar hasta el final). */
export function uncomment(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => {
      for (let i = 0; i < line.length; i++) {
        if (line[i] === '\\') i++;
        else if (line[i] === '%') return line.slice(0, i);
      }
      return line;
    })
    .join('\n');
}

/** Estado de los interruptores del documento y evaluación de sus condicionales. */
export class Conditions {
  /** interruptores de `\newif`, `\newboolean` (ifthen) y `\newbool` (etoolbox): comparten nombre */
  readonly flags = new Map<string, boolean>();
  readonly toggles = new Map<string, boolean>();
  /** órdenes definidas por el documento hasta el momento */
  readonly defined = new Set<string>();
  readonly packages = new Set<string>();
  cls = '';

  /** `exists`: ¿existe ese archivo junto al documento? (`undefined` = no se puede saber) */
  constructor(private readonly exists: (file: string) => boolean | undefined = () => undefined) {}

  /** ¿Es `name` (sin la barra) algo que `at` sabe tratar? Evita trabajo en cada orden del documento. */
  handles(name: string): boolean {
    if (name === 'newif' || name === 'IfFileExists' || name === 'InputIfFileExists') return true;
    if (name.startsWith('if')) return name !== 'iff' && (BRACED.has(name) || name in ENGINE || name === 'ifdefined' || name === 'ifx' || this.flags.has(name.slice(2)));
    if (/^(new|provide|set)(boolean|bool|toggle)$|^(bool|toggle)(true|false)$|^(not)(bool|toggle)$|^@if(package|class)loaded$/.test(name)) return true;
    return /(true|false)$/.test(name) && this.flags.has(name.replace(/(true|false)$/, ''));
  }

  /**
   * Si en `s[i]` empieza un condicional, o una orden que cambia un interruptor, devuelve lo que
   * queda en su lugar (la rama elegida, o nada) y dónde termina en `s`. `undefined` si no es nada
   * de eso o no se puede evaluar: entonces el texto se deja como está.
   */
  at(s: string, i: number): { text: string; end: number } | undefined {
    const name = nameAt(s, i);
    if (!name || !this.handles(name)) return undefined;
    let p = i + 1 + name.length;
    const arg = (): string | undefined => {
      const g = group(s, p);
      if (!g) return undefined;
      p = g.end;
      return g.content;
    };
    const pick = (value: boolean | undefined): { text: string; end: number } | undefined => {
      const yes = arg();
      const no = arg();
      if (yes === undefined || no === undefined || value === undefined) return undefined;
      return { text: value ? yes : no, end: p };
    };
    const none = (): { text: string; end: number } => ({ text: '', end: p });
    const truth = (v: string | undefined): boolean => v?.trim() === 'true';

    switch (name) {
      case 'newif': {
        const m = /^\s*\\if([a-zA-Z@]+)/.exec(s.slice(p));
        if (!m) return undefined;
        this.flags.set(m[1], false);
        p += m[0].length;
        return none();
      }
      case 'newboolean': case 'provideboolean': case 'newbool': case 'providebool': {
        const k = arg()?.trim();
        if (k && !this.flags.has(k)) this.flags.set(k, false);
        return k ? none() : undefined;
      }
      case 'setboolean': case 'setbool': {
        const k = arg()?.trim();
        const v = arg();
        if (!k || v === undefined) return undefined;
        this.flags.set(k, truth(v));
        return none();
      }
      case 'booltrue': case 'boolfalse': {
        const k = arg()?.trim();
        if (!k) return undefined;
        this.flags.set(k, name === 'booltrue');
        return none();
      }
      case 'newtoggle': case 'providetoggle': {
        const k = arg()?.trim();
        if (k && !this.toggles.has(k)) this.toggles.set(k, false);
        return k ? none() : undefined;
      }
      case 'settoggle': {
        const k = arg()?.trim();
        const v = arg();
        if (!k || v === undefined) return undefined;
        this.toggles.set(k, truth(v));
        return none();
      }
      case 'toggletrue': case 'togglefalse': {
        const k = arg()?.trim();
        if (!k) return undefined;
        this.toggles.set(k, name === 'toggletrue');
        return none();
      }
      case 'iftoggle': case 'nottoggle': {
        const v = this.toggles.get(arg()?.trim() ?? '');
        return pick(v === undefined ? undefined : name === 'iftoggle' ? v : !v);
      }
      case 'ifbool': case 'notbool': {
        const v = this.flags.get(arg()?.trim() ?? '');
        return pick(v === undefined ? undefined : name === 'ifbool' ? v : !v);
      }
      case 'ifdef': case 'ifundef': case 'ifcsdef': case 'ifcsundef': {
        const k = (arg() ?? '').trim().replace(/^\\/, '');
        const d = this.isDefined(k);
        return pick(name.endsWith('undef') ? !d : d);
      }
      case 'ifstrequal': {
        const a = arg();
        const b = arg();
        return pick(a === undefined || b === undefined ? undefined : a.trim() === b.trim());
      }
      case 'ifthenelse':
        return pick(this.test(arg() ?? ''));
      case '@ifpackageloaded':
        return pick(this.packages.has(arg()?.trim() ?? ''));
      case '@ifclassloaded':
        return pick(this.cls === (arg()?.trim() ?? ''));
      case 'IfFileExists': case 'InputIfFileExists': {
        const file = arg()?.trim();
        if (file === undefined) return undefined;
        // lo que no es un archivo del propio documento (idiomas de babel, paquetes, tipos de letra)
        // se da por instalado: es lo que pasa en cualquier distribución de LaTeX
        const here = /\.(tex|bib|txt|png|jpe?g|pdf|svg|eps|csv|dat)$/i.test(file) || !/\.[a-z0-9]+$/i.test(file) || /[\\/]/.test(file);
        return pick(here ? this.exists(file) ?? true : true);
      }
    }

    // interruptores: \borradortrue, \borradorfalse
    const sw = /^(.*?)(true|false)$/.exec(name);
    if (!name.startsWith('if') && sw && this.flags.has(sw[1])) {
      this.flags.set(sw[1], sw[2] === 'true');
      return none();
    }

    // condicionales de TeX: \ifX ... \else ... \fi
    let value: boolean | undefined;
    if (name in ENGINE) value = ENGINE[name];
    else if (name === 'ifdefined') {
      const k = nameAt(s, skipSpaces(s, p));
      if (!k) return undefined;
      p = skipSpaces(s, p) + 1 + k.length;
      value = this.isDefined(k);
    } else if (name === 'ifx') {
      // solo la forma habitual de preguntar si algo existe: \ifx\orden\undefined
      const m = /^\s*\\([a-zA-Z@]+)\s*\\(undefined|@undefined|relax)(?![a-zA-Z@])/.exec(s.slice(p));
      if (!m) return undefined;
      p += m[0].length;
      value = !this.isDefined(m[1]);
    } else value = this.flags.get(name.slice(2));
    if (value === undefined) return undefined;
    const body = branches(s, p);
    if (!body) return undefined;
    return { text: value ? body.yes : body.no, end: body.end };
  }

  private isDefined(name: string): boolean {
    return this.defined.has(name) || BUILTIN.has(name) || this.flags.has(name.replace(/^if/, '')) && name.startsWith('if');
  }

  /** Condición de `\ifthenelse`: \boolean, \equal, \isundefined, comparaciones de números, \not, \and, \or. */
  test(cond: string): boolean | undefined {
    let s = cond.trim();
    let p = 0;
    const ws = (): void => {
      while (/\s/.test(s[p] ?? '')) p++;
    };
    const word = (re: RegExp): string | undefined => {
      ws();
      re.lastIndex = p;
      const m = re.exec(s);
      if (!m) return undefined;
      p += m[0].length;
      return m[0];
    };
    const atomic = (): boolean | undefined => {
      ws();
      if (word(/\\(?:not|NOT)(?![a-zA-Z])/y)) {
        const v = atomic();
        return v === undefined ? undefined : !v;
      }
      if (word(/\\\(/y)) {
        const v = either();
        return word(/\\\)/y) ? v : undefined;
      }
      const fn = word(/\\(?:boolean|equal|isundefined|isodd)(?![a-zA-Z])/y);
      if (fn) {
        const a = group(s, p);
        if (!a) return undefined;
        p = a.end;
        if (fn === '\\boolean') return this.flags.get(a.content.trim());
        if (fn === '\\isundefined') return !this.isDefined(a.content.trim().replace(/^\\/, ''));
        if (fn === '\\isodd') return Number.isFinite(parseInt(a.content, 10)) ? parseInt(a.content, 10) % 2 !== 0 : undefined;
        const b = group(s, p);
        if (!b) return undefined;
        p = b.end;
        return a.content.trim() === b.content.trim();
      }
      const m = word(/-?\d+\s*[<>=]\s*-?\d+/y);
      if (!m) return undefined;
      const [, a, op, b] = /(-?\d+)\s*([<>=])\s*(-?\d+)/.exec(m) as RegExpExecArray;
      return op === '<' ? +a < +b : op === '>' ? +a > +b : +a === +b;
    };
    const both = (): boolean | undefined => {
      let v = atomic();
      while (word(/\\(?:and|AND)(?![a-zA-Z])/y)) {
        const w = atomic();
        v = v === undefined || w === undefined ? undefined : v && w;
      }
      return v;
    };
    const either = (): boolean | undefined => {
      let v = both();
      while (word(/\\(?:or|OR)(?![a-zA-Z])/y)) {
        const w = both();
        v = v === undefined || w === undefined ? undefined : v || w;
      }
      return v;
    };
    s = s.replace(/\\\s+/g, ' ');
    const v = either();
    ws();
    return p >= s.length ? v : undefined;
  }

  /** Resuelve todos los condicionales de `s`, de izquierda a derecha, y toma nota de lo que define. */
  expand(s: string, read?: ReadFile, depth = 0): string {
    let out = '';
    let i = 0;
    let guard = 0;
    while (i < s.length) {
      const j = s.indexOf('\\', i);
      if (j < 0) break;
      out += s.slice(i, j);
      i = j;
      const name = nameAt(s, i);
      if (!name) {
        out += s.slice(i, i + 2);
        i += 2;
        continue;
      }
      const after = i + 1 + name.length;
      if (this.handles(name) && guard++ < 2000) {
        const r = this.at(s, i);
        if (r) {
          // la rama elegida se sigue leyendo: puede traer más condicionales
          s = r.text + s.slice(r.end);
          i = 0;
          continue;
        }
      }
      if (name === 'usepackage' || name === 'RequirePackage') {
        const o = bracket(s, after);
        const g = group(s, o ? o.end : after);
        if (g) {
          out += `\\usepackage${o ? `[${o.content}]` : ''}{${g.content}}`;
          i = g.end;
          for (const pkg of g.content.split(',').map((x) => x.trim()).filter(Boolean)) {
            const first = !this.packages.has(pkg);
            this.packages.add(pkg);
            // un paquete propio, junto al documento: lo que configura cuenta como parte del preámbulo
            const sty = first && depth < 4 ? read?.(`${pkg}.sty`) : undefined;
            if (sty !== undefined) out += '\n' + this.expand(cleanPackage(sty), read, depth + 1) + '\n';
          }
          continue;
        }
      } else if (name === 'input' || name === 'include') {
        const g = group(s, after);
        const file = g?.content.trim();
        const text = file && depth < 4 ? read?.(/\.[a-z]+$/i.test(file) ? file : `${file}.tex`) : undefined;
        if (g && text !== undefined) {
          out += '\n' + this.expand(uncomment(text), read, depth + 1) + '\n';
          i = g.end;
          continue;
        }
      } else if (/^(re|provide)?newcommand$|^DeclareRobustCommand$|^def$|^gdef$|^edef$|^let$/.test(name)) {
        const m = /^\*?\s*\{?\s*\\([a-zA-Z@]+)/.exec(s.slice(after));
        if (m) this.defined.add(m[1]);
      }
      out += s.slice(i, after);
      i = after;
    }
    return out + s.slice(i);
  }
}

function skipSpaces(s: string, i: number): number {
  while (s[i] === ' ' || s[i] === '\t' || s[i] === '\n') i++;
  return i;
}

/** Ramas de un condicional de TeX a partir de `p`: lo que va hasta `\else` y de ahí a su `\fi`. */
function branches(s: string, p: number): { yes: string; no: string; end: number } | undefined {
  const re = /\\([a-zA-Z@]+)/g;
  re.lastIndex = p;
  let depth = 0;
  let elseAt = -1;
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const n = m[1];
    if (n === 'fi') {
      if (depth-- === 0) {
        const yes = s.slice(p, elseAt < 0 ? m.index : elseAt);
        const no = elseAt < 0 ? '' : s.slice(elseAt + 5, m.index);
        return { yes, no, end: re.lastIndex };
      }
    } else if (n === 'else') {
      if (depth === 0 && elseAt < 0) elseAt = m.index;
    } else if (n.startsWith('if') && !BRACED.has(n)) depth++;
  }
  return undefined;
}

/** Lo que un `.cls` o `.sty` aporta como preámbulo: sin sus declaraciones de paquete. */
function cleanPackage(text: string): string {
  return uncomment(text)
    .replace(/\\(NeedsTeXFormat|ProvidesClass|ProvidesPackage|ProvidesFile)\s*\{[^}]*\}\s*(\[[^\]]*\])?/g, '')
    .replace(/\\(ProcessOptions|ExecuteOptions\s*\{[^}]*\}|endinput)\*?(\\relax)?/g, '')
    .replace(/\\DeclareOption\*?\s*(\{[^}]*\})?\s*\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g, '');
}

/** Clases que LaTeX trae: no se buscan junto al documento. */
const STANDARD = new Set([
  'article', 'report', 'book', 'letter', 'memoir', 'beamer', 'scrartcl', 'scrreprt', 'scrbook', 'scrlttr2', 'amsart', 'amsbook', 'amsproc',
  'IEEEtran', 'standalone', 'extarticle', 'extreport', 'extbook', 'minimal', 'proc', 'slides', 'ltxdoc', 'llncs', 'acmart', 'elsarticle', 'revtex4-2',
]);
const CLASS = /\\documentclass\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/;
const LOAD = /\\LoadClass(?:WithOptions)?\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}\s*(\[[^\]]*\])?/;

/**
 * Sustituye una clase propia (un `.cls` junto al documento) por la clase estándar que carga y lo
 * que configura. Así un `\documentclass{tesis-umsa}` se lee como `\documentclass[12pt]{report}`
 * seguido de sus márgenes, su interlineado, su formato de títulos...
 */
function resolveClass(head: string, read: ReadFile | undefined, depth = 0): { head: string; custom?: string } {
  const m = CLASS.exec(head);
  const name = m?.[2].trim() ?? '';
  if (!m || !read || !name || STANDARD.has(name) || depth > 3) return { head };
  const file = read(`${name}.cls`);
  if (file === undefined) return { head };
  let body = cleanPackage(file);
  const passed: string[] = [];
  body = body.replace(/\\PassOptionsToClass\s*\{([^}]*)\}\s*\{[^}]*\}/g, (_, o: string) => (passed.push(o), ''));
  const load = LOAD.exec(body);
  const base = load?.[2].trim() || 'article';
  if (load) body = body.slice(0, load.index) + body.slice(load.index + load[0].length);
  const opts = [load?.[1], ...passed, m[1]].flatMap((o) => (o ?? '').split(',')).map((o) => o.trim()).filter(Boolean);
  const merged = `\\documentclass${opts.length ? `[${[...new Set(opts)].join(',')}]` : ''}{${base}}\n${body}\n`;
  const next = resolveClass(head.slice(0, m.index) + merged + head.slice(m.index + m[0].length), read, depth + 1);
  return { head: next.head, custom: name };
}

export interface Effective {
  /** el documento con el preámbulo ya resuelto (el cuerpo va tal cual) */
  text: string;
  /** estado de los interruptores al llegar a `\begin{document}`: el cuerpo sigue a partir de él */
  cond: Conditions;
  /** nombre de la clase propia del documento, si la tenía y se ha podido leer */
  customClass?: string;
}

/**
 * El documento tal como hay que leerlo para saber cómo está configurado. `read` da el contenido de
 * un archivo que está junto al documento (por su nombre, con extensión), o `undefined` si no existe.
 */
export function effectiveSource(text: string, read?: ReadFile): Effective {
  const cond = new Conditions(read ? (f) => read(/\.[a-z0-9]+$/i.test(f) ? f : `${f}.tex`) !== undefined : undefined);
  const at = /^[ \t]*\\begin\{document\}/m.exec(text);
  if (!at) return { text, cond };
  const cls = resolveClass(uncomment(text.slice(0, at.index)), read);
  cond.cls = CLASS.exec(cls.head)?.[2].trim() ?? '';
  const head = cond.expand(cls.head, read);
  return { text: head + (head.endsWith('\n') ? '' : '\n') + text.slice(at.index), cond, customClass: cls.custom };
}
