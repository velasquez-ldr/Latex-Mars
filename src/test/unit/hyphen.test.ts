import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { derivedSpanish } from '../../spanish';
import { canHyphenate, dropHyphensAt, hyphenate, spanishBreaks, unhyphenate } from '../../webview/hyphen';
import { offsetOf, units } from '../../webview/caret';
import { serializeBlock } from '../../webview/serialize';
import { flatten, wordsIn } from '../../webview/spell';

/** La palabra con un guion en cada punto por el que puede partirse. */
const split = (word: string): string => {
  const cuts = spanishBreaks(word);
  return [...word].map((ch, i) => (cuts.includes(i) ? '-' : '') + ch).join('');
};

test('división silábica del español: una consonante va con la vocal siguiente y los grupos no se rompen', () => {
  assert.equal(split('independencia'), 'in-de-pen-den-cia');
  assert.equal(split('sistema'), 'sis-te-ma');
  assert.equal(split('equivalencia'), 'equi-va-len-cia', 'no queda una letra sola al principio');
  assert.equal(split('estadísticamente'), 'es-ta-dís-ti-ca-men-te');
  assert.equal(split('problema'), 'pro-ble-ma');
  assert.equal(split('instrucción'), 'ins-truc-ción');
  assert.equal(split('perspectiva'), 'pers-pec-ti-va');
  assert.equal(split('coche'), 'co-che');
  assert.equal(split('perro'), 'pe-rro');
  assert.equal(split('calle'), 'ca-lle');
  assert.equal(split('deshacer'), 'des-ha-cer');
  assert.equal(split('lingüística'), 'lin-güís-ti-ca');
  // las vocales seguidas nunca se separan, formen diptongo o hiato
  assert.equal(split('había'), 'ha-bía');
  assert.equal(split('teatro'), 'tea-tro');
  // prefijos que no siguen la regla general
  assert.equal(split('subrayar'), 'sub-ra-yar');
  // mayúsculas y palabras sin vocales
  assert.equal(split('UNIVERSIDAD'), 'UNI-VER-SI-DAD');
  assert.equal(split('SQL'), 'SQL');
  assert.ok(canHyphenate('spanish') && canHyphenate('english') && !canHyphenate('klingon'));
});

test('las marcas de división no alteran el texto: ni el cursor, ni el LaTeX, ni el corrector las ven', () => {
  const win = new JSDOM('<body><div id="c">Una <b>independencia</b> relativa del sistema <code>independencia</code> <h2 data-k="head">Introducción general</h2> final</div></body>').window;
  // hyphenate usa los globales del navegador (jsdom no hereda los estilos: se le dice la alineación)
  let align = 'center';
  Object.assign(globalThis, { document: win.document, getComputedStyle: () => ({ textAlign: align }) });
  const c = win.document.getElementById('c') as unknown as HTMLElement;
  const before = { tex: serializeBlock(c), text: c.textContent, units: units(c), words: wordsIn(flatten(c).text).map((w) => w.word) };
  hyphenate(c, 'spanish');
  assert.equal(c.querySelectorAll('.shy').length, 0, 'el texto centrado no se parte');
  align = 'justify';
  hyphenate(c, 'spanish');
  const marks = c.querySelectorAll('.shy').length;
  assert.equal(marks, 4 + 3 + 2, 'independencia, relativa y sistema; ni el código, ni el título, ni la última palabra');
  assert.equal(c.querySelector('code')?.childNodes.length, 1);
  assert.equal(c.querySelector('h2')?.childNodes.length, 1);
  assert.deepEqual({ tex: serializeBlock(c), text: c.textContent, units: units(c), words: wordsIn(flatten(c).text).map((w) => w.word) }, before);
  // una posición en mitad de una palabra partida sigue contando igual
  const bold = c.querySelector('b') as HTMLElement;
  const third = bold.childNodes[4];
  assert.equal(third.textContent, 'pen');
  assert.equal(offsetOf(c, third, 1), 'Una '.length + 'indep'.length);
  // al escribir dentro de una palabra se quitan sus marcas, pero no las de las demás
  dropHyphensAt(third);
  assert.equal(bold.querySelectorAll('.shy').length, 0);
  assert.equal(c.querySelectorAll('.shy').length, marks - 4);
  // y sin marcas el contenido vuelve a ser el de antes, con el texto unido
  unhyphenate(c);
  assert.equal(c.querySelectorAll('.shy').length, 0);
  assert.equal(bold.childNodes.length, 1);
  assert.equal(serializeBlock(c), before.tex);
  // en un idioma sin reglas no se marca nada
  hyphenate(c, 'klingon');
  assert.equal(c.querySelectorAll('.shy').length, 0);
});

test('corrector: palabras que el español forma con reglas regulares a partir de otras conocidas', () => {
  const dict = new Set(['optimizar', 'sintáctica', 'cardinal', 'consulta', 'escritura', 'relacionar', 'nación', 'semántica', 'medir', 'estimar', 'plan']);
  const known = (w: string): boolean => dict.has(w);
  for (const w of ['optimizador', 'optimizadores', 'sintácticamente', 'subconsulta', 'reescritura', 'correlacionar', 'medible', 'estimación', 'Optimizador']) {
    assert.ok(derivedSpanish(w, known), w);
  }
  // sin una base conocida, o con una terminación que no es regular, sigue siendo un error
  for (const w of ['optimizadro', 'xyzmente', 'subxyzw', 'planes', 'consulto']) assert.ok(!derivedSpanish(w, known), w);
});

test('otros idiomas se dividen con los patrones de TeX, con los mínimos de babel a cada lado', () => {
  const win = new JSDOM('<body><div id="c">An internationalization of characteristics today.</div><div id="f">Le développement constitutionnel français avance.</div><div id="g">Die Donaudampfschifffahrt beginnt heute.</div></body>').window;
  Object.assign(globalThis, { document: win.document, getComputedStyle: () => ({ textAlign: 'justify' }) });
  const cuts = (id: string, lang: string): string => {
    const el = win.document.getElementById(id) as unknown as HTMLElement;
    hyphenate(el, lang);
    return Array.from(el.childNodes).map((n) => (n.nodeType === 3 ? n.textContent : '-')).join('');
  };
  assert.equal(cuts('c', 'english'), 'An in-ter-na-tion-al-iza-tion of char-ac-ter-is-tics today.', 'ni «a-» ni «-cs»: quedan 2 letras delante y 3 detrás');
  assert.equal(cuts('f', 'french'), 'Le dé-ve-lop-pe-ment consti-tu-tion-nel fran-çais avance.');
  assert.equal(cuts('g', 'german'), 'Die Do-nau-dampf-schiff-fahrt be-ginnt heute.');
});
