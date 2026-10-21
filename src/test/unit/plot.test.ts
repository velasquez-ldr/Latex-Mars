import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { plotPoints, plotPreview, plotTex } from '../../webview/plot';

const form = (v: Partial<Record<string, string>>): Record<string, string> => ({ kind: 'line', title: '', x: '', y: '', data: '', caption: '', ...v });

test('gráficas: puntos con coma decimal, punto y coma o tabulador', () => {
  assert.deepEqual(plotPoints('1 2\n2,5; 3\n4\t8\nsolo'), [['1', '2'], ['2.5', '3'], ['4', '8']]);
});

test('gráficas: código pgfplots con título, ejes y pie, y el texto escapado', () => {
  const tex = plotTex(form({ kind: 'bar', title: 'Ventas 50%', data: '1 2\n2 4', caption: 'Pie' })) ?? '';
  assert.match(tex, /title=\{Ventas 50\\%\}/);
  assert.match(tex, /ybar/);
  assert.match(tex, /\(1,2\) \(2,4\)/);
  assert.match(tex, /\\caption\{Pie\}\n\\end\{figure\}$/);
  assert.equal(plotTex(form({ data: '' })), undefined);
  assert.match(plotTex(form({ kind: 'func', data: 'y = x^2' })) ?? '', /\{x\^2\}/);
});

test('gráficas: el boceto escapa el título y avisa sin datos', () => {
  assert.match(plotPreview(form({ data: '' })), /plot-empty/);
  const svg = plotPreview(form({ title: '<b>x</b>', data: '1 2\n2 3' }));
  assert.ok(!svg.includes('<b>'));
  assert.match(svg, /&#60;b&#62;x/);
});
