/**
 * Intérprete reducido de macros de TeX. Mars no compila, pero muchos documentos generan su
 * contenido con bucles y condiciones (`\foreach`, `\ifnum`, `\csname`, `\pgfmathparse`...). Este
 * módulo ejecuta esa parte sobre el texto y devuelve LaTeX corriente, que ya sabe dibujar el
 * renderizador. Lo que no entiende lo deja tal cual; lo que solo puede calcular un compilador de
 * verdad (Lua, expl3) lo sustituye por `\MarsComputed{...}`.
 */

export interface ExpandHost {
  /** valor actual de un contador de LaTeX (`\newcounter`, secciones, figuras...) */
  counter(name: string): number | undefined;
}

interface Param {
  /** m: obligatorio · o: opcional entre corchetes · s: asterisco · d: delimitado por un texto */
  kind: 'm' | 'o' | 's' | 'd';
  def?: string;
  delim?: string;
}

interface Def {
  params: Param[];
  body: string;
  /** variable de un bucle o resultado de un cálculo: se sustituye siempre */
  isVar?: boolean;
  /** definida con expl3: no se puede ejecutar; `prints` dice si escribe algo en el documento */
  opaque?: boolean;
  prints?: boolean;
}

interface Env {
  params: Param[];
  begin: string;
  end: string;
}

const NOVALUE = '-NoValue-';
class Abort extends Error {}

/** Órdenes que este módulo ejecuta y el renderizador no sabría dibujar. */
const TRIGGER =
  /\\(?:foreach|ifnum|ifcase|ifx|ifodd|ifdim|ifcsname|csname|pgfmathparse|pgfmathsetmacro|pgfmathtruncatemacro|pgfmathresult|numexpr|loop|advance|setkeys|directlua|luaexec|IfNoValueTF|IfValueTF|IfBooleanTF)(?![a-zA-Z])/;
/** Cuerpo de una macro que necesita ejecutarse aquí (no basta con sustituir sus argumentos). */
const PROG_BODY =
  /\\(?:foreach|ifnum|ifcase|ifx|ifodd|ifdim|ifcsname|csname|pgfmath[a-zA-Z]+|numexpr|loop|advance|setkeys|directlua|luaexec|IfNoValue[TF]+|IfValue[TF]+|IfBoolean[TF]+|def|gdef|edef|xdef|let)(?![a-zA-Z])/;
const DEFINES =
  /\\(?:def|gdef|edef|xdef|let|(?:re|provide)?newcommand|(?:re)?newenvironment|(?:New|Renew|Provide|Declare)Document(?:Command|Environment)|DeclareRobustCommand|newif|newcount|(?:re)?newtcolorbox|define@key|ExplSyntaxOn|makeatletter)(?![a-zA-Z])/;
const PRIM_IFS = new Set([
  'if', 'ifx', 'ifnum', 'ifdim', 'ifodd', 'ifcase', 'iftrue', 'iffalse', 'ifmmode', 'ifhmode', 'ifvmode', 'ifinner', 'ifcat', 'ifdefined', 'ifcsname',
  'ifvoid', 'ifhbox', 'ifvbox', 'ifeof', 'ifpdf', 'ifxetex', 'ifluatex', 'ifXeTeX', 'ifLuaTeX', 'ifPDFTeX',
]);
const RAW_ENVS = new Set(['verbatim', 'verbatim*', 'lstlisting', 'minted', 'Verbatim', 'alltt', 'comment']);
const DROP_ENVS = new Set(['luacode', 'luacode*', 'filecontents', 'filecontents*']);
const TIKZ_ENVS = new Set(['tikzpicture', 'circuitikz', 'tikzcd']);
const NATIVE_ENVS = new Set([
  'proof', 'abstract', 'quote', 'quotation', 'verse', 'itemize', 'enumerate', 'description', 'figure', 'table', 'center', 'titlepage',
  'thebibliography', 'tabular', 'equation', 'align', 'minipage', 'frame',
]);
const BUILTIN = new Set(['relax', 'space', 'undefined', 'par', 'end']);
const CS = /[a-zA-Z@]+/y;

function group(s: string, i: number): { content: string; end: number } | undefined {
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
  if (s[i] !== '[') return undefined;
  let depth = 0;
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') j++;
    else if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === ']' && depth === 0) return { content: s.slice(i + 1, j), end: j + 1 };
  }
  return undefined;
}

const ws = (s: string, i: number): number => {
  while (i < s.length && /\s/.test(s[i])) i++;
  return i;
};

/** Tras una orden, TeX se salta los espacios (y un salto de línea, pero no una línea en blanco). */
function eat(s: string, i: number): number {
  let j = i;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t')) j++;
  if (s[j] === '\n') {
    let k = j + 1;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t')) k++;
    if (s[k] !== '\n') return k;
  }
  return j;
}

/** Parte por un separador que no esté dentro de llaves ni de paréntesis. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let last = 0;
  for (let j = 0; j < s.length; j++) {
    const c = s[j];
    if (c === '\\') j++;
    else if (c === '{' || c === '(') depth++;
    else if (c === '}' || c === ')') depth--;
    else if (c === sep && depth <= 0) {
      out.push(s.slice(last, j));
      last = j + 1;
    }
  }
  out.push(s.slice(last));
  return out;
}

/** Quita las llaves de un argumento que va entero entre ellas. */
function unbrace(s: string): string {
  const t = s.trim();
  const g = t.startsWith('{') ? group(t, 0) : undefined;
  return g && g.end === t.length ? g.content.trim() : t;
}

/** Quita los comentarios como TeX: hasta el fin de línea, con la sangría de la línea siguiente. */
export function uncomment(text: string): string {
  const lines = text.split(/\r?\n/);
  const out: string[] = [];
  let verb = '';
  let glue = false;
  for (const line of lines) {
    if (verb) {
      out.push(line);
      if (line.includes(`\\end{${verb}}`)) verb = '';
      continue;
    }
    let cut = -1;
    for (let i = 0; i < line.length; i++) {
      if (line[i] === '\\') i++;
      else if (line[i] === '%') {
        // dentro de una cadena entre comillas (código Lua: "%d", "%.2f") no abre un comentario
        if ((line.slice(0, i).match(/"/g)?.length ?? 0) % 2 === 1 && line.indexOf('"', i) > i) continue;
        cut = i;
        break;
      }
    }
    const m = /\\begin\{([a-zA-Z]+\*?)\}/.exec(cut < 0 ? line : line.slice(0, cut));
    if (m && (RAW_ENVS.has(m[1]) || DROP_ENVS.has(m[1])) && !line.includes(`\\end{${m[1]}}`, m.index)) {
      verb = m[1];
      out.push(line);
      glue = false;
      continue;
    }
    const kept = cut < 0 ? line : line.slice(0, cut);
    // una línea que solo llevaba un comentario desaparece sin dejar una línea en blanco
    if (cut >= 0 && kept.trim() === '') continue;
    if (glue && out.length) out[out.length - 1] += kept.replace(/^[ \t]+/, '');
    else out.push(kept);
    glue = cut >= 0;
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- aritmética

const FUNCS: Record<string, (...a: number[]) => number> = {
  int: (a) => Math.trunc(a),
  floor: Math.floor,
  ceil: Math.ceil,
  round: (a) => Math.sign(a) * Math.floor(Math.abs(a) + 0.5),
  abs: Math.abs,
  sqrt: Math.sqrt,
  min: Math.min,
  max: Math.max,
  mod: (a, b) => a - b * Math.trunc(a / b),
  Mod: (a, b) => a - b * Math.floor(a / b),
  div: (a, b) => Math.trunc(a / b),
  pow: Math.pow,
  exp: Math.exp,
  ln: Math.log,
  log10: Math.log10,
  log2: Math.log2,
  sin: (a) => Math.sin((a * Math.PI) / 180),
  cos: (a) => Math.cos((a * Math.PI) / 180),
  tan: (a) => Math.tan((a * Math.PI) / 180),
  deg: (a) => (a * 180) / Math.PI,
  rad: (a) => (a * Math.PI) / 180,
  factorial: (a) => {
    let f = 1;
    for (let k = 2; k <= a && k < 171; k++) f *= k;
    return f;
  },
  sign: Math.sign,
  ifthenelse: (c, a, b) => (c ? a : b),
  equal: (a, b) => (a === b ? 1 : 0),
  less: (a, b) => (a < b ? 1 : 0),
  greater: (a, b) => (a > b ? 1 : 0),
  notequal: (a, b) => (a !== b ? 1 : 0),
  isodd: (a) => (Math.abs(Math.trunc(a)) % 2 === 1 ? 1 : 0),
  iseven: (a) => (Math.abs(Math.trunc(a)) % 2 === 0 ? 1 : 0),
};

/**
 * Valor de una expresión aritmética al estilo de pgfmath (`int(mod(3*4,7))`) o, con `integer`, de
 * `\numexpr` (la división redondea, como en TeX). NaN si no se entiende.
 */
export function calc(expr: string, integer = false): number {
  const s = expr.replace(/\s+/g, '');
  let p = 0;
  const fail = (): never => {
    throw new Error('expr');
  };
  const or = (): number => {
    let v = and();
    while (s.startsWith('||', p)) {
      p += 2;
      const r = and();
      v = v || r ? 1 : 0;
    }
    return v;
  };
  const and = (): number => {
    let v = cmp();
    while (s.startsWith('&&', p)) {
      p += 2;
      const r = cmp();
      v = v && r ? 1 : 0;
    }
    return v;
  };
  const cmp = (): number => {
    const a = add();
    const m = /^(==|!=|<=|>=|<|>)/.exec(s.slice(p, p + 2));
    if (!m) return a;
    p += m[1].length;
    const b = add();
    switch (m[1]) {
      case '==': return a === b ? 1 : 0;
      case '!=': return a !== b ? 1 : 0;
      case '<=': return a <= b ? 1 : 0;
      case '>=': return a >= b ? 1 : 0;
      case '<': return a < b ? 1 : 0;
      default: return a > b ? 1 : 0;
    }
  };
  const add = (): number => {
    let v = mul();
    while (s[p] === '+' || s[p] === '-') {
      const op = s[p++];
      const r = mul();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const mul = (): number => {
    let v = unary();
    while (s[p] === '*' || s[p] === '/') {
      const op = s[p++];
      const r = unary();
      if (op === '*') v *= r;
      else if (r === 0) fail();
      else if (integer) v = Math.sign(v / r) * Math.floor(Math.abs(v / r) + 0.5);
      else v /= r;
    }
    return v;
  };
  const unary = (): number => {
    if (s[p] === '-') {
      p++;
      return -unary();
    }
    if (s[p] === '+') {
      p++;
      return unary();
    }
    if (s[p] === '!' && s[p + 1] !== '=') {
      p++;
      return unary() ? 0 : 1;
    }
    let v = primary();
    while (s[p] === '!' && s[p + 1] !== '=') {
      p++;
      v = FUNCS.factorial(v);
    }
    if (s[p] === '^') {
      p++;
      v = Math.pow(v, unary());
    }
    return v;
  };
  const primary = (): number => {
    if (s[p] === '(') {
      p++;
      const v = or();
      if (s[p] !== ')') fail();
      p++;
      return v;
    }
    const num = /^\d*\.?\d+(?:[eE][-+]?\d+)?/.exec(s.slice(p));
    if (num) {
      p += num[0].length;
      return parseFloat(num[0]);
    }
    const name = /^[a-zA-Z][a-zA-Z0-9]*/.exec(s.slice(p));
    if (!name) return fail();
    p += name[0].length;
    if (s[p] === '(') {
      p++;
      const args: number[] = [];
      if (s[p] !== ')') {
        args.push(or());
        while (s[p] === ',') {
          p++;
          args.push(or());
        }
      }
      if (s[p] !== ')') fail();
      p++;
      const f = FUNCS[name[0]];
      if (!f) return fail();
      return f(...args);
    }
    if (name[0] === 'pi') return Math.PI;
    if (name[0] === 'e') return Math.E;
    if (name[0] === 'true') return 1;
    if (name[0] === 'false') return 0;
    return fail();
  };
  try {
    if (!s) return NaN;
    const v = or();
    return p === s.length && Number.isFinite(v) ? v : NaN;
  } catch {
    return NaN;
  }
}

/** Número como lo escribe pgfmath: los enteros de `int(...)` sin decimales, el resto con ellos. */
function pgfNumber(v: number, expr: string): string {
  if (/^\s*int\s*\(/.test(expr)) return String(Math.trunc(v));
  if (Number.isInteger(v)) return `${v}.0`;
  return String(+v.toFixed(5));
}

const plainNumber = (v: number): string => (Number.isInteger(v) ? String(v) : String(+v.toFixed(5)));

// ---------------------------------------------------------------- definiciones

/** Texto de parámetros de `\def` (`#1#2\end`) como lista de argumentos. */
function parsePattern(text: string): Param[] {
  const out: Param[] = [];
  const re = /#(\d)([^#]*)/g;
  for (const m of text.matchAll(re)) {
    const delim = m[2].trim();
    out.push(delim ? { kind: 'd', delim } : { kind: 'm' });
  }
  return out;
}

/** Especificación de argumentos de xparse (`o m`, `O{x} m m`, `s m`). */
function parseSpec(spec: string): Param[] {
  const out: Param[] = [];
  for (let i = 0; i < spec.length; i++) {
    const c = spec[i];
    if (c === 'm' || c === 'v' || c === 'g') out.push({ kind: 'm' });
    else if (c === 'o') out.push({ kind: 'o' });
    else if (c === 's') out.push({ kind: 's' });
    else if (c === 'O') {
      const g = group(spec, ws(spec, i + 1));
      out.push({ kind: 'o', def: g?.content ?? '' });
      if (g) i = g.end - 1;
    }
  }
  return out;
}

export class Expander {
  private defs = new Map<string, Def>();
  /** definiciones de fuera mientras se ejecuta el cuerpo de un bucle (que en TeX es un grupo) */
  private scopes: Map<string, Def>[] = [];
  private envs = new Map<string, Env>();
  private counts = new Map<string, number>();
  private ifs = new Map<string, boolean>();
  private keys = new Map<string, Map<string, { body: string; def?: string }>>();
  /** contadores de LaTeX cambiados durante la ejecución en curso */
  private shadow = new Map<string, number>();
  private atLetter = false;
  private globalNext = false;
  private steps = 0;
  private size = 0;
  private progMemo = new Map<string, boolean>();
  /** dentro de un dibujo TikZ: sus bucles los ejecuta TikZ, y estas son sus variables */
  private masked: Set<string> | undefined;
  private rand = 0;
  /** condicionales que no se han podido evaluar y siguen abiertos */
  private rawIfs = 0;

  constructor(private readonly host: ExpandHost) {}

  // ------------------------------------------------------------ interfaz

  /** Ejecuta el preámbulo solo por sus definiciones. */
  load(preamble: string): void {
    this.run(preamble);
  }

  /**
   * Qué hay que hacer con un bloque: 'program' si hay que ejecutarlo (su resultado es contenido
   * generado), 'defs' si solo trae definiciones que conviene conocer, o nada.
   */
  needs(src: string): 'program' | 'defs' | undefined {
    if (!src.includes('\\')) return undefined;
    // los bucles de dentro de un dibujo son cosa de TikZ
    const text = src.replace(/\\begin\{(tikzpicture|circuitikz|tikzcd|lstlisting|verbatim|minted)\}[\s\S]*?\\end\{\1\}/g, '');
    if (TRIGGER.test(text)) return 'program';
    for (const m of text.matchAll(/\\begin\s*\{([^}]*)\}/g)) if (this.envs.has(m[1].trim())) return 'program';
    if (this.defs.size) {
      for (let i = text.indexOf('\\'); i >= 0; i = text.indexOf('\\', i + 1)) {
        const name = this.csname(text, i);
        if (!name) {
          i++;
          continue;
        }
        if (this.defs.has(name) && this.isProg(name)) return 'program';
        i += name.length;
      }
    }
    return DEFINES.test(text) ? 'defs' : undefined;
  }

  /** LaTeX resultante de ejecutar `src`; `undefined` si no se pudo (demasiado largo, recursión sin fin). */
  run(src: string): string | undefined {
    this.steps = 0;
    this.size = 0;
    this.rawIfs = 0;
    this.shadow.clear();
    const saved = this.defs;
    try {
      return this.expand(uncomment(src), 0);
    } catch {
      this.defs = this.scopes[0] ?? saved;
      this.scopes = [];
      this.masked = undefined;
      return undefined;
    }
  }

  // ------------------------------------------------------------ estado

  private define(name: string, def: Def, global = false): void {
    this.defs.set(name, def);
    if (global) for (const s of this.scopes) s.set(name, def);
    this.progMemo.clear();
  }

  private undefine(name: string): void {
    this.defs.delete(name);
    this.progMemo.clear();
  }

  private known(name: string): boolean {
    if (this.defs.has(name) || this.counts.has(name) || name === 'define@key') return true;
    if (name.startsWith('if') && this.ifs.has(name.slice(2))) return true;
    const m = /^(.*)(true|false)$/.exec(name);
    return m !== null && this.ifs.has(m[1]);
  }

  /** Nombre de la orden que empieza en `s[i] === '\\'`; vacío si es un símbolo (`\%`, `\\`). */
  private csname(s: string, i: number): string {
    CS.lastIndex = i + 1;
    const m = CS.exec(s);
    if (!m) return '';
    const long = m[0];
    if (!long.includes('@') || this.atLetter || this.known(long)) return long;
    return /^[a-zA-Z]+/.exec(long)?.[0] ?? '';
  }

  private isIf(name: string): boolean {
    return PRIM_IFS.has(name) || name.startsWith('if@') || (name.startsWith('if') && this.ifs.has(name.slice(2)));
  }

  /** La macro hay que ejecutarla aquí: el renderizador no sabría con solo sustituir argumentos. */
  private isProg(name: string, seen = new Set<string>()): boolean {
    const memo = this.progMemo.get(name);
    if (memo !== undefined) return memo;
    const d = this.defs.get(name);
    if (!d || seen.has(name)) return false;
    seen.add(name);
    let prog = d.opaque === true || d.isVar === true || name.includes('@') || d.params.some((p) => p.kind !== 'm') || PROG_BODY.test(d.body);
    if (!prog) {
      for (const m of d.body.matchAll(/\\begin\s*\{([^}]*)\}/g)) if (this.envs.has(m[1].trim())) prog = true;
      for (let i = d.body.indexOf('\\'); !prog && i >= 0; i = d.body.indexOf('\\', i + 1)) {
        const inner = this.csname(d.body, i);
        if (!inner) {
          i++;
          continue;
        }
        if (inner.startsWith('if') && this.ifs.has(inner.slice(2))) prog = true;
        else if (inner !== name && this.defs.has(inner) && this.isProg(inner, seen)) prog = true;
        i += inner.length;
      }
    }
    this.progMemo.set(name, prog);
    return prog;
  }

  private ctr(name: string): number {
    return this.shadow.get(name) ?? this.host.counter(name) ?? 0;
  }

  private tick(): void {
    if (++this.steps > 400_000) throw new Abort();
  }

  // ------------------------------------------------------------ expansión

  private expand(s: string, depth: number): string {
    if (depth > 150) throw new Abort();
    let out = '';
    let i = 0;
    const n = s.length;
    while (i < n) {
      if (s[i] !== '\\') {
        let j = i + 1;
        while (j < n && s[j] !== '\\') j++;
        out += s.slice(i, j);
        i = j;
        continue;
      }
      const name = this.csname(s, i);
      if (!name) {
        out += s.slice(i, i + 2);
        i += 2;
        continue;
      }
      const after = i + 1 + name.length;
      const r = this.handle(name, s, after, depth);
      if (r) {
        out += r.out;
        i = r.end;
        this.size += r.out.length;
        if (this.size > 4_000_000) throw new Abort();
      } else {
        out += `\\${name}`;
        i = after;
      }
    }
    return out;
  }

  private handle(name: string, s: string, i: number, depth: number): { out: string; end: number } | undefined {
    this.tick();
    const none = (end: number): { out: string; end: number } => ({ out: '', end });
    switch (name) {
      case 'makeatletter':
        this.atLetter = true;
        return none(eat(s, i));
      case 'makeatother':
        this.atLetter = false;
        return none(eat(s, i));
      case 'relax':
        return none(eat(s, i));
      case 'space':
        return { out: ' ', end: eat(s, i) };
      case 'expandafter': case 'noexpand': case 'protect': case 'long': case 'protected': case 'outer':
        return none(i);
      case 'global':
        this.globalNext = true;
        return none(eat(s, i));
      case 'def': case 'gdef': case 'edef': case 'xdef':
        return this.readDef(name, s, i, depth);
      case 'newcommand': case 'renewcommand': case 'providecommand': case 'DeclareRobustCommand':
        return this.readNewcommand(name, s, i);
      case 'NewDocumentCommand': case 'RenewDocumentCommand': case 'ProvideDocumentCommand': case 'DeclareDocumentCommand':
        return this.readDocumentCommand(s, i);
      case 'newenvironment': case 'renewenvironment': case 'NewDocumentEnvironment': case 'RenewDocumentEnvironment':
        return this.readEnvironment(name, s, i);
      case 'newtcolorbox': case 'renewtcolorbox':
        return this.readTcolorbox(s, i);
      case 'let':
        return this.readLet(s, i, depth);
      case 'csname': {
        const r = this.named(s, i, depth);
        if (!r) return undefined;
        const d = this.defs.get(r.name);
        return d ? this.call(d, r.name, s, r.end, depth) : none(r.end);
      }
      case 'else': case 'fi': case 'or': case 'repeat':
        // los de un \if que no se pudo evaluar se quedan a la vista con él; los demás, sueltos, no dibujan nada
        if (this.rawIfs > 0 && name !== 'repeat') {
          if (name === 'fi') this.rawIfs--;
          return undefined;
        }
        return none(eat(s, i));
      case 'ifcase': {
        const v = this.num(s, i, depth);
        if (!v) return this.cond(false, s, i, depth);
        const b = this.branches(s, v.end);
        const k = Math.trunc(v.v);
        const text = k >= 0 && k < b.parts.length ? b.parts[k] : b.other ?? '';
        return { out: this.expand(text, depth + 1), end: b.end };
      }
      case 'foreach':
        return this.foreach(s, i, depth);
      case 'loop':
        return this.loop(s, i, depth);
      case 'newcount': {
        const p = ws(s, i);
        CS.lastIndex = p + 1;
        const m = s[p] === '\\' ? CS.exec(s) : null;
        if (!m) return undefined;
        this.counts.set(m[0], 0);
        return none(eat(s, p + 1 + m[0].length));
      }
      case 'newif': {
        const p = ws(s, i);
        CS.lastIndex = p + 1;
        const m = s[p] === '\\' ? CS.exec(s) : null;
        if (!m || !m[0].startsWith('if')) return undefined;
        this.ifs.set(m[0].slice(2), false);
        return none(eat(s, p + 1 + m[0].length));
      }
      case 'advance': case 'multiply': case 'divide': {
        const p = ws(s, i);
        const reg = s[p] === '\\' ? this.csname(s, p) : '';
        if (!reg || !this.counts.has(reg)) return undefined;
        let q = ws(s, p + 1 + reg.length);
        if (s.startsWith('by', q)) q += 2;
        const v = this.num(s, q, depth);
        if (!v) return undefined;
        const old = this.counts.get(reg) ?? 0;
        this.counts.set(reg, name === 'advance' ? old + v.v : name === 'multiply' ? old * v.v : v.v ? Math.trunc(old / v.v) : old);
        return none(eat(s, v.end));
      }
      case 'the': case 'number': {
        const p = ws(s, i);
        if (s[p] !== '\\') return undefined;
        const what = this.csname(s, p);
        if (what === 'numexpr' || what === 'value' || this.counts.has(what)) {
          const v = this.num(s, p, depth);
          return v ? { out: plainNumber(v.v), end: v.end } : undefined;
        }
        const d = new Date();
        const date: Record<string, number> = { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
        return date[what] === undefined ? undefined : { out: String(date[what]), end: eat(s, p + 1 + what.length) };
      }
      case 'numexpr': {
        const v = this.numexpr(s, i, depth);
        return v ? { out: plainNumber(v.v), end: v.end } : undefined;
      }
      case 'pgfmathparse': case 'pgfmathsetmacro': case 'pgfmathtruncatemacro': {
        if (this.masked) return undefined;
        let p = ws(s, i);
        let target = 'pgfmathresult';
        if (name !== 'pgfmathparse') {
          const g0 = group(s, p);
          const raw = g0 ? g0.content.trim() : s[p] === '\\' ? `\\${this.rawName(s, p)}` : '';
          if (!raw.startsWith('\\')) return undefined;
          target = raw.slice(1);
          p = ws(s, g0 ? g0.end : p + raw.length);
        }
        const g = group(s, p);
        if (!g) return undefined;
        const expr = this.expand(g.content, depth + 1);
        const v = calc(expr);
        const text = Number.isNaN(v) ? expr.trim() : name === 'pgfmathtruncatemacro' ? String(Math.trunc(v)) : pgfNumber(v, expr);
        this.define(target, { params: [], body: text, isVar: true });
        return none(eat(s, g.end));
      }
      case 'setcounter': case 'addtocounter': case 'stepcounter': case 'refstepcounter': {
        const g = group(s, ws(s, i));
        if (!g) return undefined;
        const k = g.content.trim();
        if (name === 'stepcounter' || name === 'refstepcounter') {
          this.shadow.set(k, this.ctr(k) + 1);
          return { out: `\\${name}{${k}}`, end: g.end };
        }
        const g2 = group(s, ws(s, g.end));
        if (!g2) return undefined;
        const text = this.expand(g2.content, depth + 1).trim();
        const v = this.num(text, 0, depth);
        const value = v && ws(text, v.end) === text.length ? v.v : calc(text.replace(/\\value\s*\{([^}]*)\}/g, (_, c: string) => String(this.ctr(c.trim()))), true);
        if (Number.isNaN(value)) return { out: `\\${name}{${k}}{${text}}`, end: g2.end };
        this.shadow.set(k, name === 'setcounter' ? value : this.ctr(k) + value);
        return { out: `\\${name}{${k}}{${value}}`, end: g2.end };
      }
      case 'define@key': {
        const fam = group(s, ws(s, i));
        const key = fam ? group(s, ws(s, fam.end)) : undefined;
        if (!fam || !key) return undefined;
        let p = ws(s, key.end);
        const def = bracket(s, p);
        if (def) p = ws(s, def.end);
        const body = group(s, p);
        if (!body) return undefined;
        const family = this.keys.get(fam.content.trim()) ?? new Map<string, { body: string; def?: string }>();
        family.set(key.content.trim(), { body: body.content, def: def?.content });
        this.keys.set(fam.content.trim(), family);
        return none(eat(s, body.end));
      }
      case 'setkeys': {
        const fam = group(s, ws(s, i));
        const list = fam ? group(s, ws(s, fam.end)) : undefined;
        const family = fam ? this.keys.get(fam.content.trim()) : undefined;
        if (!fam || !list || !family) return undefined;
        let out = '';
        for (const item of splitTop(this.expand(list.content, depth + 1), ',')) {
          const eq = item.indexOf('=');
          const key = (eq < 0 ? item : item.slice(0, eq)).trim();
          const k = family.get(key);
          if (!k) continue;
          const value = eq < 0 ? k.def ?? '' : unbrace(item.slice(eq + 1));
          out += this.expand(k.body.replace(/#1/g, () => value), depth + 1);
        }
        return { out, end: list.end };
      }
      case 'IfNoValueTF': case 'IfValueTF': case 'IfNoValueT': case 'IfNoValueF': case 'IfValueT': case 'IfValueF': case 'IfBooleanTF': case 'IfBooleanT': case 'IfBooleanF': {
        const a = group(s, ws(s, i));
        const b = a ? group(s, ws(s, a.end)) : undefined;
        if (!a || !b) return undefined;
        const both = name.endsWith('TF');
        const c = both ? group(s, ws(s, b.end)) : undefined;
        if (both && !c) return undefined;
        const arg = a.content.trim();
        let yes = name.startsWith('IfBoolean') ? arg === '\\BooleanTrue' : arg === NOVALUE;
        if (name.startsWith('IfValue')) yes = !yes;
        const pick = both ? (yes ? b.content : (c as { content: string }).content) : yes === name.endsWith('T') ? b.content : '';
        return { out: this.expand(pick, depth + 1), end: (c ?? b).end };
      }
      case 'ifthenelse': {
        const a = group(s, ws(s, i));
        const b = a ? group(s, ws(s, a.end)) : undefined;
        const c = b ? group(s, ws(s, b.end)) : undefined;
        if (!a || !b || !c) return undefined;
        const test = this.expand(a.content, depth + 1).trim();
        let v: boolean | undefined;
        const eq = /^\\equal\s*\{([^{}]*)\}\s*\{([^{}]*)\}$/.exec(test);
        const odd = /^\\isodd\s*\{([^{}]*)\}$/.exec(test);
        if (eq) v = eq[1].trim() === eq[2].trim();
        else if (odd && !Number.isNaN(calc(odd[1]))) v = Math.abs(Math.trunc(calc(odd[1]))) % 2 === 1;
        else if (/^[-+\d.\s()*/]+[<>=][-+\d.\s()*/]+$/.test(test)) {
          const m = /^(.*?)([<>=])(.*)$/.exec(test) as RegExpExecArray;
          const x = calc(m[1]);
          const y = calc(m[3]);
          if (!Number.isNaN(x) && !Number.isNaN(y)) v = m[2] === '<' ? x < y : m[2] === '>' ? x > y : x === y;
        }
        // lo demás (\boolean, \and, \or...) lo resuelve el renderizador
        if (v === undefined) return undefined;
        return { out: this.expand(v ? b.content : c.content, depth + 1), end: c.end };
      }
      case 'ExplSyntaxOn':
        return this.expl(s, i);
      case 'directlua': case 'luaexec': case 'luadirect': {
        const g = group(s, ws(s, i));
        if (!g) return undefined;
        return { out: /tex\.s?print|tex\.write/.test(g.content) ? '\\MarsComputed{Lua}' : '', end: g.end };
      }
      case 'catcode': {
        const m = /\s*`\\?[\s\S]\s*=?\s*\d+/y;
        m.lastIndex = i;
        const r = m.exec(s);
        return r ? none(eat(s, i + r[0].length)) : undefined;
      }
      case 'begin':
        return this.begin(s, i, depth);
    }
    if (this.isIf(name)) {
      const t = this.test(name, s, i, depth);
      if (t.v === undefined) {
        // no se sabe evaluar: se deja escrito, sin inventar una rama
        this.rawIfs++;
        return undefined;
      }
      return this.cond(t.v, s, t.end, depth);
    }
    const flag = /^(.*)(true|false)$/.exec(name);
    if (flag && this.ifs.has(flag[1])) {
      this.ifs.set(flag[1], flag[2] === 'true');
      return none(eat(s, i));
    }
    if (this.counts.has(name)) {
      let p = ws(s, i);
      if (s[p] === '=') p++;
      const v = this.num(s, p, depth);
      if (!v) return none(eat(s, i));
      this.counts.set(name, v.v);
      return none(eat(s, v.end));
    }
    const d = this.defs.get(name);
    if (d && !this.masked?.has(name) && this.isProg(name)) return this.call(d, name, s, i, depth);
    return undefined;
  }

  /** Nombre tal como está escrito tras la barra (con @), para definirlo. */
  private rawName(s: string, i: number): string {
    CS.lastIndex = i + 1;
    return CS.exec(s)?.[0] ?? s[i + 1] ?? '';
  }

  /** `\csname ... \endcsname` a partir de `i` (detrás de `\csname`): el nombre que forma. */
  private named(s: string, i: number, depth: number): { name: string; end: number } | undefined {
    const e = s.indexOf('\\endcsname', i);
    if (e < 0) return undefined;
    return { name: this.expand(s.slice(i, e), depth + 1).trim(), end: e + 10 };
  }

  /** Nombre que se va a definir: `\x`, `{\x}` o `\csname x\endcsname`. */
  private target(s: string, i: number, depth: number): { name: string; end: number } | undefined {
    let p = ws(s, i);
    while (s.startsWith('\\expandafter', p)) p = ws(s, p + 12);
    if (s[p] === '{') {
      const g = group(s, p);
      const inner = g?.content.trim() ?? '';
      if (!g || !inner.startsWith('\\')) return undefined;
      return { name: inner.slice(1), end: g.end };
    }
    if (s[p] !== '\\') return undefined;
    if (s.startsWith('\\csname', p)) return this.named(s, p + 7, depth);
    const name = this.rawName(s, p);
    return name ? { name, end: p + 1 + name.length } : undefined;
  }

  private takeGlobal(): boolean {
    const g = this.globalNext;
    this.globalNext = false;
    return g;
  }

  private readDef(kind: string, s: string, i: number, depth: number): { out: string; end: number } | undefined {
    const t = this.target(s, i, depth);
    if (!t) return undefined;
    const open = s.indexOf('{', t.end);
    const g = open < 0 ? undefined : group(s, open);
    if (!g) return undefined;
    const params = parsePattern(s.slice(t.end, open));
    const body = kind === 'edef' || kind === 'xdef' ? this.expand(g.content, depth + 1) : g.content;
    const global = this.takeGlobal() || kind === 'gdef' || kind === 'xdef';
    this.define(t.name, { params, body }, global);
    return { out: '', end: eat(s, g.end) };
  }

  private readNewcommand(kind: string, s: string, i: number): { out: string; end: number } | undefined {
    let p = ws(s, i);
    if (s[p] === '*') p = ws(s, p + 1);
    const t = this.target(s, p, 0);
    if (!t) return undefined;
    p = ws(s, t.end);
    let n = 0;
    const count = bracket(s, p);
    if (count) {
      n = parseInt(count.content, 10) || 0;
      p = ws(s, count.end);
    }
    const def = n > 0 ? bracket(s, p) : undefined;
    if (def) p = ws(s, def.end);
    const g = group(s, p);
    if (!g) return undefined;
    const params: Param[] = Array.from({ length: n }, (_, k) => (k === 0 && def ? { kind: 'o', def: def.content } : { kind: 'm' }));
    const global = this.takeGlobal();
    if (kind !== 'providecommand' || !this.defs.has(t.name)) this.define(t.name, { params, body: g.content }, global);
    return { out: '', end: eat(s, g.end) };
  }

  private readDocumentCommand(s: string, i: number): { out: string; end: number } | undefined {
    const t = this.target(s, i, 0);
    const spec = t ? group(s, ws(s, t.end)) : undefined;
    const body = spec ? group(s, ws(s, spec.end)) : undefined;
    if (!t || !spec || !body) return undefined;
    this.define(t.name, { params: parseSpec(spec.content), body: body.content });
    return { out: '', end: eat(s, body.end) };
  }

  private readEnvironment(kind: string, s: string, i: number): { out: string; end: number } | undefined {
    const name = group(s, ws(s, i));
    if (!name) return undefined;
    let p = ws(s, name.end);
    let params: Param[] = [];
    if (kind.includes('Document')) {
      const spec = group(s, p);
      if (!spec) return undefined;
      params = parseSpec(spec.content);
      p = ws(s, spec.end);
    } else {
      const count = bracket(s, p);
      const n = count ? parseInt(count.content, 10) || 0 : 0;
      if (count) p = ws(s, count.end);
      const def = n > 0 ? bracket(s, p) : undefined;
      if (def) p = ws(s, def.end);
      params = Array.from({ length: n }, (_, k) => (k === 0 && def ? { kind: 'o', def: def.content } : { kind: 'm' }));
    }
    const begin = group(s, p);
    const end = begin ? group(s, ws(s, begin.end)) : undefined;
    if (!begin || !end) return undefined;
    // un entorno de LaTeX que el documento retoca por dentro (\renewenvironment{proof}...) se dibuja como siempre
    if (kind.toLowerCase().startsWith('renew') && NATIVE_ENVS.has(name.content.trim())) return { out: '', end: eat(s, end.end) };
    this.envs.set(name.content.trim(), { params, begin: begin.content, end: end.content });
    this.progMemo.clear();
    return { out: '', end: eat(s, end.end) };
  }

  /** `\newtcolorbox{nombre}[n][defecto]{opciones}`: un entorno que abre un tcolorbox con ellas. */
  private readTcolorbox(s: string, i: number): { out: string; end: number } | undefined {
    let p = ws(s, i);
    const init = bracket(s, p);
    if (init) p = ws(s, init.end);
    const name = group(s, p);
    if (!name) return undefined;
    p = ws(s, name.end);
    const count = bracket(s, p);
    const n = count ? parseInt(count.content, 10) || 0 : 0;
    if (count) p = ws(s, count.end);
    const def = n > 0 ? bracket(s, p) : undefined;
    if (def) p = ws(s, def.end);
    const opts = group(s, p);
    if (!opts) return undefined;
    const params: Param[] = Array.from({ length: n }, (_, k) => (k === 0 && def ? { kind: 'o', def: def.content } : { kind: 'm' }));
    this.envs.set(name.content.trim(), { params, begin: `\\begin{tcolorbox}[${opts.content.replace(/#(\d)/g, '{#$1}')}]`, end: '\\end{tcolorbox}' });
    this.progMemo.clear();
    return { out: '', end: eat(s, opts.end) };
  }

  private readLet(s: string, i: number, depth: number): { out: string; end: number } | undefined {
    const t = this.target(s, i, depth);
    if (!t) return undefined;
    let p = ws(s, t.end);
    if (s[p] === '=') p = ws(s, p + 1);
    const from = this.target(s, p, depth);
    const global = this.takeGlobal();
    if (!from) {
      // \let\x=c (un carácter)
      this.define(t.name, { params: [], body: s[p] ?? '' }, global);
      return { out: '', end: eat(s, p + 1) };
    }
    const d = this.defs.get(from.name);
    if (d) this.define(t.name, d, global);
    else if (this.counts.has(from.name)) this.counts.set(t.name, this.counts.get(from.name) ?? 0);
    else this.undefine(t.name);
    return { out: '', end: eat(s, from.end) };
  }

  /** Lee los argumentos de una macro a partir de `i`. */
  private args(params: Param[], s: string, i: number): { args: string[]; end: number } {
    const args: string[] = [];
    let p = i;
    for (const prm of params) {
      if (prm.kind === 's') {
        const q = ws(s, p);
        if (s[q] === '*') {
          args.push('\\BooleanTrue');
          p = q + 1;
        } else args.push('\\BooleanFalse');
      } else if (prm.kind === 'o') {
        const q = ws(s, p);
        const b = bracket(s, q);
        if (b) {
          args.push(b.content);
          p = b.end;
        } else args.push(prm.def ?? NOVALUE);
      } else if (prm.kind === 'd') {
        const delim = prm.delim ?? '';
        let depth = 0;
        let j = p;
        for (; j < s.length; j++) {
          const c = s[j];
          if (depth === 0 && s.startsWith(delim, j)) break;
          if (c === '\\') j++;
          else if (c === '{') depth++;
          else if (c === '}') depth--;
        }
        args.push(unbrace(s.slice(p, j)));
        p = Math.min(j + delim.length, s.length);
      } else {
        const q = ws(s, p);
        const g = group(s, q);
        if (g) {
          args.push(g.content);
          p = g.end;
        } else if (s[q] === '\\') {
          const name = this.csname(s, q) || s[q + 1] || '';
          args.push(`\\${name}`);
          p = q + 1 + name.length;
        } else if (s[q] === '}' || s[q] === ']') {
          // falta el argumento (el documento lo dejó sin escribir): vacío, sin comerse el cierre
          args.push('');
        } else if (q < s.length) {
          args.push(s[q]);
          p = q + 1;
        } else args.push('');
      }
    }
    return { args, end: p };
  }

  private call(d: Def, name: string, s: string, i: number, depth: number): { out: string; end: number } {
    const a = this.args(d.params, s, i);
    const end = d.params.length ? a.end : eat(s, i);
    if (d.opaque) return { out: d.prints ? `\\MarsComputed{${name}}` : '', end };
    const body = d.params.length
      ? d.body.replace(/#(#|\d)/g, (_, k: string, at: number) => {
          if (k === '#') return '#';
          const arg = a.args[parseInt(k, 10) - 1] ?? '';
          // tras una orden (\macro#1), un argumento que empieza por letra no debe pegarse a su nombre
          return /^[a-zA-Z@]/.test(arg) && /\\[a-zA-Z@]+$/.test(d.body.slice(Math.max(at - 40, 0), at)) ? ` ${arg}` : arg;
        })
      : d.body;
    return { out: d.isVar && !body.includes('\\') ? body : this.expand(body, depth + 1), end };
  }

  // ------------------------------------------------------------ números

  /** Número en `s[i]`: cifras, un registro, `\numexpr`, `\value{...}` o una macro que lo contenga. */
  private num(s: string, i: number, depth: number): { v: number; end: number } | undefined {
    let p = ws(s, i);
    let sign = 1;
    while (s[p] === '-' || s[p] === '+') {
      if (s[p] === '-') sign = -sign;
      p = ws(s, p + 1);
    }
    const digits = /\d*\.?\d+/y;
    digits.lastIndex = p;
    const m = digits.exec(s);
    if (m) {
      let end = p + m[0].length;
      if (s[end] === ' ') end++;
      return { v: sign * parseFloat(m[0]), end };
    }
    if (s[p] === '`') {
      const q = s[p + 1] === '\\' ? p + 2 : p + 1;
      return { v: sign * (s.codePointAt(q) ?? 0), end: q + 1 };
    }
    if (s[p] !== '\\') return undefined;
    const name = this.csname(s, p);
    const after = p + 1 + name.length;
    if (name === 'numexpr') {
      const r = this.numexpr(s, after, depth);
      return r ? { v: sign * r.v, end: r.end } : undefined;
    }
    if (name === 'value') {
      const g = group(s, ws(s, after));
      const k = g?.content.trim() ?? '';
      // un contador que Mars no lleva (el de página, por ejemplo) no se inventa
      if (!g || (!this.shadow.has(k) && this.host.counter(k) === undefined)) return undefined;
      return { v: sign * this.ctr(k), end: g.end };
    }
    if (name === 'pdfuniformdeviate' || name === 'pdfrandom' || name === 'uniformdeviate') {
      const r = this.num(s, after, depth);
      return { v: this.rand++ % Math.max(r?.v ?? 1, 1), end: r?.end ?? after };
    }
    if (this.counts.has(name)) return { v: sign * (this.counts.get(name) ?? 0), end: eat(s, after) };
    const d = this.defs.get(name);
    if (d && !d.opaque) {
      const c = this.call(d, name, s, after, depth);
      const text = c.out.trim();
      const inner = this.num(text, 0, depth);
      const v = inner && ws(text, inner.end) === text.length ? inner.v : calc(text);
      return Number.isNaN(v) ? undefined : { v: sign * v, end: c.end };
    }
    if (name.startsWith('the') && this.host.counter(name.slice(3)) !== undefined) return { v: sign * this.ctr(name.slice(3)), end: eat(s, after) };
    return undefined;
  }

  /** `\numexpr ... \relax` a partir de `i` (detrás de `\numexpr`). */
  private numexpr(s: string, i: number, depth: number): { v: number; end: number } | undefined {
    let expr = '';
    let p = i;
    while (p < s.length) {
      const c = s[p];
      if (/[\d\s+\-*/().]/.test(c)) {
        expr += c;
        p++;
        continue;
      }
      if (c !== '\\') break;
      const name = this.csname(s, p);
      if (name === 'relax') {
        p = p + 6;
        break;
      }
      const v = this.num(s, p, depth);
      if (!v) break;
      expr += `(${v.v})`;
      p = v.end;
    }
    const v = calc(expr, true);
    return Number.isNaN(v) ? undefined : { v, end: p };
  }

  // ------------------------------------------------------------ condicionales

  /** Evalúa la condición de un `\if...` cuyo nombre acaba en `i`. */
  private test(name: string, s: string, i: number, depth: number): { v: boolean | undefined; end: number } {
    switch (name) {
      case 'iftrue': return { v: true, end: i };
      case 'ifnum': case 'ifdim': {
        const a = this.num(s, i, depth);
        if (!a) return { v: undefined, end: i };
        let p = ws(s, a.end);
        if (name === 'ifdim') p = ws(s, p + (/^[a-z]{2}/.exec(s.slice(p, p + 2)) ? 2 : 0));
        const rel = s[p];
        const b = '<>='.includes(rel) ? this.num(s, p + 1, depth) : undefined;
        if (!b) return { v: undefined, end: a.end };
        let end = b.end;
        if (name === 'ifdim' && /^[a-z]{2}/.test(s.slice(end, end + 2))) end += 2;
        return { v: rel === '<' ? a.v < b.v : rel === '>' ? a.v > b.v : a.v === b.v, end };
      }
      case 'ifodd': {
        const a = this.num(s, i, depth);
        return a ? { v: Math.abs(Math.trunc(a.v)) % 2 === 1, end: a.end } : { v: false, end: i };
      }
      case 'ifx': {
        const a = this.token(s, ws(s, i), true);
        const b = this.token(s, a.end, a.cs);
        return { v: this.sameToken(a, b), end: b.end };
      }
      case 'ifcsname': {
        const r = this.named(s, i, depth);
        return r ? { v: this.defs.has(r.name) || this.counts.has(r.name), end: r.end } : { v: false, end: i };
      }
      case 'ifdefined': {
        const p = ws(s, i);
        const what = s[p] === '\\' ? this.rawName(s, p) : '';
        return { v: this.defs.has(what) || this.counts.has(what), end: what ? p + 1 + what.length : i };
      }
      case 'ifpdf': case 'ifPDFTeX':
        return { v: true, end: i };
      default: {
        if (name.startsWith('if') && this.ifs.has(name.slice(2))) return { v: this.ifs.get(name.slice(2)) === true, end: i };
        return { v: false, end: i };
      }
    }
  }

  private token(s: string, i: number, skip: boolean): { t: string; cs: boolean; end: number } {
    let p = i;
    if (skip) while (s[p] === ' ' || s[p] === '\n' || s[p] === '\t') p++;
    if (s[p] === '\\') {
      const name = this.csname(s, p) || s[p + 1] || '';
      return { t: name, cs: true, end: p + 1 + name.length };
    }
    return { t: s[p] ?? '', cs: false, end: p + 1 };
  }

  private sameToken(a: { t: string; cs: boolean }, b: { t: string; cs: boolean }): boolean {
    if (a.cs !== b.cs) return false;
    if (!a.cs) return a.t === b.t;
    const da = this.defs.get(a.t);
    const db = this.defs.get(b.t);
    if (da && db) return da.body === db.body && JSON.stringify(da.params) === JSON.stringify(db.params);
    if (da || db) return false;
    // dos órdenes sin definir significan lo mismo (\ifx\algo\undefined)
    const free = (t: string): boolean => !BUILTIN.has(t) || t === 'undefined';
    return a.t === b.t || (free(a.t) && free(b.t));
  }

  /** Ramas de un condicional a partir de `i` (tras su condición), hasta su `\fi`. */
  private branches(s: string, i: number): { parts: string[]; other?: string; end: number } {
    const parts: string[] = [];
    let other: string | undefined;
    let depth = 0;
    let start = i;
    let inElse = false;
    let j = i;
    const close = (to: number): void => {
      if (inElse) other = s.slice(start, to);
      else parts.push(s.slice(start, to));
    };
    while (j < s.length) {
      if (s[j] !== '\\') {
        j++;
        continue;
      }
      const name = this.csname(s, j);
      if (!name) {
        j += 2;
        continue;
      }
      const e = j + 1 + name.length;
      if (name === 'loop') {
        // el \if que gobierna un \loop no lleva \fi: su final es \repeat
        const r = s.indexOf('\\repeat', e);
        j = r < 0 ? e : r + 7;
        continue;
      }
      if (this.isIf(name)) depth++;
      else if (name === 'fi') {
        if (depth === 0) {
          close(j);
          return { parts, other, end: eat(s, e) };
        }
        depth--;
      } else if (depth === 0 && name === 'or' && !inElse) {
        parts.push(s.slice(start, j));
        start = e;
      } else if (depth === 0 && name === 'else' && !inElse) {
        parts.push(s.slice(start, j));
        start = e;
        inElse = true;
      }
      j = e;
    }
    close(s.length);
    return { parts, other, end: s.length };
  }

  private cond(v: boolean, s: string, i: number, depth: number): { out: string; end: number } {
    const b = this.branches(s, i);
    const text = v ? b.parts[0] ?? '' : b.other ?? '';
    return { out: this.expand(text, depth + 1), end: b.end };
  }

  // ------------------------------------------------------------ bucles

  /** Cabecera y cuerpo de un `\foreach` cuyo nombre acaba en `i`. */
  private foreachParts(s: string, i: number, depth: number): { vars: string[]; opts: string; list: string; body: string; end: number } | undefined {
    let p = ws(s, i);
    let opts = '';
    const takeOpts = (): void => {
      const b = bracket(s, p);
      if (b) {
        opts += `,${b.content}`;
        p = ws(s, b.end);
      }
    };
    takeOpts();
    const vars: string[] = [];
    while (s[p] === '\\') {
      const name = this.rawName(s, p);
      vars.push(name);
      p = ws(s, p + 1 + name.length);
      if (s[p] !== '/') break;
      p = ws(s, p + 1);
    }
    if (!vars.length) return undefined;
    takeOpts();
    if (!s.startsWith('in', p)) return undefined;
    p = ws(s, p + 2);
    let list: string;
    const g = group(s, p);
    if (g) {
      list = g.content;
      p = g.end;
    } else if (s[p] === '\\') {
      const name = this.csname(s, p);
      const d = this.defs.get(name);
      if (!d) return undefined;
      list = unbrace(this.expand(d.body, depth + 1));
      p += 1 + name.length;
    } else return undefined;
    const q = ws(s, p);
    const b = group(s, q);
    if (b) return { vars, opts, list, body: b.content, end: b.end };
    if (s.startsWith('\\foreach', q)) {
      // el cuerpo es otro bucle entero
      const inner = this.foreachParts(s, q + 8, depth);
      if (!inner) return undefined;
      return { vars, opts, list, body: s.slice(q, inner.end), end: inner.end };
    }
    const semi = s.indexOf(';', q);
    if (semi < 0) return undefined;
    return { vars, opts, list, body: s.slice(q, semi + 1), end: semi + 1 };
  }

  /** Elementos de la lista de un `\foreach`, con sus series (`1,...,10`, `0,0.5,...,2`, `a,...,e`). */
  private items(list: string, depth: number): string[] {
    const text = list.includes('\\') ? this.expand(list, depth + 1) : list;
    const raw = splitTop(text, ',').map((x) => x.trim());
    if (raw.length && raw[raw.length - 1] === '') raw.pop();
    const out: string[] = [];
    for (let k = 0; k < raw.length; k++) {
      if (raw[k] === '...' && out.length && k + 1 < raw.length) {
        const from = out[out.length - 1];
        const to = raw[k + 1];
        const a = calc(from);
        const z = calc(to);
        if (!Number.isNaN(a) && !Number.isNaN(z)) {
          const prev = out.length >= 2 ? calc(out[out.length - 2]) : NaN;
          const step = !Number.isNaN(prev) && prev !== a ? a - prev : z >= a ? 1 : -1;
          const count = Math.min(Math.floor((z - a) / step + 1e-9), 5000);
          for (let m = 1; m <= count; m++) out.push(plainNumber(a + m * step));
          k++;
          continue;
        }
        if (/^[a-zA-Z]$/.test(from) && /^[a-zA-Z]$/.test(to)) {
          const step = to >= from ? 1 : -1;
          for (let c = from.charCodeAt(0) + step; step > 0 ? c <= to.charCodeAt(0) : c >= to.charCodeAt(0); c += step) out.push(String.fromCharCode(c));
          k++;
          continue;
        }
      }
      out.push(raw[k]);
    }
    return out.slice(0, 5000);
  }

  private foreach(s: string, i: number, depth: number): { out: string; end: number } | undefined {
    const f = this.foreachParts(s, i, depth);
    if (!f) return undefined;
    if (this.masked) {
      // dentro de un dibujo el bucle es de TikZ: sus variables no se tocan
      for (const v of f.vars) this.masked.add(v);
      for (const m of f.opts.matchAll(/\\([a-zA-Z@]+)/g)) this.masked.add(m[1]);
      return undefined;
    }
    const count = /count\s*=\s*\\([a-zA-Z@]+)(?:\s+from\s+(-?\d+))?/.exec(f.opts);
    const evaluate = /evaluate\s*=\s*\\([a-zA-Z@]+)(?:\s+as\s+\\([a-zA-Z@]+))?(?:\s+using\s+([^,]+))?/.exec(f.opts);
    const outer = this.defs;
    const pieces: string[] = [];
    this.items(f.list, depth).forEach((item, k) => {
      this.tick();
      this.scopes.push(outer);
      this.defs = new Map(outer);
      this.progMemo.clear();
      const parts = f.vars.length > 1 ? splitTop(unbrace(item), '/').map(unbrace) : [unbrace(item)];
      f.vars.forEach((v, q) => this.defs.set(v, { params: [], body: parts[Math.min(q, parts.length - 1)], isVar: true }));
      if (count) this.defs.set(count[1], { params: [], body: String(k + (count[2] === undefined ? 1 : parseInt(count[2], 10))), isVar: true });
      if (evaluate) {
        const source = this.defs.get(evaluate[1])?.body ?? '';
        const v = calc(this.expand(evaluate[3] ?? source, depth + 1));
        if (!Number.isNaN(v)) this.defs.set(evaluate[2] ?? evaluate[1], { params: [], body: plainNumber(v), isVar: true });
      }
      try {
        pieces.push(this.expand(f.body, depth + 1).trim());
      } finally {
        this.defs = outer;
        this.scopes.pop();
        this.progMemo.clear();
      }
    });
    return { out: pieces.join('\n'), end: f.end };
  }

  /** `\loop A \if... B \repeat`: A, y mientras se cumpla la condición, B y otra vez A. */
  private loop(s: string, i: number, depth: number): { out: string; end: number } | undefined {
    const e = s.indexOf('\\repeat', i);
    if (e < 0) return undefined;
    const body = s.slice(i, e);
    // la condición es el \if del cuerpo que no se cierra dentro de él
    const open: { at: number; name: string }[] = [];
    for (let j = body.indexOf('\\'); j >= 0; j = body.indexOf('\\', j + 1)) {
      const name = this.csname(body, j);
      if (!name) {
        j++;
        continue;
      }
      if (this.isIf(name)) open.push({ at: j, name });
      else if (name === 'fi') open.pop();
      j += name.length;
    }
    const ctl = open[0];
    if (!ctl) return undefined;
    const before = body.slice(0, ctl.at);
    let out = '';
    for (let k = 0; k < 20_000; k++) {
      this.tick();
      out += this.expand(before, depth + 1);
      const t = this.test(ctl.name, body, ctl.at + 1 + ctl.name.length, depth);
      if (!t.v) break;
      out += this.expand(body.slice(t.end), depth + 1);
    }
    return { out, end: eat(s, e + 7) };
  }

  // ------------------------------------------------------------ entornos y regiones

  private begin(s: string, i: number, depth: number): { out: string; end: number } | undefined {
    const g = group(s, ws(s, i));
    if (!g) return undefined;
    const name = g.content.trim();
    const close = `\\end{${name}}`;
    if (RAW_ENVS.has(name) || DROP_ENVS.has(name)) {
      const e = s.indexOf(close, g.end);
      const end = e < 0 ? s.length : e + close.length;
      return { out: DROP_ENVS.has(name) ? '' : `\\begin{${name}}${s.slice(g.end, end)}`, end };
    }
    if (TIKZ_ENVS.has(name)) {
      const e = s.indexOf(close, g.end);
      if (e < 0) return undefined;
      const saved = this.masked;
      this.masked = new Set(saved);
      try {
        return { out: `\\begin{${name}}${this.expand(s.slice(g.end, e), depth + 1)}${close}`, end: e + close.length };
      } finally {
        this.masked = saved;
      }
    }
    const env = this.envs.get(name);
    if (!env) return undefined;
    const a = this.args(env.params, s, g.end);
    // su \end, contando los del mismo nombre que se abran dentro
    const open = `\\begin{${name}}`;
    let nest = 0;
    let e = -1;
    for (let j = a.end; j < s.length; j++) {
      if (s.startsWith(open, j)) nest++;
      else if (s.startsWith(close, j)) {
        if (nest === 0) {
          e = j;
          break;
        }
        nest--;
      }
    }
    if (e < 0) return undefined;
    const fill = (code: string): string => code.replace(/#(#|\d)/g, (_, k: string) => (k === '#' ? '#' : a.args[parseInt(k, 10) - 1] ?? ''));
    const out = `${this.expand(fill(env.begin), depth + 1)}${this.expand(s.slice(a.end, e), depth + 1)}${this.expand(fill(env.end), depth + 1)}`;
    return { out, end: e + close.length };
  }

  /**
   * Región de expl3 (`\ExplSyntaxOn ... \ExplSyntaxOff`): no se ejecuta. De ella solo se anotan
   * las órdenes de documento que define, para saltarse sus argumentos y avisar donde escriben algo.
   */
  private expl(s: string, i: number): { out: string; end: number } {
    const e = s.indexOf('\\ExplSyntaxOff', i);
    const region = s.slice(i, e < 0 ? s.length : e);
    const fns = new Map<string, string>();
    for (const m of region.matchAll(/\\cs_(?:new|set|gset)(?:_protected)?(?:_nopar)?:Npn\s*\\([a-zA-Z_:@]+)[^{]*/g)) {
      const g = group(region, m.index + m[0].length);
      if (g) fns.set(m[1], g.content);
    }
    const prints = (body: string, seen: Set<string>): boolean => {
      if (/_use:|_item:|\\(?:fp|int|dim)_eval:n|\\(?:tl|seq|clist|str|prop)_(?:use|map_inline)|\\text|\\begin|\\item\b|\\\\|&/.test(body)) return true;
      for (const m of body.matchAll(/\\([a-zA-Z_:@]+)/g)) {
        const inner = fns.get(m[1]);
        if (inner !== undefined && !seen.has(m[1])) {
          seen.add(m[1]);
          if (prints(inner, seen)) return true;
        }
      }
      return false;
    };
    for (const m of region.matchAll(/\\(?:New|Renew|Provide|Declare)DocumentCommand\s*\{?\s*\\([a-zA-Z@]+)\s*\}?\s*/g)) {
      const spec = group(region, m.index + m[0].length);
      const body = spec ? group(region, ws(region, spec.end)) : undefined;
      if (spec && body) this.define(m[1], { params: parseSpec(spec.content), body: '', opaque: true, prints: prints(body.content, new Set()) }, true);
    }
    return { out: '', end: e < 0 ? s.length : eat(s, e + 14) };
  }
}
