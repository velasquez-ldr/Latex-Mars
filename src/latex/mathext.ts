/*
 * Matemáticas que KaTeX no trae de serie y que los documentos usan a menudo: siunitx (números y
 * unidades), physics, la coma decimal y los operadores de babel en español, y órdenes sueltas de
 * otros paquetes (bbm, dsfont, cancel, upgreek...). Aquí no se dibuja nada: el código de la fórmula
 * se reescribe a LaTeX corriente antes de pasárselo a KaTeX. Sin dependencias de VS Code ni del
 * DOM: lo usan el renderizador y los diálogos del editor.
 */

/** Lo que el preámbulo del documento cambia en cómo se componen sus fórmulas. */
export interface MathContext {
  /** babel en español: operadores propios (\sen, \tg...) y acentuados (lím, máx, mín) */
  spanish?: boolean;
  /** babel en español: el punto decimal de las fórmulas se escribe como coma */
  decimalComma?: boolean;
  /** el documento pide los operadores sin acento (\unaccentedoperators) */
  unaccented?: boolean;
  /** paquete physics */
  physics?: boolean;
  /** ajustes de siunitx (\sisetup) */
  si?: Record<string, string>;
  /** unidades propias (\DeclareSIUnit): nombre de la orden -> su definición */
  units?: Record<string, string>;
  /** delimitadores con nombre (\DeclarePairedDelimiter, de mathtools): orden -> el que abre y el que cierra */
  paired?: Record<string, [string, string]>;
}

// ---------------------------------------------------------------- lectura del código

class Scan {
  constructor(public s: string, public p: number) {}

  ws(): void {
    while (this.s[this.p] === ' ' || this.s[this.p] === '\t' || this.s[this.p] === '\n') this.p++;
  }

  star(): boolean {
    if (this.s[this.p] !== '*') return false;
    this.p++;
    return true;
  }

  /** Argumento opcional entre corchetes (sin consumir nada si no lo hay). */
  opt(): string | undefined {
    let j = this.p;
    while (this.s[j] === ' ' || this.s[j] === '\t') j++;
    if (this.s[j] !== '[') return undefined;
    let depth = 0;
    for (let k = j + 1; k < this.s.length; k++) {
      const ch = this.s[k];
      if (ch === '\\') k++;
      else if (ch === '{') depth++;
      else if (ch === '}') depth--;
      else if (ch === ']' && depth === 0) {
        this.p = k + 1;
        return this.s.slice(j + 1, k);
      }
    }
    return undefined;
  }

  /** Argumento entre llaves (sin consumir nada si no lo hay). */
  group(): string | undefined {
    let j = this.p;
    while (this.s[j] === ' ' || this.s[j] === '\t' || this.s[j] === '\n') j++;
    const end = closing(this.s, j);
    if (end < 0) return undefined;
    this.p = end + 1;
    return this.s.slice(j + 1, end);
  }

  /** Argumento obligatorio: un grupo o, si no lo hay, una sola orden o un solo carácter. */
  arg(): string | undefined {
    const g = this.group();
    if (g !== undefined) return g;
    this.ws();
    if (this.p >= this.s.length) return undefined;
    const m = /^\\(?:[a-zA-Z]+|[\s\S])/.exec(this.s.slice(this.p, this.p + 40));
    const tok = m ? m[0] : this.s[this.p];
    this.p += tok.length;
    return tok;
  }
}

/** Posición de la llave que cierra el grupo que empieza en `i`; -1 si ahí no empieza ninguno o no se cierra. */
function closing(s: string, i: number): number {
  if (s[i] !== '{') return -1;
  let depth = 0;
  for (let k = i; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\') k++;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return k;
  }
  return -1;
}

type Handler = (c: Scan, name: string) => string | undefined;

/**
 * Sustituye en `tex` las órdenes de `table`. Cada una recibe el cursor justo detrás de su nombre,
 * consume sus argumentos y devuelve por qué se cambia (o `undefined` para dejarla como está).
 */
function rewrite(tex: string, table: Record<string, Handler>, skip: (name: string) => boolean): string {
  let out = '';
  let i = 0;
  while (i < tex.length) {
    const j = tex.indexOf('\\', i);
    if (j < 0) break;
    out += tex.slice(i, j);
    const m = /^\\([a-zA-Z]+)/.exec(tex.slice(j, j + 40));
    if (!m) {
      out += tex.slice(j, j + 2);
      i = j + 2;
      continue;
    }
    i = j + m[0].length;
    const fn = Object.prototype.hasOwnProperty.call(table, m[1]) && !skip(m[1]) ? table[m[1]] : undefined;
    const c = new Scan(tex, i);
    const r = fn?.(c, m[1]);
    if (r === undefined) out += m[0];
    else {
      out += r;
      i = c.p;
    }
  }
  return out + tex.slice(i);
}

/** Opciones «clave=valor» separadas por comas, respetando las llaves; una clave sola vale «true». */
export function keyValues(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  let depth = 0;
  let cur = '';
  const push = (): void => {
    const eq = cur.indexOf('=');
    const key = (eq < 0 ? cur : cur.slice(0, eq)).trim();
    if (key) out[key] = eq < 0 ? 'true' : cur.slice(eq + 1).trim().replace(/^\{([\s\S]*)\}$/, '$1');
    cur = '';
  };
  for (const ch of s) {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (ch === ',' && depth === 0) push();
    else cur += ch;
  }
  push();
  return out;
}

// ---------------------------------------------------------------- siunitx

/** Órdenes de siunitx y cuántos argumentos obligatorios llevan. */
export const SI_COMMANDS: Record<string, number> = {
  num: 1, si: 1, unit: 1, SI: 2, qty: 2, ang: 1, numrange: 2, SIrange: 3, qtyrange: 3, numlist: 1, SIlist: 2, qtylist: 2,
  numproduct: 1, qtyproduct: 2, tablenum: 1,
};

const PREFIX: Record<string, string> = {
  quecto: 'q', ronto: 'r', yocto: 'y', zepto: 'z', atto: 'a', femto: 'f', pico: 'p', nano: 'n', micro: 'µ', milli: 'm', centi: 'c', deci: 'd',
  deca: 'da', deka: 'da', hecto: 'h', kilo: 'k', mega: 'M', giga: 'G', tera: 'T', peta: 'P', exa: 'E', zetta: 'Z', yotta: 'Y', ronna: 'R', quetta: 'Q',
  kibi: 'Ki', mebi: 'Mi', gibi: 'Gi', tebi: 'Ti', pebi: 'Pi', exbi: 'Ei', zebi: 'Zi', yobi: 'Yi',
};

const UNIT: Record<string, string> = {
  ampere: 'A', candela: 'cd', kelvin: 'K', kilogram: 'kg', gram: 'g', meter: 'm', metre: 'm', mole: 'mol', second: 's',
  becquerel: 'Bq', degreeCelsius: '°C', celsius: '°C', coulomb: 'C', farad: 'F', gray: 'Gy', hertz: 'Hz', henry: 'H', joule: 'J', katal: 'kat',
  lumen: 'lm', lux: 'lx', newton: 'N', ohm: 'Ω', pascal: 'Pa', radian: 'rad', siemens: 'S', sievert: 'Sv', steradian: 'sr', tesla: 'T', volt: 'V',
  watt: 'W', weber: 'Wb', astronomicalunit: 'au', bel: 'B', dalton: 'Da', day: 'd', decibel: 'dB', degree: '°', electronvolt: 'eV', hectare: 'ha',
  hour: 'h', liter: 'L', litre: 'L', minute: 'min', arcminute: '′', arcsecond: '″', neper: 'Np', tonne: 't', angstrom: 'Å', bar: 'bar', barn: 'b',
  bit: 'bit', byte: 'B', knot: 'kn', mmHg: 'mmHg', nauticalmile: 'M', percent: '%', atomicmassunit: 'u', amu: 'u', dB: 'dB', kWh: 'kWh',
};
/** Abreviaturas de siunitx (\kg, \mm, \kHz, \uF...): un prefijo de una letra y una unidad corta. */
const ABBREVIATION = /^(a|f|p|n|u|m|c|d|h|k|M|G|T)?(mol|ohm|Hz|Pa|eV|Wh|g|m|s|A|l|L|N|V|W|J|F|H|C|K)$/;

interface UnitItem {
  tex: string;
  power?: string;
  sub?: string;
  per?: boolean;
  /** barra escrita tal cual en la unidad («m/s») */
  slash?: boolean;
  /** se pega al número, sin espacio delante (grados, minutos y segundos de arco) */
  tight?: boolean;
}

/** Símbolo de una unidad como código matemático, con las letras derechas. */
function symbolTex(sym: string): string {
  if (sym === '°') return '^{\\circ}';
  if (sym === '°C') return '^{\\circ}\\mathrm{C}';
  if (sym === '′') return '^{\\prime}';
  if (sym === '″') return '^{\\prime\\prime}';
  // (KaTeX no tiene la «µ» derecha: se dibuja con la letra griega)
  return sym.replace(/[A-Za-z]+|[µΩÅ%]/g, (run) => (run === 'µ' ? '\\mu ' : run === 'Ω' ? '\\Omega ' : run === 'Å' ? '\\mathring{\\mathrm{A}}' : run === '%' ? '\\%' : `\\mathrm{${run}}`));
}

class Si {
  private o: Record<string, string>;

  constructor(private ctx: MathContext, local = '') {
    this.o = { ...ctx.si, ...keyValues(local) };
  }

  with(local: string | undefined): Si {
    return local ? new Si({ ...this.ctx, si: this.o }, local) : this;
  }

  /**
   * Marca decimal, entre llaves: así una coma no deja hueco detrás y un punto no lo cambia babel en
   * español (siunitx no sigue a babel: su marca se fija con `output-decimal-marker`).
   */
  private get decimal(): string {
    const m = (this.o['output-decimal-marker'] ?? (/^(DE|FR|PL|ZA)$/.test(this.o.locale ?? '') ? ',' : '.')).trim();
    return m === ',' || m === '.' ? `{${m}}` : m;
  }

  private text(key: string, fallback: string): string {
    return `\\text{${this.o[key] ?? fallback}}`;
  }

  /** Número con el formato de siunitx: cifras agrupadas de tres en tres y exponente como potencia de diez. */
  num(raw: string): string {
    const s = raw.replace(/\s+/g, '');
    const pm = /^(.+?)(?:\+-|\\pm)(.+)$/.exec(s);
    if (pm) return `${this.num(pm[1])} \\pm ${this.num(pm[2])}`;
    const m = /^([+-]?)(\d*)(?:[.,](\d*))?(?:\((\d+)\))?(?:[eEdD]([+-]?\d+))?$/.exec(s);
    if (!m || (m[2] === '' && m[3] === undefined && m[5] === undefined)) return raw;
    let frac = m[3] ?? '';
    // «.5» se escribe «0.5»
    let int = m[2] === '' && frac !== '' ? '0' : m[2];
    // redondeo pedido en las opciones (frecuente en tablas de resultados)
    const places = parseInt(this.o['round-precision'] ?? '', 10);
    if (this.o['round-mode'] === 'places' && places >= 0 && places <= 12 && (int || frac)) {
      [int, frac = ''] = Number(`${int || '0'}.${frac || '0'}`).toFixed(places).split('.');
    }
    const grouped = this.o['group-digits'] !== 'false' && this.o['group-digits'] !== 'none';
    const sep = this.o['group-separator'] ?? '\\,';
    if (grouped && int.length >= 5) int = int.replace(/\B(?=(\d{3})+$)/g, sep);
    if (grouped && frac.length >= 5) frac = frac.replace(/(\d{3})(?=\d)/g, `$1${sep}`);
    let out = int + (frac ? this.decimal + frac : '');
    if (m[4]) out += `(${m[4]})`;
    if (m[5] !== undefined) {
      const power = `10^{${m[5].replace(/^\+/, '')}}`;
      out = out ? `${out} ${this.o['exponent-product'] ?? '\\times'} ${power}` : power;
    }
    return m[1] + out;
  }

  private items(u: string, depth = 0): UnitItem[] {
    const out: UnitItem[] = [];
    let per = false;
    let pow: string | undefined;
    let prefix = '';
    const sticky = this.o['sticky-per'] === 'true';
    const push = (it: UnitItem): void => {
      out.push({ ...it, per: per || undefined, power: it.power ?? pow });
      if (!sticky) per = false;
      pow = undefined;
      prefix = '';
    };
    const last = (): UnitItem | undefined => out[out.length - 1];
    const c = new Scan(u, 0);
    while (c.p < u.length) {
      const ch = u[c.p];
      if (ch === '\\') {
        const m = /^\\([a-zA-Z]+)/.exec(u.slice(c.p, c.p + 40));
        if (!m) {
          // \% es el tanto por ciento; \, \; y «\ » separan unidades
          if (u[c.p + 1] === '%') push({ tex: '\\%' });
          c.p += 2;
          continue;
        }
        c.p += m[0].length;
        const name = m[1];
        const own = this.ctx.units?.[name];
        if (name === 'per') per = true;
        else if (name === 'square') pow = '2';
        else if (name === 'cubic') pow = '3';
        else if (name === 'squared' || name === 'cubed') {
          const l = last();
          if (l) l.power = name === 'squared' ? '2' : '3';
        } else if (name === 'tothe' || name === 'raiseto') {
          const g = c.arg() ?? '';
          const l = last();
          if (name === 'raiseto') pow = g;
          else if (l) l.power = g;
        } else if (name === 'of') {
          const g = c.arg() ?? '';
          const l = last();
          if (l) l.sub = g;
        } else if (own !== undefined && depth < 4) {
          const inner = this.items(own, depth + 1);
          // una unidad propia tras \per va entera al denominador
          for (const it of inner) out.push(per ? { ...it, per: !it.per || undefined } : it);
          if (!sticky) per = false;
        } else if (PREFIX[name] !== undefined) prefix += PREFIX[name];
        else if (UNIT[name] !== undefined) push({ tex: symbolTex(prefix + UNIT[name]), tight: /^[°′″]$/.test(UNIT[name]) });
        else {
          const ab = ABBREVIATION.exec(name);
          if (ab) push({ tex: symbolTex(prefix + (ab[1] === 'u' ? 'µ' : ab[1] ?? '') + (ab[2] === 'ohm' ? 'Ω' : ab[2])) });
          else push({ tex: `\\${name} ` });
        }
      } else if (ch === '^' || ch === '_') {
        c.p++;
        const g = c.arg() ?? '';
        const l = last();
        if (l && ch === '^') l.power = g;
        else if (l) l.sub = g;
      } else if (ch === '/') {
        out.push({ tex: '/', slash: true });
        c.p++;
      } else if (ch === '{') {
        const g = c.group();
        if (g === undefined) c.p++;
        else out.push(...this.items(g, depth + 1));
      } else if (/[A-Za-zµΩÅ°%]/.test(ch)) {
        const run = /^[A-Za-zµΩÅ°%]+/.exec(u.slice(c.p))?.[0] ?? ch;
        c.p += run.length;
        push({ tex: symbolTex(prefix + run), tight: run === '°' });
      } else c.p++; // espacios, «.» y «~»: separan unidades
    }
    return out;
  }

  /** Unidad compuesta: símbolos derechos separados por un espacio fino, con sus potencias. */
  unit(u: string): { tex: string; tight: boolean } {
    const items = this.items(u);
    const one = (it: UnitItem, power: string | undefined): string => it.tex + (it.sub ? `_{\\text{${it.sub}}}` : '') + (power ? `^{${power}}` : '');
    const join = (list: UnitItem[], power: (it: UnitItem) => string | undefined): string => {
      let tex = '';
      list.forEach((it, k) => {
        const glue = k > 0 && !it.slash && !list[k - 1].slash && !it.tight;
        tex += (glue ? this.o['inter-unit-product'] ?? '\\,' : '') + (it.slash ? '/' : one(it, power(it)));
      });
      return tex;
    };
    const mode = this.o['per-mode'] ?? 'power';
    const den = items.filter((it) => it.per && !it.slash);
    let tex: string;
    if (den.length && /symbol|fraction/.test(mode)) {
      const num = join(items.filter((it) => !it.per), (it) => it.power) || '1';
      const below = join(den, (it) => it.power);
      tex = mode === 'fraction' ? `\\frac{${num}}{${below}}` : `${num}/${den.length > 1 ? `(${below})` : below}`;
    } else {
      const negative = (p: string | undefined): string => (p === undefined ? '-1' : p.startsWith('-') ? p.slice(1) : `-${p}`);
      tex = join(items, (it) => (it.per ? negative(it.power) : it.power));
    }
    return { tex, tight: items[0]?.tight === true };
  }

  qty(n: string, u: string): string {
    const unit = this.unit(u);
    const num = this.num(n);
    return num.trim() ? `${num}${unit.tight ? '' : '\\,'}${unit.tex}` : unit.tex;
  }

  /** Ángulo: «12.5» en grados o «1;2;3» en grados, minutos y segundos. */
  ang(a: string): string {
    const marks = ['^{\\circ}', '^{\\prime}', '^{\\prime\\prime}'];
    return a.split(';').map((x, k) => (x.trim() ? this.num(x) + (marks[k] ?? '') : '')).join('');
  }

  list(values: string[]): string {
    if (values.length <= 1) return values.join('');
    if (values.length === 2) return values.join(this.text('list-pair-separator', ' and '));
    return values.slice(0, -1).join(this.text('list-separator', ', ')) + this.text('list-final-separator', ' and ') + values[values.length - 1];
  }

  range(a: string, b: string): string {
    return a + this.text('range-phrase', ' to ') + b;
  }

  product(values: string[]): string {
    return values.join(` ${this.o['product-symbol'] ?? '\\times'} `);
  }
}

function siHandlers(ctx: MathContext): Record<string, Handler> {
  const base = new Si(ctx);
  /** argumentos de la orden; `undefined` si no tiene la forma de siunitx (entonces no se toca) */
  const args = (c: Scan, n: number, mid = false): { si: Si; a: string[] } | undefined => {
    const si = base.with(c.opt());
    const a: string[] = [];
    for (let k = 0; k < n; k++) {
      // \SI{número}[unidad delante]{unidad}
      if (mid && k === n - 1) c.opt();
      const g = c.group();
      if (g === undefined) return undefined;
      a.push(g);
    }
    return { si, a };
  };
  const split = (s: string, by: RegExp): string[] => s.split(by).map((x) => x.trim()).filter(Boolean);
  const h = (n: number, make: (si: Si, a: string[]) => string, mid = false): Handler => (c) => {
    const r = args(c, n, mid);
    return r ? `{${make(r.si, r.a)}}` : undefined;
  };
  return {
    num: h(1, (si, [n]) => si.num(n)),
    tablenum: h(1, (si, [n]) => si.num(n)),
    si: h(1, (si, [u]) => si.unit(u).tex),
    unit: h(1, (si, [u]) => si.unit(u).tex),
    SI: h(2, (si, [n, u]) => si.qty(n, u), true),
    qty: h(2, (si, [n, u]) => si.qty(n, u)),
    ang: h(1, (si, [a]) => si.ang(a)),
    numrange: h(2, (si, [a, b]) => si.range(si.num(a), si.num(b))),
    SIrange: h(3, (si, [a, b, u]) => si.range(si.qty(a, u), si.qty(b, u))),
    qtyrange: h(3, (si, [a, b, u]) => si.range(si.qty(a, u), si.qty(b, u))),
    numlist: h(1, (si, [l]) => si.list(split(l, /;/).map((x) => si.num(x)))),
    SIlist: h(2, (si, [l, u]) => si.list(split(l, /;/).map((x) => si.qty(x, u)))),
    qtylist: h(2, (si, [l, u]) => si.list(split(l, /;/).map((x) => si.qty(x, u)))),
    numproduct: h(1, (si, [l]) => si.product(split(l, /x|\\times/).map((x) => si.num(x)))),
    qtyproduct: h(2, (si, [l, u]) => si.product(split(l, /x|\\times/).map((x) => si.qty(x, u)))),
  };
}

const SI_HINT = new RegExp(`\\\\(?:${Object.keys(SI_COMMANDS).join('|')})(?![a-zA-Z])`);

/** Ajustes de siunitx que fija el documento: todas sus \sisetup, por orden. */
export function siSetup(text: string): Record<string, string> {
  let out: Record<string, string> = {};
  for (const m of text.matchAll(/\\sisetup\s*(?=\{)/g)) {
    const end = closing(text, m.index + m[0].length);
    if (end > 0) out = { ...out, ...keyValues(text.slice(m.index + m[0].length + 1, end)) };
  }
  return out;
}

/** Unidades que define el documento con \DeclareSIUnit. */
export function siUnits(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/\\DeclareSIUnit\s*(?:\[[^\]]*\])?\s*\{?\s*\\([a-zA-Z]+)\s*\}?\s*(?=\{)/g)) {
    const end = closing(text, m.index + m[0].length);
    if (end > 0) out[m[1]] = text.slice(m.index + m[0].length + 1, end);
  }
  return out;
}

// ---------------------------------------------------------------- physics

/** Contenido entre un delimitador y su pareja, a partir de `i` (donde está el que abre). */
function delimited(s: string, i: number): { open: string; close: string; body: string; end: number } | undefined {
  const pairs: Record<string, string> = { '(': ')', '[': ']', '|': '|' };
  let open = s[i];
  let from = i + 1;
  if (s.startsWith('\\{', i)) {
    open = '\\{';
    from = i + 2;
  }
  const close = open === '\\{' ? '\\}' : pairs[open];
  if (!close) return undefined;
  let depth = 0;
  let brace = 0;
  for (let k = from; k < s.length; k++) {
    const ch = s[k];
    if (ch === '\\') {
      if (brace === 0 && open === '\\{' && s[k + 1] === '{') depth++;
      else if (brace === 0 && open === '\\{' && s[k + 1] === '}') {
        if (depth === 0) return { open, close, body: s.slice(from, k), end: k + 2 };
        depth--;
      }
      k++;
    } else if (ch === '{') brace++;
    else if (ch === '}') brace--;
    else if (brace === 0 && open !== '\\{') {
      if (ch === close && (open === '|' || depth === 0)) return { open, close, body: s.slice(from, k), end: k + 1 };
      if (ch === open) depth++;
      else if (ch === close) depth--;
    }
  }
  return undefined;
}

function physicsHandlers(again: (tex: string) => string): Record<string, Handler> {
  const d = (sym: string): Handler => (c) => {
    // \dv{x}, \dv{f}{x}, \dv[n]{f}{x}, \pdv{f}{x}{y}; con asterisco, en una línea
    const flat = c.star();
    const n = c.opt();
    const a = c.group();
    if (a === undefined) return undefined;
    const b = c.group();
    const third = sym === '\\partial' && b !== undefined ? c.group() : undefined;
    const up = n ? `^{${n}}` : '';
    let top: string;
    let bottom: string;
    if (third !== undefined) {
      top = `${sym}^{2} ${again(a)}`;
      bottom = `${sym} ${again(b as string)}\\,${sym} ${again(third)}`;
    } else if (b !== undefined) {
      top = `${sym}${up} ${again(a)}`;
      bottom = `${sym} ${again(b)}${up}`;
    } else {
      top = `${sym}${up}`;
      bottom = `${sym} ${again(a)}${up}`;
    }
    return flat ? `{${top}/${bottom}}` : `\\frac{${top}}{${bottom}}`;
  };
  const fence = (l: string, r: string, n = 1, mid = ', '): Handler => (c) => {
    const small = c.star();
    const a: string[] = [];
    for (let k = 0; k < n; k++) {
      const g = c.group();
      if (g === undefined) return undefined;
      a.push(again(g));
    }
    // con asterisco los delimitadores no crecen (y \middle solo vale entre \left y \right)
    return small ? `${l} ${a.join(mid.replace('\\middle', ''))} ${r}` : `\\left${l} ${a.join(mid)} \\right${r}`;
  };
  /** uno o dos argumentos: con uno solo, se repite */
  const pair = (make: (a: string, b: string) => string): Handler => (c) => {
    c.star();
    const a = c.group();
    if (a === undefined) return undefined;
    const b = c.group();
    return make(again(a), again(b ?? a));
  };
  const bold = (make: (x: string, star: boolean) => string): Handler => (c) => {
    const star = c.star();
    const a = c.arg();
    return a === undefined ? undefined : make(again(a), star);
  };
  const matrix = (env?: string): Handler => (c) => {
    if (env) {
      const g = c.group();
      return g === undefined ? undefined : `\\begin{${env}}${again(g)}\\end{${env}}`;
    }
    c.ws();
    const g = c.group();
    if (g !== undefined) return `\\begin{matrix}${again(g)}\\end{matrix}`;
    const r = delimited(c.s, c.p);
    if (!r) return undefined;
    c.p = r.end;
    const kind = r.open === '(' ? 'pmatrix' : r.open === '[' ? 'bmatrix' : r.open === '|' ? 'vmatrix' : 'Bmatrix';
    return `\\begin{${kind}}${again(r.body)}\\end{${kind}}`;
  };
  const quantity: Handler = (c) => {
    c.ws();
    // \qty\big( ... ): el tamaño pedido no cambia lo que se lee
    const size = /^\\(?:big|Big|bigg|Bigg)(?![a-zA-Z])/.exec(c.s.slice(c.p, c.p + 8));
    if (size) c.p += size[0].length;
    const g = c.group();
    if (g !== undefined) return `\\left\\{ ${again(g)} \\right\\}`;
    const r = delimited(c.s, c.p);
    if (!r) return undefined;
    c.p = r.end;
    const l = r.open === '|' ? '\\lvert' : r.open;
    const rr = r.open === '|' ? '\\rvert' : r.close;
    return `\\left${l} ${again(r.body)} \\right${rr}`;
  };
  const diagonal: Handler = (c) => {
    c.opt();
    const g = c.group();
    if (g === undefined) return undefined;
    const cells = g.split(',').map((x) => again(x.trim()));
    return cells.map((x, i) => cells.map((_, j) => (i === j ? x : '')).join(' & ')).join(' \\\\ ');
  };
  const identity: Handler = (c) => {
    const n = Math.min(parseInt(c.group() ?? '', 10) || 0, 12);
    return n ? Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_x, j) => (i === j ? '1' : '0')).join(' & ')).join(' \\\\ ') : undefined;
  };
  return {
    dv: d('\\mathrm{d}'), derivative: d('\\mathrm{d}'), pdv: d('\\partial'), partialderivative: d('\\partial'), fdv: d('\\delta'), functionalderivative: d('\\delta'),
    dd: (c) => {
      const n = c.opt();
      return `\\mathrm{d}${n ? `^{${n}}` : ''}`;
    },
    differential: (c) => {
      const n = c.opt();
      return `\\mathrm{d}${n ? `^{${n}}` : ''}`;
    },
    qty: quantity, quantity,
    pqty: fence('(', ')'), bqty: fence('[', ']'), vqty: fence('\\lvert', '\\rvert'), Bqty: fence('\\{', '\\}'),
    abs: fence('\\lvert', '\\rvert'), absolutevalue: fence('\\lvert', '\\rvert'), norm: fence('\\lVert', '\\rVert'),
    order: (c) => {
      const g = c.group();
      return g === undefined ? undefined : `\\mathcal{O}\\left( ${again(g)} \\right)`;
    },
    eval: (c) => {
      const g = c.group();
      return g === undefined ? undefined : `\\left. ${again(g)} \\right\\rvert`;
    },
    evaluated: (c) => {
      const g = c.group();
      return g === undefined ? undefined : `\\left. ${again(g)} \\right\\rvert`;
    },
    comm: fence('[', ']', 2), commutator: fence('[', ']', 2), acomm: fence('\\{', '\\}', 2), anticommutator: fence('\\{', '\\}', 2),
    pb: fence('\\{', '\\}', 2), poissonbracket: fence('\\{', '\\}', 2),
    ev: (c) => {
      c.star();
      const a = c.group();
      if (a === undefined) return undefined;
      const b = c.group();
      return b === undefined ? `\\left\\langle ${again(a)} \\right\\rangle` : `\\left\\langle ${again(b)} \\middle| ${again(a)} \\middle| ${again(b)} \\right\\rangle`;
    },
    mel: fence('\\langle', '\\rangle', 3, ' \\middle| '), matrixel: fence('\\langle', '\\rangle', 3, ' \\middle| '), matrixelement: fence('\\langle', '\\rangle', 3, ' \\middle| '),
    braket: pair((a, b) => `\\left\\langle ${a} \\middle| ${b} \\right\\rangle`), ip: pair((a, b) => `\\left\\langle ${a} \\middle| ${b} \\right\\rangle`),
    innerproduct: pair((a, b) => `\\left\\langle ${a} \\middle| ${b} \\right\\rangle`),
    dyad: pair((a, b) => `\\left\\lvert ${a} \\right\\rangle\\!\\left\\langle ${b} \\right\\rvert`), ketbra: pair((a, b) => `\\left\\lvert ${a} \\right\\rangle\\!\\left\\langle ${b} \\right\\rvert`),
    op: pair((a, b) => `\\left\\lvert ${a} \\right\\rangle\\!\\left\\langle ${b} \\right\\rvert`), outerproduct: pair((a, b) => `\\left\\lvert ${a} \\right\\rangle\\!\\left\\langle ${b} \\right\\rvert`),
    vb: bold((x, star) => (star ? `\\boldsymbol{${x}}` : `\\mathbf{${x}}`)), vectorbold: bold((x, star) => (star ? `\\boldsymbol{${x}}` : `\\mathbf{${x}}`)),
    va: bold((x, star) => `\\vec{${star ? `\\boldsymbol{${x}}` : `\\mathbf{${x}}`}}`), vectorarrow: bold((x, star) => `\\vec{${star ? `\\boldsymbol{${x}}` : `\\mathbf{${x}}`}}`),
    vu: bold((x, star) => `\\hat{${star ? `\\boldsymbol{${x}}` : `\\mathbf{${x}}`}}`), vectorunit: bold((x, star) => `\\hat{${star ? `\\boldsymbol{${x}}` : `\\mathbf{${x}}`}}`),
    mqty: matrix(), matrixquantity: matrix(), pmqty: matrix('pmatrix'), bmqty: matrix('bmatrix'), vmqty: matrix('vmatrix'), Pmqty: matrix('Bmatrix'),
    dmat: diagonal, diagonalmatrix: diagonal, imat: identity, identitymatrix: identity,
  };
}
// (se llama `expval` igual que `ev`)
const PHYSICS_ALIASES: Record<string, string> = { expval: 'ev', expectationvalue: 'ev' };

/** Órdenes de physics que no llevan argumentos opcionales: bastan como macros de KaTeX. */
const PHYSICS_MACROS: Record<string, string> = {
  '\\grad': '\\boldsymbol{\\nabla}', '\\gradient': '\\boldsymbol{\\nabla}', '\\div': '\\boldsymbol{\\nabla}\\boldsymbol{\\cdot}',
  '\\divergence': '\\boldsymbol{\\nabla}\\boldsymbol{\\cdot}', '\\curl': '\\boldsymbol{\\nabla}\\boldsymbol{\\times}', '\\laplacian': '\\nabla^{2}',
  '\\vdot': '\\boldsymbol{\\cdot}', '\\dotproduct': '\\boldsymbol{\\cdot}', '\\cross': '\\boldsymbol{\\times}', '\\crossproduct': '\\boldsymbol{\\times}',
  '\\cp': '\\boldsymbol{\\times}', '\\tr': '\\operatorname{tr}', '\\Tr': '\\operatorname{Tr}', '\\rank': '\\operatorname{rank}', '\\erf': '\\operatorname{erf}',
  '\\Res': '\\operatorname{Res}', '\\pv': '\\mathcal{P}', '\\PV': '\\operatorname{P.V.}', '\\Re': '\\operatorname{Re}', '\\Im': '\\operatorname{Im}',
  '\\qq': '\\quad\\text{#1}\\quad', '\\qqtext': '\\quad\\text{#1}\\quad', '\\qc': ',\\quad', '\\qcomma': ',\\quad', '\\qcc': '\\quad\\text{c.c.}\\quad',
  '\\flatfrac': '\\left. #1 \\middle/ #2 \\right.', '\\var': '\\delta', '\\variation': '\\delta', '\\ordersymbol': '\\mathcal{O}',
  ...Object.fromEntries(['if', 'then', 'else', 'otherwise', 'unless', 'given', 'using', 'assume', 'since', 'let', 'for', 'all', 'even', 'odd', 'integer', 'and', 'or', 'as', 'in']
    .map((w) => [`\\q${w}`, `\\quad\\text{${w}}\\quad`])),
  ...Object.fromEntries(['asin', 'acos', 'atan', 'acsc', 'asec', 'acot', 'arccsc', 'arcsec', 'arccot', 'asinh', 'acosh', 'atanh'].map((w) => [`\\${w}`, `\\operatorname{${w}}`])),
};

// ---------------------------------------------------------------- babel en español

/** Operadores que añade babel en español y los que acentúa (lím, máx, mín, ínf, mód). */
const SPANISH_MACROS: Record<string, string> = {
  '\\sen': '\\operatorname{sen}', '\\tg': '\\operatorname{tg}', '\\arcsen': '\\operatorname{arc\\,sen}', '\\arctg': '\\operatorname{arc\\,tg}',
  '\\arccos': '\\operatorname{arc\\,cos}', '\\senh': '\\operatorname{senh}', '\\tgh': '\\operatorname{tgh}', '\\cotg': '\\operatorname{cotg}',
  '\\cosec': '\\operatorname{cosec}',
};
const SPANISH_ACCENTED: Record<string, string> = {
  '\\lim': '\\operatorname*{lím}', '\\limsup': '\\operatorname*{lím\\,sup}', '\\liminf': '\\operatorname*{lím\\,inf}',
  '\\max': '\\operatorname*{máx}', '\\min': '\\operatorname*{mín}', '\\inf': '\\operatorname*{ínf}', '\\bmod': '\\mathbin{\\operatorname{mód}}',
};

/**
 * Órdenes que llevan detrás una medida, un nombre o un texto, y cuántos argumentos entre llaves son
 * así: lo que va en ellos no son cifras de la fórmula.
 */
const NOT_NUMBERS: Record<string, number> = {
  text: 1, textrm: 1, textbf: 1, textit: 1, textsf: 1, texttt: 1, textnormal: 1, textup: 1, mbox: 1, hbox: 1, tag: 1, label: 1, ref: 1, eqref: 1,
  hspace: 1, vspace: 1, kern: 0, mkern: 0, mskip: 0, hskip: 0, rule: 2, color: 1, textcolor: 1, colorbox: 1, begin: 2, end: 1, href: 1, url: 1,
  operatorname: 1, raisebox: 1, scalebox: 1,
};

/** Cambia el punto decimal por una coma en las cifras de una fórmula, como hace babel en español. */
function decimalComma(tex: string): string {
  let out = '';
  let i = 0;
  const n = tex.length;
  /** copia tal cual los argumentos que siguen: los opcionales y hasta `groups` entre llaves */
  const verbatim = (groups: number): void => {
    for (let done = 0; ; ) {
      let j = i;
      while (tex[j] === ' ' || tex[j] === '*') j++;
      const brace = tex[j] === '{';
      if ((brace && done >= groups) || (!brace && tex[j] !== '[')) break;
      const end = brace ? closing(tex, j) : tex.indexOf(']', j);
      if (end < 0) break;
      out += tex.slice(i, end + 1);
      i = end + 1;
      if (brace) done++;
    }
  };
  while (i < n) {
    const ch = tex[i];
    if (ch === '\\') {
      const m = /^\\([a-zA-Z]+)/.exec(tex.slice(i, i + 40));
      if (!m) {
        out += tex.slice(i, i + 2);
        i += 2;
        // \\[1.5ex]: el espacio tras un salto de línea es una medida
        if (tex[i - 1] === '\\') verbatim(0);
        continue;
      }
      out += m[0];
      i += m[0].length;
      const groups = Object.prototype.hasOwnProperty.call(NOT_NUMBERS, m[1]) ? NOT_NUMBERS[m[1]] : undefined;
      if (groups === 0) {
        // \kern1.5em, \hskip 0.5cm: la medida va sin llaves
        const dim = /^\s*-?[\d.]+\s*(?:pt|cm|mm|em|ex|in|mu|bp|pc)/.exec(tex.slice(i, i + 24));
        if (dim) {
          out += dim[0];
          i += dim[0].length;
        }
      } else if (groups !== undefined) verbatim(groups);
    } else if (ch >= '0' && ch <= '9') {
      const num = /^\d+(?:\.\d+)*/.exec(tex.slice(i))?.[0] ?? ch;
      out += num.replace(/\./g, '{,}');
      i += num.length;
    } else {
      out += ch;
      i++;
    }
  }
  return out;
}

// ---------------------------------------------------------------- órdenes sueltas de otros paquetes

const GREEK = [
  'alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'mu', 'nu', 'xi', 'pi', 'rho', 'sigma', 'tau',
  'upsilon', 'phi', 'chi', 'psi', 'omega', 'varepsilon', 'vartheta', 'varpi', 'varrho', 'varsigma', 'varphi',
];
const GREEK_UPPER = ['Gamma', 'Delta', 'Theta', 'Lambda', 'Xi', 'Pi', 'Sigma', 'Upsilon', 'Phi', 'Psi', 'Omega'];

const BASE_MACROS: Record<string, string> = {
  // bbm, dsfont: letras de doble trazo
  '\\mathbbm': '\\mathbb{#1}', '\\mathds': '\\mathbb{#1}', '\\mathbbmss': '\\mathbb{#1}',
  // cancel, slashed
  '\\cancelto': '\\cancel{#2}^{\\,#1}', '\\slashed': '\\cancel{#1}',
  // unicode-math
  '\\symup': '\\mathrm{#1}', '\\symrm': '\\mathrm{#1}', '\\symbf': '\\mathbf{#1}', '\\symit': '\\mathit{#1}', '\\symbb': '\\mathbb{#1}',
  '\\symcal': '\\mathcal{#1}', '\\symscr': '\\mathscr{#1}', '\\symfrak': '\\mathfrak{#1}', '\\symsf': '\\mathsf{#1}', '\\symtt': '\\mathtt{#1}',
  '\\mathup': '\\mathrm{#1}', '\\mathbfit': '\\boldsymbol{#1}',
  // esvect, fracciones en línea, gensymb y otros
  '\\vv': '\\overrightarrow{#1}', '\\widebar': '\\overline{#1}', '\\overbar': '\\overline{#1}', '\\nicefrac': '{}^{#1}\\!/_{#2}', '\\sfrac': '{}^{#1}\\!/_{#2}',
  '\\celsius': '^{\\circ}\\mathrm{C}', '\\micro': '\\mu', '\\ohm': '\\Omega', '\\textmu': '\\mu',
  '\\ensuremath': '#1', '\\qedhere': '', '\\displaybreak': '', '\\textsuperscript': '^{\\text{#1}}', '\\textsubscript': '_{\\text{#1}}',
  '\\hdots': '\\ldots', '\\hfill': '\\qquad',
  // upgreek: letras griegas derechas (KaTeX solo las tiene inclinadas)
  ...Object.fromEntries(GREEK.map((g) => [`\\up${g}`, `\\${g}`])),
  ...Object.fromEntries(GREEK_UPPER.map((g) => [`\\Up${g.toLowerCase()}`, `\\${g}`])),
};

/** Macros de KaTeX para lo que el documento usa de estos paquetes; las del propio documento mandan sobre ellas. */
export function mathMacros(ctx: MathContext = {}): Record<string, string> {
  return {
    ...BASE_MACROS,
    ...(ctx.physics ? PHYSICS_MACROS : {}),
    ...(ctx.spanish ? SPANISH_MACROS : {}),
    ...(ctx.spanish && !ctx.unaccented ? SPANISH_ACCENTED : {}),
  };
}

const PHYSICS_HINT = /\\(?:[pf]?dv|dd|[pbvB]?qty|abs|norm|order|eval|a?comm|pb|ev|expval|mel|matrixel|braket|ip|dyad|ketbra|op|v[bau]|[pbvP]?mqty|[di]mat|[a-z]+(?:derivative|quantity|value|product|matrix|bold|arrow|unit|bracket|commutator|element|ated))(?![a-zA-Z])/;

/**
 * Deja una fórmula lista para KaTeX. `defined` dice si el documento define por su cuenta una orden
 * (entonces vale su definición y aquí no se toca).
 */
export function prepareMath(tex: string, ctx: MathContext = {}, defined: (name: string) => boolean = () => false): string {
  let out = tex;
  const paired = Object.keys(ctx.paired ?? {});
  // (la \qty de siunitx lleva dos grupos; la de physics, un paréntesis que se ajusta a su contenido)
  if (SI_HINT.test(out)) out = rewrite(out, siHandlers(ctx), defined);
  if (ctx.physics === true && PHYSICS_HINT.test(out)) {
    const own = (name: string): boolean => defined(name) || paired.includes(name);
    const table = physicsHandlers((t) => (PHYSICS_HINT.test(t) ? rewrite(t, table, own) : t));
    for (const [alias, name] of Object.entries(PHYSICS_ALIASES)) table[alias] = table[name];
    out = rewrite(out, table, own);
  }
  if (paired.length && paired.some((name) => out.includes(`\\${name}`))) out = rewrite(out, pairedHandlers(ctx.paired ?? {}), () => false);
  if (ctx.decimalComma && /\d\.\d/.test(out)) out = decimalComma(out);
  return out;
}

/**
 * Delimitadores de mathtools: `\abs{x}` los pone a su tamaño, `\abs*{x}` los ajusta al contenido y
 * `\abs[\Big]{x}` les da el tamaño pedido.
 */
function pairedHandlers(paired: Record<string, [string, string]>): Record<string, Handler> {
  const table: Record<string, Handler> = {};
  for (const [name, [l, r]] of Object.entries(paired)) {
    table[name] = (c) => {
      const auto = c.star();
      const size = /^\\(big|Big|bigg|Bigg)$/.exec((c.opt() ?? '').trim())?.[1];
      const g = c.group();
      if (g === undefined) return undefined;
      const inner = rewrite(g, table, () => false);
      if (auto) return `\\left${l} ${inner} \\right${r}`;
      return size ? `\\${size}l${l} ${inner} \\${size}r${r}` : `${l} ${inner} ${r}`;
    };
  }
  return table;
}

/** Delimitadores que el documento declara con \DeclarePairedDelimiter (mathtools). */
export function pairedDelimiters(text: string): Record<string, [string, string]> {
  const out: Record<string, [string, string]> = {};
  for (const m of text.matchAll(/\\DeclarePairedDelimiter\s*\{?\s*\\([a-zA-Z]+)\s*\}?\s*(?=\{)/g)) {
    const c = new Scan(text, m.index + m[0].length);
    const l = c.group();
    const r = c.group();
    if (l !== undefined && r !== undefined && l.trim() && r.trim()) out[m[1]] = [l.trim(), r.trim()];
  }
  return out;
}
