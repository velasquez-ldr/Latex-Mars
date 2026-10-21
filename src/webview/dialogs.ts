import katex from 'katex';
// fórmulas químicas (\ce, \pu): la extensión de KaTeX se registra sola al cargarla
import 'katex/contrib/mhchem';
import { type MathContext, mathMacros, prepareMath } from '../latex/mathext';

export interface Field {
  id: string;
  label: string;
  type?: 'text' | 'number' | 'textarea' | 'checkbox' | 'select' | 'color';
  value?: string | number | boolean;
  /** opciones de un select: texto, o [valor, texto visible] */
  options?: (string | [string, string])[];
  placeholder?: string;
}

export type Values = Record<string, string>;

let overlay: HTMLElement | undefined;
let onClose: (() => void) | undefined;

export const isDialogOpen = (): boolean => overlay !== undefined;

export function closeDialog(): void {
  overlay?.remove();
  overlay = undefined;
  const cb = onClose;
  onClose = undefined;
  cb?.();
}

function shell(title: string, closed?: () => void): { box: HTMLElement; body: HTMLElement; buttons: HTMLElement } {
  closeDialog();
  overlay = document.createElement('div');
  overlay.className = 'overlay';
  overlay.innerHTML =
    `<div class="dialog" role="dialog"><div class="dlg-title"></div><div class="dlg-body"></div>` +
    `<div class="dlg-buttons"></div></div>`;
  overlay.querySelector('.dlg-title')!.textContent = title;
  overlay.addEventListener('mousedown', (e) => {
    if (e.target === overlay) closeDialog();
  });
  overlay.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') closeDialog();
  });
  document.body.appendChild(overlay);
  onClose = closed;
  return {
    box: overlay.firstElementChild as HTMLElement,
    body: overlay.querySelector('.dlg-body') as HTMLElement,
    buttons: overlay.querySelector('.dlg-buttons') as HTMLElement,
  };
}

function button(parent: HTMLElement, text: string, primary: boolean, fn: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.className = primary ? 'primary' : '';
  b.addEventListener('click', fn);
  parent.appendChild(b);
  return b;
}

/** Diálogo genérico de formulario. */
/** `preview`: HTML que enseña, mientras se rellena, lo que el formulario va a insertar. */
export function openForm(title: string, fields: Field[], ok: (v: Values) => void, closed?: () => void, preview?: (v: Values) => string): void {
  const { body, buttons } = shell(title, closed);
  const inputs = new Map<string, HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>();
  for (const f of fields) {
    const row = document.createElement('label');
    row.className = 'field' + (f.type === 'checkbox' ? ' check' : '');
    const span = document.createElement('span');
    span.textContent = f.label;
    let input: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
    if (f.type === 'textarea') {
      input = document.createElement('textarea');
      input.rows = 8;
      input.spellcheck = false;
      input.value = String(f.value ?? '');
    } else if (f.type === 'select') {
      input = document.createElement('select');
      for (const o of f.options ?? []) {
        const opt = document.createElement('option');
        opt.value = typeof o === 'string' ? o : o[0];
        opt.textContent = typeof o === 'string' ? o : o[1];
        input.appendChild(opt);
      }
      if (f.value !== undefined) input.value = String(f.value);
    } else {
      input = document.createElement('input');
      input.type = f.type ?? 'text';
      if (f.type === 'checkbox') input.checked = Boolean(f.value);
      else input.value = String(f.value ?? '');
      if (f.placeholder) input.placeholder = f.placeholder;
    }
    input.dataset.field = f.id;
    inputs.set(f.id, input);
    if (f.type === 'checkbox') row.append(input, span);
    else row.append(span, input);
    body.appendChild(row);
  }
  const values = (): Values => {
    const v: Values = {};
    for (const [id, el] of inputs) v[id] = el instanceof HTMLInputElement && el.type === 'checkbox' ? (el.checked ? '1' : '') : el.value;
    return v;
  };
  if (preview) {
    // formulario a la izquierda y lo que va a insertar a la derecha
    body.closest('.dialog')?.classList.add('with-preview');
    const view = document.createElement('div');
    view.className = 'form-preview';
    const draw = (): void => {
      view.innerHTML = preview(values());
    };
    body.appendChild(view);
    body.addEventListener('input', draw);
    body.addEventListener('change', draw);
    draw();
  }
  const submit = (): void => {
    const v = values();
    closeDialog();
    ok(v);
  };
  body.addEventListener('keydown', (e) => {
    const inTextarea = (e.target as HTMLElement).tagName === 'TEXTAREA';
    if (e.key === 'Enter' && (!inTextarea || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  });
  button(buttons, 'Cancelar', false, closeDialog);
  button(buttons, 'Aceptar', true, submit);
  const first = inputs.values().next().value;
  first?.focus();
  if (first instanceof HTMLInputElement) first.select();
}

// ------------------------------------------------------------------ matemáticas

/**
 * Elemento de la paleta: cómo se dibuja en el botón, qué se inserta (`#?` = hueco a rellenar) y su
 * nombre en español, por el que también se puede buscar.
 */
type Item = [show: string, insert: string, name?: string];

/** Hueco de una estructura, dibujado como un recuadro punteado (como en el editor de Word). */
const HOLE = '\\htmlClass{hole}{\\phantom{0}}';
/** Estructura: se dibuja tal cual se inserta, con un recuadro en cada hueco. */
const tpl = (insert: string, name: string, show?: string): Item => [show ?? insert.replace(/#\?/g, HOLE), insert, name];
/** Símbolos sueltos: «\cmd nombre» separados por comas. */
const syms = (list: string): Item[] =>
  list.split(',').map((entry) => {
    const [tex, ...name] = entry.trim().split(' ');
    return [tex, tex, name.join(' ') || tex.replace(/^\\/, '')] as Item;
  });

export interface PaletteGroup {
  name: string;
  /** fórmula pequeña que hace de icono de la categoría */
  icon: string;
  /** las estructuras se dibujan en tarjetas grandes */
  big?: boolean;
  items: Item[];
}

export const PALETTE: PaletteGroup[] = [
  {
    name: 'Estructuras',
    icon: '\\tfrac{x}{y}',
    big: true,
    items: [
      tpl('\\frac{#?}{#?}', 'fracción quebrado dividir'), tpl('\\sqrt{#?}', 'raíz cuadrada'), tpl('\\sqrt[#?]{#?}', 'raíz enésima cúbica'),
      tpl('#?^{#?}', 'potencia exponente superíndice elevado'), tpl('#?_{#?}', 'subíndice'), tpl('#?_{#?}^{#?}', 'subíndice y superíndice'),
      tpl('\\sum_{#?}^{#?}', 'sumatorio suma serie'), tpl('\\prod_{#?}^{#?}', 'productorio producto'), tpl('\\int_{#?}^{#?}', 'integral definida'),
      tpl('\\int #?\\,dx', 'integral indefinida'), tpl('\\iint', 'integral doble'), tpl('\\oint', 'integral de contorno cerrada'),
      tpl('\\lim_{#?\\to #?}', 'límite'), tpl('\\frac{d#?}{d#?}', 'derivada'), tpl('\\frac{\\partial #?}{\\partial #?}', 'derivada parcial'),
      tpl('\\binom{#?}{#?}', 'binomio número combinatorio'), tpl('\\left(#?\\right)', 'paréntesis'), tpl('\\left[#?\\right]', 'corchetes'),
      tpl('\\left|#?\\right|', 'valor absoluto módulo barras'), tpl('\\left\\{#?\\right\\}', 'llaves conjunto'), tpl('\\overline{#?}', 'barra superior conjugado media'),
      tpl('\\underbrace{#?}_{#?}', 'llave inferior'), tpl('\\log_{#?}', 'logaritmo en base'), tpl('e^{#?}', 'exponencial'),
    ],
  },
  {
    name: 'Griegas',
    icon: '\\alpha\\beta',
    items: syms(
      '\\alpha alfa,\\beta,\\gamma gamma,\\delta,\\epsilon épsilon,\\varepsilon épsilon,\\zeta,\\eta,\\theta zeta theta,\\vartheta,\\iota,\\kappa,\\lambda,\\mu mu mi,\\nu nu ni,\\xi,\\pi pi,\\rho ro,\\sigma,\\tau,\\upsilon ípsilon,\\phi fi,\\varphi fi,\\chi ji,\\psi,\\omega,' +
        '\\Gamma gamma mayúscula,\\Delta delta mayúscula incremento,\\Theta theta mayúscula,\\Lambda lambda mayúscula,\\Xi xi mayúscula,\\Pi pi mayúscula,\\Sigma sigma mayúscula,\\Phi fi mayúscula,\\Psi psi mayúscula,\\Omega omega mayúscula ohmio',
    ),
  },
  {
    name: 'Operadores',
    icon: '\\pm\\times',
    items: syms(
      '+ más suma,- menos resta,\\pm más menos,\\mp menos más,\\times por multiplicación producto,\\div dividir división entre,\\cdot punto producto,\\ast asterisco,\\circ composición círculo,\\bullet punto grueso,\\oplus suma directa,\\otimes producto tensorial,' +
        '\\infty infinito,\\partial derivada parcial,\\nabla nabla gradiente,\\degree grados,\\% por ciento porcentaje,\\angle ángulo,\\ldots puntos suspensivos,\\cdots puntos centrados,\\vdots puntos verticales,\\ddots puntos diagonales,\\hbar h barra planck,\\ell ele',
    ),
  },
  {
    name: 'Relaciones',
    icon: '\\leq\\neq',
    items: syms(
      '= igual,\\neq distinto no igual,\\approx aproximado aproximadamente,\\equiv equivalente idéntico congruente,\\sim similar,\\simeq,\\cong congruente,\\propto proporcional,< menor,> mayor,\\leq menor o igual,\\geq mayor o igual,\\ll mucho menor,\\gg mucho mayor,' +
        '\\in pertenece,\\notin no pertenece,\\subset subconjunto contenido,\\subseteq subconjunto o igual,\\supset contiene superconjunto,\\supseteq contiene o igual,\\parallel paralelo,\\perp perpendicular,\\mid divide tal que',
    ),
  },
  {
    name: 'Flechas',
    icon: '\\Rightarrow',
    items: syms(
      '\\to flecha derecha tiende,\\leftarrow flecha izquierda,\\leftrightarrow flecha doble,\\Rightarrow implica flecha derecha doble,\\Leftarrow flecha izquierda doble,\\Leftrightarrow si y solo si equivale,\\mapsto aplica,\\longrightarrow flecha larga,' +
        '\\uparrow flecha arriba,\\downarrow flecha abajo,\\nearrow flecha diagonal arriba,\\searrow flecha diagonal abajo,\\rightleftharpoons equilibrio reversible,\\implies implica,\\iff si y solo si',
    ),
  },
  {
    name: 'Conjuntos y lógica',
    icon: '\\forall\\in',
    items: syms(
      '\\forall para todo,\\exists existe,\\nexists no existe,\\emptyset conjunto vacío,\\cup unión,\\cap intersección,\\setminus diferencia menos,\\land y conjunción,\\lor o disyunción,\\neg no negación,\\therefore por lo tanto,\\because porque,' +
        '\\mathbb{R} reales,\\mathbb{N} naturales,\\mathbb{Z} enteros,\\mathbb{Q} racionales,\\mathbb{C} complejos',
    ),
  },
  {
    name: 'Funciones',
    icon: '\\sin',
    items: syms(
      '\\sin seno,\\cos coseno,\\tan tangente,\\cot cotangente,\\sec secante,\\csc cosecante,\\arcsin arcoseno,\\arccos arcocoseno,\\arctan arcotangente,\\sinh seno hiperbólico,\\cosh coseno hiperbólico,\\tanh tangente hiperbólica,' +
        '\\ln logaritmo neperiano natural,\\log logaritmo,\\exp exponencial,\\max máximo,\\min mínimo,\\det determinante,\\gcd máximo común divisor',
    ),
  },
  {
    name: 'Matrices',
    icon: '[\\begin{smallmatrix}\\cdot&\\cdot\\\\\\cdot&\\cdot\\end{smallmatrix}]',
    big: true,
    items: [
      tpl('\\begin{pmatrix}#?&#?\\\\#?&#?\\end{pmatrix}', 'matriz 2×2 paréntesis'),
      tpl('\\begin{bmatrix}#?&#?\\\\#?&#?\\end{bmatrix}', 'matriz 2×2 corchetes'),
      tpl('\\begin{vmatrix}#?&#?\\\\#?&#?\\end{vmatrix}', 'determinante 2×2'),
      tpl('\\begin{pmatrix}#?&#?&#?\\\\#?&#?&#?\\\\#?&#?&#?\\end{pmatrix}', 'matriz 3×3'),
      tpl('\\begin{pmatrix}#?\\\\#?\\end{pmatrix}', 'vector columna'),
      tpl('\\begin{cases}#?&#?\\\\#?&#?\\end{cases}', 'función a trozos casos sistema'),
    ],
  },
  {
    name: 'Acentos',
    icon: '\\hat{x}\\,\\vec{v}',
    big: true,
    items: [
      tpl('\\hat{#?}', 'sombrero circunflejo'), tpl('\\bar{#?}', 'barra media'), tpl('\\vec{#?}', 'vector flecha'), tpl('\\dot{#?}', 'punto derivada temporal'),
      tpl('\\ddot{#?}', 'dos puntos segunda derivada'), tpl('\\tilde{#?}', 'tilde virgulilla'), tpl('\\widehat{#?}', 'sombrero ancho ángulo'),
      tpl('\\overrightarrow{#?}', 'vector de dos puntos flecha larga'), tpl('\\mathbf{#?}', 'negrita', '\\mathbf{A}'), tpl('\\mathcal{#?}', 'caligráfica', '\\mathcal{L}'),
      tpl('\\mathbb{#?}', 'pizarra doble trazo', '\\mathbb{R}'), tpl('\\text{#?}', 'texto normal', '\\text{texto}'),
    ],
  },
];

/** Ecuaciones habituales listas para insertar. */
export const GALLERY: [name: string, tex: string][] = [
  ['Fórmula cuadrática', 'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}'],
  ['Teorema de Pitágoras', 'a^2 + b^2 = c^2'],
  ['Área del círculo', 'A = \\pi r^2'],
  ['Binomio de Newton', '(x + a)^n = \\sum_{k=0}^{n} \\binom{n}{k} x^k a^{n-k}'],
  ['Serie de Taylor', 'e^x = 1 + \\frac{x}{1!} + \\frac{x^2}{2!} + \\frac{x^3}{3!} + \\cdots'],
  ['Identidad trigonométrica', '\\sin^2 \\theta + \\cos^2 \\theta = 1'],
  ['Derivada', 'f\'(x) = \\lim_{h \\to 0} \\frac{f(x+h) - f(x)}{h}'],
  ['Integral gaussiana', '\\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi}'],
  ['Identidad de Euler', 'e^{i\\pi} + 1 = 0'],
  ['Serie de Fourier', 'f(x) = a_0 + \\sum_{n=1}^{\\infty} \\left( a_n \\cos \\frac{n \\pi x}{L} + b_n \\sin \\frac{n \\pi x}{L} \\right)'],
];

export interface FormulaOptions {
  title: string;
  tex: string;
  display: boolean;
  macros: Record<string, string>;
  /** muestra la casilla "numerada" (solo al insertar ecuaciones de bloque) */
  askNumbered?: boolean;
  ok: (tex: string, numbered: boolean) => void;
  closed?: () => void;
}

/**
 * Lo que el preámbulo del documento cambia en sus fórmulas (babel en español, physics, siunitx): las
 * que dibuja el editor —la que se acaba de escribir, la vista previa de un diálogo— salen igual que
 * las del documento.
 */
let mathContext: MathContext = {};
let packageMacros = mathMacros();
export function setMathContext(ctx: MathContext | undefined): void {
  mathContext = ctx ?? {};
  packageMacros = mathMacros(mathContext);
}

export function renderMath(tex: string, display: boolean, macros: Record<string, string>): string {
  try {
    const ready = prepareMath(tex.replace(/\\label\s*\{[^}]*\}/g, ''), mathContext, (name) => macros[`\\${name}`] !== undefined);
    return katex.renderToString(ready, {
      displayMode: display, throwOnError: false, strict: 'ignore', output: 'html', macros: { ...packageMacros, ...macros },
      // solo se admite la orden con la que la paleta dibuja los huecos de las estructuras
      trust: (ctx: { command: string }) => ctx.command === '\\htmlClass',
    });
  } catch {
    return '';
  }
}

/** Lo mínimo que se usa del campo matemático de MathLive. */
interface MathField extends HTMLElement {
  value: string;
  mathVirtualKeyboardPolicy: string;
  inlineShortcuts: Record<string, string>;
  getValue(format: string): string;
  setValue(tex: string, options?: { silenceNotifications?: boolean }): void;
  insert(tex: string, options?: { focus?: boolean; format?: string; selectionMode?: string }): boolean;
  executeCommand(command: string): boolean;
}
interface MathLive {
  MathfieldElement: { new (): MathField; fontsDirectory: string | null; soundsDirectory: string | null; locale: string };
}

let mathlive: Promise<MathLive> | undefined;

/** MathLive (editor visual de fórmulas) se carga la primera vez que se abre el diálogo. */
function loadMathLive(): Promise<MathLive> {
  mathlive ??= (async () => {
    const lib = (await import(/* @vite-ignore */ document.body.dataset.mathlive as string)) as MathLive;
    lib.MathfieldElement.fontsDirectory = document.body.dataset.mathfonts as string;
    lib.MathfieldElement.soundsDirectory = null;
    try {
      lib.MathfieldElement.locale = 'es'; // su menú contextual, en español
    } catch {
      // versión sin esa opción: se queda en inglés
    }
    return lib;
  })();
  return mathlive;
}

/** Funciones con su nombre en español: al teclearlas quedan en redonda, como las demás. */
const SHORTCUTS: Record<string, string> = { sen: '\\mathrm{sen}', tg: '\\mathrm{tg}', arcsen: '\\mathrm{arcsen}', arctg: '\\mathrm{arctg}', mcd: '\\mathrm{mcd}', mcm: '\\mathrm{mcm}' };

/** Lo que se ha insertado desde la paleta en esta sesión, lo más reciente primero. */
const recent: Item[] = [];
/** El código LaTeX se enseña o no según lo dejó el usuario la última vez. */
let showCode = false;

const plain = (s: string): string => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Elementos de toda la paleta cuyo nombre o código contiene las palabras buscadas. */
export function searchPalette(query: string): Item[] {
  const words = plain(query).split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const out: Item[] = [];
  for (const g of PALETTE) {
    for (const it of g.items) {
      const hay = plain(`${it[2] ?? ''} ${it[1].replace(/#\?|[\\{}_^&]/g, ' ')} ${g.name}`);
      if (words.every((w) => hay.includes(w))) out.push(it);
    }
  }
  return out;
}

/** Matriz de `rows` × `cols` huecos dentro del entorno `env` (pmatrix, bmatrix...). */
export function matrixTex(rows: number, cols: number, env: string): string {
  const row = Array.from({ length: cols }, () => '#?').join(' & ');
  return `\\begin{${env}}${Array.from({ length: rows }, () => row).join(' \\\\ ')}\\end{${env}}`;
}

const MATRIX_KINDS: [env: string, icon: string, name: string][] = [
  ['pmatrix', '(\\,)', 'Entre paréntesis'], ['bmatrix', '[\\,]', 'Entre corchetes'], ['vmatrix', '|\\,|', 'Determinante'],
  ['Bmatrix', '\\{\\,\\}', 'Entre llaves'], ['matrix', '\\cdot', 'Sin delimitadores'],
];

/** LaTeX estándar a partir de lo que devuelve el campo visual. */
const clean = (tex: string): string => tex.replace(/\\placeholder\{[^}]*\}/g, '').replace(/\\mleft/g, '\\left').replace(/\\mright/g, '\\right');

let field: MathField | undefined;

/** Botón con un icono de la interfaz (codicon). */
function iconButton(icon: string, title: string, fn: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'eq-tool';
  b.title = title;
  b.innerHTML = `<i class="codicon codicon-${icon}"></i>`;
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', fn);
  return b;
}

/**
 * Editor de ecuaciones. Arriba, el campo visual: se escribe sobre la propia fórmula y los huecos
 * se rellenan en su sitio. Debajo, la paleta gráfica (buscador, lo usado hace poco y las
 * categorías, con las estructuras dibujadas con sus huecos). El código LaTeX queda plegado para
 * quien lo quiera; campo, paleta y código están siempre sincronizados.
 */
export function openFormula(o: FormulaOptions): void {
  const { box, body, buttons } = shell(o.title, () => {
    field = undefined;
    o.closed?.();
  });
  box.classList.add('wide', 'eq');
  body.classList.add('formula');

  const holder = document.createElement('div');
  holder.className = 'formula-field';
  holder.innerHTML = '<span class="ph">Cargando el editor visual…</span>';

  const ta = document.createElement('textarea');
  ta.rows = o.display ? 3 : 2;
  ta.spellcheck = false;
  ta.value = o.tex;
  ta.dataset.field = 'tex';
  ta.placeholder = 'x^2 + \\frac{1}{2}';

  const preview = document.createElement('div');
  preview.className = 'formula-preview';
  const paint = (): void => {
    preview.innerHTML = ta.value.trim() ? renderMath(ta.value, o.display, o.macros) : '<span class="ph">Así quedará en el documento</span>';
  };
  /** el código cambió: actualizar el campo visual y el resultado */
  const fromCode = (): void => {
    paint();
    if (field && clean(field.getValue('latex-expanded')) !== ta.value) field.setValue(ta.value, { silenceNotifications: true });
  };
  /** el campo visual cambió: actualizar el código y el resultado */
  const fromField = (): void => {
    if (!field) return;
    ta.value = clean(field.getValue('latex-expanded'));
    paint();
  };
  ta.addEventListener('input', fromCode);

  const insert = (tex: string): void => {
    if (field) {
      field.insert(tex, { focus: true, format: 'latex', selectionMode: 'placeholder' });
      fromField();
    } else {
      ta.setRangeText(tex.replace(/#\?/g, '') + ' ', ta.selectionStart, ta.selectionEnd, 'end');
      ta.focus();
      fromCode();
    }
  };

  // cabecera: deshacer, rehacer, vaciar y enseñar el código
  const title = box.querySelector('.dlg-title') as HTMLElement;
  title.innerHTML = '<span class="eq-badge"></span><span class="eq-title"></span><span class="eq-tools"></span>';
  (title.querySelector('.eq-badge') as HTMLElement).innerHTML = renderMath('f(x)', false, {});
  (title.querySelector('.eq-title') as HTMLElement).textContent = o.title;
  const tools = title.querySelector('.eq-tools') as HTMLElement;
  const codeBox = document.createElement('div');
  codeBox.className = 'eq-code';
  const setCode = (on: boolean): void => {
    codeBox.hidden = !on;
    codeToggle.classList.toggle('on', on);
  };
  const codeToggle = iconButton('code', 'Ver y editar el código LaTeX', () => {
    showCode = codeBox.hidden;
    setCode(showCode);
    if (showCode) ta.focus();
    else field?.focus();
  });
  tools.append(
    iconButton('discard', 'Deshacer', () => {
      field?.executeCommand('undo');
      fromField();
    }),
    iconButton('redo', 'Rehacer', () => {
      field?.executeCommand('redo');
      fromField();
    }),
    iconButton('clear-all', 'Vaciar la ecuación', () => {
      ta.value = '';
      fromCode();
      (field ?? ta).focus();
    }),
    codeToggle,
  );

  // cómo se escribe: lo esencial, a la vista
  const hints = document.createElement('div');
  hints.className = 'eq-hints';
  hints.innerHTML = (
    [['/', 'fracción'], ['^', 'exponente'], ['_', 'subíndice'], ['sqrt', 'raíz'], ['pi', 'π'], ['Tab', 'siguiente hueco']] as [string, string][]
  )
    .map(([k, what]) => `<span><kbd>${k}</kbd>${what}</span>`)
    .join('');

  // paleta gráfica
  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'eq-search';
  search.placeholder = 'Buscar: fracción, alfa, integral, flecha, matriz…';
  search.spellcheck = false;
  const recentRow = document.createElement('div');
  recentRow.className = 'eq-recent';
  const tabs = document.createElement('div');
  tabs.className = 'pal-tabs';
  const matrix = document.createElement('div');
  matrix.className = 'eq-matrix';
  matrix.hidden = true;
  const grid = document.createElement('div');
  grid.className = 'pal-grid';

  const pick = (it: Item): void => {
    const k = recent.findIndex((r) => r[1] === it[1]);
    if (k >= 0) recent.splice(k, 1);
    recent.unshift(it);
    recent.length = Math.min(recent.length, 12);
    insert(it[1]);
    paintRecent();
  };
  /** Botón de la paleta: la fórmula dibujada; el título dice qué es y qué código inserta. */
  const itemButton = (it: Item): HTMLButtonElement => {
    const b = document.createElement('button');
    b.innerHTML = renderMath(`\\displaystyle ${it[0]}`, false, o.macros);
    const name = it[2] ? it[2].split(' ')[0] : '';
    b.title = `${name ? name[0].toUpperCase() + name.slice(1) + ' — ' : ''}${it[1].replace(/#\?/g, '□')}`;
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => pick(it));
    return b;
  };
  const paintRecent = (): void => {
    recentRow.hidden = recent.length === 0;
    recentRow.replaceChildren();
    if (!recent.length) return;
    const label = document.createElement('span');
    label.className = 'eq-recent-label';
    label.textContent = 'Recientes';
    recentRow.append(label, ...recent.map(itemButton));
  };
  let current = 0;
  const show = (index: number): void => {
    current = index;
    search.value = '';
    const g = PALETTE[index];
    tabs.querySelectorAll('button').forEach((b, k) => b.classList.toggle('on', k === index));
    grid.classList.toggle('big', g.big === true);
    grid.replaceChildren(...g.items.map(itemButton));
    matrix.hidden = g.name !== 'Matrices';
  };
  PALETTE.forEach((g, k) => {
    const b = document.createElement('button');
    b.innerHTML = `<span class="pal-ico">${renderMath(g.icon, false, {})}</span><span>${g.name}</span>`;
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => show(k));
    tabs.appendChild(b);
  });
  search.addEventListener('input', () => {
    const q = search.value.trim();
    if (!q) {
      show(current);
      return;
    }
    const found = searchPalette(q).slice(0, 60);
    tabs.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
    matrix.hidden = true;
    grid.classList.toggle('big', found.some((it) => it[1].includes('#?')));
    if (found.length) grid.replaceChildren(...found.map(itemButton));
    else grid.innerHTML = '<div class="pal-empty">Nada con ese nombre. Prueba con otra palabra o escribe el código LaTeX.</div>';
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      // Intro inserta el primer resultado
      e.preventDefault();
      e.stopPropagation();
      (grid.querySelector('button') as HTMLButtonElement | null)?.click();
    }
  });

  // matrices: tamaño eligiendo en una cuadrícula y tipo de delimitador
  let kind = MATRIX_KINDS[0][0];
  const kinds = document.createElement('div');
  kinds.className = 'eq-kinds';
  for (const [env, icon, name] of MATRIX_KINDS) {
    const b = document.createElement('button');
    b.innerHTML = renderMath(icon, false, {});
    b.title = name;
    b.dataset.env = env;
    b.classList.toggle('on', env === kind);
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      kind = env;
      kinds.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
    });
    kinds.appendChild(b);
  }
  const sizeLabel = document.createElement('span');
  sizeLabel.className = 'eq-size';
  sizeLabel.textContent = 'Elige el tamaño';
  const cells = document.createElement('div');
  cells.className = 'eq-cells';
  for (let r = 1; r <= 5; r++) {
    for (let c = 1; c <= 6; c++) {
      const cell = document.createElement('span');
      cell.dataset.r = String(r);
      cell.dataset.c = String(c);
      cells.appendChild(cell);
    }
  }
  const over = (r: number, c: number): void => {
    cells.querySelectorAll<HTMLElement>('span').forEach((s) => s.classList.toggle('on', Number(s.dataset.r) <= r && Number(s.dataset.c) <= c));
    sizeLabel.textContent = r ? `Matriz de ${r} × ${c}` : 'Elige el tamaño';
  };
  cells.addEventListener('mouseover', (e) => {
    const cell = (e.target as HTMLElement).closest('span') as HTMLElement | null;
    if (cell?.dataset.r) over(Number(cell.dataset.r), Number(cell.dataset.c));
  });
  cells.addEventListener('mouseleave', () => over(0, 0));
  cells.addEventListener('mousedown', (e) => e.preventDefault());
  cells.addEventListener('click', (e) => {
    const cell = (e.target as HTMLElement).closest('span') as HTMLElement | null;
    if (cell?.dataset.r) insert(matrixTex(Number(cell.dataset.r), Number(cell.dataset.c), kind));
  });
  const matrixText = document.createElement('div');
  matrixText.className = 'eq-matrix-text';
  matrixText.append(sizeLabel, kinds);
  matrix.append(cells, matrixText);

  const codeLabel = document.createElement('div');
  codeLabel.className = 'formula-label';
  codeLabel.textContent = 'Código LaTeX';
  codeBox.append(codeLabel, ta);
  body.append(holder, hints, search, recentRow, tabs, matrix, grid, codeBox, preview);
  // sin el campo visual (todavía cargando, o si fallara) se trabaja con el código y su resultado
  preview.hidden = false;
  setCode(true);

  let numbered: HTMLInputElement | undefined;
  if (o.askNumbered) {
    const row = document.createElement('label');
    row.className = 'field check eq-numbered';
    numbered = document.createElement('input');
    numbered.type = 'checkbox';
    numbered.checked = true;
    const span = document.createElement('span');
    span.textContent = 'Ecuación numerada';
    row.append(numbered, span);
    buttons.appendChild(row);
  }
  const submit = (): void => {
    const tex = ta.value.trim();
    const num = numbered?.checked ?? false;
    closeDialog();
    if (tex) o.ok(tex, num);
  };
  const onEnter = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && (!o.display || e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      submit();
    }
  };
  ta.addEventListener('keydown', onEnter);
  button(buttons, 'Cancelar', false, closeDialog);
  const okButton = button(buttons, 'Insertar', true, submit);
  okButton.title = o.display ? 'Ctrl+Enter' : 'Enter';
  show(0);
  paintRecent();
  paint();
  ta.focus();

  const mine = overlay;
  loadMathLive()
    .then((lib) => {
      if (overlay !== mine) return; // el diálogo ya se cerró
      const mf = new lib.MathfieldElement();
      mf.mathVirtualKeyboardPolicy = 'manual';
      if (!o.display) mf.setAttribute('default-mode', 'inline-math');
      mf.setAttribute('placeholder', '\\text{Escribe aquí la ecuación}');
      try {
        mf.inlineShortcuts = { ...mf.inlineShortcuts, ...SHORTCUTS };
      } catch {
        // sin atajos propios: quedan los de MathLive
      }
      mf.value = ta.value;
      mf.addEventListener('input', fromField);
      mf.addEventListener('keydown', onEnter as EventListener);
      holder.replaceChildren(mf);
      field = mf;
      // con el campo visual ya no hacen falta ni el resultado aparte ni el código a la vista
      preview.hidden = true;
      setCode(showCode);
      mf.focus();
    })
    .catch((err) => {
      holder.innerHTML = '<span class="ph">El editor visual no está disponible; usa la paleta y el código LaTeX.</span>';
      console.error('[mars] MathLive', err);
    });
}

/** Para las pruebas: rellena un campo del diálogo abierto y pulsa Aceptar. */
export function fillDialog(values: Record<string, string>): boolean {
  if (!overlay) return false;
  for (const [id, v] of Object.entries(values)) {
    const el = overlay.querySelector<HTMLInputElement>(`[data-field="${id}"]`);
    if (!el) continue;
    if (el.type === 'checkbox') el.checked = Boolean(v);
    else el.value = v;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  overlay.querySelector<HTMLButtonElement>('button.primary')?.click();
  return true;
}

/** Para las pruebas: estado del editor de ecuaciones y uso de su paleta. */
export function formulaProbe(action: string, arg: number | string = 0, item = 0): unknown {
  if (!overlay) return undefined;
  if (action === 'palette') {
    overlay.querySelectorAll<HTMLButtonElement>('.pal-tabs button')[Number(arg)]?.click();
    overlay.querySelectorAll<HTMLButtonElement>('.pal-grid button')[item]?.click();
  } else if (action === 'type' && field) {
    // como si el usuario tecleara sobre la fórmula
    field.insert(String(arg), { format: 'latex' });
    field.dispatchEvent(new Event('input'));
  } else if (action === 'search') {
    const box = overlay.querySelector<HTMLInputElement>('.eq-search');
    if (box) {
      box.value = String(arg);
      box.dispatchEvent(new Event('input'));
    }
  } else if (action === 'matrix') {
    // «filas,columnas,entorno»
    const [r, c, env] = String(arg).split(',');
    overlay.querySelector<HTMLElement>(`.eq-kinds button[data-env="${env}"]`)?.click();
    overlay.querySelector<HTMLElement>(`.eq-cells span[data-r="${r}"][data-c="${c}"]`)?.click();
  } else if (action === 'tool') {
    overlay.querySelectorAll<HTMLElement>('.eq-tool')[Number(arg)]?.click();
  }
  return {
    recent: overlay.querySelectorAll('.eq-recent button').length,
    holes: overlay.querySelectorAll('.pal-grid .hole').length,
    codeShown: overlay.querySelector<HTMLElement>('.eq-code')?.hidden === false,
    matrixShown: overlay.querySelector<HTMLElement>('.eq-matrix')?.hidden === false,
    visual: field !== undefined,
    fieldValue: field ? clean(field.getValue('latex-expanded')) : undefined,
    code: overlay.querySelector<HTMLTextAreaElement>('[data-field="tex"]')?.value,
    tabs: overlay.querySelectorAll('.pal-tabs button').length,
    items: overlay.querySelectorAll('.pal-grid button').length,
    rendered: overlay.querySelectorAll('.pal-grid .katex').length,
  };
}
