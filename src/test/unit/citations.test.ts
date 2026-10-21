import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { bibitem, bibtex, citeKey, fetchDoi, normalizeDoi, parseBibtex, sourceLabel, zoteroExport, zoteroPick } from '../../citations';

// respuestas reales de doi.org (Crossref en una línea, DataCite en varias)
const CROSSREF =
  ' @article{LeCun_2015, title={Deep learning}, volume={521}, ISSN={1476-4687}, url={http://dx.doi.org/10.1038/nature14539}, DOI={10.1038/nature14539}, number={7553}, journal={Nature}, publisher={Springer Science and Business Media LLC}, author={LeCun, Yann and Bengio, Yoshua and Hinton, Geoffrey}, year={2015}, month=May, pages={436–444} }\n';
const PROCEEDINGS =
  '@inproceedings{Akiba_2019, series={KDD ’19}, title={Optuna: A Next-generation Hyperparameter Optimization Framework}, booktitle={Proceedings of the 25th ACM SIGKDD International Conference on Knowledge Discovery &amp; Data Mining}, publisher={ACM}, author={Akiba, Takuya and Sano, Shotaro}, year={2019}, month=July, pages={2623–2631} }';
const DATACITE = [
  '@misc{https://doi.org/10.5281/zenodo.3509134,',
  '  doi = {10.5281/ZENODO.3509134},',
  '  author = {The pandas development team, },',
  '  title = {pandas-dev/pandas: Pandas},',
  '  publisher = {Zenodo},',
  '  year = {2026},',
  '  copyright = {BSD 3-Clause "New" or "Revised" License}',
  '}',
].join('\n');

test('lee las entradas BibTeX que devuelven doi.org y Zotero', () => {
  const [e] = parseBibtex(CROSSREF);
  assert.equal(e.type, 'article');
  assert.equal(e.key, 'LeCun_2015');
  assert.equal(e.fields.title, 'Deep learning');
  assert.equal(e.fields.author, 'LeCun, Yann and Bengio, Yoshua and Hinton, Geoffrey');
  assert.equal(e.fields.month, 'May', 'un valor sin llaves');
  assert.equal(e.fields.doi, '10.1038/nature14539', 'los nombres de campo no distinguen mayúsculas');
  const [d] = parseBibtex(DATACITE);
  assert.equal(d.key, 'https://doi.org/10.5281/zenodo.3509134');
  assert.equal(d.fields.copyright, 'BSD 3-Clause "New" or "Revised" License');
  // llaves anidadas, comillas, concatenación y varias entradas seguidas
  const many = parseBibtex('@comment{x}\n@string{k = "v"}\n@book{a1, title = {The {\\TeX}book}, year = 1984,}\n@article{b2,\n  title = "Con {"}comillas{"} y" # " más",\n  note={50\\% {de} {A}}\n}');
  assert.deepEqual(many.map((x) => [x.type, x.key]), [['book', 'a1'], ['article', 'b2']]);
  assert.equal(many[0].fields.title, 'The {\\TeX}book');
  assert.equal(many[0].fields.year, '1984');
  assert.equal(many[1].fields.title, 'Con {"}comillas{"} y más');
  assert.equal(many[1].fields.note, '50\\% {de} {A}');
});

test('clave de cita, etiqueta y \\bibitem equivalente', () => {
  const [e] = parseBibtex(CROSSREF);
  assert.equal(citeKey(e), 'lecun2015');
  assert.equal(sourceLabel(e), 'LeCun, Yann; Bengio, Yoshua; Hinton, Geoffrey. Deep learning. 2015');
  assert.equal(
    bibitem(e, 'lecun2015'),
    '\\bibitem{lecun2015} LeCun, Yann; Bengio, Yoshua; Hinton, Geoffrey. \\textit{Deep learning}. Nature, vol.~521, n.º~7553, pp.~436--444. 2015. doi:10.1038/nature14539.',
  );
  // los caracteres especiales quedan escapados y las entidades HTML resueltas
  assert.match(bibitem(parseBibtex(PROCEEDINGS)[0]), /Knowledge Discovery \\& Data Mining, pp\.~2623--2631\. 2019\.$/);
  const [d] = parseBibtex(DATACITE);
  assert.equal(citeKey(d), 'thepandasdevelopme2026', 'un autor institucional da una clave acotada');
  assert.match(bibitem(d, 'x'), /^\\bibitem\{x\} The pandas development team\. \\textit\{pandas-dev\/pandas: Pandas\}\. Zenodo\. 2026\. doi:10\.5281\/ZENODO\.3509134\.$/);
  // nombre «Nombre Apellido» y acentos escritos en LaTeX
  assert.equal(citeKey({ type: 'book', key: 'k', fields: { author: 'Gabriel Garc{\\\'i}a M{\\\'a}rquez', year: '1967' } }), 'marquez1967');
  assert.equal(citeKey({ type: 'misc', key: 'sin:datos', fields: {} }), 'sin:datos');
  // la entrada se puede volver a escribir con otra clave
  assert.deepEqual(parseBibtex(bibtex(e, 'lecun2015'))[0], { ...e, key: 'lecun2015' });
});

test('reconoce un DOI suelto, con prefijo o dentro de una dirección', () => {
  assert.equal(normalizeDoi('10.1038/nature14539'), '10.1038/nature14539');
  assert.equal(normalizeDoi(' doi:10.1038/nature14539. '), '10.1038/nature14539');
  assert.equal(normalizeDoi('https://doi.org/10.1145/3292500.3330701'), '10.1145/3292500.3330701');
  assert.equal(normalizeDoi('https://dx.doi.org/10.1002%2F(SICI)1097-4571(199009)41%3A6'), '10.1002/(SICI)1097-4571(199009)41:6');
  assert.equal(normalizeDoi('no es un doi'), undefined);
  assert.equal(normalizeDoi('100% seguro'), undefined);
});

/** Servidor simulado: registra las peticiones y responde según la dirección. */
function fake(routes: (url: string, init?: RequestInit) => { status?: number; body: string }): { fetch: typeof fetch; calls: { url: string; init?: RequestInit }[] } {
  const calls: { url: string; init?: RequestInit }[] = [];
  const f = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    const r = routes(url, init);
    return new Response(r.body, { status: r.status ?? 200 });
  }) as typeof fetch;
  return { fetch: f, calls };
}

test('pide a doi.org la referencia en BibTeX', async () => {
  const web = fake((url) => (url.endsWith('nature14539') ? { body: CROSSREF } : { status: 404, body: 'DOI Not Found' }));
  assert.equal(await fetchDoi('10.1038/nature14539', web.fetch), CROSSREF);
  assert.equal(web.calls[0].url, 'https://doi.org/10.1038/nature14539');
  assert.match(String((web.calls[0].init?.headers as Record<string, string>).Accept), /application\/x-bibtex/);
  await assert.rejects(fetchDoi('10.9999/nada', web.fetch), /no existe el DOI 10\.9999\/nada/);
});

test('Zotero (Better BibTeX): selector de citas y exportación de las referencias elegidas', async () => {
  const zotero = fake((url, init) => {
    if (url.includes('probe=true')) return { body: 'ready' };
    if (url.includes('/cayw?')) return { body: '\\cite{knuth1984,lamport1994}' };
    const rpc = JSON.parse(String(init?.body)) as { method: string; params: [string[], string] };
    assert.equal(rpc.method, 'item.export');
    return { body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: rpc.params[0].map((k) => `@book{${k}, title={T de ${k}}}`).join('\n') }) };
  });
  const keys = await zoteroPick('http://127.0.0.1:23119', zotero.fetch);
  assert.deepEqual(keys, ['knuth1984', 'lamport1994']);
  assert.match(zotero.calls[1].url, /\/better-bibtex\/cayw\?format=latex/);
  assert.deepEqual(parseBibtex(await zoteroExport('http://127.0.0.1:23119', keys, zotero.fetch)).map((e) => e.key), keys);
  // el usuario cierra el selector sin elegir nada
  assert.deepEqual(await zoteroPick('http://x', fake((url) => ({ body: url.includes('probe') ? 'ready' : '' })).fetch), []);
  // versiones que devuelven [estado, tipo, texto] y errores del complemento
  const old = fake(() => ({ body: JSON.stringify({ result: [200, 'text/plain', '@misc{a, title={A}}'] }) }));
  assert.equal(await zoteroExport('http://x', ['a'], old.fetch), '@misc{a, title={A}}');
  await assert.rejects(zoteroExport('http://x', ['a'], fake(() => ({ body: JSON.stringify({ error: { message: 'sin acceso' } }) })).fetch), /sin acceso/);
  await assert.rejects(zoteroPick('http://x', fake(() => ({ status: 404, body: 'No endpoint found' })).fetch), /Better BibTeX/);
});
