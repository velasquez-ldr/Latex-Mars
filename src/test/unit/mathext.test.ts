import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import katex from 'katex';
import { JSDOM } from 'jsdom';
import { type MathContext, mathMacros, pairedDelimiters, prepareMath, siSetup, siUnits } from '../../latex/mathext';
import { renderLatex } from '../../latex/renderer';

/** Lo que KaTeX dibuja con la fórmula ya preparada; falla si KaTeX no la entiende. */
const shown = (tex: string, ctx: MathContext = {}): string => {
  const html = katex.renderToString(prepareMath(tex, ctx), { throwOnError: false, strict: 'ignore', output: 'html', macros: { ...mathMacros(ctx) } });
  assert.doesNotMatch(html, /katex-error|color:#cc0000/, `KaTeX no entiende: ${tex} -> ${prepareMath(tex, ctx)}`);
  return (new JSDOM(`<div id="c">${html}</div>`).window.document.getElementById('c')?.textContent ?? '').replace(/[\u200b\s]+/g, '');
};
const text = (html: string): string => (new JSDOM(`<div id="c">${html}</div>`).window.document.getElementById('c')?.textContent ?? '').replace(/[\u200b\s]+/g, ' ').trim();
/** Lo mismo que `shown`, pero conservando los espacios escritos (los de \u00ab1 to 5\u00bb). */
const phrase = (tex: string, ctx: MathContext = {}): string => text(katex.renderToString(prepareMath(tex, ctx), { throwOnError: false, strict: 'ignore', output: 'html', macros: { ...mathMacros(ctx) } }));
const doc = (head: string, body: string): string => `\\documentclass{article}\n${head}\n\\begin{document}\n${body}\n\\end{document}\n`;

test('siunitx: números con las cifras agrupadas y el exponente como potencia de diez', () => {
  // (la marca decimal va entre llaves: ver más abajo qué pasa con babel en español)
  assert.equal(prepareMath('\\num{1.2e3}'), '{1{.}2 \\times 10^{3}}');
  assert.equal(prepareMath('\\num{12345.67891}'), '{12\\,345{.}678\\,91}');
  assert.equal(prepareMath('\\num{1234}'), '{1234}', 'cuatro cifras no se separan');
  assert.equal(prepareMath('\\num{.5}'), '{0{.}5}');
  assert.equal(prepareMath('\\num{-1e-3}'), '{-1 \\times 10^{-3}}');
  assert.equal(prepareMath('\\num{e5}'), '{10^{5}}');
  assert.equal(prepareMath('\\num{1.23(4)}'), '{1{.}23(4)}');
  assert.equal(prepareMath('\\num{1.5 +- 0.2}'), '{1{.}5 \\pm 0{.}2}');
  assert.equal(prepareMath('\\num[round-mode=places,round-precision=2]{3.14159}'), '{3{.}14}');
  assert.equal(prepareMath('\\num{x}'), '{x}', 'lo que no es un número se deja como está');
  assert.equal(shown('\\num{1.2e3}'), '1.2×103');
  // siunitx no sigue a babel: con español sus números conservan el punto salvo que \sisetup pida la coma
  const es = { spanish: true, decimalComma: true };
  assert.equal(prepareMath('\\num{1.5} + 2.5', es), '{1{.}5} + 2{,}5');
  assert.equal(prepareMath('\\num{1.5} + 2.5', { ...es, si: { 'output-decimal-marker': ',' } }), '{1{,}5} + 2{,}5');
});

test('siunitx: unidades con prefijos, potencias y «por»', () => {
  assert.equal(shown('\\SI{5}{\\meter}'), '5m');
  assert.equal(shown('\\qty{3}{\\kilo\\gram}'), '3kg');
  assert.equal(shown('\\SI{9.81}{\\meter\\per\\second\\squared}'), '9.81ms−2');
  assert.equal(shown('\\si{\\joule\\per\\mole\\per\\kelvin}'), 'Jmol−1K−1');
  assert.equal(shown('\\SI[per-mode=symbol]{3e8}{\\meter\\per\\second}'), '3×108m/s');
  assert.equal(shown('\\si{kg.m/s^2}'), 'kgm/s2', 'unidades escritas con letras');
  assert.equal(shown('\\SI{5}{\\square\\meter}'), '5m2');
  assert.equal(shown('\\SI{1.5}{\\kHz}') + shown('\\si{\\ohm}'), '1.5kHzΩ', 'abreviaturas y símbolos');
  assert.match(prepareMath('\\SI{20}{\\degreeCelsius}'), /20\\,\^\{\\circ\}\\mathrm\{C\}/);
  assert.doesNotMatch(prepareMath('\\ang{45}'), /\\,/, 'los grados van pegados al número');
  assert.equal(shown('\\ang{1;2;3}'), '1∘2′3′′');
});

test('siunitx: intervalos, listas, ajustes del documento y unidades propias', () => {
  assert.equal(phrase('\\SIrange{1}{5}{\\meter}'), '1m to 5m');
  assert.equal(phrase('\\numlist{1;2;3}'), '1, 2 and 3');
  const setup = siSetup('\\sisetup{output-decimal-marker={,}, per-mode=symbol}\n\\sisetup{range-phrase={ a }}');
  assert.deepEqual(setup, { 'output-decimal-marker': ',', 'per-mode': 'symbol', 'range-phrase': ' a ' });
  assert.equal(shown('\\SI{1.5}{\\meter\\per\\second}', { si: setup }), '1,5m/s');
  assert.equal(phrase('\\numrange{1}{5}', { si: setup }), '1 a 5');
  const units = siUnits('\\DeclareSIUnit\\molar{\\mole\\per\\liter}\n\\DeclareSIUnit{\\px}{px}');
  assert.deepEqual(units, { molar: '\\mole\\per\\liter', px: 'px' });
  assert.equal(shown('\\SI{3}{\\molar}', { units }), '3molL−1');
  // una orden que no tiene la forma de siunitx no se toca
  assert.equal(prepareMath('\\num + \\unit'), '\\num + \\unit');
});

test('physics: derivadas, valores absolutos, paréntesis que se ajustan y notación de Dirac', () => {
  const p = { physics: true };
  assert.equal(prepareMath('\\dv{f}{x}', p), '\\frac{\\mathrm{d} f}{\\mathrm{d} x}');
  assert.equal(prepareMath('\\dv[2]{f}{x}', p), '\\frac{\\mathrm{d}^{2} f}{\\mathrm{d} x^{2}}');
  assert.equal(prepareMath('\\pdv{f}{x}{y}', p), '\\frac{\\partial^{2} f}{\\partial x\\,\\partial y}');
  assert.equal(prepareMath('\\abs{x}', p), '\\left\\lvert x \\right\\rvert');
  assert.equal(prepareMath('\\qty(\\frac{a}{b})', p), '\\left( \\frac{a}{b} \\right)');
  assert.equal(prepareMath('\\mqty(a & b \\\\ c & d)', p), '\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}');
  for (const t of ['\\dv{x}', '\\dd[3]{r}', '\\norm{\\vb{v}}', '\\qty[x]', '\\comm{A}{B}', '\\ev{A}{\\psi}', '\\mel{a}{H}{b}', '\\braket{a}{b}', '\\dyad{a}{b}', '\\va{F} \\cross \\vu{n}', '\\grad f + \\div\\vb{A}', '\\order{x^2}', '\\eval{f}_0^1', '\\Tr\\rho \\qq{y} \\Re z']) {
    shown(t, p);
  }
  // con physics y siunitx a la vez, \qty con dos grupos es una cantidad con su unidad
  assert.equal(shown('\\qty{1}{\\meter}', p), '1m');
  // sin el paquete no se inventa nada, y lo que define el documento manda
  assert.equal(prepareMath('\\abs{x}'), '\\abs{x}');
  assert.equal(prepareMath('\\abs{x}', p, (name) => name === 'abs'), '\\abs{x}');
});

test('mathtools: delimitadores declarados con \\DeclarePairedDelimiter', () => {
  const paired = pairedDelimiters('\\DeclarePairedDelimiter\\abs{\\lvert}{\\rvert}\n\\DeclarePairedDelimiter{\\norm}{\\lVert}{\\rVert}');
  assert.deepEqual(paired, { abs: ['\\lvert', '\\rvert'], norm: ['\\lVert', '\\rVert'] });
  assert.equal(prepareMath('\\abs{x} + \\abs*{y} + \\norm[\\Big]{v}', { paired }), '\\lvert x \\rvert + \\left\\lvert y \\right\\rvert + \\Bigl\\lVert v \\Bigr\\rVert');
  shown('\\abs{x} + \\abs*{\\frac{a}{b}} + \\norm[\\Big]{v}', { paired });
});

test('babel en español: coma decimal y operadores, sin tocar medidas ni textos', () => {
  const es = { spanish: true, decimalComma: true };
  assert.equal(prepareMath('3.14', es), '3{,}14');
  assert.equal(prepareMath('\\frac{1.5}{2.25}', es), '\\frac{1{,}5}{2{,}25}');
  assert.equal(prepareMath('a\\hspace{1.5cm}b', es), 'a\\hspace{1.5cm}b');
  assert.equal(prepareMath('\\text{v 1.5} + 2.5', es), '\\text{v 1.5} + 2{,}5');
  assert.equal(prepareMath('x \\tag{2.3}', es), 'x \\tag{2.3}', 'el número de la ecuación no es una cifra de la fórmula');
  assert.equal(prepareMath('a \\\\[1.5ex] 0.5', es), 'a \\\\[1.5ex] 0{,}5');
  assert.equal(prepareMath('\\kern1.5em 2.5', es), '\\kern1.5em 2{,}5');
  assert.equal(prepareMath('\\begin{array}{p{1.5cm}} 1.5 \\end{array}', es), '\\begin{array}{p{1.5cm}} 1{,}5 \\end{array}');
  assert.equal(prepareMath('3.14', { spanish: true }), '3.14', 'con es-nodecimaldot el punto se queda');
  assert.equal(shown('\\sen x + \\tg y + \\arcsen z', es), 'senx+tgy+arcsenz');
  assert.match(shown('\\lim_{x\\to 0} f', es), /^l[ıi]\u02ca?[ıi]?m/, 'el límite lleva acento');
  assert.equal(mathMacros({ spanish: true, unaccented: true })['\\lim'], undefined, '\\unaccentedoperators los deja sin acento');
  assert.equal(mathMacros()['\\sen'], undefined, 'sin babel en español no existe \\sen');
});

test('órdenes sueltas de otros paquetes: bbm, dsfont, cancel, upgreek, mhchem', () => {
  for (const t of ['\\mathbbm{1} + \\mathds{R}', '\\cancelto{0}{x}', '\\upalpha + \\Upgamma', '\\nicefrac{1}{2}', '\\vv{AB}', '\\symbf{x}', 'a \\hdots b']) shown(t);
});

test('el renderizador usa todo ello: en el texto, en las fórmulas y según el preámbulo', () => {
  const body = (head: string, src: string): string => renderLatex(doc(head, src)).blocks.slice(1).map((b) => text(b.html)).join(' | ');
  assert.equal(body('\\usepackage{siunitx}', 'Mide \\SI{5}{\\meter} y pesa \\qty{3}{\\kilo\\gram}; $v = \\SI{3e8}{m/s}$.'), 'Mide 5m y pesa 3kg; v=3×108m/s.');
  // la coma decimal solo con babel en español, y no con es-nodecimaldot
  assert.equal(body('\\usepackage[spanish]{babel}', '$3.14$'), '3,14');
  assert.equal(body('\\usepackage[spanish,es-nodecimaldot]{babel}', '$3.14$'), '3.14');
  assert.equal(body('\\usepackage[english]{babel}', '$3.14$'), '3.14');
  assert.equal(body('\\usepackage[spanish]{babel}\n\\decimalpoint', '$3.14$'), '3.14', 'el documento puede pedir el punto');
  assert.equal(body('\\usepackage[spanish,mexico]{babel}', '$3.14$ \\begin{figure}\\caption{x}\\end{figure}'), '3.14 Figura 1: x', 'en México se usa el punto, y sigue siendo español');
  assert.equal(body('\\usepackage[spanish]{babel}', '$\\sen x$'), 'senx');
  assert.match(renderLatex(doc('', '$\\sen x$')).blocks[1].html, /color:#cc0000/, 'sin babel, \\sen no existe');
  // la definición del documento manda sobre la del paquete
  assert.equal(body('\\usepackage[spanish]{babel}\n\\newcommand{\\sen}{\\operatorname{seno}}', '$\\sen x$'), 'senox');
  assert.equal(body('\\usepackage{physics}', '$\\dv{x}{t} = \\abs{v}$').replace(/\s/g, ''), 'dtdx=' + String.fromCharCode(0x2223) + 'v' + String.fromCharCode(0x2223));
  assert.equal(body('\\usepackage{mathtools}\n\\DeclarePairedDelimiter\\abs{\\lvert}{\\rvert}', '$\\abs{x}$'), '∣x∣');
  // química: en una fórmula o directamente en el texto
  assert.doesNotMatch(renderLatex(doc('\\usepackage{mhchem}', 'Agua: \\ce{H2O} y $\\ce{CO2}$.')).blocks[1].html, /tex-unknown|color:#cc0000/);
  // operador con los límites debajo
  assert.match(renderLatex(doc('\\DeclareMathOperator*{\\argmax}{arg\\,max}', '\\[\\argmax_x f\\]')).blocks[1].html, /op-limits/);
  // el contexto viaja al editor para que dibuje igual las fórmulas que se escriben
  assert.deepEqual(renderLatex(doc('\\usepackage[spanish]{babel}\n\\usepackage{physics}', 'x')).math, { spanish: true, decimalComma: true, physics: true });
  assert.deepEqual(renderLatex(doc('', 'x')).math, {});
});

test('\\intertext parte una ecuación de varias filas y deja el texto entre ellas', () => {
  const r = renderLatex('\\begin{align}\na &= b \\\\\n\\intertext{y además}\nc &= d \\label{z}\n\\end{align}\n\nEc. \\ref{z}');
  assert.doesNotMatch(r.blocks[0].html, /katex-error|color:#cc0000/);
  assert.match(r.blocks[0].html, /<div class="intertext">y además<\/div>/);
  assert.equal(r.blocks[0].kind, 'atom');
  assert.match(text(r.blocks[1].html), /Ec\. 2/, 'las filas siguen contándose seguidas');
});
