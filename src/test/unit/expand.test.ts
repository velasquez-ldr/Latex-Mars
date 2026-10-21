import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { Expander, calc } from '../../latex/expand';
import { renderLatex } from '../../latex/renderer';

const flat = (s: string | undefined): string => (s ?? 'ERROR').replace(/\s+/g, ' ').trim();
/** Ejecuta `body` tras cargar `preamble`, con los contadores que se digan. */
const run = (body: string, preamble = '', counters: Record<string, number> = {}): string => {
  const x = new Expander({ counter: (n) => counters[n] });
  x.load(preamble);
  return flat(x.run(body));
};
const dom = (html: string): Element => new JSDOM(`<div id="c">${html}</div>`).window.document.getElementById('c') as Element;
const doc = (body: string, head = ''): string => `\\documentclass{article}\n\\usepackage[spanish]{babel}\n${head}\n\\begin{document}\n\n${body}\n\n\\end{document}\n`;
const blocks = (tex: string): Element[] => renderLatex(tex).blocks.filter((b) => b.kind !== 'ro').slice(1).map((b) => dom(b.html));
const text = (e: Element): string => (e.textContent ?? '').replace(/\s+/g, ' ').trim();

test('aritmética: pgfmath y \\numexpr', () => {
  assert.equal(calc('int(mod(3*4,7))'), 5);
  assert.equal(calc('2^10 + factorial(4)'), 1048);
  assert.equal(calc('max(1, 2.5) * (3 - 1)'), 5);
  assert.equal(calc('7/2', true), 4, 'la división de \\numexpr redondea');
  assert.equal(calc('7 - (7/2)*2', true), -1);
  assert.ok(Number.isNaN(calc('2 +')));
  assert.ok(Number.isNaN(calc('desconocida(3)')));
  assert.equal(run('\\pgfmathparse{int(3*4)}\\pgfmathresult, \\pgfmathparse{3/2}\\pgfmathresult, \\pgfmathtruncatemacro{\\r}{7.9}\\r, \\the\\numexpr 2*(3+4)\\relax'), '12, 1.5, 7, 14');
});

test('\\foreach: series, varias variables, contador y bucles anidados con \\ifnum', () => {
  assert.equal(run('\\foreach \\x in {1,...,5} {[\\x]}'), '[1] [2] [3] [4] [5]');
  assert.equal(run('\\foreach \\x in {0,0.5,...,2} {\\x;}'), '0; 0.5; 1; 1.5; 2;');
  assert.equal(run('\\foreach \\x in {a,...,d} {\\x}'), 'a b c d');
  assert.equal(run('\\foreach \\n/\\v [count=\\i] in {Ana/9, Luis/7} {\\i: \\n{} = \\v.}'), '1: Ana{} = 9. 2: Luis{} = 7.');
  assert.equal(run('\\foreach \\i in {1,2} {\\foreach \\j in {1,2,3} {\\pgfmathparse{int(\\i*\\j)}\\pgfmathresult\\ifnum\\j<3 & \\fi} \\\\}'), '1& 2& 3 \\\\ 2& 4& 6 \\\\');
  // la lista puede venir de una macro, y los elementos entre llaves llevan sus propias comas
  assert.equal(run('\\foreach \\t/\\cs in {{A/{x, y}}, {B/{z}}} {\\t: \\foreach \\c in \\cs {(\\c)} }'), 'A: (x) (y) B: (z)');
  // las variables no sobreviven al bucle
  assert.equal(run('\\foreach \\x in {1} {\\x} \\x'), '1 \\x');
});

test('condicionales: \\ifnum anidado en una macro, \\ifcase, \\ifodd y los que no se pueden evaluar', () => {
  const pre = '\\newcommand{\\nota}[1]{\\ifnum #1<60 Reprobado\\else\\ifnum #1<90 Aprobado\\else Sobresaliente\\fi\\fi}';
  assert.equal(run('\\nota{40}, \\nota{75}, \\nota{95}', pre), 'Reprobado, Aprobado, Sobresaliente');
  assert.equal(run('\\ifcase 2 cero\\or uno\\or dos\\else otro\\fi{} \\ifcase 9 cero\\or uno\\else otro\\fi'), 'dos{} otro');
  assert.equal(run('\\ifodd 7 impar\\else par\\fi'), 'impar');
  assert.equal(run('\\ifnum\\value{section}>1 varias\\else una\\fi', '', { section: 3 }), 'varias');
  // el contador de página no lo lleva Mars: no se inventa una rama
  assert.equal(run('Uno \\ifnum\\value{page}>1 dos\\fi'), 'Uno \\ifnum\\value{page}>1 dos\\fi');
});

test('definiciones dinámicas: \\csname, \\ifcsname, \\let y \\ifx', () => {
  const pre = [
    '\\makeatletter',
    '\\newcommand{\\setvar}[2]{\\expandafter\\def\\csname var@#1\\endcsname{#2}}',
    '\\newcommand{\\getvar}[1]{\\ifcsname var@#1\\endcsname\\csname var@#1\\endcsname\\else[#1 sin definir]\\fi}',
    '\\def\\@iguales#1#2{\\def\\@a{#1}\\def\\@b{#2}\\ifx\\@a\\@b IGUALES\\else DISTINTOS\\fi}',
    '\\newenvironment{caja}[2][]{\\ifx&#1&\\else[#1] \\fi\\textbf{#2}: }{ (fin)}',
    '\\makeatother',
  ].join('\n');
  assert.equal(run('\\setvar{ciudad}{Madrid}\\getvar{ciudad} y \\getvar{pais}', pre), 'Madrid y [pais sin definir]');
  assert.equal(run('\\setvar{x}{1}\\expandafter\\let\\csname var@x\\endcsname\\undefined \\getvar{x}', pre), '[x sin definir]');
  assert.equal(run('\\@iguales{a b}{a b} \\@iguales{a}{b}', pre), 'IGUALES DISTINTOS');
  assert.equal(run('\\begin{caja}{Título}texto\\end{caja} \\begin{caja}[rojo]{Otro}más\\end{caja}', pre), '\\textbf{Título}: texto (fin) [rojo] \\textbf{Otro}: más (fin)');
});

test('TeX de bajo nivel: argumentos delimitados con recursión, \\loop, \\newcount y \\newif', () => {
  const pre = [
    '\\makeatletter',
    '\\def\\@invertir#1#2\\end{\\ifx\\relax#2\\relax#1\\else\\@invertir#2\\end#1\\fi}',
    '\\newcount\\@num \\newcount\\@div \\newif\\if@primo',
    '\\def\\@esPrimo#1{\\@num=#1\\relax \\@primotrue',
    '  \\ifnum\\@num<2\\relax \\@primofalse \\else \\@div=2\\relax',
    '    \\loop \\ifnum\\@div<\\@num \\ifnum\\numexpr\\@num - (\\@num/\\@div)*\\@div\\relax=0\\relax \\@primofalse \\fi \\advance\\@div by 1 \\repeat',
    '  \\fi \\if@primo #1p\\else #1\\fi}',
    '\\makeatother',
  ].join('\n');
  assert.equal(run('\\@invertir r e c o n o c e r\\end', pre).replace(/\s/g, ''), 'reconocer');
  assert.equal(run('\\@invertir A n a\\end', pre).replace(/\s/g, ''), 'anA');
  assert.equal(run('\\@esPrimo{1} \\@esPrimo{2} \\@esPrimo{9} \\@esPrimo{13} \\@esPrimo{15}', pre), '1 2p 9 13p 15');
});

test('xparse y keyval: argumentos opcionales y claves', () => {
  const pre = [
    '\\NewDocumentCommand{\\vect}{o m}{\\IfNoValueTF{#1}{\\mathbf{#2}}{\\mathbf{#2}_{#1}}}',
    '\\NewDocumentCommand{\\tit}{s O{gris} m}{\\IfBooleanTF{#1}{*}{}#3 (#2)}',
    '\\makeatletter\\define@key{info}{autor}{\\def\\info@autor{#1}}\\define@key{info}{ver}{\\def\\info@ver{#1}}\\makeatother',
    '\\newcommand{\\ficha}[1]{\\setkeys{info}{autor=,ver=,#1}Autor: \\info@autor, v\\info@ver}',
  ].join('\n');
  assert.equal(run('$\\vect{F}$ y $\\vect[i]{F}$', pre), '$\\mathbf{F}$ y $\\mathbf{F}_{i}$');
  assert.equal(run('\\tit{A} \\tit*[rojo]{B}', pre), 'A (gris) *B (rojo)');
  assert.equal(run('\\ficha{autor=Ana, ver=3.2}', pre), 'Autor: Ana, v3.2');
});

test('lo que no es cosa del intérprete: bucles de TikZ, texto corriente, expl3 y Lua', () => {
  const x = new Expander({ counter: () => undefined });
  x.load('\\newcommand{\\simple}[1]{\\textbf{#1}}\n\\newcommand{\\prog}[1]{\\ifnum#1>0 +\\fi}\n\\ExplSyntaxOn\n\\cs_new:Npn \\mi_calc: { \\fp_use:N \\g_x }\n\\NewDocumentCommand{\\anota}{mm}{ \\seq_put:Nn \\g_s {#1} }\n\\NewDocumentCommand{\\muestra}{}{ \\mi_calc: }\n\\ExplSyntaxOff');
  assert.equal(x.needs('Texto con \\simple{negrita} y $x^2$.'), undefined, 'una macro que solo da formato la dibuja el renderizador');
  assert.equal(x.needs('\\begin{tikzpicture}\\foreach \\x in {1,2} \\draw (\\x,0) circle (1);\\end{tikzpicture}'), undefined, 'los bucles de un dibujo son de TikZ');
  assert.equal(x.needs('Valor \\prog{3}'), 'program');
  assert.equal(x.needs('\\newcommand{\\otra}{x}'), 'defs');
  // las órdenes definidas con expl3 no se ejecutan: se saltan sus argumentos y se avisa donde escriben
  assert.equal(flat(x.run('\\anota{A}{85}\\anota{B}{92} Media: \\muestra')), 'Media: \\MarsComputed{muestra}');
  assert.equal(flat(x.run('\\directlua{tex.print(1+1)} \\directlua{x = 1}')), '\\MarsComputed{Lua}');
  // dentro de un dibujo solo se sustituyen las variables de fuera
  assert.equal(
    flat(x.run('\\foreach \\n in {3} {\\begin{tikzpicture}\\foreach \\k in {1,2} \\draw (\\k,\\n);\\end{tikzpicture}}')),
    '\\begin{tikzpicture}\\foreach \\k in {1,2} \\draw (\\k,3);\\end{tikzpicture}',
  );
  // una recursión sin fin no cuelga el editor
  x.load('\\def\\bucle{\\ifnum 1>0 \\bucle\\bucle\\fi}');
  assert.equal(x.run('\\bucle'), undefined);
});

test('contenido generado: una tabla hecha con \\foreach se dibuja con sus filas y el bloque conserva su código', () => {
  const src = '\\begin{tabular}{cc}\n\\hline\nN & Doble \\\\\n\\hline\n\\foreach \\n in {1,...,4} {\n  \\n & \\pgfmathparse{int(2*\\n)}\\pgfmathresult \\\\\n}\n\\hline\n\\end{tabular}';
  const r = renderLatex(doc(`Antes.\n\n${src}\n\nDespués.`, '\\usepackage{pgffor}'));
  const b = r.blocks[2];
  assert.equal(b.kind, 'atom', 'lo generado no se edita en sitio');
  assert.equal(b.src, src);
  const rows = Array.from(dom(b.html).querySelectorAll('tr')).map((tr) => text(tr));
  assert.deepEqual(rows, ['N Doble', '1 2', '2 4', '3 6', '4 8']);
  assert.doesNotMatch(b.html, /tex-unknown/);
  assert.equal(r.blocks[1].kind, 'rich', 'los párrafos de alrededor siguen siendo editables');
  // el cuerpo de un bucle con líneas en blanco y títulos dentro no se parte en varios bloques
  const sections = renderLatex(doc('\\foreach \\t in {Uno, Dos} {\n  \\subsection{\\t}\n\n  Texto de \\t.\n}', '\\usepackage{pgffor}'));
  assert.equal(sections.blocks.length, 2);
  assert.deepEqual(Array.from(dom(sections.blocks[1].html).querySelectorAll('h3')).map((h) => text(h).replace(/^[\d.]+\s*/, '')), ['Uno', 'Dos']);
});

test('colores de xcolor: mezclas y colores definidos por el documento', () => {
  const [p] = blocks(doc('\\textcolor{azul}{a} \\textcolor{blue!20}{b} \\textcolor{green!60!black}{c} \\textcolor[HTML]{FF8800}{d} \\colorlet{suave}{azul!50}\\colorbox{suave}{e}', '\\usepackage{xcolor}\n\\definecolor{azul}{RGB}{30, 60, 120}'));
  const styles = Array.from(p.querySelectorAll('span[style]')).map((s) => s.getAttribute('style'));
  assert.deepEqual(styles, ['color:rgb(30,60,120)', 'color:rgb(204,204,255)', 'color:rgb(0,153,0)', 'color:rgb(255,136,0)', 'background:rgb(143,158,188)']);
});

test('cajas, algoritmos, glosario y enlaces: paquetes habituales que antes salían como código', () => {
  const head = '\\usepackage{tcolorbox,algpseudocode,glossaries,hyperref}\n\\newtcolorbox{aviso}[1][]{colback=red!5, colframe=red!75!black, title=#1}\n\\newglossaryentry{api}{name=API, description={Interfaz de programación}}';
  const bs = blocks(doc([
    '\\begin{tcolorbox}[colback=blue!5, colframe=blue!60!black, title=Archivos creados]\nContenido de la caja.\n\\end{tcolorbox}',
    '\\begin{aviso}[Cuidado]\nTexto del aviso.\n\\end{aviso}',
    '\\begin{algorithmic}[1]\n\\Procedure{Suma}{$a, b$}\n\\If{$a > 0$}\n  \\State $s \\gets a + b$\n\\EndIf\n\\State \\Return $s$\n\\EndProcedure\n\\end{algorithmic}',
    'Una \\gls{api} y un enlace a la \\hyperref[sec:x]{sección}.\\index{interfaz}',
    '\\printglossary[title=Glosario]',
    '\\printindex',
  ].join('\n\n'), head));
  const box = bs[0].querySelector('.tcb') as HTMLElement;
  assert.equal(text(box.querySelector('.tcb-title') as Element), 'Archivos creados');
  assert.match(box.getAttribute('style') ?? '', /--tcb-back:rgb\(242,242,255\);--tcb-frame:rgb\(0,0,153\)/);
  assert.match(text(box), /Contenido de la caja\./);
  assert.equal(text(bs[1].querySelector('.tcb-title') as Element), 'Cuidado', 'un entorno hecho con \\newtcolorbox');
  const lines = Array.from(bs[2].querySelectorAll('.algo-line')).map((l) => `${l.getAttribute('style')?.replace('--d:', '')}|${text(l)}`);
  assert.deepEqual(lines.map((l) => l.replace(/\s+/g, ' ')), ['0|1:procedure Suma(a,b)', '1|2:if a>0 then', '2|3:s←a+b', '1|4:end if', '1|5:return s', '0|6:end procedure'].map((l) => l));
  assert.equal(text(bs[3].querySelector('a.gls') as Element), 'API');
  assert.equal(bs[3].querySelector('a[href="#lbl-sec%3Ax"]')?.textContent, 'sección');
  assert.match(text(bs[4]), /Glosario ?API ?Interfaz de programación/);
  assert.match(text(bs[5]), /interfaz/);
  for (const b of bs) assert.doesNotMatch(b.innerHTML, /tex-unknown|env-unknown/);
});

test('clases de documento: carta, examen, presentación y póster', () => {
  const letter = renderLatex('\\documentclass{letter}\n\\signature{Juan Mendoza}\n\\address{Av. Reforma 1 \\\\ México}\n\\begin{document}\n\n\\begin{letter}{Dra. Salinas \\\\ GlobalTech}\n\n\\opening{Estimada Dra.:}\n\nTexto de la carta.\n\n\\closing{Atentamente,}\n\n\\end{letter}\n\n\\end{document}');
  const l = dom(letter.blocks[1].html);
  assert.match(text(l.querySelector('.letter-from') as Element), /Av\. Reforma 1 ?México/);
  assert.match(text(l.querySelector('.letter-to') as Element), /Dra\. Salinas ?GlobalTech/);
  assert.equal(text(l.querySelector('.letter-opening') as Element), 'Estimada Dra.:');
  assert.equal(text(l.querySelector('.letter-closing') as Element), 'Atentamente,Juan Mendoza');
  assert.equal(letter.blocks[1].kind, 'rich', 'el texto de la carta se edita en sitio');

  const exam = renderLatex('\\documentclass{exam}\n\\usepackage[spanish]{babel}\n\\begin{document}\n\n\\begin{questions}\n\\question[15] Derive:\n\\begin{parts}\n  \\part $x^2$\n  \\begin{solution}\n  $2x$\n  \\end{solution}\n  \\part $x^3$\n\\end{parts}\n\\question[1] Defina límite.\n\\end{questions}\n\n\\end{document}');
  const e = dom(exam.blocks[1].html);
  assert.equal(e.querySelectorAll(':scope ol.enumerate > li, :scope > div > ol > li').length >= 2, true);
  assert.match(text(e), /\(15 puntos\) Derive:/);
  assert.match(text(e), /\(1 punto\) Defina límite\./);
  assert.match(text(e.querySelector('.solution') as Element), /Solución: ?2x/);
  assert.equal(e.querySelectorAll('ol ol > li').length, 2, 'los apartados son una lista dentro de la pregunta');
  assert.doesNotMatch(exam.blocks[1].html, /tex-unknown|env-unknown/);

  const slides = renderLatex('\\documentclass{beamer}\n\\title{Blockchain}\n\\author{P. Castro}\n\\institute{UPN}\n\\begin{document}\n\n\\frame{\\titlepage}\n\n\\begin{frame}{Casos de uso}\n\\begin{block}{Salud}\nRegistros seguros.\n\\end{block}\n\\end{frame}\n\n\\end{document}');
  assert.match(text(dom(slides.blocks[1].html)), /Blockchain ?P\. Castro ?UPN/);
  const frame = dom(slides.blocks[2].html);
  assert.equal(text(frame.querySelector('.frametitle') as Element), 'Casos de uso');
  assert.equal(text(frame.querySelector('.tcb-title') as Element), 'Salud');

  const poster = renderLatex('\\documentclass{tikzposter}\n\\title{Vacunas}\n\\begin{document}\n\\maketitle\n\n\\begin{columns}\n\n\\column{0.5}\n\n\\block{Método}{\n\\begin{itemize}\n  \\item Estudio prospectivo\n\\end{itemize}\n}\n\n\\block{Discusión}{\nTexto.\n}\n\n\\end{columns}\n\n\\end{document}');
  const titles = poster.blocks.flatMap((b) => Array.from(dom(b.html).querySelectorAll('.tcb-title')).map((t) => text(t)));
  assert.deepEqual(titles, ['Método', 'Discusión']);
  assert.doesNotMatch(poster.blocks.map((b) => b.html).join(''), /tex-unknown|env-unknown/);
});

test('órdenes de ajuste y cajas que no deben verse como código', () => {
  const bs = blocks(doc([
    '\\parindent=0pt \\tolerance 1000 \\KOMAoptions{parskip=half}\\addtokomafont{section}{\\Large}\\clearpairofpagestyles Texto limpio.',
    '\\resizebox{\\textwidth}{!}{\\begin{tabular}{cc}a & b \\\\ c & d\\end{tabular}}',
    '\\makecell{dos \\\\ líneas} \\fbox{caja} \\parbox{3cm}{párrafo} \\tablename{} \\lstinline|x = 1| \\enquote{cita}',
  ].join('\n\n')));
  assert.equal(text(bs[0]), 'Texto limpio.');
  assert.equal(bs[1].querySelectorAll('td').length, 4);
  assert.match(text(bs[2]), /dos ?líneas caja párrafo Cuadro x = 1 cita/);
  for (const b of bs) assert.doesNotMatch(b.innerHTML, /tex-unknown|env-unknown/);
});
