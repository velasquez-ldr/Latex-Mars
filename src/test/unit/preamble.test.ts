import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { pageGeometry, readLayout } from '../../latex/layout';
import { Conditions, effectiveSource } from '../../latex/preamble';
import { renderLatex } from '../../latex/renderer';

const doc = (head: string, body = 'Hola'): string => `${head}\n\\begin{document}\n${body}\n\\end{document}\n`;
const text = (html: string): string => (new JSDOM(`<div id="c">${html}</div>`).window.document.getElementById('c')?.textContent ?? '').replace(/\s+/g, ' ').trim();
const body = (src: string, files: Record<string, string> = {}): string =>
  renderLatex(src, { readInput: (n) => files[n] })
    .blocks.filter((b) => b.kind !== 'ro')
    .slice(1)
    .map((b) => text(b.html))
    .join(' | ');

test('condicionales del preámbulo: \\IfFileExists, \\newif, \\ifthenelse y los de etoolbox', () => {
  // el idioma de babel se da por instalado; un archivo del documento se busca de verdad
  const guarded = doc('\\documentclass{article}\n\\IfFileExists{spanish.ldf}{%\n  \\usepackage[spanish]{babel}%\n}{%\n  \\usepackage[english]{babel}%\n}');
  assert.match(effectiveSource(guarded).text, /\\usepackage\[spanish\]\{babel\}/);
  assert.doesNotMatch(effectiveSource(guarded).text, /english/);
  const local = doc('\\documentclass{article}\n\\IfFileExists{datos.tex}{\\usepackage[margin=1cm]{geometry}}{\\usepackage[margin=3cm]{geometry}}');
  assert.equal(readLayout(effectiveSource(local, () => undefined).text)?.margin, '3cm');
  assert.equal(readLayout(effectiveSource(local, (n) => (n === 'datos.tex' ? 'x' : undefined)).text)?.margin, '1cm');
  // interruptor de TeX
  const sw = (on: string): string => doc(`\\documentclass{article}\n\\newif\\ifborrador\n${on}\n\\ifborrador\n\\usepackage[margin=1cm]{geometry}\n\\else\n\\usepackage[margin=2.5cm]{geometry}\n\\fi`);
  assert.equal(readLayout(effectiveSource(sw('')).text)?.margin, '2.5cm');
  assert.equal(readLayout(effectiveSource(sw('\\borradortrue')).text)?.margin, '1cm');
  // ifthen y etoolbox
  const ifthen = doc('\\documentclass{article}\n\\newboolean{doble}\n\\setboolean{doble}{true}\n\\ifthenelse{\\boolean{doble}}{\\usepackage{setspace}\n\\doublespacing}{}');
  assert.equal(readLayout(effectiveSource(ifthen).text)?.spacing, '2');
  const toggle = doc('\\documentclass{article}\n\\newtoggle{a4}\n\\toggletrue{a4}\n\\iftoggle{a4}{\\usepackage[a4paper]{geometry}}{\\usepackage[letterpaper]{geometry}}');
  assert.equal(readLayout(effectiveSource(toggle).text)?.paper, 'a4paper');
  // el motor: Mars se comporta como pdfLaTeX
  const engine = doc('\\documentclass{article}\n\\usepackage{iftex}\n\\ifXeTeX\n\\usepackage{fontspec}\n\\else\n\\usepackage{mathptmx}\n\\fi');
  assert.equal(readLayout(effectiveSource(engine).text)?.font, 'times');
});

test('condiciones de \\ifthenelse: \\equal, \\not, \\and, \\or y comparaciones', () => {
  const c = new Conditions();
  c.flags.set('a', true);
  c.flags.set('b', false);
  assert.equal(c.test('\\boolean{a}'), true);
  assert.equal(c.test('\\not \\boolean{a}'), false);
  assert.equal(c.test('\\boolean{a} \\and \\boolean{b}'), false);
  assert.equal(c.test('\\boolean{a} \\or \\boolean{b}'), true);
  assert.equal(c.test('\\( \\boolean{b} \\or \\boolean{a} \\) \\and \\equal{es}{es}'), true);
  assert.equal(c.test('\\equal{a}{b}'), false);
  assert.equal(c.test('3 > 2'), true);
  assert.equal(c.test('\\boolean{desconocido}'), undefined, 'lo que no se puede saber no se decide');
  assert.equal(c.test('\\lengthtest{1pt < 2pt}'), undefined);
});

test('condicionales en el cuerpo: se dibuja la rama que usaría LaTeX y el código no se toca', () => {
  const head = '\\documentclass{article}\n\\newif\\ifsolucion\n\\soluciontrue\n\\newboolean{largo}';
  assert.equal(body(doc(head, 'Antes \\ifsolucion Con solución\\else Sin ella\\fi después.')), 'Antes Con solución después.');
  assert.equal(body(doc(head, 'Texto \\ifthenelse{\\boolean{largo}}{largo}{corto}.')), 'Texto corto.');
  // el interruptor también puede cambiar a mitad del documento
  assert.equal(body(doc(head, '\\solucionfalse\n\\ifsolucion sí\\else no\\fi')), 'no');
  // un condicional que no se sabe evaluar se deja a la vista, sin inventar
  const r = renderLatex(doc(head, 'Uno \\ifnum\\value{page}>1 dos\\fi'));
  assert.match(r.blocks[1].html, /tex-unknown/);
  // y nada de esto cambia el código al volver a guardarlo
  const src = 'Antes \\ifsolucion Con solución\\else Sin ella\\fi después.';
  assert.match(renderLatex(doc(head, src)).blocks[1].html, /data-tex="\\ifsolucion Con solución\\else Sin ella\\fi"/);
});

test('contadores y longitudes del documento', () => {
  const head = '\\documentclass{article}\n\\newcounter{ejercicio}\n\\setcounter{ejercicio}{4}\n\\newlength{\\hueco}\n\\setlength{\\hueco}{2cm}';
  assert.equal(body(doc(head, '\\stepcounter{ejercicio}Ejercicio \\theejercicio, \\Roman{ejercicio}, \\alph{ejercicio}.')), 'Ejercicio 5, V, e.');
  assert.equal(body(doc(head, '\\addtocounter{ejercicio}{\\value{ejercicio}}Ahora \\arabic{ejercicio}.')), 'Ahora 8.');
  // los contadores de Mars también se pueden fijar: la numeración sigue desde ahí
  assert.equal(body(doc('\\documentclass{article}', '\\setcounter{section}{6}\n\n\\section{Siete}\n\nVer \\thesection.')), '7Siete | Ver 7.');
  // una longitud propia vale donde vale cualquier otra, también con un factor delante
  const html = renderLatex(doc(head, 'A\n\n\\vspace{\\hueco}\n\nB\n\n\\vspace{0.5\\hueco}')).blocks.map((b) => b.html).join('');
  assert.match(html, /class="vskip" style="height:calc\(2 \* var\(--cm/);
  assert.match(html, /class="vskip" style="height:calc\(1 \* var\(--cm/);
});

test('nombres que el documento cambia: \\contentsname, \\figurename, \\refname', () => {
  const plain = doc('\\documentclass{article}\n\\renewcommand{\\contentsname}{Sumario}\n\\renewcommand{\\figurename}{Ilustración}', '\\tableofcontents\n\n\\section{Uno}\n\n\\begin{figure}\n\\caption{Pie}\n\\end{figure}');
  assert.match(body(plain), /^Sumario1Uno \| 1Uno \| Ilustración 1: Pie$/);
  // con babel, un \renewcommand suelto en el preámbulo no sirve (babel pone los suyos al empezar)...
  const lost = doc('\\documentclass{article}\n\\usepackage[spanish]{babel}\n\\renewcommand{\\contentsname}{Sumario}', '\\tableofcontents\n\n\\section{Uno}');
  assert.match(body(lost), /^Índice/);
  // ...y sí dentro de \addto\captionsspanish
  const kept = doc('\\documentclass{article}\n\\usepackage[spanish]{babel}\n\\addto\\captionsspanish{\\renewcommand{\\contentsname}{Sumario}}', '\\tableofcontents\n\n\\section{Uno}');
  assert.match(body(kept), /^Sumario/);
  // en español babel llama «Cuadro» a las tablas, salvo con es-tabla
  const table = (opts: string): string => body(doc(`\\documentclass{article}\n\\usepackage[${opts}]{babel}`, '\\begin{table}\n\\caption{Datos}\n\\end{table}'));
  assert.equal(table('spanish'), 'Cuadro 1: Datos');
  assert.equal(table('spanish,es-tabla'), 'Tabla 1: Datos');
});

test('clase propia (.cls junto al documento): se lee la clase que carga y lo que configura', () => {
  const cls = [
    '\\NeedsTeXFormat{LaTeX2e}',
    '\\ProvidesClass{tesis}[2026/01/01 Tesis de la universidad]',
    '\\DeclareOption*{\\PassOptionsToClass{\\CurrentOption}{report}}',
    '\\ProcessOptions\\relax',
    '\\LoadClass[12pt,a4paper]{report} % clase de partida',
    '\\RequirePackage[left=4cm,right=2.5cm,top=3cm,bottom=3cm]{geometry}',
    '\\RequirePackage{setspace}',
    '\\onehalfspacing',
    '\\RequirePackage{mathptmx}',
    '\\RequirePackage[spanish]{babel}',
    '\\setlength{\\parindent}{0pt}',
  ].join('\n');
  const src = doc('\\documentclass{tesis}\n\\usepackage{graphicx}');
  const files: Record<string, string> = { 'tesis.cls': cls };
  const eff = effectiveSource(src, (n) => files[n]);
  assert.equal(eff.customClass, 'tesis');
  const l = readLayout(eff.text);
  assert.deepEqual(
    [l?.cls, l?.fontSize, l?.paper, l?.margins, l?.spacing, l?.font, l?.lang, l?.parIndent],
    ['report', '12pt', 'a4paper', '3cm,3cm,4cm,2.5cm', '1.5', 'times', 'spanish', '0pt'],
  );
  const g = pageGeometry(l);
  assert.deepEqual([g.pageW, g.marginLeft, g.fontPt], [21, 4, 12]);
  // sin el archivo a mano no se inventa nada: se queda como estaba
  assert.equal(readLayout(effectiveSource(src, () => undefined).text)?.cls, 'tesis');
  assert.equal(readLayout(effectiveSource(src, () => undefined).text)?.margins, '');
  // las opciones del documento se suman a las de la clase, y la vista dice de qué clase se trata
  assert.equal(readLayout(effectiveSource(doc('\\documentclass[twocolumn]{tesis}'), (n) => files[n]).text)?.columns, '2');
  assert.match(renderLatex(src, { readInput: (n) => files[n] }).blocks[0].html, /tesis \(report\)/);
  // el documento original no cambia: solo se lee
  assert.ok(eff.text.endsWith('\\begin{document}\nHola\n\\end{document}\n'));
});

test('paquetes propios (.sty) y \\input del preámbulo cuentan como parte de él', () => {
  const files: Record<string, string> = {
    'estilo.sty': '\\ProvidesPackage{estilo}\n\\RequirePackage[margin=2cm]{geometry}\n\\newcommand{\\uni}{Universidad Mayor}',
    'config.tex': '\\usepackage{setspace}\n\\doublespacing % interlineado\n\\newcounter{caso}',
  };
  const src = doc('\\documentclass{article}\n\\usepackage{estilo}\n\\input{config}', 'En la \\uni, caso \\thecaso.');
  const l = readLayout(effectiveSource(src, (n) => files[n]).text);
  assert.deepEqual([l?.margin, l?.spacing], ['2cm', '2']);
  assert.equal(body(src, files), 'En la Universidad Mayor, caso 0.');
});
