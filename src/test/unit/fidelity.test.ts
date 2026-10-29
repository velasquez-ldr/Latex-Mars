import * as assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { renderLatex } from '../../latex/renderer';
import { customCommand, engineFor, fallbackFailureSummary, fallbackOnError, firstError, hintFor, isMiKTeX, latexmkArgs } from '../../pdf';

const text = (html: string): string => (new JSDOM(`<div id="c">${html}</div>`).window.document.getElementById('c')?.textContent ?? '').replace(/\s+/g, ' ').trim();
const all = (tex: string, opts: Parameters<typeof renderLatex>[1] = {}): string => renderLatex(tex, opts).blocks.map((b) => text(b.html)).join(' | ');

test('en informes y libros, ecuaciones, figuras y tablas se numeran dentro del capítulo', () => {
  const body = [
    '\\chapter{Uno}', '\\begin{equation}\\label{a}\n a\n\\end{equation}', '\\begin{figure}\n\\caption{Primera}\\label{f}\n\\end{figure}',
    '\\chapter{Dos}', '\\begin{equation}\\label{b}\n b\n\\end{equation}', '\\begin{equation}\n c\n\\end{equation}',
    '\\begin{table}\n\\caption{Datos}\\label{t}\n\\end{table}', 'Ver \\eqref{a}, \\eqref{b}, la figura \\ref{f} y la tabla \\ref{t}.',
  ].join('\n\n');
  const out = all(`\\documentclass{report}\n\\begin{document}\n\n${body}\n\n\\end{document}`);
  assert.match(out, /\(1\.1\)/);
  assert.match(out, /Figure 1\.1: Primera/);
  assert.match(out, /\(2\.1\)[\s\S]*\(2\.2\)/, 'la cuenta vuelve a empezar en cada capítulo');
  assert.match(out, /Table 2\.1: Datos/);
  assert.match(out, /Ver \(1\.1\), \(2\.1\), la figura 1\.1 y la tabla 2\.1\./);
  // en un artículo siguen siendo corridas, salvo que se pida con \numberwithin
  const article = (head: string): string => all(`\\documentclass{article}\n${head}\n\\begin{document}\n\n\\section{A}\n\n\\begin{equation}\n a\n\\end{equation}\n\n\\section{B}\n\n\\begin{equation}\n b\n\\end{equation}\n\n\\end{document}`);
  assert.match(article(''), /\(1\)[\s\S]*\(2\)/);
  assert.match(article('\\numberwithin{equation}{section}'), /\(1\.1\)[\s\S]*\(2\.1\)/);
});

test('índices de figuras y de tablas: una línea por cada título, con su número', () => {
  const r = renderLatex('\\documentclass{article}\n\\usepackage[spanish]{babel}\n\\begin{document}\n\n\\listoffigures\n\n\\listoftables\n\n\\begin{figure}\n\\caption{Mapa del \\textbf{sitio}}\n\\end{figure}\n\n\\begin{table}\n\\caption{Resultados}\n\\end{table}\n\n\\begin{figure}\n\\caption{Detalle}\n\\end{figure}\n\n\\end{document}');
  assert.equal(text(r.blocks[1].html), 'Índice de figuras1Mapa del sitio2Detalle');
  assert.equal(text(r.blocks[2].html), 'Índice de cuadros1Resultados');
  assert.doesNotMatch(r.blocks[1].html, /data-o=|data-tex="\\\\textbf/, 'las entradas del índice no llevan marcas de edición');
});

test('avisos del documento: referencias y citas sin definir, etiquetas repetidas e imágenes que faltan', () => {
  const tex = [
    '\\documentclass{article}', '\\begin{document}', '',
    '\\section{Uno}\\label{sec:a}', '',
    'Ver \\ref{sec:a} y \\ref{sec:nada}, según \\cite{knuth} y \\cite{nadie}.', '',
    '\\section{Dos}\\label{sec:a}', '',
    '\\includegraphics{img/falta}', '',
    '\\begin{thebibliography}{9}', '\\bibitem{knuth} Knuth.', '\\end{thebibliography}', '',
    '\\end{document}',
  ].join('\n');
  const r = renderLatex(tex, { resolveImage: () => undefined });
  assert.deepEqual(r.issues.map((x) => `${x.kind}:${x.text}@${x.line}`).sort(), ['cite:nadie@5', 'image:img/falta@9', 'label:sec:a@7', 'ref:sec:nada@5']);
  assert.deepEqual(renderLatex('\\documentclass{article}\n\\begin{document}\n\nTodo bien, \\cite{x}.\n\n\\end{document}').issues, [], 'sin bibliografía a la vista no se sabe si una cita falta');
});

test('un archivo incluido se dibuja por bloques, cada uno con la línea que ocupa en su archivo', () => {
  const r = renderLatex('\\documentclass{report}\n\\begin{document}\n\n\\include{cap}\n\n\\end{document}', { readInput: () => '\\chapter{Uno}\n\nPrimer párrafo.\n\n% nota\nSegundo párrafo.\n' });
  const dom = new JSDOM(`<div id="c">${r.blocks[1].html}</div>`).window.document;
  const parts = Array.from(dom.querySelectorAll('.inc-block')).map((b) => `${b.getAttribute('data-line')}:${(b.textContent ?? '').trim()}`);
  assert.deepEqual(parts, ['0:Chapter 1Uno', '2:Primer párrafo.', '4:Segundo párrafo.']);
});

const doc = (head: string, body: string, cls = 'article'): string => `\\documentclass{${cls}}\n${head}\n\\begin{document}\n\n${body}\n\n\\end{document}\n`;
const ES = '\\usepackage[spanish]{babel}';

test('una orden que se llama a sí misma no cuelga el dibujado', () => {
  const cases: [string, string][] = [
    ['\\newcommand{\\a}{\\a\\a}', '\\a'],
    ['\\def\\a{\\a\\a}', '\\a'],
    ['\\newcommand{\\uno}{\\dos}\\newcommand{\\dos}{\\uno\\uno}', '\\uno'],
    ['\\newcommand{\\rep}[1]{\\rep{#1#1}}', '\\rep{x}'],
    ['\\newcommand{\\a}{\\a\\a}\\title{\\a}', '\\maketitle'],
    // sin llamarse a sí mismas, ocho órdenes que se multiplican por diez: cien millones de expansiones
    [['uno:x', 'dos:\\uno', 'tres:\\dos', 'cuatro:\\tres', 'cinco:\\cuatro', 'seis:\\cinco', 'siete:\\seis', 'ocho:\\siete'].map((x) => `\\newcommand{\\${x.split(':')[0]}}{${`${x.split(':')[1]} `.repeat(10)}}`).join(''), '\\ocho'],
  ];
  for (const [head, body] of cases) {
    const started = Date.now();
    const r = renderLatex(doc(head, body));
    assert.ok(Date.now() - started < 5000, `tarda demasiado: ${head}`);
    assert.equal(r.blocks.length, 2, head);
  }
  // una orden usada dentro de su propio argumento no es recursiva: se dibuja entera
  assert.match(all(doc('\\newcommand{\\caja}[1]{[#1]}', '\\caja{a \\caja{b}}')), /\[a \[b\]\]/);
  // y el resto del documento sigue dibujándose con normalidad
  assert.match(all(doc('\\newcommand{\\a}{\\a\\a}\\newcommand{\\bien}{correcto}', '\\a\n\nTodo \\bien.')), /Todo correcto\./);
});

test('apéndices: tras \\appendix los títulos se cuentan con letras', () => {
  const article = all(doc('', '\\section{Uno}\\label{a}\n\n\\appendix\n\n\\section{Datos}\\label{b}\n\n\\subsection{Sub}\n\n\\begin{equation}\n x\n\\end{equation}\n\nVer \\ref{a} y \\ref{b}.'));
  assert.match(article, /1Uno \| ADatos \| A\.1Sub/);
  assert.match(article, /Ver 1 y A\./);
  const report = all(doc(ES, '\\chapter{Uno}\n\n\\appendix\n\n\\chapter{Datos}\n\n\\section{Sec}\n\n\\begin{equation}\n x\n\\end{equation}\n\n\\begin{figure}\n\\caption{Mapa}\n\\end{figure}', 'report'));
  assert.match(report, /Capítulo 1Uno \| Apéndice ADatos \| A\.1\.Sec/);
  assert.match(report, /\(A\.1\)/, 'las ecuaciones de un apéndice llevan su letra');
  assert.match(report, /Figura A\.1: Mapa/);
  // también escrito como entorno
  assert.match(all(doc('', '\\section{Uno}\n\n\\begin{appendices}\n\\section{Datos}\n\\end{appendices}')), /ADatos/);
});

test('libros e informes: qué títulos llevan número y cuáles entran en el índice', () => {
  const body = [
    '\\frontmatter', '\\chapter{Prólogo}', '\\tableofcontents', '\\mainmatter', '\\part{Primera}', '\\chapter{Uno}', '\\section{A}', '\\subsection{B}',
    '\\subsubsection{C}', '\\section*{Suelta}', '\\backmatter', '\\chapter{Epílogo}',
  ].join('\n\n');
  const r = renderLatex(doc('', body, 'book'));
  const out = r.blocks.map((b) => text(b.html));
  assert.equal(out[1], 'Prólogo', 'antes del cuerpo del libro los capítulos van sin número');
  assert.equal(out[3], 'Part IPrimera');
  assert.equal(out[4], 'Chapter 1Uno');
  assert.deepEqual(out.slice(5, 9), ['1.1A', '1.1.1B', 'C', 'Suelta'], 'en un libro las subsubsecciones no se numeran');
  assert.equal(out[9], 'Epílogo');
  // el índice: sin los títulos con asterisco ni los que quedan por debajo de tocdepth
  assert.equal(out[2], 'ContentsPrólogoIPrimera1Uno1.1A1.1.1BEpílogo');
  // \frontmatter pagina en romanos y \mainmatter vuelve a los arábigos
  assert.equal(r.blocks[1].pagenum, 'roman');
  assert.equal(r.blocks.find((b) => b.html.includes('data-level="part"'))?.pagenum, 'arabic');
  // en un artículo las subsubsecciones sí se numeran, y el documento puede cambiar los dos límites
  assert.match(all(doc('', '\\section{A}\n\n\\subsection{B}\n\n\\subsubsection{C}')), /1A \| 1\.1B \| 1\.1\.1C/);
  const deep = all(doc('\\setcounter{secnumdepth}{3}\n\\setcounter{tocdepth}{1}', '\\tableofcontents\n\n\\chapter{Uno}\n\n\\section{A}\n\n\\subsection{B}\n\n\\subsubsection{C}', 'report'));
  assert.match(deep, /Contents1Uno1\.1A \|/, 'con tocdepth 1 el índice llega hasta las secciones');
  assert.match(deep, /1\.1\.1\.1C/);
  // un título sin número entra en el índice si se añade a mano
  assert.match(all(doc('', '\\tableofcontents\n\n\\section*{Gracias}\n\\addcontentsline{toc}{section}{Gracias}\n\n\\section{Uno}')), /ContentsGracias1Uno/);
  // en informes y libros la lista de referencias se titula «Bibliografía»
  const refs = '\\begin{thebibliography}{9}\n\\bibitem{k} Autor.\n\\end{thebibliography}';
  assert.match(all(doc(ES, refs, 'report')), /BibliografíaAutor\./);
  assert.match(all(doc(ES, refs)), /ReferenciasAutor\./);
  assert.match(all(doc('', refs, 'book')), /BibliographyAutor\./);
  assert.match(all(doc('', '\\listoffigures\n\n\\begin{figure}\n\\caption{Uno}\n\\end{figure}', 'report')), /List of Figures/, 'el idioma no cambia por ser un informe');
});

test('listas: etiquetas cortas, número inicial y marcas de cada nivel en inglés y en español', () => {
  const list = (head: string, src: string): string => renderLatex(doc(head, src)).blocks[1].html;
  const nested = '\\begin{itemize}\n\\item a\n\\begin{itemize}\n\\item b\n\\end{itemize}\n\\end{itemize}';
  const numbers = '\\begin{enumerate}\n\\item a\n\\begin{enumerate}\n\\item b\n\\end{enumerate}\n\\end{enumerate}';
  // LaTeX: • y –; 1. y (a). Babel en español: ▪ y •; 1. y a)
  assert.match(list('', nested), /<ul[^>]*class="itemize" data-o[^]*<ul[^>]*style="list-style-type:'– '"/);
  assert.match(list(ES, nested), /<ul[^>]*style="list-style-type:'▪ '"[^]*<ul[^>]*style="list-style-type:'• '"/);
  assert.match(list('', numbers), /<ol[^>]*class="enumerate" data-o[^]*<ol[^>]*class="enumerate lbl" style="--kind:lower-alpha;--pre:'\(';--suf:'\)'"/);
  assert.match(list(ES, numbers), /<ol[^>]*class="enumerate lbl" style="--kind:lower-alpha;--pre:'';--suf:'\)';--num-style:italic"/);
  assert.doesNotMatch(list('\\usepackage[spanish,es-nolists]{babel}', nested), /▪/, 'es-nolists deja las marcas de LaTeX');
  // cada tipo de lista lleva su cuenta de niveles: una numerada dentro de una de marcas es de primer nivel
  assert.match(list('', '\\begin{itemize}\n\\item a\n\\begin{enumerate}\n\\item b\n\\end{enumerate}\n\\end{itemize}'), /<ol data-k="list" data-x class="enumerate" data-o/);
  // paquete enumerate: [a)], [(i)], [1.]
  assert.match(list('', '\\begin{enumerate}[a)]\n\\item uno\n\\end{enumerate}'), /class="enumerate lbl" style="--kind:lower-alpha;--pre:'';--suf:'\)'"/);
  assert.match(list('', '\\begin{enumerate}[(i)]\n\\item uno\n\\end{enumerate}'), /--kind:lower-roman;--pre:'\(';--suf:'\)'/);
  assert.match(list('', '\\begin{enumerate}[\\bfseries A.]\n\\item uno\n\\end{enumerate}'), /--kind:upper-alpha;--pre:'';--suf:'\.'/);
  assert.doesNotMatch(list('', '\\begin{enumerate}[noitemsep]\n\\item uno\n\\end{enumerate}'), /lbl/, 'una opción de enumitem no es una etiqueta');
  // start y resume
  assert.match(list('', '\\begin{enumerate}[start=3]\n\\item tres\n\\end{enumerate}'), /<ol[^>]*class="enumerate" start="3"/);
  assert.match(list('', '\\begin{enumerate}[label=\\alph*), start=2]\n\\item b\n\\end{enumerate}'), /--suf:'\)';counter-reset:lbl 1"/);
  const resumed = renderLatex(doc('', '\\begin{enumerate}\n\\item a\n\\item b\n\\end{enumerate}\n\nTexto.\n\n\\begin{enumerate}[resume]\n\\item c\n\\end{enumerate}'));
  assert.match(resumed.blocks[3].html, /start="3"/);
});

test('babel en español: «<<» y «>>» son comillas latinas', () => {
  const src = 'Dijo <<hola>> y se fue.';
  const html = renderLatex(doc(ES, src)).blocks[1].html;
  assert.equal(text(html), 'Dijo «hola» y se fue.');
  assert.match(html, /data-tex="&lt;&lt;"/, 'el código sigue siendo «<<»');
  assert.equal(text(renderLatex(doc('', src)).blocks[1].html), 'Dijo <<hola>> y se fue.', 'sin babel en español no se tocan');
  assert.equal(text(renderLatex(doc('\\usepackage[T1]{fontenc}', src)).blocks[1].html), 'Dijo «hola» y se fue.', 'la codificación T1 también las junta');
  assert.equal(text(renderLatex(doc('\\usepackage[spanish,es-noquoting]{babel}', src)).blocks[1].html), 'Dijo <<hola>> y se fue.');
});

test('referencias con nombre: \\autoref, \\cref, \\Cref, \\nameref y \\pageref', () => {
  const body =
    '\\section{Intro}\\label{s}\n\n\\begin{figure}\n\\caption{Mapa}\\label{f}\n\\end{figure}\n\n\\begin{figure}\n\\caption{Otra}\\label{g}\n\\end{figure}\n\n' +
    '\\begin{equation}\\label{e}\n x\n\\end{equation}\n\n\\begin{table}\n\\caption{Datos}\\label{t}\n\\end{table}\n\n';
  const es = renderLatex(doc(`${ES}\n\\usepackage{hyperref,cleveref}`, `${body}Ver \\autoref{f}, \\autoref{s}, \\cref{f,g}, \\Cref{e}, \\cref{t}, \\cref{s}, \\nameref{s}, \\crefrange{f}{g} y \\cref{nada}.`));
  const last = es.blocks[es.blocks.length - 1];
  assert.equal(text(last.html), 'Ver Figura 1, Sección 1, figuras 1 y 2, Ecuación (1), cuadro 1, apartado 1, Intro, figuras 1 a 2 y ??.');
  assert.deepEqual(es.issues.map((x) => `${x.kind}:${x.text}`), ['ref:nada'], 'una etiqueta que no existe se avisa igual que con \\ref');
  const en = renderLatex(doc('\\usepackage{hyperref,cleveref}\n\\newtheorem{thm}{Theorem}', `${body}\\begin{thm}\\label{th}\nx\n\\end{thm}\n\nSee \\cref{f}, \\Cref{f}, \\cref{e}, \\autoref{e}, \\cref{th}, \\autoref{th} and \\cref{s}.`));
  assert.equal(text(en.blocks[en.blocks.length - 1].html), 'See fig. 1, Figure 1, eq. (1), Equation 1, theorem 1, Theorem 1 and section 1.');
  // opciones de cleveref y nombres que cambia el documento
  const named = (head: string): string => text(renderLatex(doc(`\\usepackage${head}`, `${body}\\cref{f}, \\cref{e}.`)).blocks.slice(-1)[0].html);
  assert.equal(named('[capitalise]{cleveref}'), 'Fig. 1, Eq. (1).');
  assert.equal(named('[noabbrev]{cleveref}'), 'figure 1, equation (1).');
  assert.equal(named('{cleveref}\n\\crefname{figure}{ilustración}{ilustraciones}'), 'ilustración 1, eq. (1).');
  assert.equal(text(renderLatex(doc('\\usepackage{hyperref}\n\\renewcommand{\\figureautorefname}{Fig.}', `${body}\\autoref{f}.`)).blocks.slice(-1)[0].html), 'Fig. 1.');
  // la página la pone el editor al repartir el documento en hojas
  assert.match(renderLatex(doc('', `${body}Página \\pageref{f}.`)).blocks.slice(-1)[0].html, /<a class="ref pageref" href="#lbl-f" data-ref="f">\?<\/a>/);
  // subfiguras: la referencia lleva el número de la figura; \subref, solo la letra
  const sub = '\\begin{figure}\n\\begin{subfigure}{0.5\\textwidth}\nA\\caption{Uno}\\label{sa}\n\\end{subfigure}\n\\begin{subfigure}{0.5\\textwidth}\nB\\caption{Dos}\\label{sb}\n\\end{subfigure}\n\\caption{Par}\\label{par}\n\\end{figure}';
  assert.match(all(doc('', `${sub}\n\nVer \\ref{sa}, \\ref{sb}, \\subref{sb} y \\ref{par}.`)), /Ver 1a, 1b, \(b\) y 1\./);
});

test('subequations: las ecuaciones de dentro comparten número y se distinguen con una letra', () => {
  const body = '\\begin{equation}\n a\n\\end{equation}\n\n\\begin{subequations}\\label{grupo}\n\\begin{align}\na &= b \\label{e1}\\\\\nc &= d \\label{e2}\n\\end{align}\n\\end{subequations}\n\n\\begin{equation}\n e\n\\end{equation}\n\nVer \\eqref{grupo}, \\eqref{e1} y \\eqref{e2}.';
  const out = all(doc('', body));
  assert.match(out, /\(2a\)[\s\S]*\(2b\)[\s\S]*\(3\)/);
  assert.match(out, /Ver \(2\), \(2a\) y \(2b\)\./);
});

test('notas al pie con la llamada y el texto por separado (\\footnotemark y \\footnotetext)', () => {
  const r = renderLatex(doc('', 'Texto\\footnote{uno} y\n\\begin{tabular}{l}\na\\footnotemark \\\\\nb\\footnotemark \\\\\n\\end{tabular}\n\\footnotetext{dos}\\footnotetext{tres} fin\\footnote{cuatro}.'));
  const drawn = r.blocks.slice(0, -1).map((b) => b.html).join('');
  const marks = [...drawn.matchAll(/<sup class="fn"[^>]*>(\d+)<\/sup>/g)].map((m) => m[1]);
  assert.deepEqual(marks, ['1', '2', '3', '4']);
  const notes = [...r.blocks[r.blocks.length - 1].html.matchAll(/<li>([^<]*)<\/li>/g)].map((m) => m[1]);
  assert.deepEqual(notes, ['uno', 'dos', 'tres', 'cuatro'], 'cada texto va con su llamada, en orden');
  assert.doesNotMatch(drawn, /tex-unknown/);
  // la nota de un título de figura solo cuenta una vez
  const cap = renderLatex(doc('', '\\begin{figure}\n\\caption{Mapa\\footnote{fuente}}\n\\end{figure}\n\n\\listoffigures'));
  assert.equal([...cap.blocks.map((b) => b.html).join('').matchAll(/<li>/g)].length, 1);
});

test('símbolos, letras voladas, subrayados y citas de los paquetes habituales', () => {
  const t = (head: string, src: string): string => text(renderLatex(doc(head, src)).blocks[1].html);
  assert.equal(t(ES, '1\\textordmasculine{} 2\\textordfeminine{} 3\\sptext{er}'), '1º 2ª 3.er');
  assert.equal(t('', '20\\degree{}C, 5\\celsius, 3\\textmu m, \\textonehalf, \\perthousand, \\ohm, \\texttimes, \\textcopyright'), '20°C, 5°C, 3µm, ½, ‰, Ω, ×, ©');
  assert.equal(t('', '\\textalpha{} y \\textOmega'), 'α y Ω');
  assert.equal(t('', '\\nicefrac{1}{2} y \\sfrac{3}{4}'), '1⁄2 y 3⁄4');
  // un símbolo que el documento redefine vale lo que diga su definición
  assert.equal(t('\\newcommand{\\th}{\\textsuperscript{o}}', '5\\th'), '5o');
  const marked = renderLatex(doc('\\usepackage{soul,ulem}', '\\hl{resaltado} \\ul{sub} \\st{tach} \\uuline{doble} \\uwave{onda}')).blocks[1];
  assert.match(marked.html, /<mark data-o="\\hl\{" data-c="\}">resaltado<\/mark>/);
  assert.match(marked.html, /<u class="uu" data-o="\\uuline\{" data-c="\}">doble<\/u>/);
  assert.equal(marked.kind, 'rich', 'el texto resaltado se sigue editando en sitio');
  assert.doesNotMatch(marked.html, /tex-unknown/);
  // csquotes: las comillas son las del idioma
  assert.match(renderLatex(doc(`${ES}\n\\usepackage{csquotes}`, '\\enquote{hola} \\textquote[Autor]{cita}')).blocks[1].html, /<span class="enquote es" data-o="\\enquote\{"[^>]*>hola<\/span> <span class="enquote es" data-o="\\textquote\[Autor\]\{"/);
  assert.match(renderLatex(doc('', '\\enquote*{dentro}')).blocks[1].html, /class="enquote inner"/);
  assert.match(renderLatex(doc('', '\\blockquote{Una cita larga.}')).blocks[1].html, /<blockquote data-o="\\blockquote\{" data-c="\}">Una cita larga\.<\/blockquote>/);
});

test('siglas (paquete acronym): entera la primera vez, después solo la sigla', () => {
  const head = '\\usepackage{acronym}';
  const list = '\\begin{acronym}\n\\acro{ONU}{Organización de las Naciones Unidas}\n\\acro{UE}[U.E.]{Unión Europea}\n\\end{acronym}';
  const out = all(doc(head, `La \\ac{ONU} y la \\ac{ONU}; \\acl{UE}, \\acs{UE}, \\acf{UE}, \\acp{ONU}. Falta \\ac{nada}.\n\n${list}`));
  assert.match(out, /La Organización de las Naciones Unidas \(ONU\) y la ONU; Unión Europea, U\.E\., Unión Europea \(U\.E\.\), ONUs\. Falta nada\?\./);
  assert.match(out, /ONUOrganización de las Naciones UnidasU\.E\.Unión Europea/, 'la lista de siglas');
  // paquete acro
  assert.match(all(doc('\\usepackage{acro}\n\\DeclareAcronym{pdf}{short=PDF, long=Portable Document Format}', 'Un \\ac{pdf}.')), /Un Portable Document Format \(PDF\)\./);
});

test('subfiguras escritas como orden, listados con título y tablas de otros paquetes', () => {
  const fig = all(doc('\\usepackage{subfig}', '\\begin{figure}\n\\subfloat[Uno\\label{a}]{A}\n\\subfloat[Dos]{B}\n\\caption{Par}\\label{p}\n\\end{figure}\n\nVer \\ref{a} y \\ref{p}.'));
  assert.match(fig, /A\(a\) Uno B\(b\) Dos Figure 1: Par \| Ver 1a y 1\./);
  const lst = all(doc('\\usepackage{listings}\n\\renewcommand{\\lstlistingname}{Código}', '\\begin{lstlisting}[caption={Hola mundo}, label=lst:a]\nprint(1)\n\\end{lstlisting}\n\n\\begin{listing}\n\\begin{verbatim}\nx\n\\end{verbatim}\n\\caption{Otro}\\label{lst:b}\n\\end{listing}\n\nVer \\ref{lst:a} y \\ref{lst:b}.'));
  assert.match(lst, /Código 1: Hola mundoprint\(1\) \| x Código 2: Otro \| Ver 1 y 2\./);
  // código traído de un archivo
  const file = renderLatex(doc('', '\\lstinputlisting[language=Python]{hola.py}'), { readInput: (p) => (p === 'hola.py' ? 'print("hola")\n' : undefined) });
  assert.match(file.blocks[1].html, /<pre><code>print\(&quot;hola&quot;\)<\/code><\/pre>/);
  // tabularray: columnas en colspec, con Q[c]; líneas de toda la tabla con hlines y vlines
  const tblr = renderLatex(doc('', '\\begin{tblr}{colspec={Q[l]Q[c]r}, hlines, vlines}\na & b & c \\\\\n\\end{tblr}')).blocks[1].html;
  assert.match(tblr, /<table data-k="table" data-x class="bordered hlines"/);
  assert.deepEqual([...tblr.matchAll(/text-align:(\w+)/g)].map((m) => m[1]), ['left', 'center', 'right']);
  // tipos de columna propios y columnas de números de siunitx con opciones
  const own = renderLatex(doc('\\newcolumntype{L}[1]{>{\\raggedright\\arraybackslash}p{#1}}\n\\newcolumntype{Y}{>{\\centering\\arraybackslash}X}', '\\begin{tabular}{L{3cm}YS[table-format=2.1]}\na & b & 1.5 \\\\\n\\end{tabular}')).blocks[1].html;
  assert.deepEqual([...own.matchAll(/text-align:(\w+)/g)].map((m) => m[1]), ['left', 'center', 'right']);
  assert.match(own, /width:calc\(3 \* var\(--cm/);
  for (const env of ['supertabular', 'tabu', 'NiceTabular']) assert.doesNotMatch(renderLatex(doc('', `\\begin{${env}}{ll}\na & b \\\\\n\\end{${env}}`)).blocks[1].html, /env-unknown/, env);
});

test('pseudocódigo de algorithm2e, con sus palabras en español si el paquete lo pide', () => {
  const src = '\\begin{algorithm}[H]\n\\KwIn{un número $n$}\n\\KwOut{su factorial}\n$r \\gets 1$\\;\n\\While{$n > 1$}{\n  $r \\gets r \\cdot n$\\;\n}\n\\eIf{$r > 100$}{grande\\;}{pequeño\\;}\n\\Return{$r$}\\;\n\\caption{Factorial}\\label{alg}\n\\end{algorithm}\n\nVer \\ref{alg}.';
  const es = renderLatex(doc(`\\usepackage[spanish,ruled]{algorithm2e}\n${ES}`, src));
  assert.doesNotMatch(es.blocks[1].html, /tex-unknown/);
  const lines = [...es.blocks[1].html.matchAll(/<div class="algo-line" style="--d:(\d)">([^]*?)<\/div>(?=<div class="algo-line"|<\/div>)/g)].map((m) => `${m[1]}:${text(m[2])}`);
  assert.deepEqual(lines, [
    '0:Entrada: un número n', '0:Salida: su factorial', '0:r←1;', '0:mientras n>1 hacer', '1:r←r⋅n;', '0:fin', '0:si r>100 entonces', '1:grande;',
    '0:en otro caso', '1:pequeño;', '0:fin', '0:devolver r;',
  ]);
  assert.match(text(es.blocks[1].html), /^Algoritmo 1: Factorial/);
  assert.match(text(es.blocks[2].html), /Ver 1\./);
  // funciones y palabras que nombra el documento, órdenes de una línea y comentarios
  const en = renderLatex(doc('\\usepackage{algorithm2e}', '\\begin{algorithm}\n\\SetKwFunction{F}{Fact}\\SetKwProg{Fn}{Function}{:}{}\n\\Fn{\\F{$n$}}{\n\\lIf{$n = 0$}{\\Return{1}}\n\\For{$i \\gets 1$ \\KwTo $n$}{$r \\gets r i$\\tcp*{multiplica}}\n}\n\\end{algorithm}'));
  assert.doesNotMatch(en.blocks[1].html, /tex-unknown/);
  assert.match(text(en.blocks[1].html), /Function Fact\(n\)if n=0 then return 1;for i←1 to n dor←ri; \/\/ multiplicaendend/);
});

test('beamer: las capas de una diapositiva no ensucian el texto', () => {
  const r = renderLatex(doc('', '\\begin{frame}{Título}\n\\begin{itemize}\n\\item<1-> uno\n\\item<2-> dos\n\\end{itemize}\n\\only<2>{solo} \\uncover<3->{luego} \\alert{aviso}\n\\end{frame}', 'beamer'));
  assert.doesNotMatch(r.blocks[1].html, /tex-unknown/);
  assert.match(r.blocks[1].html, /data-o="\\item&lt;1-&gt; "/, 'la capa de un elemento se conserva en su código');
  assert.equal(text(r.blocks[1].html), 'Título unodos solo luego aviso');
});

test('\\includepdf enseña la primera página del PDF que se inserta', () => {
  const r = renderLatex(doc('\\usepackage{pdfpages}', '\\includepdf[pages=-]{anexo.pdf}'), { resolveImage: (p) => (p === 'anexo.pdf' ? 'file:///anexo.pdf#mars-pdf' : undefined) });
  assert.match(r.blocks[1].html, /<canvas class="pdfimg" data-pdf="file:\/\/\/anexo\.pdf"/);
  assert.match(text(r.blocks[1].html), /anexo\.pdf · pages -/);
  assert.deepEqual(r.issues, []);
});

test('exportar a PDF: el motor que pide el documento y el primer error del registro', () => {
  assert.equal(engineFor('\\documentclass{article}\n\\begin{document}x\\end{document}'), 'pdflatex');
  assert.equal(engineFor('\\documentclass{article}\n\\usepackage{fontspec}\n\\begin{document}x\\end{document}'), 'xelatex');
  assert.equal(engineFor('\\documentclass{article}\n\\begin{document}\\directlua{tex.print(1)}\\end{document}'), 'lualatex');
  const log = 'This is pdfTeX\n(./doc.tex\n! Undefined control sequence.\nl.12 Hola \\cosa\n               mundo\n?';
  assert.equal(firstError(log), 'Undefined control sequence. (línea 12: Hola \\cosa)');
  assert.equal(firstError('Output written on doc.pdf'), undefined);
  // con -file-line-error (como compila Mars con latexmk) el error no empieza por «!»
  const fle = 'This is pdfTeX\n(./d38.tex\n./d38.tex:53: Argument of \\language@active@arg> has an extra }.\n<inserted text> \n                \\par \nl.53   };\n\n./d38.tex:60: Otro error.';
  assert.equal(firstError(fle), 'Argument of \\language@active@arg> has an extra }. (d38.tex, línea 53: };)');
  assert.equal(firstError('C:/tesis/cap 1.tex:7: Undefined control sequence.\nl.7 \\cosa'), 'Undefined control sequence. (C:/tesis/cap 1.tex, línea 7: \\cosa)');
});

test('exportar a PDF: usa el motor directo si falla latexmk y conserva el resultado principal', async () => {
  const primary = { code: 1, out: 'MiKTeX no encontró Perl' };
  const fallback = { code: 0, out: 'PDF creado con pdflatex' };
  let called = false;
  const recovered = await fallbackOnError(
    async () => primary,
    async () => {
      called = true;
      return fallback;
    },
  );
  assert.equal(called, true);
  assert.deepEqual(recovered, { result: fallback, usedFallback: true, primaryResult: primary });

  const alreadyWorked = await fallbackOnError(async () => fallback, async () => {
    throw new Error('no debe ejecutar el fallback');
  });
  assert.deepEqual(alreadyWorked, { result: fallback, usedFallback: false });
  assert.equal(
    fallbackFailureSummary('pdflatex', 'latexmk', 'Missing file.cls\n! LaTeX Error: File `x.cls` not found.\nl.4', 'MiKTeX could not find Perl'),
    'Falló pdflatex: LaTeX Error: File `x.cls` not found. (línea 4: ). También falló latexmk: MiKTeX could not find Perl.',
  );
});

test('exportar a PDF: identifica MiKTeX para desactivar diálogos al compilar desde VS Code', () => {
  assert.equal(isMiKTeX('MiKTeX-pdfTeX 4.27 (MiKTeX 26.5)'), true);
  assert.equal(isMiKTeX('pdfTeX 3.141592653-2.6-1.40.27 (TeX Live 2025)'), false);
  // latexmk también debe llamar al motor sin el diálogo de instalación, o se queda colgado
  assert.deepEqual(latexmkArgs('xelatex', 'd.tex', true).slice(0, 2), ['-xelatex', '-xelatex=xelatex --enable-installer %O %S']);
  assert.deepEqual(latexmkArgs('pdflatex', 'd.tex', false), ['-pdf', '-interaction=nonstopmode', '-file-line-error', '-synctex=1', 'd.tex']);
});

test('exportar a PDF: babel en español con flechas de TikZ se reconoce y trae su arreglo', () => {
  const doc = (pre: string): string => `\\documentclass{article}\n${pre}\n\\usepackage{tikz}\n\\begin{document}\n\\tikz \\draw[->] (0,0) -- (1,0);\n\\end{document}`;
  const error = 'Argument of \\language@active@arg> has an extra }. (d.tex, línea 5)';
  assert.equal(hintFor(doc('\\usepackage[spanish]{babel}'), error).fix, '\\usetikzlibrary{babel}');
  assert.equal(hintFor(doc('\\usepackage[spanish,es-noshorthands]{babel}'), error).fix, undefined, 'ya está resuelto en el documento');
  assert.equal(hintFor(doc('\\usepackage[spanish]{babel}\n\\usetikzlibrary{babel}'), error).fix, undefined);
  assert.equal(hintFor(doc('\\usepackage[english]{babel}'), error).fix, undefined);
  assert.equal(hintFor(doc('\\usepackage[spanish]{babel}'), 'File `foto.png\' not found.').fix, undefined, 'otro error no se achaca a babel');
});

test('tesis con titlesec, setspace y babel: interlineado por tramos, nombres redefinidos en el cuerpo e índice con páginas', () => {
  const B = String.fromCharCode(92);
  const tex = [
    `${B}documentclass[12pt]{report}`, `${B}usepackage[spanish]{babel}`, `${B}usepackage{setspace,titlesec}`, `${B}doublespacing`,
    `${B}titleformat{${B}chapter}[display]{${B}normalfont${B}huge${B}bfseries${B}centering}{${B}chaptertitlename${B} ${B}thechapter}{0pt}{${B}LARGE}`,
    `${B}titleformat{${B}section}{${B}normalfont${B}large${B}bfseries}{${B}thesection}{1em}{}`,
    `${B}begin{document}`, '', `${B}pagenumbering{roman}`, `${B}singlespacing`, '', 'Portada', '',
    `${B}renewcommand{${B}contentsname}{ÍNDICE}`, `${B}tableofcontents`, '', `${B}chapter*{Resumen}`, `${B}addcontentsline{toc}{chapter}{Resumen}`, '', 'Texto del resumen.', '',
    `${B}doublespacing`, '', `${B}chapter{Uno}`, '', `${B}section{Primera}`, '', `Nota: ${B}dotfill`, '',
    `${B}appendix`, `${B}renewcommand{${B}appendixname}{ANEXO}`, '', `${B}chapter{Datos}`, '', `${B}end{document}`,
  ].join('\n');
  const r = renderLatex(tex);
  const of = (re: RegExp) => r.blocks.find((b) => re.test(text(b.html)));
  const cover = of(/^Portada/);
  assert.equal(cover?.pagenum, 'Roman', 'con babel en español los romanos van en mayúsculas');
  assert.equal(cover?.lh, 1.208);
  assert.equal(of(/^Nota/)?.lh, 1.999);
  assert.ok(of(/^Capítulo 1 ?Uno$/), 'el nombre cambiado tras el apéndice no alcanza a los capítulos de antes');
  assert.match(of(/^Capítulo 1/)?.html ?? '', /text-align:center/);
  assert.ok(of(/^ANEXO A ?Datos$/));
  assert.match(of(/^1\.1 ?Primera$/)?.html ?? '', /class="deco secnum"[^>]*>1\.1</, 'titlesec quita el punto que babel pone tras el número');
  const toc = of(/^ÍNDICE/);
  assert.ok(toc, 'el índice lleva el título que vale donde se pide');
  assert.match(toc.html, /class="toc-item toc-l1"><a href="#toc-1">Resumen<\/a><span class="toc-fill"><\/span><a class="toc-page" href="#toc-1" data-page-of="toc-1">/);
  assert.deepEqual(of(/^Texto del resumen/)?.anchors, ['toc-1']);
});

test('orden propia de PDF: el nombre del archivo no se interpreta como código del shell', () => {
  assert.equal(customCommand('latexmk -pdf %DOC%', 'linux'), 'latexmk -pdf "$MARS_DOC"');
  assert.equal(customCommand('latexmk -pdf %DOC%', 'win32'), 'latexmk -pdf "%MARS_DOC%"');
  if (process.platform === 'win32') return;
  const file = '/tmp/a "b" $(echo X); `echo Y`.tex';
  const out = execSync(customCommand('printf %s %DOC%'), { env: { ...process.env, MARS_DOC: file }, shell: '/bin/sh' }).toString();
  assert.equal(out, file);
});

test('listas: numeración jerárquica por niveles (1. / 1.1. / 1.1.1.)', () => {
  const src = '\\begin{enumerate}[label=\\arabic*.]\n\\item a\n\\begin{enumerate}[label=\\arabic{enumi}.\\arabic*.]\n\\item b\n\\end{enumerate}\n\\end{enumerate}';
  const html = renderLatex(doc('\\usepackage{enumitem}', src)).blocks[1].html;
  assert.match(html, /<ol[^>]*class="enumerate lbl" style="--kind:decimal;--pre:'';--suf:'\.'"[^]*<ol[^>]*class="enumerate lbl nested" style="--kind:nested;--pre:'';--suf:'\.'"/);
});
