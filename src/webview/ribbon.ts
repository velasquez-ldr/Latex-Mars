/** Datos de la cinta de opciones: estilos, menús de Disposición, tamaños de letra y colores. */

export const STYLES: [level: string, name: string, tag: string][] = [
  ['', 'Normal', 'span'], ['section', 'Título 1', 'b'], ['subsection', 'Título 2', 'b'],
  ['subsubsection', 'Título 3', 'b'], ['chapter', 'Capítulo', 'b'],
];

/** Opciones de la pestaña Disposición: [valor en el preámbulo, texto del menú]. */
export const es = (n: number): string => String(Math.round(n * 100) / 100).replace('.', ',');

/** Miniatura de una hoja con su caja de texto, a escala (para los menús de márgenes, tamaño y orientación). */
export function sheetThumb(w: number, h: number, m?: [number, number, number, number], k = 34 / 30): string {
  const box = m ? `<i style="top:${m[0] * k}px;bottom:${m[1] * k}px;left:${m[2] * k}px;right:${m[3] * k}px"></i>` : '';
  return `<span class="thumb" style="width:${Math.round(w * k)}px;height:${Math.round(h * k)}px">${box}</span>`;
}

/** Márgenes predefinidos: [superior, inferior, izquierdo, derecho] en centímetros. */
const MARGIN_PRESETS: [name: string, sides: [number, number, number, number]][] = [
  ['Normal', [2.54, 2.54, 2.54, 2.54]],
  ['Estrecho', [1.27, 1.27, 1.27, 1.27]],
  ['Moderado', [2.54, 2.54, 1.91, 1.91]],
  ['Ancho', [2.54, 2.54, 5.08, 5.08]],
  ['Encuadernación', [2.5, 2.5, 3.5, 2]],
];
const marginItem = (name: string, s: [number, number, number, number]): string =>
  `${sheetThumb(21, 29.7, s)}<span class="mi-text"><b>${name}</b><small>Sup. ${es(s[0])} · Inf. ${es(s[1])} · Izq. ${es(s[2])} · Der. ${es(s[3])} cm</small></span>`;

const PAPER_SIZES: [value: string, name: string, w: number, h: number][] = [
  ['a4paper', 'A4', 21, 29.7], ['letterpaper', 'Carta', 21.59, 27.94], ['legalpaper', 'Oficio', 21.59, 35.56],
  ['a3paper', 'A3', 29.7, 42], ['a5paper', 'A5', 14.8, 21], ['b5paper', 'B5', 17.6, 25], ['executivepaper', 'Ejecutivo', 18.42, 26.67],
];

export const LAYOUT_MENUS: Record<string, [string, string][]> = {
  margins: [
    ['', `${sheetThumb(21, 29.7, [3.7, 3.7, 4.5, 4.5])}<span class="mi-text"><b>Predeterminados de LaTeX</b><small>Caja de texto estrecha y centrada</small></span>`],
    ...MARGIN_PRESETS.map(([name, s]) => [s.map((x) => `${x}cm`).join(','), marginItem(name, s)] as [string, string]),
    ['custom', `<i class="codicon codicon-settings-gear"></i><span class="mi-text"><b>Márgenes personalizados…</b></span>`],
  ],
  orientation: [
    ['portrait', `${sheetThumb(21, 29.7, undefined, 1)}<span class="mi-text"><b>Vertical</b></span>`],
    ['landscape', `${sheetThumb(29.7, 21, undefined, 1)}<span class="mi-text"><b>Horizontal</b></span>`],
  ],
  paper: [
    // todas a la misma escala, para que se vea la diferencia de tamaño
    ...PAPER_SIZES.map(([v, name, w, h]) => [v, `${sheetThumb(w, h, undefined, 0.86)}<span class="mi-text"><b>${name}</b><small>${es(w)} × ${es(h)} cm</small></span>`] as [string, string]),
    ['custom', `<i class="codicon codicon-settings-gear"></i><span class="mi-text"><b>Tamaño personalizado…</b></span>`],
  ],
  columns: [['1', 'Una columna'], ['2', 'Dos columnas']],
  spacing: [['1', 'Sencillo'], ['1.5', '1,5 líneas'], ['2', 'Doble']],
  cls: [['article', 'Artículo'], ['report', 'Informe (con capítulos)'], ['book', 'Libro']],
  lang: [['spanish', 'Español'], ['english', 'Inglés'], ['french', 'Francés'], ['german', 'Alemán'], ['portuguese', 'Portugués'], ['italian', 'Italiano']],
};

/** Cómo se ven las hojas horizontales (ajuste `mars.landscapePages`): [valor, texto del menú]. */
export const LANDSCAPE_MENU: [string, string][] = [
  ['edit', `${sheetThumb(21, 29.7, undefined, 1)}<span class="mi-text"><b>Girada; derecha al editarla</b><small>Como en el PDF hasta que haces clic en ella para editarla</small></span>`],
  ['pdf', `${sheetThumb(21, 29.7, undefined, 1)}<span class="mi-text"><b>Como en el PDF</b><small>Girada en hoja vertical con lscape; apaisada con pdflscape</small></span>`],
  ['rotated', `${sheetThumb(21, 29.7, undefined, 1)}<span class="mi-text"><b>Siempre girada</b><small>Como sale impresa: hoja vertical, contenido a 90°</small></span>`],
  ['upright', `${sheetThumb(29.7, 21, undefined, 1)}<span class="mi-text"><b>Siempre derecha</b><small>Más cómoda para leer y editar</small></span>`],
];

/** Idiomas del corrector ortográfico: [valor del ajuste, texto del menú]. */
export const SPELL_CHOICES: [string, string][] = [
  ['auto', 'Automático (el idioma del documento)'], ['es', 'Español'], ['en', 'Inglés'], ['es+en', 'Español e inglés'],
];

export const SIZE_EM: Record<string, number> = { footnotesize: 0.8, small: 0.9, large: 1.2, Large: 1.44, huge: 2.07 };
/** Tamaños de letra del cuadro de Inicio, en puntos (los de un procesador de textos). */
export const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];
export const ptText = (pt: number): string => String(Math.round(pt * 10) / 10).replace('.', ',');
const COLORS = ['black', 'red', 'blue', 'teal', 'orange', 'purple', 'brown', 'gray'];

// paleta como la de un procesador de textos: colores del tema con sus tonos, los estándar y los recientes
export const THEME_COLORS: [string, string][] = [
  ['FFFFFF', 'Blanco'], ['000000', 'Negro'], ['E7E6E6', 'Gris claro'], ['44546A', 'Azul grisáceo'], ['4472C4', 'Azul'],
  ['ED7D31', 'Naranja'], ['A5A5A5', 'Gris'], ['FFC000', 'Oro'], ['5B9BD5', 'Azul claro'], ['70AD47', 'Verde'],
];
export const STANDARD_COLORS: [string, string][] = [
  ['C00000', 'Rojo oscuro'], ['FF0000', 'Rojo'], ['FFC000', 'Naranja'], ['FFFF00', 'Amarillo'], ['92D050', 'Verde claro'],
  ['00B050', 'Verde'], ['00B0F0', 'Azul claro'], ['0070C0', 'Azul'], ['002060', 'Azul oscuro'], ['7030A0', 'Púrpura'],
];
/** Colores que xcolor conoce por su nombre: el código queda más legible que con el número. */
const COLOR_NAMES: Record<string, string> = { '000000': 'black', FFFFFF: 'white', FF0000: 'red', '00FF00': 'green', '0000FF': 'blue', FFFF00: 'yellow', '00FFFF': 'cyan', FF00FF: 'magenta' };

/** `hex` aclarado (f > 0, hacia el blanco) u oscurecido (f < 0, hacia el negro) en esa proporción. */
function tone(hex: string, f: number): string {
  return [0, 2, 4]
    .map((k) => {
      const v = parseInt(hex.slice(k, k + 2), 16);
      return Math.round(f >= 0 ? v + (255 - v) * f : v * (1 + f)).toString(16).padStart(2, '0');
    })
    .join('')
    .toUpperCase();
}

/** Filas de tonos bajo cada color del tema: del más claro al más oscuro. */
export function themeTones(): [string, string][][] {
  const steps = (hex: string): number[] => (hex === 'FFFFFF' ? [-0.05, -0.15, -0.25, -0.35, -0.5] : hex === '000000' ? [0.5, 0.35, 0.25, 0.15, 0.05] : [0.8, 0.6, 0.4, -0.25, -0.5]);
  return [0, 1, 2, 3, 4].map((row) =>
    THEME_COLORS.map(([hex, name]): [string, string] => {
      const f = steps(hex)[row];
      return [tone(hex, f), `${name}, ${f > 0 ? 'más claro' : 'más oscuro'} ${Math.round(Math.abs(f) * 100)} %`];
    }),
  );
}

/** Cómo se escribe un color en LaTeX y cómo se pinta: un nombre de xcolor o seis cifras hexadecimales. */
export function colorOf(v: string | undefined): { open: string; css: string; hex?: string } | undefined {
  if (!v) return undefined;
  if (COLORS.includes(v)) return { open: `\\textcolor{${v}}{`, css: v };
  const hex = v.replace(/^#/, '').toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(hex)) return undefined;
  const name = COLOR_NAMES[hex];
  return { open: name ? `\\textcolor{${name}}{` : `\\textcolor[HTML]{${hex}}{`, css: `#${hex}`, hex };
}
