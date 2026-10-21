/**
 * Encabezado y pie de página como los edita el usuario: tres casillas arriba y tres abajo, con
 * marcas legibles ({página}, {total}, {sección}, {subsección}) en lugar de las órdenes de LaTeX.
 * Sin dependencias del DOM: lo usan el diálogo del editor y las pruebas.
 */

import { escHtml, escapeText } from './serialize';

export type Cells = [string, string, string];

export interface HeadFootSpec {
  head: Cells;
  foot: Cells;
  headRule: boolean;
  footRule: boolean;
}

/** Marca legible -> orden de LaTeX. */
const TOKENS: [string, string][] = [
  ['{página}', '\\thepage'],
  ['{total}', '\\pageref{LastPage}'],
  ['{sección}', '\\leftmark'],
  ['{subsección}', '\\rightmark'],
];
const TOKEN_RE = /(\{página\}|\{total\}|\{sección\}|\{subsección\})/;

/** Código de una casilla -> lo que se escribe en el diálogo. */
export function toFriendly(tex: string): string {
  let s = tex;
  for (const [mark, cmd] of TOKENS) {
    // (con lo que LaTeX pide para no comerse el espacio de detrás: «\thepage\ de», «\thepage{} de»)
    const esc = cmd.replace(/[\\{}]/g, '\\$&');
    s = s.replace(new RegExp(`${esc}(?![a-zA-Z])(?:\\{\\}|\\\\(?= ))?`, 'g'), mark);
  }
  // texto corriente escapado (50\%, A\&B): se enseña tal cual
  if (!/\\[a-zA-Z]/.test(s)) s = s.replace(/\\([%&#$_{}])/g, '$1');
  return s;
}

/**
 * Lo escrito en el diálogo -> código de la casilla. Si lleva órdenes de LaTeX se respeta tal cual
 * (salvo las marcas); si es texto corriente, se escapa lo que LaTeX entendería como código.
 */
export function toTex(text: string): string {
  const latex = /\\[a-zA-Z]/.test(text);
  const parts = text.trim().split(TOKEN_RE);
  return parts
    .map((p, k) => {
      if (k % 2 === 0) return latex ? p : escapeText(p);
      const cmd = TOKENS.find(([mark]) => mark === p)?.[1] ?? '';
      // una orden seguida de un espacio o una letra se comería el espacio: se cierra con {}
      return /[a-zA-Z]$/.test(cmd) && /^[\sa-zA-Z]/.test(parts[k + 1] ?? '') ? `${cmd}{}` : cmd;
    })
    .join('');
}

/** Dónde poner el número de página. */
export type NumberPlace = 'bottom-center' | 'bottom-right' | 'top-right' | 'page-of' | 'none';

/** Lleva el número de página a otro sitio (o lo quita), sin tocar lo demás del encabezado y el pie. */
export function withPageNumber(spec: HeadFootSpec, place: NumberPlace, lang = 'spanish'): HeadFootSpec {
  const clear = (c: Cells): Cells => c.map((x) => (/\\thepage(?![a-zA-Z])/.test(x) ? '' : x)) as Cells;
  const head = clear(spec.head);
  const foot = clear(spec.foot);
  const word = lang === 'english' ? ['Page', 'of'] : ['Página', 'de'];
  if (place === 'bottom-center') foot[1] = '\\thepage';
  else if (place === 'bottom-right') foot[2] = '\\thepage';
  else if (place === 'top-right') head[2] = '\\thepage';
  else if (place === 'page-of') foot[1] = `${word[0]} \\thepage{} ${word[1]} \\pageref{LastPage}`;
  return { ...spec, head, foot };
}

/** Boceto de la hoja con su encabezado y su pie, con valores de ejemplo en las marcas. */
export function headFootPreview(spec: HeadFootSpec): string {
  const sample = (tex: string): string =>
    escHtml(
      toFriendly(tex)
        .replace(/\{página\}/g, '3')
        .replace(/\{total\}/g, '12')
        .replace(/\{sección\}/g, '1. Introducción')
        .replace(/\{subsección\}/g, '1.1. Contexto')
        // lo demás de LaTeX, sin sus órdenes: solo para hacerse una idea
        .replace(/\\[a-zA-Z]+\*?/g, '')
        .replace(/[{}]/g, ''),
    );
  const row = (cls: string, cells: Cells, rule: boolean): string =>
    `<div class="hf-row ${cls}${rule ? ' ruled' : ''}">${cells.map((c) => `<span>${sample(c)}</span>`).join('')}</div>`;
  return (
    `<div class="hf-sheet">${row('hf-head', spec.head, spec.headRule)}` +
    '<div class="hf-text"><i></i><i></i><i></i><i></i><i></i><i></i></div>' +
    `${row('hf-foot', spec.foot, spec.footRule)}</div>`
  );
}
