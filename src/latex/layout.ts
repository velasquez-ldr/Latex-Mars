/*
 * Configuración de página (la pestaña «Disposición»): se lee del preámbulo y se escribe en él.
 * Todo son funciones puras sobre el texto del documento.
 */

export interface Layout {
  /** clase del documento: article, report, book... */
  cls: string;
  /** a4paper, letterpaper...; 'custom' si el tamaño se fija con paperwidth/paperheight */
  paper: string;
  /** tamaño personalizado «ancho,alto» (p. ej. "18cm,24cm"); vacío si el papel es estándar */
  paperSize: string;
  /** 10pt, 11pt, 12pt */
  fontSize: string;
  columns: '1' | '2';
  orientation: 'portrait' | 'landscape';
  /** márgenes «superior,inferior,izquierdo,derecho» (p. ej. "2.5cm,2.5cm,3cm,3cm"); vacío = los de LaTeX */
  margins: string;
  /** margen uniforme cuando los cuatro lados son iguales; vacío en otro caso */
  margin: string;
  spacing: '1' | '1.5' | '2';
  /** idioma de babel; vacío si no se usa */
  lang: string;
  /** tipo de letra del documento (clave de `FONTS`); vacío = Computer Modern, el de LaTeX */
  font: string;
  /** sangría de párrafo (`\parindent`) y separación entre párrafos (`\parskip`) si el preámbulo las fija; vacío = las de LaTeX */
  parIndent: string;
  parSkip: string;
  /** '1' si el documento prohíbe dejar una línea suelta de un párrafo al pie o al principio de una hoja */
  widows: string;
}

/** Opciones de babel que no son idiomas («mexico» es una variante del español: \usepackage[spanish,mexico]{babel}). */
const BABEL_MODIFIERS = new Set(['activeacute', 'activegrave', 'shorthands', 'noconfigs', 'showlanguages', 'silent', 'strings', 'safe', 'math', 'headfoot', 'base', 'bidi', 'layout', 'provide', 'KeepShorthandsActive', 'mexico']);

/**
 * Idioma principal del documento. En babel es el último idioma de la lista (o `main=`); las
 * opciones como `es-tabla` no son idiomas. Si hay varias líneas de babel (por ejemplo dentro de un
 * `\IfFileExists{spanish.ldf}{...}{...}`) vale la primera, que es la que se usa cuando el idioma
 * está instalado. También se entiende polyglossia.
 */
export function documentLanguage(preamble: string): string {
  const babel = /\\usepackage\s*(?:\[([^\]]*)\])?\s*\{babel\}/.exec(preamble);
  if (babel) {
    const fromClass = /\\documentclass\s*\[([^\]]*)\]/.exec(preamble)?.[1] ?? '';
    const opts = options(babel[1] ?? fromClass);
    const main = opts.find((o) => /^main\s*=/.test(o));
    if (main) return main.split('=')[1].trim();
    const langs = opts.filter((o) => /^[a-zA-Z]+$/.test(o) && !BABEL_MODIFIERS.has(o) && !/^\d+pt$|paper$|^(one|two)(side|column)$|^draft$|^final$|^landscape$/.test(o));
    if (langs.length) return langs[langs.length - 1];
  }
  return /\\set(?:main|default)language\s*(?:\[[^\]]*\])?\s*\{([a-zA-Z]+)\}/.exec(preamble)?.[1] ?? '';
}

/**
 * Tipos de letra del documento que se pueden elegir. Todos funcionan con pdfLaTeX sin instalar
 * nada. `lines` es lo que se escribe en el preámbulo, `packages` los paquetes que identifican esa
 * letra al leer un documento, `family` su código en LaTeX (el de `\fontfamily{...}`, para ponérsela
 * solo a un trozo de texto) y `css` las fuentes del sistema con las que se imita en pantalla (Mars
 * no compila: es una aproximación).
 */
export const FONTS: Record<string, { name: string; lines: string[]; packages: string[]; sans?: boolean; css: string; family: string }> = {
  '': { name: 'Computer Modern', lines: [], packages: [], family: 'cmr', css: "KaTeX_Main, 'Latin Modern Roman', 'CMU Serif', Georgia, 'Times New Roman', serif" },
  lmodern: { name: 'Latin Modern', lines: ['\\usepackage{lmodern}'], packages: ['lmodern'], family: 'lmr', css: "KaTeX_Main, 'Latin Modern Roman', 'CMU Serif', Georgia, 'Times New Roman', serif" },
  times: { name: 'Times', lines: ['\\usepackage{mathptmx}'], packages: ['mathptmx', 'times', 'newtxtext', 'tgtermes'], family: 'ptm', css: "'Times New Roman', Times, 'Nimbus Roman', 'Liberation Serif', serif" },
  palatino: { name: 'Palatino', lines: ['\\usepackage{mathpazo}'], packages: ['mathpazo', 'palatino', 'newpxtext', 'tgpagella'], family: 'ppl', css: "'Palatino Linotype', Palatino, 'Book Antiqua', 'URW Palladio L', serif" },
  charter: { name: 'Charter', lines: ['\\usepackage{charter}'], packages: ['charter', 'XCharter'], family: 'bch', css: "Charter, 'Bitstream Charter', Cambria, Georgia, serif" },
  bookman: { name: 'Bookman', lines: ['\\usepackage{bookman}'], packages: ['bookman', 'tgbonum'], family: 'pbk', css: "'Bookman Old Style', Bookman, 'URW Bookman', Georgia, serif" },
  schoolbook: { name: 'Century Schoolbook', lines: ['\\usepackage{newcent}'], packages: ['newcent', 'tgschola'], family: 'pnc', css: "'Century Schoolbook', 'New Century Schoolbook', Century, Georgia, serif" },
  helvetica: {
    name: 'Helvetica (sin remates)', lines: ['\\usepackage{helvet}', '\\renewcommand{\\familydefault}{\\sfdefault}'], packages: ['helvet', 'tgheros'], sans: true, family: 'phv',
    css: "Helvetica, Arial, 'Nimbus Sans', 'Liberation Sans', sans-serif",
  },
  sans: { name: 'Computer Modern sin remates', lines: ['\\renewcommand{\\familydefault}{\\sfdefault}'], packages: [], sans: true, family: 'cmss', css: "KaTeX_SansSerif, 'CMU Sans Serif', 'Latin Modern Sans', sans-serif" },
};
const FONT_PACKAGES = Object.values(FONTS).flatMap((f) => f.packages);
const SANS_DEFAULT = /^\s*\\renewcommand\s*\{?\\familydefault\}?\s*\{\\sfdefault\}/;

/** Medidas de cada papel en centímetros (ancho × alto en vertical). */
export const PAPER_CM: Record<string, [number, number]> = {
  a3paper: [29.7, 42], a4paper: [21, 29.7], a5paper: [14.8, 21], b5paper: [17.6, 25],
  letterpaper: [21.59, 27.94], legalpaper: [21.59, 35.56], executivepaper: [18.42, 26.67],
};
/** Papeles que las clases estándar aceptan como opción; el resto se indica a través de geometry. */
const CLASS_PAPERS = ['a4paper', 'a5paper', 'b5paper', 'letterpaper', 'legalpaper', 'executivepaper'];
const PAPERS = Object.keys(PAPER_CM);
const SIZES = ['10pt', '11pt', '12pt'];
const SPACING: Record<string, Layout['spacing']> = { singlespacing: '1', onehalfspacing: '1.5', doublespacing: '2' };
const SPACING_CMD: Record<Layout['spacing'], string> = { '1': '', '1.5': '\\onehalfspacing', '2': '\\doublespacing' };
const MARGIN_KEY = /^(margin|left|right|top|bottom|hmargin|vmargin|inner|outer|lmargin|rmargin|tmargin|bmargin)\s*=/;
const PAPER_KEY = /^(paperwidth|paperheight|papersize)\s*=/;

const CLASS = /^(\s*)\\documentclass\s*(?:\[([^\]]*)\])?\s*\{([^}]*)\}/;
const PACKAGE = (name: string): RegExp => new RegExp(`^\\s*\\\\usepackage\\s*(?:\\[([^\\]]*)\\])?\\s*\\{${name}\\}`);
/** Opciones separadas por comas, respetando las llaves (margin={2cm,3cm}). */
function options(s: string | undefined): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s ?? '') {
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
}

/** Líneas del preámbulo (hasta \begin{document}, sin incluirla); `undefined` si no hay documento. */
function preamble(lines: string[]): number | undefined {
  const end = lines.findIndex((l) => /^\s*\\begin\{document\}/.test(l));
  return end < 0 ? undefined : end;
}

export function toCm(len: string): number | undefined {
  const m = /^(-?[\d.]+)\s*(cm|mm|in|pt|bp|pc)$/.exec(len.trim());
  if (!m) return undefined;
  const v = parseFloat(m[1]);
  switch (m[2]) {
    case 'cm': return v;
    case 'mm': return v / 10;
    case 'in': return v * 2.54;
    case 'bp': return (v * 2.54) / 72;
    case 'pc': return v * 12 * 0.03515;
    default: return v * 0.03515;
  }
}

/**
 * Una longitud de LaTeX como valor de CSS, a la escala de la hoja: `--cm` son los píxeles de un
 * centímetro, `--tw` y `--th` el ancho y el alto de la caja de texto. `axis` indica si se va a
 * usar como ancho ('x': las fracciones del ancho de línea son porcentajes) o como alto ('y').
 */
export function cssLength(len: string, axis: 'x' | 'y' = 'x'): string | undefined {
  const v = len.trim().split(/\s+(?:plus|minus)\b/)[0].trim();
  const cm = toCm(v);
  if (cm !== undefined) return `calc(${+cm.toFixed(4)} * var(--cm, 37.8px))`;
  let m = /^(-?[\d.]+)\s*(em|ex)$/.exec(v);
  if (m) return `${m[1]}${m[2]}`;
  m = /^(-?[\d.]*)\s*\\(textwidth|linewidth|columnwidth|hsize|textheight|vsize|paperwidth|paperheight|baselineskip)$/.exec(v);
  if (!m) return undefined;
  const n = m[1] === '' ? 1 : m[1] === '-' ? -1 : parseFloat(m[1]);
  if (Number.isNaN(n)) return undefined;
  switch (m[2]) {
    case 'textheight': case 'vsize': return `calc(${n} * var(--th, 24cm))`;
    case 'paperwidth': return `calc(${n} * var(--pw, 21cm))`;
    case 'paperheight': return `calc(${n} * var(--ph, 29.7cm))`;
    case 'baselineskip': return `${n}lh`;
    default: return axis === 'x' ? `${+(n * 100).toFixed(2)}%` : `calc(${n} * var(--tw, 16cm))`;
  }
}

type Sides = [top: string, bottom: string, left: string, right: string];

/** Márgenes que las opciones de geometry fijan de forma explícita (vacío = no indicado). */
function readMargins(opts: string[]): Sides {
  const side: Record<string, string> = {};
  for (const o of opts) {
    const m = /^(\w+)\s*=\s*(.+)$/.exec(o);
    if (!m) continue;
    const v = m[2].replace(/[{}\s]/g, '');
    const [a, b = a] = v.split(',');
    switch (m[1]) {
      case 'margin': side.top = side.bottom = side.left = side.right = a; break;
      case 'hmargin': side.left = a; side.right = b; break;
      case 'vmargin': side.top = a; side.bottom = b; break;
      case 'left': case 'lmargin': case 'inner': side.left = a; break;
      case 'right': case 'rmargin': case 'outer': side.right = a; break;
      case 'top': case 'tmargin': side.top = a; break;
      case 'bottom': case 'bmargin': side.bottom = a; break;
    }
  }
  return [side.top ?? '', side.bottom ?? '', side.left ?? '', side.right ?? ''];
}

/**
 * Completa los lados que no se indican tal como lo hace geometry: la caja de texto ocupa el 70 %
 * del papel, centrada en horizontal y con el hueco vertical repartido 2:3 entre arriba y abajo.
 */
function completeMargins(sides: Sides, w: number, h: number): string {
  const cm = (v: number): string => `${Math.round(Math.max(v, 0) * 100) / 100}cm`;
  let [top, bottom, left, right] = sides;
  const t = toCm(top);
  const b = toCm(bottom);
  const l = toCm(left);
  const r = toCm(right);
  if (!top && !bottom) [top, bottom] = [cm(0.12 * h), cm(0.18 * h)];
  else if (!bottom && t !== undefined) bottom = cm(0.3 * h - t);
  else if (!top && b !== undefined) top = cm(0.3 * h - b);
  if (!left && !right) left = right = cm(0.15 * w);
  else if (!right && l !== undefined) right = cm(0.3 * w - l);
  else if (!left && r !== undefined) left = cm(0.3 * w - r);
  return [top, bottom, left, right].join(',');
}

export function readLayout(text: string): Layout | undefined {
  const lines = text.split(/\r?\n/);
  const end = preamble(lines);
  if (end === undefined) return undefined;
  const head = lines.slice(0, end);
  const layout: Layout = {
    cls: 'article', paper: 'letterpaper', paperSize: '', fontSize: '10pt', columns: '1', orientation: 'portrait',
    margins: '', margin: '', spacing: '1', lang: documentLanguage(head.join('\n')), font: '', parIndent: '', parSkip: '', widows: '',
  };
  let found = false;
  /** márgenes explícitos de geometry; `undefined` si el paquete no se usa */
  let explicit: Sides | undefined;
  /** paquetes de letra cargados y si la familia por defecto pasa a ser la de palo seco */
  const fontPackages: string[] = [];
  let sans = false;
  for (const line of head) {
    const pk = /^\s*\\usepackage\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/.exec(line);
    for (const p of pk ? pk[1].split(',').map((x) => x.trim()) : []) if (FONT_PACKAGES.includes(p)) fontPackages.push(p);
    if (SANS_DEFAULT.test(line)) sans = true;
    const c = CLASS.exec(line);
    if (c) {
      found = true;
      layout.cls = c[3].trim();
      for (const o of options(c[2])) {
        if (PAPERS.includes(o)) layout.paper = o;
        else if (/^\d+(\.\d+)?pt$/.test(o)) layout.fontSize = o;
        else if (o === 'twocolumn') layout.columns = '2';
        else if (o === 'landscape') layout.orientation = 'landscape';
      }
      // un póster (A0, letra de 25 pt) se muestra a escala de folio para poder trabajar en él
      if (/^(tikzposter|a0poster|sciposter|baposter|beamerposter)$/.test(layout.cls)) layout.fontSize = '12pt';
    }
    const g = PACKAGE('geometry').exec(line);
    if (g) {
      const opts = options(g[1]);
      explicit = readMargins(opts);
      let w = '';
      let h = '';
      for (const o of opts) {
        if (PAPERS.includes(o)) layout.paper = o;
        else if (o === 'landscape') layout.orientation = 'landscape';
        const m = /^(paperwidth|paperheight|papersize)\s*=\s*(.+)$/.exec(o);
        if (m?.[1] === 'paperwidth') w = m[2].trim();
        else if (m?.[1] === 'paperheight') h = m[2].trim();
        else if (m?.[1] === 'papersize') [w, h = ''] = m[2].replace(/[{}\s]/g, '').split(',');
      }
      if (w && h && toCm(w) && toCm(h)) {
        layout.paper = 'custom';
        layout.paperSize = `${w},${h}`;
      }
    }
    if (WIDOWS.test(line)) layout.widows = '1';
    const s = /^\s*\\(singlespacing|onehalfspacing|doublespacing)\b/.exec(line);
    if (s) layout.spacing = SPACING[s[1]];
    // sangría y separación de párrafos, en el orden en que aparecen: lo último que se dice es lo que vale
    const len = /^\s*\\setlength\s*\{?\\(parindent|parskip)\}?\s*\{([^}]*)\}/.exec(line) ?? /^\s*\\(parindent|parskip)\s*=?\s*([-\d.]+\s*[a-z]+)/.exec(line);
    if (len) {
      const value = len[2].split(/\s+(?:plus|minus)\b/)[0].trim();
      if (len[1] === 'parindent') layout.parIndent = value;
      else layout.parSkip = value;
    }
    // tamaños de letra que las clases estándar no traen: \usepackage[fontsize=14pt]{scrextend}
    const fs = PACKAGE('scrextend').exec(line);
    const size = fs ? options(fs[1]).find((o) => /^fontsize\s*=/.test(o))?.split('=')[1].trim() : undefined;
    if (size && /^\d+(\.\d+)?pt$/.test(size)) layout.fontSize = size;
    const ps = PACKAGE('parskip').exec(line);
    if (ps) {
      // el paquete parskip quita la sangría y separa los párrafos, salvo que sus opciones digan otra cosa
      const opts = options(ps[1]);
      const opt = (name: string): string | undefined => opts.find((o) => o.startsWith(name + '='))?.split('=')[1].trim();
      layout.parIndent = opt('indent') ?? '0pt';
      layout.parSkip = opt('skip') ?? '0.5\\baselineskip';
    }
  }
  if (explicit) {
    // con geometry cargado, los márgenes son siempre los suyos (indicados o calculados)
    const [w, h] = paperCm(layout);
    layout.margins = completeMargins(explicit, w, h);
  }
  const sides = layout.margins.split(',');
  layout.margin = layout.margins && sides.every((x) => x === sides[0]) ? sides[0] : '';
  // la letra del texto: con la familia por defecto de palo seco manda el paquete de palo seco que
  // haya (o la de LaTeX); si no, el paquete de letra con remates. Un paquete como helvet, sin más,
  // solo cambia la letra de \textsf
  const loaded = Object.keys(FONTS).filter((k) => FONTS[k].packages.some((p) => fontPackages.includes(p)));
  if (sans) layout.font = loaded.find((k) => FONTS[k].sans) ?? 'sans';
  else layout.font = loaded.find((k) => !FONTS[k].sans) ?? '';
  return found ? layout : undefined;
}

/** Cambios que admite `writeLayout`; `margin` es un atajo para los cuatro lados iguales. */
export type LayoutPatch = Partial<Layout>;

/** Líneas con las que un documento prohíbe las viudas y las huérfanas. */
const WIDOWS = /^\s*\\(?:(?:widow|club)penalty\s*=?\s*1\d{4}|usepackage\s*(?:\[[^\]]*\])?\s*\{(?:nowidow|widows-and-orphans)\})/;

/** Devuelve el documento con la disposición cambiada, o el mismo texto si no hay preámbulo. */
export function writeLayout(text: string, patch: LayoutPatch): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const end = preamble(lines);
  const current = readLayout(text);
  if (end === undefined || !current) return text;
  const want: Layout = { ...current, ...patch };
  if (patch.margin !== undefined && patch.margins === undefined) want.margins = patch.margin ? Array(4).fill(patch.margin).join(',') : '';
  if (patch.paper !== undefined && patch.paper !== 'custom') want.paperSize = '';
  if (patch.paperSize) want.paper = 'custom';
  const head = lines.slice(0, end);
  const find = (re: RegExp): number => head.findIndex((l) => re.test(l));
  /** Inserta tras el último \usepackage (o tras \documentclass). */
  const insert = (line: string): number => {
    let at = find(CLASS);
    head.forEach((l, i) => {
      if (/^\s*\\usepackage\b/.test(l)) at = i;
    });
    head.splice(at + 1, 0, line);
    return at + 1;
  };

  // \documentclass[opciones]{clase}
  const ci = find(CLASS);
  const c = CLASS.exec(head[ci]) as RegExpExecArray;
  const keep = options(c[2]).filter((o) => !PAPERS.includes(o) && !/^\d+(\.\d+)?pt$/.test(o) && !['twocolumn', 'onecolumn', 'landscape'].includes(o));
  const classPaper = CLASS_PAPERS.includes(want.paper) && want.paper !== 'letterpaper';
  // las clases estándar solo conocen 10, 11 y 12 pt; cualquier otro tamaño lo pone el paquete scrextend
  const classSize = SIZES.includes(want.fontSize);
  const opts = [
    ...(classSize && want.fontSize !== '10pt' ? [want.fontSize] : []),
    ...(classPaper ? [want.paper] : []),
    ...(want.orientation === 'landscape' ? ['landscape'] : []),
    ...(want.columns === '2' ? ['twocolumn'] : []),
    ...keep,
  ];
  head[ci] = `${c[1]}\\documentclass${opts.length ? `[${opts.join(', ')}]` : ''}{${want.cls}}` + head[ci].slice(c[0].length);

  if (patch.fontSize !== undefined) {
    const si = find(PACKAGE('scrextend'));
    const old = si >= 0 ? options((PACKAGE('scrextend').exec(head[si]) as RegExpExecArray)[1]).filter((o) => !/^fontsize\s*=/.test(o)) : [];
    const all = classSize ? old : [`fontsize=${want.fontSize}`, ...old];
    const line = `\\usepackage${all.length ? `[${all.join(', ')}]` : ''}{scrextend}`;
    if (si >= 0 && (all.length || !classSize)) head[si] = line;
    else if (si >= 0) head.splice(si, 1);
    else if (!classSize) insert(line);
  }

  // geometry: márgenes, papeles que la clase no conoce y tamaños personalizados
  if (patch.margin !== undefined || patch.margins !== undefined || patch.orientation !== undefined || patch.paper !== undefined || patch.paperSize !== undefined) {
    const gi = find(PACKAGE('geometry'));
    const old = gi >= 0 ? options((PACKAGE('geometry').exec(head[gi]) as RegExpExecArray)[1]) : [];
    const rest = old.filter((o) => !MARGIN_KEY.test(o) && !PAPER_KEY.test(o) && !PAPERS.includes(o) && o !== 'landscape');
    let margins: string[];
    if (patch.margin !== undefined || patch.margins !== undefined) {
      const [t, b, l, r] = want.margins.split(',');
      margins = !want.margins ? [] : t === b && b === l && l === r ? [`margin=${t}`] : [`top=${t}`, `bottom=${b}`, `left=${l}`, `right=${r}`];
    } else {
      // si no se piden márgenes nuevos, los que hubiera escritos se dejan tal cual
      margins = old.filter((o) => MARGIN_KEY.test(o));
    }
    const [pw, ph] = want.paperSize.split(',');
    const paper = want.paper === 'custom' && pw && ph ? [`paperwidth=${pw}`, `paperheight=${ph}`] : !CLASS_PAPERS.includes(want.paper) && PAPERS.includes(want.paper) ? [want.paper] : [];
    const all = [...paper, ...margins, ...rest];
    const line = `\\usepackage${all.length ? `[${all.join(', ')}]` : ''}{geometry}`;
    // sin opciones el paquete solo cambiaría los márgenes a los suyos: se quita, salvo que el
    // documento lo configure después con \geometry{...}
    const needed = all.length > 0 || /\\(new)?geometry\s*\{/.test(text);
    if (gi >= 0 && needed) head[gi] = line;
    else if (gi >= 0) head.splice(gi, 1);
    else if (all.length) insert(line);
  }

  // interlineado: paquete setspace + orden
  if (patch.spacing !== undefined) {
    for (let i = head.length - 1; i >= 0; i--) if (/^\s*\\(singlespacing|onehalfspacing|doublespacing)\s*$/.test(head[i])) head.splice(i, 1);
    if (want.spacing !== '1') {
      let si = find(PACKAGE('setspace'));
      if (si < 0) si = insert('\\usepackage{setspace}');
      head.splice(si + 1, 0, SPACING_CMD[want.spacing]);
    }
  }

  // viudas y huérfanas: dos penalizaciones al final del preámbulo
  if (patch.widows !== undefined) {
    for (let i = head.length - 1; i >= 0; i--) if (WIDOWS.test(head[i])) head.splice(i, 1);
    if (want.widows === '1') head.push('\\widowpenalty=10000', '\\clubpenalty=10000');
  }

  // tipo de letra: se quitan las líneas de la letra anterior y se escriben las de la nueva
  if (patch.font !== undefined && want.font in FONTS) {
    // solo se quita lo que define la letra actual: otro paquete de fuentes (p. ej. helvet para
    // \textsf) puede estar ahí por otro motivo
    const old = FONTS[current.font] ?? FONTS[''];
    for (let i = head.length - 1; i >= 0; i--) {
      const pk = /^(\s*\\usepackage\s*(?:\[[^\]]*\])?\s*)\{([^}]*)\}(.*)$/.exec(head[i]);
      if (old.sans && SANS_DEFAULT.test(head[i])) head.splice(i, 1);
      else if (pk) {
        const names = pk[2].split(',').map((x) => x.trim());
        const rest = names.filter((n) => !old.packages.includes(n));
        if (rest.length === names.length) continue;
        // un paquete de letra compartiendo línea con otros: solo se quita él
        if (rest.length) head[i] = `${pk[1]}{${rest.join(', ')}}${pk[3]}`;
        else head.splice(i, 1);
      }
    }
    for (const line of FONTS[want.font].lines) if (!head.some((l) => l.trim() === line)) insert(line);
  }

  // idioma: \usepackage[idioma]{babel}
  if (patch.lang !== undefined && want.lang) {
    const bi = find(PACKAGE('babel'));
    const line = `\\usepackage[${want.lang}]{babel}`;
    if (bi >= 0) head[bi] = line;
    else insert(line);
  }

  return [...head, ...lines.slice(end)].join(eol);
}

/** Ancho de texto por defecto de LaTeX (cm) según el tamaño de letra, cuando no se usa geometry. */
const DEFAULT_TEXT_CM: Record<string, number> = { '10pt': 12.1, '11pt': 12.7, '12pt': 13.7 };

/** Medidas de la hoja (en centímetros) para la vista de página. */
export interface PageGeometry {
  pageW: number;
  pageH: number;
  marginTop: number;
  marginBottom: number;
  marginLeft: number;
  marginRight: number;
  /** tamaño de letra en puntos */
  fontPt: number;
  spacing: number;
  columns: number;
  /** fuentes con las que se dibuja el texto del documento (valor de `font-family`) */
  fontCss: string;
  /** alto de línea, en veces el tamaño de letra (interlineado de LaTeX por el factor de setspace) */
  lineHeight: number;
  /** sangría de la primera línea y separación entre párrafos, como valores de CSS */
  indent: string;
  parSkip: string;
  /** líneas de un párrafo que como mínimo quedan juntas al pie y al principio de una hoja */
  keepLines: number;
}

const DEFAULT_LAYOUT: Layout = {
  cls: 'article', paper: 'letterpaper', paperSize: '', fontSize: '10pt', columns: '1', orientation: 'portrait',
  margins: '', margin: '', spacing: '1', lang: '', font: '', parIndent: '', parSkip: '', widows: '',
};

/** Interlineado de las clases estándar (\baselineskip entre el tamaño de letra). */
const BASELINE: Record<number, number> = { 10: 1.2, 11: 1.236, 12: 1.208 };
/** Factores de setspace para espacio y medio y doble espacio, según el tamaño de letra. */
const STRETCH: Record<string, Record<number, number>> = { '1.5': { 10: 1.25, 11: 1.213, 12: 1.241 }, '2': { 10: 1.667, 11: 1.618, 12: 1.655 } };

/** Alto de línea (en em) para un tamaño de letra y un interlineado de setspace ('1', '1.5' o '2'). */
export function lineHeightFor(fontPt: number, spacing: string): number {
  const base = BASELINE[fontPt] ?? 1.2;
  const stretch = STRETCH[spacing]?.[fontPt] ?? (spacing === '1.5' ? 1.25 : spacing === '2' ? 1.667 : 1);
  return +(base * stretch).toFixed(3);
}

/** Tamaño del papel en centímetros, ya girado si la orientación es horizontal. */
function paperCm(l: Layout): [number, number] {
  let [w, h] = PAPER_CM[l.paper] ?? PAPER_CM.letterpaper;
  if (l.paper === 'custom') {
    const [cw, ch] = l.paperSize.split(',').map((x) => toCm(x));
    if (cw && ch) [w, h] = [cw, ch];
  }
  return l.orientation === 'landscape' && w < h ? [h, w] : [w, h];
}

/** Tamaño de papel y márgenes que tendrá el documento compilado. */
export function pageGeometry(layout: Layout | undefined): PageGeometry {
  const l = layout ?? DEFAULT_LAYOUT;
  const [w, h] = paperCm(l);
  const sides = l.margins ? l.margins.split(',').map((x) => toCm(x)) : [];
  const [top, bottom, left, right] = sides;
  // sin geometry, LaTeX centra una caja de texto de ancho fijo y deja unos 3,7 cm arriba y abajo
  const base = DEFAULT_TEXT_CM[l.fontSize] ?? 12.1;
  const textW = l.orientation === 'landscape' ? base * (w / PAPER_CM.letterpaper[0]) : Math.min(base, w - 3);
  const dx = Math.max((w - textW) / 2, 1);
  const dy = Math.min(3.7, h * 0.14);
  const fit = (v: number | undefined, def: number, max: number): number => (v === undefined || Number.isNaN(v) ? def : Math.min(Math.max(v, 0), max));
  return {
    pageW: w,
    pageH: h,
    marginTop: fit(top, dy, h / 2 - 1),
    marginBottom: fit(bottom, dy, h / 2 - 1),
    marginLeft: fit(left, dx, w / 2 - 1),
    marginRight: fit(right, dx, w / 2 - 1),
    fontPt: parseFloat(l.fontSize) || 10,
    spacing: parseFloat(l.spacing) || 1,
    columns: l.columns === '2' ? 2 : 1,
    fontCss: (FONTS[l.font] ?? FONTS['']).css,
    lineHeight: lineHeightFor(parseFloat(l.fontSize) || 10, l.spacing),
    // por defecto LaTeX sangra 1,5 em (15 pt a 10 pt) y no separa los párrafos
    indent: (l.parIndent && cssLength(l.parIndent)) || '1.5em',
    parSkip: (l.parSkip && cssLength(l.parSkip, 'y')) || '0px',
    keepLines: l.widows === '1' ? 2 : 1,
  };
}

/** Ancho de la caja de texto en centímetros. */
export function textWidthCm(l: Layout): number {
  const g = pageGeometry(l);
  return Math.round((g.pageW - g.marginLeft - g.marginRight) * 100) / 100;
}

/**
 * Cambia en el preámbulo `lscape` por `pdflscape` (con `pdf`) o al revés. Devuelve la línea
 * cambiada, o nada si el documento no carga ninguno de los dos o ya carga el que se pide.
 */
export function landscapeSwap(text: string, pdf: boolean): { line: number; text: string } | undefined {
  const lines = text.split(/\r?\n/);
  const from = pdf ? 'lscape' : 'pdflscape';
  const to = pdf ? 'pdflscape' : 'lscape';
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*\\begin\{document\}/.test(lines[i])) break;
    const m = /^(\s*\\usepackage\s*(?:\[[^\]]*\])?\s*\{)([^}]*)(\}.*)$/.exec(lines[i]);
    if (!m) continue;
    const names = m[2].split(',');
    const k = names.findIndex((n) => n.trim() === from);
    if (k < 0) continue;
    names[k] = names[k].replace(from, to);
    return { line: i, text: m[1] + names.join(',') + m[3] };
  }
  return undefined;
}

/** Encabezado y pie de página en código LaTeX: izquierda, centro y derecha, y sus rayas. */
export interface HeadFoot {
  head: [string, string, string];
  foot: [string, string, string];
  headRule: boolean;
  footRule: boolean;
}

/** Línea del preámbulo que configura el encabezado o el pie (fancyhdr) y la que lo activa. */
const HEADFOOT_LINE = /^\s*(?:\\(?:fancyhf|fancyhead|fancyfoot|[lcr]head|[lcr]foot)(?![a-zA-Z])|\\pagestyle\s*\{|\\renewcommand\s*\{?\s*\\(?:head|foot)rulewidth\b|%\s*encabezado y pie de página\s*$)/;

/**
 * Escribe el encabezado y el pie con fancyhdr: quita del preámbulo la configuración que hubiera y
 * pone la nueva al final, donde ya están definidas las órdenes del documento. Sin `spec`, solo la
 * quita: las hojas vuelven al estilo de la clase (el número al pie, centrado).
 */
export function writeHeadFoot(text: string, spec: HeadFoot | undefined): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  const end = preamble(lines);
  if (end === undefined) return text;
  const kept: string[] = [];
  for (let i = 0; i < end; i++) {
    if (!HEADFOOT_LINE.test(lines[i])) {
      kept.push(lines[i]);
      continue;
    }
    // una orden que sigue en las líneas siguientes (llaves sin cerrar) sale entera
    let depth = 0;
    for (;;) {
      for (const ch of lines[i].replace(/\\[{}%]/g, '').replace(/%.*$/, '')) depth += ch === '{' ? 1 : ch === '}' ? -1 : 0;
      if (depth <= 0 || i + 1 >= end) break;
      i++;
    }
  }
  const out = [...kept];
  if (spec) {
    const used = (re: RegExp): boolean => [...spec.head, ...spec.foot].some((c) => re.test(c));
    const pkgs = ['fancyhdr', ...(used(/\\pageref\*?\s*\{LastPage\}/) ? ['lastpage'] : [])];
    const block = ['% encabezado y pie de página', '\\pagestyle{fancy}', '\\fancyhf{}'];
    spec.head.forEach((c, k) => c.trim() && block.push(`\\fancyhead[${'LCR'[k]}]{${c.trim()}}`));
    spec.foot.forEach((c, k) => c.trim() && block.push(`\\fancyfoot[${'LCR'[k]}]{${c.trim()}}`));
    block.push(`\\renewcommand{\\headrulewidth}{${spec.headRule ? '0.4pt' : '0pt'}}`, `\\renewcommand{\\footrulewidth}{${spec.footRule ? '0.4pt' : '0pt'}}`);
    const head = out.join('\n');
    const missing = pkgs.filter((p) => !new RegExp(`\\\\usepackage\\s*(?:\\[[^\\]]*\\])?\\s*\\{[^}]*\\b${p}\\b`).test(head));
    let lastPkg = -1;
    out.forEach((l, k) => /^\s*\\usepackage/.test(l) && (lastPkg = k));
    if (missing.length) out.splice(lastPkg >= 0 ? lastPkg + 1 : Math.max(out.findIndex((l) => /^\s*\\documentclass/.test(l)) + 1, 0), 0, ...missing.map((p) => `\\usepackage{${p}}`));
    // (sin dejar dos líneas en blanco seguidas delante)
    while (out.length && !out[out.length - 1].trim()) out.pop();
    out.push('', ...block, '');
  }
  return [...out, ...lines.slice(end)].join(eol);
}
