import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { renderLatex } from '../../latex/renderer';
import { serializeBlock, stamp } from '../../webview/serialize';

const example = fs.readFileSync(path.join(__dirname, '..', '..', '..', 'ejemplo.tex'), 'utf8');

const dom = (html: string): HTMLElement => {
  const d = new JSDOM(`<div id="c">${html}</div>`);
  const el = d.window.document.getElementById('c') as unknown as HTMLElement;
  stamp(el);
  return el;
};
const text = (html: string): string => (dom(html).textContent ?? '').replace(/\s+/g, ' ').trim();
const body = (tex: string): string =>
  renderLatex(tex).blocks.filter((b) => b.kind !== 'ro').map((b) => b.html).join('\n');
const norm = (html: string): string => html.replace(/\s+/g, ' ').replace(/ ?(<\/?(li|ul|ol|td|tr|table|div|figure)\b)/g, '$1');
/** HTML -> LaTeX -> HTML debe dar el mismo resultado (salvo espacios en blanco). */
const roundtrip = (src: string): void => {
  const html = body(src);
  const tex = serializeBlock(dom(html));
  assert.equal(norm(body(tex)), norm(html), `no es estable al serializar:\n--- original\n${src}\n--- serializado\n${tex}`);
  // sin cambios del usuario, el código sale exactamente como estaba escrito
  assert.equal(tex, src.replace(/[ \t]+\n/g, '\n').trim(), 'un bloque sin modificar debe conservar su formato');
};

test('al cambiar una celda o un elemento solo se reescribe esa línea', () => {
  const table = '\\begin{tabular}{lr}\n    \\toprule\n    a   &   b \\\\[2pt]\n    c   &   d \\\\\n    \\bottomrule\n\\end{tabular}';
  const t = dom(body(table));
  t.querySelectorAll('td')[2].textContent = ' cambiada ';
  assert.equal(serializeBlock(t), table.replace('c   &   d', 'cambiada & d'));

  const list = '\\begin{itemize}\n\n    \\item   uno\n    \\item dos   % nota\n\n\\end{itemize}';
  const l = dom(body(list));
  l.querySelectorAll('li')[0].append(' más');
  assert.equal(serializeBlock(l), list.replace('\\item   uno', '\\item uno más'));
});

test('divide el documento en bloques con sus líneas', () => {
  const r = renderLatex('\\documentclass{article}\n\\begin{document}\nHola\nmundo\n\nOtro\n\\end{document}\n');
  assert.equal(r.hasDocument, true);
  assert.deepEqual(r.blocks.map((b) => [b.s, b.e, b.kind]), [[0, 1, 'atom'], [2, 3, 'rich'], [5, 5, 'rich']]);
  assert.equal(r.insertLine, 6);
});

test('un fragmento sin \\begin{document} también se renderiza', () => {
  const r = renderLatex('\\section{Uno}\n\nTexto.');
  assert.equal(r.hasDocument, false);
  assert.equal(r.blocks.length, 2);
  assert.match(r.blocks[0].html, /<h2[^>]*>.*Uno<\/h2>/);
});

test('numera secciones, ecuaciones y resuelve referencias', () => {
  const html = body('\\section{A}\\label{s}\n\n\\subsection{B}\n\n\\begin{equation}\\label{e} x=1 \\end{equation}\n\nVer \\ref{s} y \\eqref{e}.');
  assert.match(text(html), /1A.*1\.1B/);
  assert.match(text(html), /Ver 1 y \(1\)\./);
  assert.match(html, /class="[^"]*tag/);
});

test('las ecuaciones align numeran cada fila', () => {
  const r = renderLatex('\\begin{align}\na &= b \\\\\nc &= d \\nonumber \\\\\ne &= f \\label{z}\n\\end{align}\n\nEc. \\ref{z}');
  assert.equal(r.blocks[0].kind, 'atom');
  assert.match(text(r.blocks[1].html), /Ec\. 2/);
  assert.doesNotMatch(r.blocks[0].html, /katex-error/);
});

test('texto con formato, acentos y símbolos especiales', () => {
  const html = body("\\textbf{a} \\emph{b} caf\\'e ma\\~nana 50\\% ``x'' --- $y$");
  assert.match(html, /<strong[^>]*>a<\/strong>/);
  assert.match(text(html), /a b café mañana 50% “x” — y/);
});

test('listas anidadas y tablas', () => {
  const html = body('\\begin{itemize}\n\\item uno\n\\begin{enumerate}\n\\item a\n\\end{enumerate}\n\\item dos\n\\end{itemize}');
  const d = dom(html);
  assert.equal(d.querySelectorAll('ul > li').length, 2);
  assert.equal(d.querySelectorAll('ul > li > ol > li').length, 1);
  const t = dom(body('\\begin{tabular}{lr}\n\\hline\na & b \\\\\n\\multicolumn{2}{c}{c} \\\\\n\\hline\n\\end{tabular}'));
  assert.equal(t.querySelectorAll('tr').length, 2);
  assert.equal(t.querySelector('td[colspan="2"]')?.textContent, 'c');
});

test('\\vspace deja un hueco a la escala de la hoja y los saltos de página se marcan', () => {
  const html = body('Uno\n\n\\vspace{2cm}\n\nDos\n\n\\newpage\n\nTres');
  assert.match(html, /class="vskip" style="height:calc\(2 \* var\(--cm, 37\.8px\)\)"/);
  assert.match(html, /class="pagebreak"/);
  // fracciones del alto de la caja de texto, espacio negativo (acerca lo que sigue) y espacio elástico
  assert.match(body('\\vspace{0.05\\textheight}'), /class="vskip" style="height:calc\(0\.05 \* var\(--th, 24cm\)\)"/);
  assert.match(body('\\vspace{-1em}'), /class="vskip" style="margin-top:-1em"/);
  assert.match(body('Arriba\n\n\\vfill\n\nAbajo'), /class="vfill"/);
  // \\[10pt]: salto de línea con espacio detrás
  const br = body('Uno\\\\[10pt]\nDos');
  assert.match(br, /<br>/);
  assert.match(br, /class="vskip" style="height:calc\(0\.3515 \* var\(--cm/);
});

test('una orden propia sin argumentos se dibuja con su texto y queda marcada como variable', () => {
  const h = renderLatex('\\documentclass{article}\n\\newcommand{\\anio}{2026}\n\\newcommand{\\caja}[1]{[#1]}\n\\begin{document}\nEn \\anio{} y \\caja{x}.\n\\end{document}').blocks.map((b) => b.html).join('');
  assert.match(h, /<span class="atom var" data-tex="\\anio[^"]*"[^>]*>2026<\/span>/);
  assert.doesNotMatch(h, /class="atom var"[^>]*data-tex="\\caja/, 'con argumentos no es una variable');
});

test('las imágenes llevan las medidas que pide \\includegraphics', () => {
  const img = (opts: string): string => renderLatex(`\\includegraphics${opts}{logo.png}`, { resolveImage: (p) => `file:///${p}#mars-dpi=96` }).blocks[0].html;
  assert.match(img('[width=0.5\\textwidth]'), /<img[^>]*style="[^"]*width:50%/);
  assert.match(img('[height=8cm]'), /<img[^>]*style="[^"]*height:calc\(8 \* var\(--cm/);
  assert.doesNotMatch(img('[height=8cm]'), /style="[^"]*width:/, 'solo con el alto, el ancho sale de la proporción');
  // sin medidas: tamaño natural según los píxeles y la resolución del archivo, por el factor scale
  assert.match(img('[scale=0.5]'), /data-scale="0\.5"[^>]*data-dpi="96"|data-dpi="96"[^>]*data-scale="0\.5"/);
  assert.match(img(''), /data-scale="1"/);
  assert.match(img('[width=3cm, angle=90]'), /data-angle="90"/);
  assert.doesNotMatch(img('[width=3cm, angle=360]'), /data-angle/, 'una vuelta entera no es ningún giro');
});

test('titlesec y babel en español: punto tras el número, tamaño y espacios de los títulos', () => {
  const head = '\\documentclass[12pt]{article}\n\\usepackage[spanish]{babel}\n';
  const plain = renderLatex(`${head}\\begin{document}\n\\section{Uno}\n\\end{document}`).blocks[1].html;
  assert.match(text(plain), /^1\.Uno$/, 'babel en español pone punto tras el número');
  assert.doesNotMatch(plain, /data-strut/);
  const noDot = renderLatex(`\\documentclass{article}\n\\usepackage[spanish,es-nosectiondot]{babel}\n\\begin{document}\n\\section{Uno}\n\\end{document}`).blocks[1].html;
  assert.match(text(noDot), /^1Uno$/);
  const ts =
    `${head}\\usepackage{titlesec}\n\\titleformat{\\section}{\\normalfont\\large\\bfseries}{\\thesection.}{0.5em}{}\n` +
    '\\titlespacing*{\\section}{0pt}{12pt}{6pt}\n\\begin{document}\n\\section{Uno}\n\\end{document}';
  const h = renderLatex(ts).blocks[1].html;
  assert.match(h, /<h2[^>]*data-strut/, 'con titlesec la línea del título lleva puntal');
  assert.match(h, /style="font-size:1\.2em;margin-top:calc\(0\.4218 \* var\(--cm, 37\.8px\)\);margin-bottom:calc\(0\.2109 \* var\(--cm, 37\.8px\)\)"/);
  assert.match(text(h), /^1\.Uno$/);
});

test('citas por autor y año (natbib) y lista de referencias a partir del .bib', () => {
  const bib =
    '@article{codd1970, author = {Codd, E. F.}, title = {A relational model of data}, journal = {CACM}, year = {1970}}\n' +
    '@book{elmasri2016, author = {Elmasri, Ramez and Navathe, Shamkant B.}, title = {Fundamentals of Database Systems}, publisher = {Pearson}, year = {2016}}\n' +
    '@inproceedings{chu2017, author = {Chu, Shumo and Wang, Chenglong and Weitz, Konstantin and Cheung, Alvin}, title = {Cosette}, booktitle = {CIDR}, year = {2017}}\n' +
    '@misc{sincitar, author = {Nadie, N.}, title = {No citada}, year = {2000}}';
  const src =
    '\\documentclass{article}\n\\usepackage{natbib}\n\\bibliographystyle{apalike}\n\\begin{document}\n' +
    'Según \\citet{codd1970}, y otros \\citep{elmasri2016,chu2017}. Sin fuente \\citep{nohay}.\n\n\\bibliography{refs}\n\\end{document}';
  const r = renderLatex(src, { readBib: (name) => (name === 'refs' ? bib : undefined) });
  assert.equal(r.authorYear, true);
  const para = text(r.blocks[1].html);
  assert.match(para, /Según Codd \(1970\), y otros \(Elmasri and Navathe, 2016; Chu et al\., 2017\)\./);
  assert.match(r.blocks[1].html, /cite-missing/, 'una clave que no está en el .bib se señala');
  const refs = dom(r.blocks[2].html);
  const items = Array.from(refs.querySelectorAll('ol.refs li')).map((li) => (li.textContent ?? '').replace(/\s+/g, ' ').trim());
  assert.equal(items.length, 3, 'solo salen las fuentes citadas');
  assert.match(items[0], /^Chu, S\., Wang, C\., Weitz, K\., and Cheung, A\. \(2017\)/, 'ordenadas por autor');
  assert.match(items[1], /^Codd, E\. F\. \(1970\)\. A relational model of data/);
  assert.match(items[2], /^Elmasri, R\. and Navathe, S\. B\. \(2016\)/);
  assert.ok(refs.querySelector('ol.refs.authoryear'));
  // sin natbib las citas son numéricas, como hasta ahora
  const numeric = renderLatex(src.replace('\\usepackage{natbib}\n', '').replace(/\\cite[tp]/g, '\\cite'), { readBib: () => bib });
  assert.equal(numeric.authorYear, false);
  assert.match(text(numeric.blocks[1].html), /Según \[\d\], y otros \[\d, ?\d\]/);
});

test('fuente y tamaño de un trozo de texto: \\fontfamily y \\fontsize', () => {
  const html = renderLatex('\\documentclass[12pt]{article}\n\\begin{document}\nAntes {\\fontsize{18}{21.6}\\selectfont grande} y {\\fontfamily{ptm}\\selectfont times} fin.\n\\end{document}').blocks[1].html;
  assert.match(html, /style="line-height:0\.95;font-size:1\.5em"[^>]*>grande</, '18 pt sobre un documento de 12');
  assert.match(html, /style="font-family:'Times New Roman'[^"]*"[^>]*>times</);
  assert.equal(text(html), 'Antes grande y times fin.');
  roundtrip('Antes {\\fontsize{18}{21.6}\\selectfont grande} y {\\fontfamily{ptm}\\selectfont times} fin.');
  // un cambio de tamaño con el párrafo cerrado dentro del grupo lleva su propio interlineado
  assert.match(body('{\\Large Título suelto\\par}'), /line-height:1\.2;font-size:1\.44em/);
});

test('macros del usuario y entornos de teorema', () => {
  const html = body('\\newcommand{\\hola}[1]{Hola #1}\n\\newtheorem{teo}{Teorema}\n\n\\hola{Marte}\n\n\\begin{teo}[Nombre]\nTexto.\n\\end{teo}');
  assert.match(text(html), /Hola Marte/);
  assert.match(text(html), /Teorema 1 \(Nombre\)\. Texto\./);
});

test('no falla con LaTeX incompleto o desconocido', () => {
  for (const src of ['\\begin{itemize}\n\\item a', '\\textbf{sin cerrar', '$x', '\\cosa{rara} texto', '\\begin{equation} \\frac{1}{ \\end{equation}', '}}}{{{', '\\']) {
    assert.doesNotThrow(() => renderLatex(src), src);
  }
});

test('la serialización conserva comentarios y comandos desconocidos', () => {
  const src = 'Hola % nota\nmundo \\cosa{x} y \\LaTeX{} fin';
  const tex = serializeBlock(dom(body(src)));
  assert.equal(tex, src);
});

test('ida y vuelta estable para las construcciones habituales', () => {
  const cases = [
    'Texto \\textbf{negrita \\textit{y cursiva}} con $x^2$ y 50\\% de \\$ y a\\_b.',
    '\\section{Un título con $\\alpha$}\\label{x}',
    '\\subsection*{Sin número}',
    '\\begin{itemize}\n  \\item uno\n  \\item dos \\textbf{x}\n  \\begin{enumerate}\n    \\item a\n  \\end{enumerate}\n\\end{itemize}',
    '\\begin{description}\n  \\item[Uno] primero\n  \\item[Dos] segundo\n\\end{description}',
    '\\begin{tabular}{|l|c|}\n  \\hline\n  a & b \\\\\n  \\hline\n  \\multicolumn{2}{|c|}{c} \\\\\n  \\hline\n\\end{tabular}',
    '\\begin{table}[h]\n  \\centering\n  \\begin{tabular}{lr}\n    \\toprule\n    a & b \\\\\n    \\bottomrule\n  \\end{tabular}\n  \\caption{Una tabla}\n\\end{table}',
    '\\begin{quote}\nUna cita.\n\nDos párrafos.\n\\end{quote}',
    '\\begin{center}\n{\\Large Grande} y \\emph{normal}\n\\end{center}',
    'Una línea \\\\ otra línea~pegada, ``comillas\'\' --- y \\href{https://a.b}{enlace}\\footnote{nota}.',
    '\\begin{figure}[h]\n  \\centering\n  \\includegraphics[width=0.5\\textwidth]{foto}\n  \\caption{Pie}\n  \\label{fig:a}\n\\end{figure}',
  ];
  for (const c of cases) roundtrip(c);
});

test('ida y vuelta estable para cada bloque del documento de ejemplo', () => {
  const r = renderLatex(example);
  assert.ok(r.blocks.length > 15);
  for (const b of r.blocks.filter((x) => x.kind === 'rich')) roundtrip(b.src);
});

test('el texto escrito por el usuario se escapa al serializar', () => {
  const d = dom('100% de A&B_c <b>negrita</b> <i>cursiva</i><br>');
  assert.equal(serializeBlock(d), '100\\% de A\\&B\\_c \\textbf{negrita} \\textit{cursiva}');
});

test('hoja horizontal: bloque propio marcado con el paquete que la gira y que se guarda igual', () => {
  const env = '\\begin{landscape}\nTexto apaisado.\n\\end{landscape}';
  const html = (pkg: string): string => renderLatex(`\\documentclass{article}\n\\usepackage{${pkg}}\n\\begin{document}\n${env}\n\\end{document}`).blocks.filter((b) => b.kind === 'rich').map((b) => b.html).join('');
  assert.match(html('lscape'), /class="landscape" data-land="print"/);
  assert.match(html('pdflscape'), /class="landscape" data-land="pdf"/);
  roundtrip(env);
  // eso-pic (números de página a medida en esas hojas): no se dibuja y se conserva
  roundtrip('Texto \\AddToShipoutPictureFG*{\\put(10,20){\\thepage}} fin.');
  assert.equal(text(body('Texto \\AddToShipoutPictureFG*{\\put(10,20){x}} fin.')), 'Texto fin.');
});

test('listas: un salto de línea delante de una sublista no escribe \\\\', () => {
  const d = dom(body('\\begin{itemize}\n  \\item Uno\n  \\begin{itemize}\n    \\item Dos\n  \\end{itemize}\n\\end{itemize}'));
  const li = d.querySelector('li') as HTMLElement;
  // lo que deja el editor al pulsar Enter al principio de un elemento con sublista
  li.firstChild?.remove();
  li.prepend(d.ownerDocument.createElement('br'));
  assert.ok(!serializeBlock(d).includes('\\\\'), serializeBlock(d));
});

test('listas en español: la letra del segundo nivel numerado va en cursiva, como con babel', () => {
  const html = renderLatex('\\documentclass{article}\n\\usepackage[spanish]{babel}\n\\begin{document}\n\\begin{enumerate}\n  \\item A\n  \\begin{enumerate}\n    \\item B\n  \\end{enumerate}\n\\end{enumerate}\n\\end{document}').blocks.map((b) => b.html).join('');
  assert.match(html, /--kind:lower-alpha;--pre:'';--suf:'\)';--num-style:italic/);
});
