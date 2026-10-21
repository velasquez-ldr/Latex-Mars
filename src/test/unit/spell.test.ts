import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { Spell, spellLangs } from '../../spell';
import { flatten, rangeOf, wordsIn } from '../../webview/spell';

const body = (html: string): HTMLElement => new JSDOM(`<body>${html}</body>`).window.document.body;
const words = (text: string): string[] => wordsIn(text).map((w) => w.word);

test('palabras que se comprueban: ni siglas, ni unidades, ni direcciones', () => {
  assert.deepEqual(words('Una canción, ¿qué tal? Niño y pingüino.'), ['Una', 'canción', 'qué', 'tal', 'Niño', 'pingüino']);
  assert.deepEqual(words('El PDF de LaTeX pesa 20kg y mide 3m; ver x_i'), ['El', 'de', 'pesa', 'mide', 'ver']);
  assert.deepEqual(words('Escribe a ana@correo.es o visita https://ejemplo.org/pagina y www.otra.com hoy'), ['Escribe', 'visita', 'hoy']);
  assert.deepEqual(words("It doesn't matter"), ['It', "doesn't", 'matter']);
  assert.deepEqual(words('físico-químico'), ['físico', 'químico']);
});

test('el texto corrido deja fuera fórmulas, código y adornos, y une las palabras partidas', () => {
  const b = body(
    '<h2 data-k="head"><span class="secnum" data-skip="">1</span>Intro<b>duc</b>ción</h2>' +
      '<div>Sea <span class="atom" data-tex="$x$">equis</span>el valor de <code>codigo</code> y pala<span class="pg-split" data-skip=""></span>bra final.</div>' +
      '<ol class="bib"><li>Knuth</li></ol>',
  );
  const { text, segs } = flatten(b);
  assert.deepEqual(words(text), ['Introducción', 'Sea', 'el', 'valor', 'de', 'palabra', 'final']);
  // cada palabra vuelve a su sitio en el DOM aunque ocupe varios nodos
  for (const w of wordsIn(text)) assert.equal(rangeOf(segs, w.start, w.end).toString(), w.word);
});

test('idiomas del corrector: el ajuste manda; en automático, babel y luego el idioma de VS Code', () => {
  assert.deepEqual(spellLangs('auto', 'spanish', 'en'), ['es']);
  assert.deepEqual(spellLangs('auto', 'english', 'es'), ['en']);
  assert.deepEqual(spellLangs('auto', 'french', 'es'), [], 'un idioma sin diccionario no se corrige');
  // las variantes regionales usan el diccionario de su idioma
  for (const variant of ['british', 'american', 'USenglish', 'UKenglish', 'australian']) assert.deepEqual(spellLangs('auto', variant, 'es'), ['en'], variant);
  assert.deepEqual(spellLangs('auto', 'mexican', 'en'), ['es']);
  assert.deepEqual(spellLangs('auto', undefined, 'es-ES'), ['es']);
  assert.deepEqual(spellLangs('auto', undefined, 'de'), ['en']);
  assert.deepEqual(spellLangs('es+en', 'french', 'de'), ['es', 'en']);
  assert.deepEqual(spellLangs('en', 'spanish', 'es'), ['en']);
});

const saved: string[][] = [];
const spell = new Spell(path.resolve(__dirname, '..', '..', '..'), ['marsianito'], (w) => saved.push(w));
after(() => spell.dispose());

test('diccionario español: reconoce formas conjugadas y acentos, y propone correcciones', async () => {
  assert.ok(spell.has('es') && spell.has('en'), 'los diccionarios están instalados');
  const bad = await spell.check(['es'], ['palabra', 'canción', 'escribiríamos', 'niños', 'palabrra', 'cancion', 'house', 'LaTeX', 'marsianito']);
  assert.deepEqual(bad, ['palabrra', 'cancion', 'house']);
  assert.ok((await spell.suggest(['es'], 'palabrra')).includes('palabra'));
  assert.ok((await spell.suggest(['es'], 'cancion')).includes('canción'));
});

test('varios idiomas a la vez y diccionario personal', async () => {
  assert.deepEqual(await spell.check(['es', 'en'], ['house', 'casa', 'hoouse']), ['hoouse']);
  assert.deepEqual(await spell.check(['en'], ['house', 'casa']), ['casa']);
  assert.deepEqual(await spell.check(['es'], ['Zotero', 'tikzpicturo']), ['tikzpicturo']);
  spell.add('tikzpicturo');
  assert.deepEqual(await spell.check(['es'], ['tikzpicturo', 'Tikzpicturo']), [], 'la palabra añadida vale también con mayúscula inicial');
  assert.deepEqual(saved.at(-1), ['marsianito', 'tikzpicturo'], 'y se guarda para la próxima sesión');
  assert.deepEqual(await spell.check(['fr'], ['palabrra']), [], 'sin diccionario no se marca nada');
});
