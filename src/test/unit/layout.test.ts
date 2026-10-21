import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { FONTS, cssLength, documentLanguage, landscapeSwap, lineHeightFor, pageGeometry, readLayout, textWidthCm, writeLayout } from '../../latex/layout';
import { renderLatex } from '../../latex/renderer';
import { TEMPLATES } from '../../templates';

const doc = (head: string): string => `${head}\n\\begin{document}\nHola\n\\end{document}\n`;

test('lee la disposición del preámbulo', () => {
  const l = readLayout(doc('\\documentclass[12pt, a4paper, twocolumn]{report}\n\\usepackage[spanish]{babel}\n\\usepackage[margin=2cm]{geometry}\n\\usepackage{setspace}\n\\onehalfspacing'));
  assert.deepEqual(l, {
    cls: 'report', paper: 'a4paper', paperSize: '', fontSize: '12pt', columns: '2', orientation: 'portrait',
    margins: '2cm,2cm,2cm,2cm', margin: '2cm', spacing: '1.5', lang: 'spanish', font: '', parIndent: '', parSkip: '', widows: '',
  });
  assert.equal(readLayout('Solo un fragmento'), undefined);
  assert.equal(readLayout(doc('\\documentclass{article}'))?.paper, 'letterpaper');
});

test('cambia papel, letra, orientación y columnas en \\documentclass conservando otras opciones', () => {
  const src = doc('\\documentclass[draft]{article}');
  assert.match(writeLayout(src, { paper: 'a4paper', fontSize: '11pt' }), /^\\documentclass\[11pt, a4paper, draft\]\{article\}\n/);
  assert.match(writeLayout(src, { orientation: 'landscape', columns: '2' }), /^\\documentclass\[landscape, twocolumn, draft\]\{article\}\n/);
  const back = writeLayout(writeLayout(src, { paper: 'a4paper' }), { paper: 'letterpaper' });
  assert.equal(back, src);
});

test('tipo de letra del documento: se lee del preámbulo y se cambia sin tocar lo demás', () => {
  const src = doc('\\documentclass{article}\n\\usepackage{amsmath, amssymb}');
  assert.equal(readLayout(src)?.font, '');
  // Times: un paquete
  const times = writeLayout(src, { font: 'times' });
  assert.match(times, /\\usepackage\{amsmath, amssymb\}\n\\usepackage\{mathptmx\}\n\\begin\{document\}/);
  assert.equal(readLayout(times)?.font, 'times');
  assert.match(pageGeometry(readLayout(times)).fontCss, /^'Times New Roman'/);
  // Helvetica: el paquete y, además, la familia por defecto pasa a ser la de palo seco
  const helv = writeLayout(times, { font: 'helvetica' });
  assert.doesNotMatch(helv, /mathptmx/);
  assert.match(helv, /\\usepackage\{helvet\}\n\\renewcommand\{\\familydefault\}\{\\sfdefault\}\n\\begin\{document\}/);
  assert.equal(readLayout(helv)?.font, 'helvetica');
  // palo seco de LaTeX: solo la familia por defecto
  const sans = writeLayout(helv, { font: 'sans' });
  assert.doesNotMatch(sans, /helvet/);
  assert.equal(readLayout(sans)?.font, 'sans');
  // volver a la letra de LaTeX deja el preámbulo como estaba
  assert.equal(writeLayout(sans, { font: '' }), src);
  assert.equal(writeLayout(times, { font: '' }), src);
  // se reconocen otros paquetes equivalentes y se respeta lo que comparta línea con ellos
  const mixed = doc('\\documentclass{article}\n\\usepackage{graphicx, palatino}\n\\usepackage{helvet}');
  assert.equal(readLayout(mixed)?.font, 'palatino', 'helvet sin \\familydefault no cambia la letra del texto');
  assert.match(writeLayout(mixed, { font: 'charter' }), /\\usepackage\{graphicx\}\n\\usepackage\{helvet\}\n\\usepackage\{charter\}\n\\begin\{document\}/);
  // si el paquete ya estaba cargado, no se repite: solo se añade lo que falta
  assert.match(writeLayout(mixed, { font: 'helvetica' }), /\\usepackage\{graphicx\}\n\\usepackage\{helvet\}\n\\renewcommand\{\\familydefault\}\{\\sfdefault\}\n\\begin\{document\}/);
  // cambiar otra cosa no toca la letra
  assert.match(writeLayout(times, { paper: 'a4paper' }), /\\usepackage\{mathptmx\}/);
});

test('los márgenes usan el paquete geometry', () => {
  const src = doc('\\documentclass{article}\n\\usepackage{amsmath}');
  const a = writeLayout(src, { margin: '2.54cm' });
  assert.match(a, /\\usepackage\{amsmath\}\n\\usepackage\[margin=2\.54cm\]\{geometry\}\n\\begin\{document\}/);
  const b = writeLayout(a, { margin: '1.27cm' });
  assert.match(b, /\\usepackage\[margin=1\.27cm\]\{geometry\}/);
  assert.equal((b.match(/geometry/g) ?? []).length, 1);
  // sin márgenes ni otras opciones, el paquete sobra: se quita para volver a los márgenes de LaTeX
  assert.equal(writeLayout(b, { margin: '' }), src);
  // ...salvo que el documento lo configure después con \geometry{...}
  assert.match(writeLayout(doc('\\documentclass{article}\n\\usepackage[margin=1cm]{geometry}\n\\geometry{headsep=1cm}'), { margin: '' }), /\\usepackage\{geometry\}\n\\geometry/);
  // otras opciones de geometry se respetan
  const c = writeLayout(doc('\\documentclass{article}\n\\usepackage[headheight=15pt, left=3cm]{geometry}'), { margin: '2cm' });
  assert.match(c, /\\usepackage\[margin=2cm, headheight=15pt\]\{geometry\}/);
});

test('márgenes distintos por lado', () => {
  const src = doc('\\documentclass{article}');
  const a = writeLayout(src, { margins: '2.54cm,2.54cm,1.91cm,1.91cm' });
  assert.match(a, /\\usepackage\[top=2\.54cm, bottom=2\.54cm, left=1\.91cm, right=1\.91cm\]\{geometry\}/);
  assert.equal(readLayout(a)?.margins, '2.54cm,2.54cm,1.91cm,1.91cm');
  assert.equal(readLayout(a)?.margin, '', 'no es un margen uniforme');
  // cuatro lados iguales se escriben de forma compacta
  assert.match(writeLayout(a, { margins: '3cm,3cm,3cm,3cm' }), /\\usepackage\[margin=3cm\]\{geometry\}/);
  // se entienden las distintas formas de geometry
  assert.equal(readLayout(doc('\\documentclass{article}\n\\usepackage[hmargin=2cm, vmargin={3cm,4cm}]{geometry}'))?.margins, '3cm,4cm,2cm,2cm');
  // los lados que no se indican los calcula geometry: la caja de texto ocupa el 70 % del papel
  assert.equal(readLayout(doc('\\documentclass{article}\n\\usepackage[left=3cm, top=2cm]{geometry}'))?.margins, '2cm,6.38cm,3cm,3.48cm');
  assert.equal(readLayout(doc('\\documentclass[a4paper]{article}\n\\usepackage{geometry}'))?.margins, '3.56cm,5.35cm,3.15cm,3.15cm');
  // cambiar otra cosa (el papel) no reescribe los márgenes que ya había
  assert.match(writeLayout(doc('\\documentclass{article}\n\\usepackage[left=3cm, top=2cm]{geometry}'), { paper: 'a4paper' }), /\\usepackage\[left=3cm, top=2cm\]\{geometry\}/);
  const g = pageGeometry(readLayout(a));
  assert.deepEqual([g.marginTop, g.marginBottom, g.marginLeft, g.marginRight], [2.54, 2.54, 1.91, 1.91]);
});

test('tamaños de papel: estándar, solo de geometry y personalizado', () => {
  const src = doc('\\documentclass[a4paper]{article}');
  // A3 no es una opción de la clase: va por geometry
  const a3 = writeLayout(src, { paper: 'a3paper' });
  assert.match(a3, /^\\documentclass\{article\}\n\\usepackage\[a3paper\]\{geometry\}/);
  assert.equal(readLayout(a3)?.paper, 'a3paper');
  assert.deepEqual([pageGeometry(readLayout(a3)).pageW, pageGeometry(readLayout(a3)).pageH], [29.7, 42]);
  // personalizado
  const custom = writeLayout(a3, { paperSize: '18cm,24cm' });
  assert.match(custom, /\\usepackage\[paperwidth=18cm, paperheight=24cm\]\{geometry\}/);
  const l = readLayout(custom);
  assert.equal(l?.paper, 'custom');
  assert.deepEqual([pageGeometry(l).pageW, pageGeometry(l).pageH], [18, 24]);
  // volver a un papel estándar limpia el tamaño personalizado
  assert.equal(writeLayout(custom, { paper: 'a4paper' }), src);
  // horizontal: se intercambian ancho y alto
  const land = pageGeometry(readLayout(writeLayout(src, { orientation: 'landscape' })));
  assert.deepEqual([land.pageW, land.pageH], [29.7, 21]);
});

test('interlineado e idioma', () => {
  const src = doc('\\documentclass{article}');
  const a = writeLayout(src, { spacing: '2' });
  assert.match(a, /\\usepackage\{setspace\}\n\\doublespacing\n/);
  const b = writeLayout(a, { spacing: '1.5' });
  assert.match(b, /\\usepackage\{setspace\}\n\\onehalfspacing\n/);
  assert.doesNotMatch(b, /doublespacing/);
  assert.doesNotMatch(writeLayout(b, { spacing: '1' }), /spacing\n/);
  assert.match(writeLayout(src, { lang: 'spanish' }), /\\usepackage\[spanish\]\{babel\}/);
  assert.match(writeLayout(doc('\\documentclass{article}\n\\usepackage[english]{babel}'), { lang: 'spanish' }), /\[spanish\]\{babel\}/);
});

test('no toca el cuerpo ni los finales de línea', () => {
  const src = '\\documentclass{article}\r\n\\begin{document}\r\nHola\r\n\\end{document}\r\n';
  const out = writeLayout(src, { fontSize: '12pt' });
  assert.equal(out, '\\documentclass[12pt]{article}\r\n\\begin{document}\r\nHola\r\n\\end{document}\r\n');
  assert.equal(writeLayout('sin preámbulo', { fontSize: '12pt' }), 'sin preámbulo');
});

test('todas las plantillas de documento nuevo se dibujan y tienen disposición válida', () => {
  for (const [id, tex] of Object.entries(TEMPLATES)) {
    const r = renderLatex(tex);
    // (la hoja en blanco solo lleva el preámbulo: el primer párrafo lo abre el editor al empezar a escribir)
    assert.ok(r.hasDocument && r.blocks.length >= (id === 'blank' ? 1 : 4), id);
    assert.ok(!r.blocks.some((b) => /tex-error|tex-unknown/.test(b.html)), `${id}: comandos sin dibujar`);
    assert.ok(readLayout(tex), id);
  }
});

test('idioma del documento: el de babel, aunque lleve opciones que no son idiomas o esté dentro de un \\IfFileExists', () => {
  assert.equal(documentLanguage('\\usepackage[spanish]{babel}'), 'spanish');
  assert.equal(documentLanguage('\\usepackage[spanish,es-tabla]{babel}'), 'spanish', 'es-tabla es una opción, no un idioma');
  assert.equal(documentLanguage('\\usepackage[spanish,mexico]{babel}'), 'spanish', 'mexico es una variante del español, no otro idioma');
  assert.equal(documentLanguage('\\usepackage[english, spanish, activeacute]{babel}'), 'spanish', 'el principal es el último idioma');
  assert.equal(documentLanguage('\\usepackage[main=spanish, english]{babel}'), 'spanish');
  assert.equal(documentLanguage('\\documentclass[12pt, spanish]{article}\n\\usepackage{babel}'), 'spanish', 'también como opción de la clase');
  assert.equal(documentLanguage('\\usepackage{polyglossia}\n\\setmainlanguage{spanish}'), 'spanish');
  assert.equal(documentLanguage('\\usepackage{amsmath}'), '');
  // con dos líneas de babel (la segunda, de reserva por si falta el idioma) vale la primera
  const guarded = '\\documentclass{article}\n\\IfFileExists{spanish.ldf}{%\n  \\usepackage[spanish,es-tabla]{babel}%\n}{%\n  \\usepackage[english]{babel}%\n}';
  assert.equal(readLayout(doc(guarded))?.lang, 'spanish');
});

test('sangría y separación de párrafos: \\setlength y el paquete parskip', () => {
  const none = pageGeometry(readLayout(doc('\\documentclass{article}')));
  assert.deepEqual([none.indent, none.parSkip], ['1.5em', '0px'], 'por defecto, los de LaTeX');
  const set = readLayout(doc('\\documentclass{article}\n\\setlength{\\parindent}{1.27cm}\n\\setlength{\\parskip}{6pt plus 2pt}'));
  assert.deepEqual([set?.parIndent, set?.parSkip], ['1.27cm', '6pt']);
  assert.match(pageGeometry(set).indent, /^calc\(1\.27 \* var\(--cm/);
  // el paquete parskip quita la sangría y separa los párrafos media línea...
  const pkg = readLayout(doc('\\documentclass{article}\n\\usepackage{parskip}'));
  assert.deepEqual([pkg?.parIndent, pkg?.parSkip], ['0pt', '0.5\\baselineskip']);
  assert.equal(pageGeometry(pkg).parSkip, '0.5lh');
  // ...y manda lo último que se dice: aquí anula la sangría pedida justo antes
  const late = readLayout(doc('\\documentclass{article}\n\\setlength{\\parindent}{1.27cm}\n\\usepackage[skip=0pt]{parskip}\n\\setlength{\\parskip}{0pt}'));
  assert.deepEqual([late?.parIndent, late?.parSkip], ['0pt', '0pt']);
});

test('tamaño de letra del documento: 10, 11 y 12 pt son opciones de la clase; los demás, del paquete scrextend', () => {
  const src = doc('\\documentclass[a4paper]{article}');
  const big = writeLayout(src, { fontSize: '14pt' });
  assert.match(big, /^\\documentclass\[a4paper\]\{article\}\n\\usepackage\[fontsize=14pt\]\{scrextend\}\n/);
  assert.equal(readLayout(big)?.fontSize, '14pt');
  assert.equal(pageGeometry(readLayout(big)).fontPt, 14);
  // otro tamaño no estándar sustituye al anterior, sin repetir el paquete
  const bigger = writeLayout(big, { fontSize: '20pt' });
  assert.match(bigger, /\\usepackage\[fontsize=20pt\]\{scrextend\}/);
  assert.equal((bigger.match(/scrextend/g) ?? []).length, 1);
  // volver a un tamaño de la clase quita el paquete
  assert.equal(writeLayout(bigger, { fontSize: '12pt' }), doc('\\documentclass[12pt, a4paper]{article}'));
  assert.equal(writeLayout(bigger, { fontSize: '10pt' }), src);
  // cambiar otra cosa no toca el tamaño
  assert.match(writeLayout(big, { spacing: '2' }), /\\usepackage\[fontsize=14pt\]\{scrextend\}/);
});

test('longitudes de LaTeX como medidas de la hoja e interlineado', () => {
  assert.equal(cssLength('2cm'), 'calc(2 * var(--cm, 37.8px))');
  assert.equal(cssLength('10pt'), 'calc(0.3515 * var(--cm, 37.8px))');
  assert.equal(cssLength('8pt plus 2pt minus 1pt'), 'calc(0.2812 * var(--cm, 37.8px))', 'la parte elástica no cuenta');
  assert.equal(cssLength('1.5em'), '1.5em');
  assert.equal(cssLength('0.86\\linewidth'), '86%');
  assert.equal(cssLength('\\textwidth'), '100%');
  assert.equal(cssLength('0.05\\textheight', 'y'), 'calc(0.05 * var(--th, 24cm))');
  assert.equal(cssLength('0.5\\textwidth', 'y'), 'calc(0.5 * var(--tw, 16cm))');
  assert.equal(cssLength('2\\baselineskip'), '2lh');
  assert.equal(cssLength('\\fill'), undefined);
  // interlineado de las clases estándar por el factor de setspace: a 12 pt, el doble espacio son 2 em
  assert.equal(lineHeightFor(10, '1'), 1.2);
  assert.equal(lineHeightFor(12, '1'), 1.208);
  assert.equal(lineHeightFor(12, '2'), 1.999);
  assert.equal(lineHeightFor(10, '1.5'), 1.5);
  assert.equal(pageGeometry(readLayout(doc('\\documentclass[12pt]{article}\n\\usepackage{setspace}\n\\doublespacing'))).lineHeight, 1.999);
});

test('cada tipo de letra tiene su familia de LaTeX, distinta de las demás', () => {
  const families = Object.values(FONTS).map((f) => f.family);
  assert.ok(families.every((f) => /^[a-z]{3,4}$/.test(f)));
  assert.equal(new Set(families).size, families.length);
  assert.equal(FONTS.times.family, 'ptm');
});

test('ancho de texto para la vista previa', () => {
  const base = readLayout(doc('\\documentclass[a4paper]{article}'))!;
  const m = '2.5cm,2.5cm,2.5cm,2.5cm';
  assert.equal(textWidthCm({ ...base, margins: m }), 16);
  assert.ok(Math.abs(textWidthCm({ ...base, margins: m, orientation: 'landscape' }) - 24.7) < 0.01);
  assert.equal(textWidthCm(base), 12.1);
});

test('viudas y huérfanas: se leen del preámbulo y se pueden activar y quitar', () => {
  const src = doc('\\documentclass{article}\n\\usepackage{amsmath}');
  assert.equal(readLayout(src)?.widows, '');
  assert.equal(pageGeometry(readLayout(src)).keepLines, 1);
  const on = writeLayout(src, { widows: '1' });
  assert.match(on, /\\usepackage\{amsmath\}\n\\widowpenalty=10000\n\\clubpenalty=10000\n\\begin\{document\}/);
  assert.equal(pageGeometry(readLayout(on)).keepLines, 2);
  assert.equal(writeLayout(on, { widows: '' }), src);
  assert.equal(readLayout(doc('\\documentclass{article}\n\\usepackage[all]{nowidow}'))?.widows, '1');
});

test('hojas horizontales: cambia lscape por pdflscape y al revés en el preámbulo', () => {
  const src = doc('\\documentclass{article}\n\\usepackage{graphicx, lscape}\n\\usepackage{float}');
  assert.deepEqual(landscapeSwap(src, true), { line: 1, text: '\\usepackage{graphicx, pdflscape}' });
  assert.equal(landscapeSwap(src, false), undefined, 'ya usa lscape');
  assert.deepEqual(landscapeSwap(doc('\\documentclass{article}\n\\usepackage[pdftex]{pdflscape}'), false), { line: 1, text: '\\usepackage[pdftex]{lscape}' });
  assert.equal(landscapeSwap(doc('\\documentclass{article}'), true), undefined, 'sin ninguno de los dos');
  assert.equal(landscapeSwap('\\documentclass{article}\n\\begin{document}\n\\usepackage{lscape}\n', true), undefined, 'solo en el preámbulo');
});
