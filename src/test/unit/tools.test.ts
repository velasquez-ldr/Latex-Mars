import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { renderLatex } from '../../latex/renderer';
import { serializeBlock, stamp } from '../../webview/serialize';

const dom = (html: string): HTMLElement => {
  const el = new JSDOM(`<div id="c">${html}</div>`).window.document.getElementById('c') as unknown as HTMLElement;
  stamp(el);
  return el;
};
const text = (html: string): string => (dom(html).textContent ?? '').replace(/\s+/g, ' ').trim();
const body = (tex: string): string => renderLatex(tex).blocks.filter((b) => b.kind !== 'ro').map((b) => b.html).join('\n');
/** Sin cambios del usuario, el bloque vuelve a salir tal como estaba escrito. */
const stable = (src: string): void => assert.equal(serializeBlock(dom(body(src))), src);
const doc = (head: string, content: string): string => `\\documentclass{article}\n${head}\n\\begin{document}\n${content}\n\\end{document}\n`;

test('listas con viñeta o numeración propias (enumitem)', () => {
  const circ = body('\\begin{itemize}[label=$\\circ$]\n  \\item uno\n  \\item dos\n\\end{itemize}');
  assert.match(circ, /<ul[^>]*style="list-style-type:'○ '"/);
  assert.match(body('\\begin{itemize}[label=--]\n  \\item uno\n\\end{itemize}'), /list-style-type:'– '/);
  const alpha = body('\\begin{enumerate}[label=(\\alph*)]\n  \\item uno\n\\end{enumerate}');
  assert.match(alpha, /<ol[^>]*class="enumerate lbl" style="--kind:lower-alpha;--pre:'\(';--suf:'\)'"/);
  assert.match(body('\\begin{enumerate}[label=\\Roman*.]\n  \\item uno\n\\end{enumerate}'), /--kind:upper-roman;--pre:'';--suf:'\.'/);
  // sin opción, la lista de siempre
  assert.doesNotMatch(body('\\begin{itemize}\n  \\item uno\n\\end{itemize}'), /list-style-type/);
  stable('\\begin{itemize}[label=$\\circ$]\n  \\item uno\n  \\item dos\n\\end{itemize}');
  stable('\\begin{enumerate}[label=(\\alph*)]\n  \\item uno\n\\end{enumerate}');
});

test('sangría e interlineado de un párrafo (adjustwidth y spacing)', () => {
  const html = body('\\begin{adjustwidth}{1cm}{0.5cm}\nTexto con sangría.\n\\end{adjustwidth}');
  assert.match(html, /class="indented" style="margin-left:calc\(1 \* var\(--cm, 37\.8px\)\);margin-right:calc\(0\.5 \* var\(--cm, 37\.8px\)\)"/);
  assert.equal(text(html), 'Texto con sangría.');
  assert.match(body('\\begin{spacing}{1.667}\nDoble.\n\\end{spacing}'), /class="spacing" style="line-height:2"/);
  stable('\\begin{adjustwidth}{1cm}{0cm}\n\\begin{spacing}{1.25}\nLas dos cosas.\n\\end{spacing}\n\\end{adjustwidth}');
});

test('control de cambios y comentarios: se ven marcados y el texto sigue siendo editable', () => {
  const html = body('Uno \\added{nuevo} dos \\deleted{viejo} tres \\replaced{ahora}{antes} y \\added[id=AB]{con autor}.');
  assert.match(html, /<ins class="chg" data-o="\\added\{" data-c="\}">nuevo<\/ins>/);
  assert.match(html, /<del class="chg" data-o="\\deleted\{" data-c="\}">viejo<\/del>/);
  assert.match(html, /<ins class="chg" data-o="\\replaced\{" data-c="\}\{antes\}">ahora<span class="deco"[^>]*><del class="chg">antes<\/del><\/span><\/ins>/);
  assert.match(html, /data-o="\\added\[id=AB\]\{"/);
  stable('Uno \\added{nuevo} dos \\deleted{viejo} tres \\replaced{ahora}{antes} y \\added[id=AB]{con autor}.');
  // cambiar el texto nuevo de una sustitución conserva el viejo
  const d = dom(body('\\replaced{ahora}{antes}'));
  (d.querySelector('ins')?.firstChild as Text).data = 'luego';
  assert.equal(serializeBlock(d), '\\replaced{luego}{antes}');
  // comentarios al margen
  const note = body('Frase\\todo{Revisar} siguiente \\marginpar{Otra nota}.');
  assert.match(note, /<span class="mnote" title="Comentario al margen">Revisar<\/span>/);
  assert.match(note, /<span class="mnote"[^>]*>Otra nota<\/span>/);
  assert.match(body('\\todo[inline]{En línea}'), /class="mnote inline"/);
  stable('Frase\\todo{Revisar} siguiente \\marginpar{Otra nota}.');
});

test('tablas: ancho de las columnas p{...} y celdas combinadas en horizontal y en vertical', () => {
  const src = '\\begin{tabular}{|p{3cm}|c|r|}\n  \\hline\n  \\multirow{2}{*}{Alto} & a & b \\\\\n   & c & d \\\\\n  \\multicolumn{2}{|c|}{Ancho} & e \\\\\n  \\hline\n\\end{tabular}';
  const t = dom(body(src));
  const rows = Array.from(t.querySelectorAll('tr'));
  assert.equal(rows.length, 3);
  const tall = rows[0].children[0] as HTMLTableCellElement;
  assert.equal(tall.getAttribute('rowspan'), '2');
  assert.equal(tall.textContent, 'Alto');
  assert.match(tall.getAttribute('style') ?? '', /width:calc\(3 \* var\(--cm, 37\.8px\)\);white-space:normal/);
  assert.equal(rows[1].children[0].className, 'under', 'la celda de debajo sigue en el código, pero no se dibuja');
  assert.equal(rows[1].children[1].className, '');
  assert.equal(rows[2].children[0].getAttribute('colspan'), '2');
  assert.equal(rows[2].children[0].className, '', 'la combinación vertical ya terminó en esta fila');
  stable(src);
});

test('figura rodeada de texto e imagen recortada', () => {
  const wrap = body('\\begin{wrapfigure}{r}{0.4\\textwidth}\n  \\centering\n  FIG\n  \\caption{Pie}\n\\end{wrapfigure}');
  assert.match(wrap, /<figure class="float" data-wrap="r" style="width:40%"/);
  assert.doesNotMatch(wrap, /data-float/, 'no es un flotante: va junto a su texto');
  assert.match(body('\\begin{wrapfigure}{l}{5cm}\nFIG\n\\end{wrapfigure}'), /data-wrap="l" style="width:calc\(5 \* var\(--cm/);
  // flotantes: «H» los clava donde están; lo demás puede pasar a otra hoja
  assert.match(body('\\begin{figure}[ht]\nFIG\n\\end{figure}'), /<figure class="float" data-float/);
  assert.match(body('\\begin{table}\nTAB\n\\end{table}'), /<figure class="float" data-float/);
  assert.doesNotMatch(body('\\begin{figure}[H]\nFIG\n\\end{figure}'), /data-float/);
  // recorte: trim en puntos (o con unidades) y clip
  const img = (opts: string): string => renderLatex(`\\includegraphics[${opts}]{a.png}`, { resolveImage: (p) => `file:///${p}#mars-dpi=96` }).blocks[0].html;
  assert.match(img('width=5cm, trim=10 20 30 40, clip'), /data-trim="10 20 30 40" data-dpi="96"/);
  assert.match(img('trim={1in 0 0 0}, clip'), /data-trim="72 0 0 0"/);
  assert.doesNotMatch(img('trim=10 20 30 40'), /data-trim/, 'sin clip no se recorta nada');
});

test('estilos propios: una orden que solo da formato deja su texto editable', () => {
  const src = doc('\\usepackage{xcolor}\n\\newcommand{\\destacado}[1]{\\textbf{\\textcolor{red}{#1}}}\n\\newcommand{\\saludo}[1]{Hola, #1, y adiós #1}', 'Un \\destacado{aviso} claro y \\saludo{Ana}.');
  const html = renderLatex(src).blocks[1].html;
  assert.match(html, /<span class="ustyle" data-o="\\destacado\{" data-c="\}"><strong data-thru><span style="color:rgb\(255,0,0\)" data-thru>aviso<\/span><\/strong><\/span>/);
  assert.equal(text(html), 'Un aviso claro y Hola, Ana, y adiós Ana.');
  // el formato que pone la orden no se escribe: solo el texto
  const d = dom(html);
  assert.equal(serializeBlock(d), 'Un \\destacado{aviso} claro y \\saludo{Ana}.');
  (d.querySelector('.ustyle span')?.firstChild as Text).data = 'aviso urgente';
  assert.equal(serializeBlock(d), 'Un \\destacado{aviso urgente} claro y \\saludo{Ana}.');
});

test('encabezado y pie de página: estilo de la clase, \\pagestyle y fancyhdr', () => {
  const f = (head: string): ReturnType<typeof renderLatex>['furniture'] => renderLatex(doc(head, 'Texto')).furniture;
  const PAGE = '\u0002PAGE\u0002';
  assert.deepEqual(f(''), { style: 'plain', head: ['', '', ''], foot: ['', PAGE, ''], headRule: false, footRule: false, src: { head: ['', '', ''], foot: ['', '\\thepage', ''] } });
  assert.equal(f('\\pagestyle{empty}').style, 'empty');
  assert.deepEqual(f('\\pagestyle{headings}').head, ['<i>\u0002LM\u0002</i>', '', PAGE]);
  // fancyhdr sin más: títulos en curso arriba, número abajo y raya bajo el encabezado
  const fancy = f('\\usepackage{fancyhdr}\n\\pagestyle{fancy}');
  assert.deepEqual([fancy.style, fancy.foot, fancy.headRule, fancy.footRule], ['fancy', ['', PAGE, ''], true, false]);
  const own = f(
    '\\usepackage{fancyhdr}\n\\pagestyle{fancy}\n\\fancyhf{}\n\\fancyhead[L]{Mi tesis}\n\\fancyhead[RO,LE]{\\leftmark}\n\\fancyhead[CE]{solo pares}\n' +
      '\\fancyfoot[C]{Página \\thepage\\ de \\pageref{LastPage}}\n\\rfoot{\\textbf{UMSA}}\n\\renewcommand{\\headrulewidth}{0pt}\n\\renewcommand{\\footrulewidth}{0.4pt}',
  );
  assert.deepEqual(own.head, ['Mi tesis', '', '\u0002LM\u0002'], 'lo de las páginas pares no cuenta: el documento se ve a una cara');
  assert.equal(own.foot[1].replace(/<[^>]*>/g, ''), `Página ${PAGE} de \u0002LAST\u0002`);
  assert.match(own.foot[2], /<strong[^>]*>UMSA<\/strong>/);
  assert.deepEqual([own.headRule, own.footRule], [false, true]);
});

test('numeración y estilo de página escritos en una línea propia pasan al bloque siguiente', () => {
  const r = renderLatex(doc('', '\\pagenumbering{roman}\n\\tableofcontents\n\\newpage\n\n\\thispagestyle{empty}\nTexto \\MakeUppercase{en mayúsculas}.\n\n\\section{Uno}'));
  const toc = r.blocks.find((b) => b.html.includes('class="toc"'));
  assert.equal(toc?.pagenum, 'roman');
  const para = r.blocks.find((b) => b.html.includes('Texto'));
  assert.match(para?.html ?? '', /data-pagestyle="empty"/);
  assert.match(para?.html ?? '', /<span style="text-transform:uppercase"[^>]*>en mayúsculas<\/span>/);
  assert.equal(r.blocks.every((b) => b.html.replace(/<span class="atom (hid|anc)"[^>]*><\/span>/g, '').trim() !== ''), true, 'ninguna línea vacía se convierte en bloque');
});

test('estilos de tabla: reglas de booktabs y filas con color de fondo', () => {
  const src = '\\begin{tabular}{lc}\n  \\toprule\n  \\rowcolor{gray!25}\n  A & B \\\\\n  \\midrule\n  1 & 2 \\\\\n  \\rowcolor{yellow}\n  3 & 4 \\\\\n  \\bottomrule\n\\end{tabular}';
  const t = dom(body(src));
  const rows = Array.from(t.querySelectorAll('tr'));
  assert.equal(rows[0].className, 'rule heavy');
  assert.match(rows[0].getAttribute('style') ?? '', /background:rgb\(223,223,223\)/);
  assert.equal(rows[1].className, 'rule');
  assert.equal(rows[2].className, '', 'un color de fondo no es una línea');
  assert.match(rows[2].getAttribute('style') ?? '', /background:rgb\(255,255,0\)/);
  assert.match(t.querySelector('table')?.className ?? '', /rule-end heavy-end/);
  stable(src);
});
