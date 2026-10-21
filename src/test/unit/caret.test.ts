import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { offsetOf, pointAt, units, wrapRange } from '../../webview/caret';
import { serializeBlock } from '../../webview/serialize';

function dom(html: string): { doc: Document; body: HTMLElement } {
  const doc = new JSDOM(`<body>${html}</body>`).window.document;
  return { doc, body: doc.body };
}

/** Rango entre dos posiciones (en unidades) del contenido. */
function span(body: HTMLElement, from: number, to: number): Range {
  const r = body.ownerDocument.createRange();
  const a = pointAt(body, from);
  const b = pointAt(body, to);
  r.setStart(a.node, a.offset);
  r.setEnd(b.node, b.offset);
  return r;
}

test('las posiciones en unidades van y vuelven: una fórmula cuenta uno y los adornos, cero', () => {
  const { body } = dom('<span data-skip="">1.2</span>Sea <span data-tex="$x$">x</span> un <b>valor</b> real');
  assert.equal(units(body), 'Sea '.length + 1 + ' un valor real'.length);
  for (const off of [0, 2, 4, 5, 9, 14, units(body)]) {
    const p = pointAt(body, off);
    assert.equal(offsetOf(body, p.node, p.offset), off, `posición ${off}`);
  }
  // pasarse de largo lleva al final
  const end = pointAt(body, Number.MAX_SAFE_INTEGER);
  assert.equal(offsetOf(body, end.node, end.offset), units(body));
});

test('envolver un rango da formato a su texto sin tocar fórmulas ni partir la estructura', () => {
  const { doc, body } = dom('Uno dos <i>tres</i> y <span data-tex="$x$" class="atom">x</span> cuatro cinco');
  wrapRange(span(body, 4, 23), () => doc.createElement('b'));
  assert.equal(serializeBlock(body), 'Uno \\textbf{dos }\\textit{\\textbf{tres}}\\textbf{ y }$x$\\textbf{ cuatro} cinco');
  assert.equal(units(body), 'Uno dos tres y '.length + 1 + ' cuatro cinco'.length, 'el formato no cambia las posiciones');

  // tras un comentario, el comando se abre en la línea siguiente: en la del comentario quedaría anulado
  const note = dom('uno <span class="atom" data-tex="% nota">% nota</span>\ndos <strong data-o="\\textbf{" data-c="}">ya</strong> tres\n');
  wrapRange(span(note.body, 0, Number.MAX_SAFE_INTEGER), () => note.doc.createElement('b'), 'b, strong');
  assert.equal(serializeBlock(note.body), '\\textbf{uno }% nota\n\\textbf{dos }\\textbf{ya}\\textbf{ tres}', 'y lo que ya estaba en negrita no se envuelve otra vez');

  // dentro de un solo nodo de texto
  const one = dom('abcdef');
  wrapRange(span(one.body, 2, 4), () => one.doc.createElement('u'));
  assert.equal(serializeBlock(one.body), 'ab\\underline{cd}ef');

  // a través de los elementos de una lista: cada uno conserva su sitio
  const list = dom('<ul><li>primero largo</li><li>segundo</li><li>tercero largo</li></ul>');
  wrapRange(span(list.body, 8, 'primero largosegundotercero'.length), () => {
    const w = list.doc.createElement('span');
    w.setAttribute('data-o', '\\textsc{');
    w.setAttribute('data-c', '}');
    return w;
  });
  assert.equal(
    serializeBlock(list.body),
    '\\begin{itemize}\n  \\item primero \\textsc{largo}\n  \\item \\textsc{segundo}\n  \\item \\textsc{tercero} largo\n\\end{itemize}',
  );
});
