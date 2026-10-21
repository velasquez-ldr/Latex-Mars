/*
 * DOM -> LaTeX. Inverso del renderizador: recorre el HTML anotado (data-tex, data-o/data-c,
 * data-skip, data-k) y reconstruye el código fuente. Los elementos que crea el navegador al
 * editar (b, i, u, br, div...) se traducen a sus comandos LaTeX.
 *
 * Las listas y tablas conservan el formato con que estaban escritas: cada elemento o fila lleva
 * su código original (data-raw) y solo se vuelve a generar el que el usuario ha modificado.
 */

const TEXT_MAP: Record<string, string> = {
  ' ': ' ', '—': '---', '–': '--', '“': '``', '”': "''", '‘': '`', '’': "'",
  '%': '\\%', '&': '\\&', '#': '\\#', '_': '\\_', '$': '\\$',
  '~': '\\textasciitilde{}', '^': '\\textasciicircum{}',
};

/** Texto para insertar en HTML: sin etiquetas ni comillas que cierren un atributo. */
export const escHtml = (s: string): string => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);

export function escapeText(s: string): string {
  return s.replace(/[ —–“”‘’%&#_$~^]/g, (ch) => TEXT_MAP[ch]);
}

/**
 * Como `escapeText`, pero también las barras invertidas y las llaves: para un texto que se sabe
 * que no es código LaTeX (una ruta de Windows, un trozo con una llave suelta).
 */
export function escapeLiteral(s: string): string {
  let out = '';
  for (const ch of s) out += ch === '\\' ? '\\textbackslash{}' : ch === '{' ? '\\{' : ch === '}' ? '\\}' : escapeText(ch);
  return out;
}

/** Las llaves de un texto van por parejas (sin contar las que ya están escapadas). */
export function bracesBalanced(s: string): boolean {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '{') depth++;
    else if (s[i] === '}' && --depth < 0) return false;
  }
  return depth === 0;
}

const TAGS: Record<string, [string, string]> = {
  B: ['\\textbf{', '}'], STRONG: ['\\textbf{', '}'], I: ['\\textit{', '}'], EM: ['\\emph{', '}'],
  U: ['\\underline{', '}'], CODE: ['\\texttt{', '}'], S: ['\\sout{', '}'], STRIKE: ['\\sout{', '}'],
  SUP: ['\\textsuperscript{', '}'], SUB: ['\\textsubscript{', '}'],
};

export function tidy(s: string): string {
  return s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const oneLine = (s: string): string => tidy(s).replace(/\s*\n\s*/g, ' ');

/** Marca el final de una estructura de bloque: absorbe el salto de línea que venga detrás. */
const END = '\u0003';

/** Elemento con la firma de su contenido tal como se renderizó. */
type Signed = Element & { _sig?: string };

/** Añade una estructura de varias líneas (lista, tabla) empezando en línea propia. */
function block(out: string[], text: string): void {
  const before = out.join('').replace(/[ \t]+$/, '');
  out.length = 0;
  if (before) out.push(before, /[\n\u0003]$/.test(before) ? '' : '\n');
  out.push(text, END);
}

// ------------------------------------------------------------------ forma canónica

function itemTex(li: Element): string {
  const io = (li.getAttribute('data-o') ?? '\\item ').trimEnd();
  return `${io} ${tidy(serializeChildren(li))}`.trimEnd();
}

function cellsTex(tr: Element): string {
  return Array.from(tr.children)
    .filter((td) => td.tagName === 'TD' || td.tagName === 'TH')
    .map((td) => (td.getAttribute('data-o') ?? '') + oneLine(serializeChildren(td)) + (td.getAttribute('data-c') ?? ''))
    .join(' & ');
}

const canon = (el: Element): string => (el.tagName === 'TR' ? cellsTex(el) : itemTex(el));

/**
 * Anota cada elemento de lista y fila de tabla con la firma de su contenido recién renderizado.
 * Mientras la firma no cambie, al serializar se emite su código original sin tocar.
 */
export function stamp(root: Element): void {
  for (const el of Array.from(root.querySelectorAll('[data-raw]'))) (el as Signed)._sig = canon(el);
}

/** Código original del elemento si no se ha modificado. */
function untouched(el: Element, now: string): string | undefined {
  const sig = (el as Signed)._sig;
  return sig !== undefined && sig === now ? el.getAttribute('data-raw') ?? undefined : undefined;
}

// ------------------------------------------------------------------ listas y tablas

const rows = (el: Element): Element[] => Array.from(el.querySelectorAll(':scope > tr, :scope > tbody > tr'));

/** Lista o tabla renderizada desde el documento: se respeta su formato original. */
function exact(el: Element): string {
  const isTable = el.getAttribute('data-k') === 'table';
  const kids = isTable ? rows(el) : Array.from(el.children).filter((c) => c.tagName === 'LI');
  let out = el.getAttribute('data-o') ?? '';
  let lead = '\n';
  for (const kid of kids) {
    lead = kid.getAttribute('data-lead') ?? lead;
    const now = canon(kid);
    const tex = untouched(kid, now) ?? (isTable ? (kid.getAttribute('data-pre') ?? '') + now + (kid.getAttribute('data-post') ?? ' \\\\') : now);
    out += lead + tex;
  }
  return out + (el.getAttribute('data-c') ?? '');
}

/** Lista creada durante la edición (sin formato previo que respetar). */
function list(el: Element, ind: string): string {
  const ordered = el.tagName === 'OL';
  const o = el.getAttribute('data-o') ?? (ordered ? '\\begin{enumerate}' : '\\begin{itemize}');
  const c = el.getAttribute('data-c') ?? (ordered ? '\\end{enumerate}' : '\\end{itemize}');
  const lines = [ind + o.trim()];
  for (const li of Array.from(el.children)) if (li.tagName === 'LI') lines.push(`${ind}  ${itemTex(li)}`);
  if (c.trim()) lines.push(ind + c.trim());
  return lines.join('\n');
}

function ser(n: Node, out: string[], ind: string): void {
  if (n.nodeType === 3) {
    out.push(escapeText((n as Text).data));
    return;
  }
  if (n.nodeType !== 1) return;
  const el = n as Element;
  if (el.hasAttribute('data-skip')) return;
  if (el.hasAttribute('data-thru')) {
    // aspecto que pone una orden del documento (un estilo propio): no es código, solo lo es su contenido
    for (const ch of Array.from(el.childNodes)) ser(ch, out, ind);
    return;
  }
  const tex = el.getAttribute('data-tex');
  if (tex !== null) {
    out.push(tex);
    return;
  }
  const kind = el.getAttribute('data-k');
  const tag = el.tagName;
  if ((kind === 'list' || kind === 'table') && el.hasAttribute('data-x')) {
    // una lista o tabla recién anidada empieza en línea propia
    const prev = out.length ? out[out.length - 1] : '';
    if (prev && !/\s$/.test(prev)) out.push('\n');
    out.push(exact(el));
    return;
  }
  if (kind === 'list' || (!kind && (tag === 'UL' || tag === 'OL'))) return block(out, list(el, ind));
  if (kind === 'head') {
    out.push((el.getAttribute('data-o') ?? '') + oneLine(serializeChildren(el, ind)) + (el.getAttribute('data-c') ?? ''));
    return;
  }

  const o = el.getAttribute('data-o');
  const c = el.getAttribute('data-c');
  if (o !== null || c !== null) {
    const inner = o?.startsWith('\\begin{') ? ind + '  ' : ind;
    out.push(o ?? '');
    for (const ch of Array.from(el.childNodes)) ser(ch, out, inner);
    out.push(c ?? '');
    return;
  }

  // elementos creados por el navegador durante la edición
  if (tag === 'BR') {
    // (delante de una sublista no hay línea que terminar: LaTeX daría error)
    let next = el.nextSibling;
    while (next && next.nodeType === 3 && !next.textContent?.trim()) next = next.nextSibling;
    const list = next?.nodeType === 1 && (/^(UL|OL)$/.test((next as Element).tagName) || (next as Element).getAttribute('data-k') === 'list');
    if (next && !list) out.push(' \\\\\n');
    return;
  }
  if (tag === 'DIV' || tag === 'P') {
    out.push('\n\n');
    for (const ch of Array.from(el.childNodes)) ser(ch, out, ind);
    return;
  }
  const map = TAGS[tag];
  if (!map) {
    for (const ch of Array.from(el.childNodes)) ser(ch, out, ind);
    return;
  }
  const inner = serializeChildren(el, ind);
  if (inner) out.push(map[0], inner, map[1]);
}

export function serializeChildren(el: Node, ind = ''): string {
  const out: string[] = [];
  for (const ch of Array.from(el.childNodes)) ser(ch, out, ind);
  return out.join('').replace(/\u0003[ \t]*\n?/g, '\n');
}

/** Código LaTeX de un bloque completo a partir de su contenedor de contenido. */
export function serializeBlock(content: Node): string {
  return tidy(serializeChildren(content));
}
