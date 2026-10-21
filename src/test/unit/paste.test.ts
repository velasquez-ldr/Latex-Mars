import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { renderLatex } from '../../latex/renderer';
import { htmlToLatex } from '../../webview/paste';
import { bracesBalanced, escapeLiteral } from '../../webview/serialize';

const tex = (html: string): string | undefined => htmlToLatex(new JSDOM(`<body>${html}</body>`).window.document.body);

test('formato de carácter y enlaces', () => {
  assert.equal(tex('Un <b>texto</b> con <i>cursiva</i>, <u>subrayado</u> y x<sup>2</sup>'), 'Un \\textbf{texto} con \\textit{cursiva}, \\underline{subrayado} y x\\textsuperscript{2}');
  assert.equal(tex('Ver <a href="https://a.b/c?x=1#y">la web</a> al 50%'), 'Ver \\href{https://a.b/c?x=1\\#y}{la web} al 50\\%');
});

test('el formato por estilos de Word y Google Docs también se reconoce', () => {
  assert.equal(tex('<span style="font-weight:700">fuerte</span> y <span style="font-style:italic">inclinado</span>'), '\\textbf{fuerte} y \\textit{inclinado}');
});

test('títulos, párrafos y listas anidadas', () => {
  const out = tex('<h1>Título</h1><p>Primer párrafo.</p><p>Segundo <strong>párrafo</strong>.</p><ul><li>uno</li><li>dos<ol><li>a</li></ol></li></ul>');
  assert.equal(
    out,
    '\\section{Título}\n\nPrimer párrafo.\n\nSegundo \\textbf{párrafo}.\n\n\\begin{itemize}\n  \\item uno\n  \\item dos\n  \\begin{enumerate}\n    \\item a\n  \\end{enumerate}\n\\end{itemize}',
  );
});

test('tablas', () => {
  const out = tex('<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2 &amp; 3</td></tr></table>');
  assert.equal(
    out,
    '\\begin{center}\n  \\begin{tabular}{|l|l|}\n    \\hline\n    \\textbf{A} & \\textbf{B} \\\\\n    \\hline\n    1 & 2 \\& 3 \\\\\n    \\hline\n  \\end{tabular}\n\\end{center}',
  );
});

test('texto corriente con barras invertidas o llaves sueltas: se escapa entero para que no se tome por código', () => {
  assert.equal(escapeLiteral('C:\\Users\\ana\\tesis_1.tex'), 'C:\\textbackslash{}Users\\textbackslash{}ana\\textbackslash{}tesis\\_1.tex');
  assert.equal(escapeLiteral('{a: 1, b: 50%'), '\\{a: 1, b: 50\\%');
  assert.equal(bracesBalanced('f(x) = {1, 2}'), true);
  assert.equal(bracesBalanced('abre { y no cierra'), false);
  assert.equal(bracesBalanced('cierra } sin abrir {'), false);
  assert.equal(bracesBalanced('ya escapada \\{ no cuenta'), true);
  // lo escapado se dibuja tal como se pegó
  const html = renderLatex(escapeLiteral('C:\\Users\\ana y {suelta')).blocks[0].html;
  assert.equal(new JSDOM(`<div id="c">${html}</div>`).window.document.getElementById('c')?.textContent, 'C:\\Users\\ana y {suelta');
});

test('el texto sin formato no se convierte (se pegará como texto plano)', () => {
  assert.equal(tex('<span>solo texto</span> <div>y más</div>'), undefined);
  assert.equal(tex('<style>p{color:red}</style><p>hola</p>'), undefined);
});
