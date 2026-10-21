import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { changesBetween, diffLines, diffWords } from '../../diff';

test('comparación por líneas: tramos añadidos, cambiados y borrados', () => {
  const a = ['uno', 'dos', 'tres', 'cuatro', 'cinco'];
  assert.deepEqual(diffLines(a, a), []);
  assert.deepEqual(diffLines(a, ['uno', 'dos', 'TRES', 'cuatro', 'cinco']), [{ a0: 2, a1: 3, b0: 2, b1: 3 }]);
  assert.deepEqual(diffLines(a, ['uno', 'nueva', 'dos', 'tres', 'cuatro', 'cinco']), [{ a0: 1, a1: 1, b0: 1, b1: 2 }]);
  assert.deepEqual(diffLines(a, ['uno', 'dos', 'cinco']), [{ a0: 2, a1: 4, b0: 2, b1: 2 }]);
  assert.deepEqual(diffLines([], ['x', 'y']), [{ a0: 0, a1: 0, b0: 0, b1: 2 }]);
  // dos cambios separados no se funden en uno
  assert.deepEqual(diffLines(a, ['UNO', 'dos', 'tres', 'cuatro', 'CINCO', 'seis']), [{ a0: 0, a1: 1, b0: 0, b1: 1 }, { a0: 4, a1: 5, b0: 4, b1: 6 }]);
  // aplicar los tramos a la versión antigua da la nueva
  const b = ['cero', 'uno', 'tres', 'tres y medio', 'cuatro', 'seis'];
  const out: string[] = [];
  let x = 0;
  for (const h of diffLines(a, b)) {
    out.push(...a.slice(x, h.a0), ...b.slice(h.b0, h.b1));
    x = h.a1;
  }
  assert.deepEqual([...out, ...a.slice(x)], b);
});

test('cambios de un documento respecto a otra versión: en líneas del actual y sin contar líneas en blanco', () => {
  const old = '\\section{Uno}\n\nPrimer párrafo.\n\nSegundo párrafo.\n\nTercero.\n';
  const now = '\\section{Uno}\n\nPrimer párrafo, retocado.\n\n\nNuevo párrafo.\n\nTercero.\n';
  assert.deepEqual(changesBetween(old, now), [
    { kind: 'mod', s: 2, n: 1, old: ['Primer párrafo.'] },
    { kind: 'mod', s: 4, n: 2, old: ['Segundo párrafo.'] },
  ]);
  assert.deepEqual(changesBetween(old, old.replace('Segundo párrafo.\n\n', '')), [{ kind: 'del', s: 4, n: 0, old: ['Segundo párrafo.', ''] }]);
  assert.deepEqual(changesBetween(old, `${old}\nCuarto.\n`), [{ kind: 'add', s: 8, n: 2, old: [] }]);
  assert.deepEqual(changesBetween(old, old.replace('\n\nTercero', '\n\n\n\nTercero')), [], 'una línea en blanco de más no es un cambio');
  assert.deepEqual(changesBetween('', 'Todo nuevo.\n'), [{ kind: 'add', s: 0, n: 1, old: [] }]);
});

test('comparación palabra a palabra', () => {
  assert.deepEqual(diffWords('el gato negro duerme', 'el gato blanco duerme mucho'), [[0, 'el gato'], [-1, ' negro'], [1, ' blanco'], [0, ' duerme'], [1, ' mucho']]);
  assert.deepEqual(diffWords('igual', 'igual'), [[0, 'igual']]);
  assert.deepEqual(diffWords('', 'nuevo texto'), [[1, 'nuevo texto']]);
  assert.deepEqual(diffWords('texto viejo', ''), [[-1, 'texto viejo']]);
});
