import { escapeText } from './serialize';

/*
 * HTML pegado (Word, Google Docs, páginas web) -> LaTeX, conservando negritas, cursivas,
 * enlaces, títulos, listas y tablas.
 */

const INLINE: Record<string, [string, string]> = {
  B: ['\\textbf{', '}'], STRONG: ['\\textbf{', '}'], I: ['\\textit{', '}'], EM: ['\\emph{', '}'], U: ['\\underline{', '}'],
  SUP: ['\\textsuperscript{', '}'], SUB: ['\\textsubscript{', '}'], CODE: ['\\texttt{', '}'], TT: ['\\texttt{', '}'],
};
const HEAD: Record<string, string> = { H1: 'section', H2: 'subsection', H3: 'subsubsection', H4: 'paragraph', H5: 'paragraph', H6: 'paragraph' };
const SKIP = new Set(['STYLE', 'SCRIPT', 'META', 'LINK', 'TITLE', 'HEAD', 'IMG', 'SVG', 'OBJECT', 'IFRAME', 'TEMPLATE']);
const BLOCK = new Set(['P', 'DIV', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'MAIN', 'TR', 'DD', 'DT', 'FIGURE', 'FIGCAPTION', 'PRE']);

const squash = (s: string): string => s.replace(/\s+/g, ' ');

function inline(node: Node): string {
  if (node.nodeType === 3) return escapeText(squash((node as Text).data));
  if (node.nodeType !== 1) return '';
  const el = node as HTMLElement;
  const tag = el.tagName;
  if (SKIP.has(tag)) return '';
  if (tag === 'BR') return ' \\\\\n';
  let inner = Array.from(el.childNodes).map(inline).join('');
  if (!inner.trim()) return inner;
  if (tag === 'A') {
    const href = el.getAttribute('href') ?? '';
    return /^(https?:|mailto:)/i.test(href) ? `\\href{${href.replace(/[%#]/g, '\\$&')}}{${inner}}` : inner;
  }
  const map = INLINE[tag];
  if (map) return map[0] + inner + map[1];
  // Word y Google Docs marcan el formato con estilos en vez de con etiquetas
  const st = el.style;
  if (st) {
    if (st.fontStyle === 'italic') inner = `\\textit{${inner}}`;
    if (st.fontWeight === 'bold' || parseInt(st.fontWeight, 10) >= 600) inner = `\\textbf{${inner}}`;
    if (st.textDecoration.includes('underline') || st.textDecorationLine?.includes('underline')) inner = `\\underline{${inner}}`;
  }
  return inner;
}

function list(el: Element, ind: string): string {
  const env = el.tagName === 'OL' ? 'enumerate' : 'itemize';
  const items = Array.from(el.children)
    .filter((li) => li.tagName === 'LI')
    .map((li) => {
      const parts: string[] = [];
      let text = '';
      for (const ch of Array.from(li.childNodes)) {
        if (ch.nodeType === 1 && ((ch as Element).tagName === 'UL' || (ch as Element).tagName === 'OL')) parts.push(list(ch as Element, ind + '  '));
        else text += ch.nodeType === 1 && BLOCK.has((ch as Element).tagName) ? ' ' + inline(ch) : inline(ch);
      }
      return [`${ind}  \\item ${text.trim()}`, ...parts].join('\n');
    });
  return `${ind}\\begin{${env}}\n${items.join('\n')}\n${ind}\\end{${env}}`;
}

function table(el: Element): string {
  const rows = Array.from(el.querySelectorAll('tr')).map((tr) =>
    Array.from(tr.children)
      .filter((c) => c.tagName === 'TD' || c.tagName === 'TH')
      .map((c) => {
        const t = inline(c).replace(/\s*\\\\\s*/g, ' ').trim();
        return c.tagName === 'TH' && t ? `\\textbf{${t}}` : t;
      }),
  );
  const cols = Math.max(0, ...rows.map((r) => r.length));
  if (!cols) return '';
  const body = rows.map((r) => `    ${[...r, ...Array(cols - r.length).fill('')].join(' & ')} \\\\\n    \\hline`).join('\n');
  return `\\begin{center}\n  \\begin{tabular}{|${'l|'.repeat(cols)}}\n    \\hline\n${body}\n  \\end{tabular}\n\\end{center}`;
}

/** Bloques de LaTeX (párrafos, títulos, listas, tablas) a partir de un árbol HTML. */
function blocks(node: Node, out: string[]): void {
  let run = '';
  const flush = (): void => {
    const t = run.replace(/[ \t]+/g, ' ').trim();
    if (t) out.push(t);
    run = '';
  };
  for (const ch of Array.from(node.childNodes)) {
    if (ch.nodeType !== 1) {
      run += inline(ch);
      continue;
    }
    const el = ch as HTMLElement;
    const tag = el.tagName;
    if (SKIP.has(tag)) continue;
    if (HEAD[tag]) {
      flush();
      const t = inline(el).replace(/\\textbf\{([^{}]*)\}/g, '$1').trim();
      if (t) out.push(`\\${HEAD[tag]}{${t}}`);
    } else if (tag === 'UL' || tag === 'OL') {
      flush();
      out.push(list(el, ''));
    } else if (tag === 'TABLE') {
      flush();
      const t = table(el);
      if (t) out.push(t);
    } else if (tag === 'BLOCKQUOTE') {
      flush();
      const inner: string[] = [];
      blocks(el, inner);
      if (inner.length) out.push(`\\begin{quote}\n${inner.join('\n\n')}\n\\end{quote}`);
    } else if (tag === 'PRE') {
      flush();
      out.push(`\\begin{verbatim}\n${el.textContent ?? ''}\n\\end{verbatim}`);
    } else if (tag === 'HR') {
      flush();
    } else if (BLOCK.has(tag) || tag === 'BODY' || tag === 'HTML') {
      flush();
      // un contenedor con bloques dentro se recorre; si solo tiene texto es un párrafo
      if (el.querySelector('p, div, ul, ol, table, h1, h2, h3, h4, blockquote, pre')) blocks(el, out);
      else {
        const t = inline(el).trim();
        if (t) out.push(t);
      }
    } else run += inline(el);
  }
  flush();
}

/**
 * Convierte el HTML del portapapeles a LaTeX. Devuelve `undefined` cuando no aporta formato
 * (texto corriente): en ese caso es mejor pegar el texto plano.
 */
export function htmlToLatex(root: Node): string | undefined {
  const out: string[] = [];
  blocks(root, out);
  const tex = out.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return /\\(textbf|textit|emph|underline|href|section|subsection|subsubsection|paragraph|begin|texttt|textsuperscript|textsubscript)\b/.test(tex) ? tex : undefined;
}
