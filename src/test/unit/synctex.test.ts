import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { forward, inverse, parseSyncTex } from '../../synctex';

const dir = path.resolve('/proyecto');
/** 65781,76 «puntos escalados» de TeX hacen un punto del PDF. */
const sp = (pt: number): number => Math.round(pt * 65781.76);
const box = (kind: string, file: number, line: number, x: number, y: number, w: number, h: number, d: number): string => `${kind}${file},${line}:${sp(x)},${sp(y)}:${sp(w)},${sp(h)},${sp(d)}`;
const mark = (kind: string, file: number, line: number, x: number, y: number): string => `${kind}${file},${line}:${sp(x)},${sp(y)}`;

const SYNC = [
  'SyncTeX Version:1',
  'Input:1:./tesis.tex',
  'Input:2:capitulos/uno.tex',
  'Output:pdf',
  'Magnification:1000',
  'Unit:1',
  'X Offset:0',
  'Y Offset:0',
  'Content:',
  '!100',
  '{1',
  box('[', 1, 5, 72, 720, 451, 648, 0),
  // el título (línea 5 del principal) y dos líneas de un párrafo que viene de la línea 9
  box('(', 1, 5, 72, 100, 451, 14, 4),
  mark('x', 1, 5, 80, 100),
  ')',
  box('(', 1, 9, 72, 140, 451, 8, 2),
  mark('x', 1, 9, 72, 140),
  mark('g', 1, 9, 200, 140),
  // (a mitad de línea empieza texto de la línea 10 del código)
  mark('x', 1, 10, 300, 140),
  ')',
  box('(', 1, 10, 72, 152, 451, 8, 2),
  mark('x', 1, 10, 72, 152),
  ')',
  ']',
  '}1',
  '{2',
  box('(', 2, 3, 72, 90, 451, 8, 2),
  mark('x', 2, 3, 72, 90),
  ')',
  '}2',
  'Postamble:',
].join('\n');

test('SyncTeX: se leen los archivos y las cajas, en puntos del PDF', () => {
  const s = parseSyncTex(SYNC, dir);
  assert.equal(s.files.get(1), path.join(dir, 'tesis.tex'));
  assert.equal(s.files.get(2), path.join(dir, 'capitulos', 'uno.tex'));
  const title = s.records.find((r) => r.kind === '(' && r.line === 5);
  assert.ok(title);
  assert.deepEqual([title.page, Math.round(title.x), Math.round(title.y), Math.round(title.width), Math.round(title.height)], [1, 72, 100, 451, 14]);
  assert.equal(s.records.filter((r) => r.page === 2).length, 2);
  // con otra unidad y aumento, las medidas se escalan
  const scaled = parseSyncTex(SYNC.replace('Unit:1', 'Unit:2').replace('Magnification:1000', 'Magnification:2000'), dir);
  assert.equal(Math.round(scaled.records.find((r) => r.kind === '(' && r.line === 5)?.x ?? 0), 288);
});

test('SyncTeX: del código al PDF (línea → página y posición)', () => {
  const s = parseSyncTex(SYNC, dir);
  const main = path.join(dir, 'tesis.tex');
  const p = forward(s, main, 9);
  assert.ok(p);
  assert.deepEqual([p.page, Math.round(p.x), Math.round(p.y), Math.round(p.height)], [1, 72, 132, 10], 'el párrafo: arriba de su primera línea');
  // una línea que no dibuja nada (en blanco, una orden) lleva a la siguiente que sí
  assert.equal(Math.round(forward(s, main, 7)?.y ?? 0), 132);
  // después de la última, a la última (que empieza a mitad de la primera línea del párrafo)
  assert.equal(Math.round(forward(s, main, 99)?.y ?? 0), 132);
  assert.equal(Math.round(forward(s, main, 10)?.y ?? 0), 132);
  // otro archivo del proyecto, en su página
  assert.equal(forward(s, path.join(dir, 'capitulos', 'uno.tex'), 3)?.page, 2);
  assert.equal(forward(s, path.join(dir, 'no-esta.tex'), 1), undefined);
});

test('SyncTeX: del PDF al código (punto → archivo y línea)', () => {
  const s = parseSyncTex(SYNC, dir);
  const main = path.join(dir, 'tesis.tex');
  assert.deepEqual(inverse(s, 1, 100, 95), { file: main, line: 5 }, 'sobre el título');
  assert.deepEqual(inverse(s, 1, 90, 138), { file: main, line: 9 }, 'principio de la línea del párrafo');
  assert.deepEqual(inverse(s, 1, 320, 138), { file: main, line: 10 }, 'la misma línea del PDF, más a la derecha: ya es la línea siguiente del código');
  assert.deepEqual(inverse(s, 1, 100, 150), { file: main, line: 10 });
  assert.deepEqual(inverse(s, 1, 100, 400), { file: main, line: 10 }, 'en un hueco, la línea más cercana');
  assert.deepEqual(inverse(s, 2, 80, 88), { file: path.join(dir, 'capitulos', 'uno.tex'), line: 3 });
  assert.equal(inverse(s, 7, 10, 10), undefined, 'una página que no existe');
});
