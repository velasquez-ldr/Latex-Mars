import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { writeHeadFoot } from '../../latex/layout';
import { renderLatex } from '../../latex/renderer';
import { type HeadFootSpec, headFootPreview, toFriendly, toTex, withPageNumber } from '../../webview/headfoot';

const doc = (head: string, body = 'Hola'): string => `\\documentclass{article}\n\\usepackage{graphicx}\n${head}\\begin{document}\n${body}\n\\end{document}\n`;
const spec = (v: Partial<HeadFootSpec>): HeadFootSpec => ({ head: ['', '', ''], foot: ['', '', ''], headRule: false, footRule: false, ...v });

test('encabezado y pie: marcas legibles <-> órdenes de LaTeX', () => {
  assert.equal(toTex('Página {página} de {total}'), 'Página \\thepage{} de \\pageref{LastPage}');
  assert.equal(toFriendly('Página \\thepage{} de \\pageref{LastPage}'), 'Página {página} de {total}');
  assert.equal(toFriendly('Página \\thepage\\ de \\pageref{LastPage}'), 'Página {página} de {total}');
  assert.equal(toTex('{sección}'), '\\leftmark');
  // texto corriente: se escapa al escribirlo y se enseña sin escapar
  assert.equal(toTex('Informe 50% & más'), 'Informe 50\\% \\& más');
  assert.equal(toFriendly('Informe 50\\% \\& más'), 'Informe 50% & más');
  // con órdenes de LaTeX se respeta lo escrito
  assert.equal(toTex('\\textbf{Mi tesis} {página}'), '\\textbf{Mi tesis} \\thepage');
  assert.equal(toFriendly('\\textit{\\leftmark}'), '\\textit{{sección}}');
});

test('encabezado y pie: se escriben con fancyhdr en el preámbulo, sustituyendo lo que hubiera', () => {
  const out = writeHeadFoot(doc(''), spec({ head: ['Mi tesis', '', '\\leftmark'], foot: ['', 'Página \\thepage{} de \\pageref{LastPage}', ''], headRule: true }));
  const head = out.split('\\begin{document}')[0];
  assert.match(head, /\\usepackage\{graphicx\}\n\\usepackage\{fancyhdr\}\n\\usepackage\{lastpage\}\n/);
  assert.match(head, /\\pagestyle\{fancy\}\n\\fancyhf\{\}\n\\fancyhead\[L\]\{Mi tesis\}\n\\fancyhead\[R\]\{\\leftmark\}\n\\fancyfoot\[C\]\{Página \\thepage\{\} de \\pageref\{LastPage\}\}\n/);
  assert.match(head, /\\renewcommand\{\\headrulewidth\}\{0\.4pt\}\n\\renewcommand\{\\footrulewidth\}\{0pt\}\n/);
  // volver a escribirlo no duplica nada (tampoco una orden repartida en varias líneas)
  const again = writeHeadFoot(out.replace('\\fancyhead[L]{Mi tesis}', '\\fancyhead[L]{%\n  Mi tesis}'), spec({ foot: ['', '\\thepage', ''] }));
  assert.equal(again.match(/\\pagestyle\{fancy\}/g)?.length, 1);
  assert.equal(again.match(/\\usepackage\{fancyhdr\}/g)?.length, 1);
  assert.ok(!again.includes('Mi tesis'));
  // el cuerpo no se toca
  assert.ok(again.endsWith('\\begin{document}\nHola\n\\end{document}\n'));
  // quitarlo deja el preámbulo sin la configuración
  const none = writeHeadFoot(out, undefined);
  assert.ok(!/fancyhead|fancyfoot|\\pagestyle|rulewidth/.test(none));
});

test('encabezado y pie: lo que escribe el diálogo se dibuja y se vuelve a leer igual', () => {
  const s = spec({ head: ['Mi tesis', '', '\\leftmark'], foot: ['', 'Página \\thepage{} de \\pageref{LastPage}', ''], headRule: true });
  const f = renderLatex(writeHeadFoot(doc(''), s)).furniture;
  assert.equal(f.style, 'fancy');
  assert.deepEqual(f.src, { head: s.head, foot: s.foot });
  assert.equal(f.headRule, true);
  assert.equal(f.footRule, false);
  assert.match(f.foot[1], /Página \u0002PAGE\u0002 de \u0002LAST\u0002/);
});

test('número de página: cambia de sitio sin tocar el resto', () => {
  const s = spec({ head: ['Mi tesis', '', ''], foot: ['', '\\thepage', ''] });
  assert.deepEqual(withPageNumber(s, 'top-right').head, ['Mi tesis', '', '\\thepage']);
  assert.deepEqual(withPageNumber(s, 'top-right').foot, ['', '', '']);
  assert.deepEqual(withPageNumber(s, 'page-of').foot, ['', 'Página \\thepage{} de \\pageref{LastPage}', '']);
  assert.deepEqual(withPageNumber(s, 'page-of', 'english').foot[1], 'Page \\thepage{} of \\pageref{LastPage}');
  assert.deepEqual(withPageNumber(s, 'none').foot, ['', '', '']);
  assert.match(headFootPreview(withPageNumber(s, 'page-of')), /Página 3 de 12/);
  assert.ok(!headFootPreview(spec({ head: ['<b>', '', ''] })).includes('<b>'));
});

test('\\pagestyle: en el preámbulo vale para todo; dentro de un entorno, solo en él', () => {
  const inside = renderLatex(doc('', '\\begin{landscape}\n\\pagestyle{empty}\nTabla\n\\end{landscape}\n\nSigue.'));
  assert.equal(inside.furniture.style, 'plain', 'un \\pagestyle dentro de un entorno no cambia el resto del documento');
  assert.match(inside.blocks.map((b) => b.html).join(''), /data-pagestyle-from="empty"/);
  assert.equal(renderLatex(doc('\\pagestyle{empty}\n')).furniture.style, 'empty');
  // en una línea propia del cuerpo: vale desde el bloque que le sigue
  const later = renderLatex(doc('', 'Portada.\n\n\\pagestyle{empty}\n\nResto.'));
  assert.equal(later.blocks.find((b) => b.src.startsWith('Resto'))?.pagestyleFrom, 'empty');
  // fancyhdr activado solo en el cuerpo: su aspecto se conoce igual
  const fancy = renderLatex(doc('\\usepackage{fancyhdr}\n\\fancyhf{}\n\\fancyhead[R]{Hola}\n', 'Uno.\n\n\\pagestyle{fancy}\n\nDos.'));
  assert.equal(fancy.furniture.style, 'plain');
  assert.equal(fancy.furniture.src.head[2], 'Hola');
});
