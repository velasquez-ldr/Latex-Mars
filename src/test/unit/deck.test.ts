import * as assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { renderLatex } from '../../latex/renderer';
import { citesIn, removeCite } from '../../webview/cites';
import { type DeckSection, DECK_DEFAULTS, blockKind, buildSlides, keySentence } from '../../webview/deck';

test('quitar una cita concreta: la orden entera o solo su clave', () => {
  const src = 'Según \\cite{knuth} y luego~\\citep[p. 3]{knuth, lamport}. Otra vez \\cite{knuth}.';
  assert.equal(removeCite(src, 'knuth', 0), 'Según y luego~\\citep[p. 3]{knuth, lamport}. Otra vez \\cite{knuth}.');
  assert.equal(removeCite(src, 'knuth', 1), 'Según \\cite{knuth} y luego~\\citep[p. 3]{lamport}. Otra vez \\cite{knuth}.');
  assert.equal(removeCite(src, 'knuth', 2), 'Según \\cite{knuth} y luego~\\citep[p. 3]{knuth, lamport}. Otra vez.');
  assert.equal(removeCite(src, 'knuth', 3), undefined, 'no hay cuarta cita');
  assert.equal(removeCite('\\cite{a,b} empieza', 'b', 0), '\\cite{a} empieza', 'sin espacio tras la coma, como estaba');
  assert.equal(removeCite('\\cite{a} empieza la línea', 'a', 0), 'empieza la línea');
});

test('las citas comentadas no cuentan', () => {
  const src = 'Texto \\cite{a} % antes \\cite{a}\nY \\cite{a}. Un 50\\% \\cite{a}';
  assert.equal(citesIn(src).length, 3);
  assert.equal(removeCite(src, 'a', 1), 'Texto \\cite{a} % antes \\cite{a}\nY. Un 50\\% \\cite{a}');
});

/** El documento dibujado como en la vista: cada bloque, un div con su contenido dentro. */
function view(tex: string): { doc: Document; contents: HTMLElement[] } {
  const doc = new JSDOM('<body></body>').window.document;
  const contents = renderLatex(tex, {}).blocks.map((b) => {
    const el = doc.createElement('div');
    el.className = 'block';
    el.innerHTML = `<div class="content">${b.html}</div>`;
    doc.body.appendChild(el);
    return el.lastElementChild as HTMLElement;
  });
  return { doc, contents };
}

/** Apartados como los arma el panel: lo que va entre un título y el siguiente. */
function sections(contents: HTMLElement[]): DeckSection[] {
  const out: DeckSection[] = [];
  for (const c of contents) {
    const head = c.querySelector<HTMLElement>(':scope > [data-k="head"]');
    if (!head) {
      out[out.length - 1]?.blocks.push(c);
      continue;
    }
    const num = head.querySelector('.secnum')?.textContent ?? '';
    const title = (head.textContent ?? '').slice(num.length).trim();
    out.push({ key: `${num}|${title}`, num, title, level: { section: 0, subsection: 1 }[head.dataset.level ?? ''] ?? 2, blocks: [] });
  }
  return out;
}

const TESIS = String.raw`\documentclass{article}
\title{Mi tesis}\author{Ana Pérez}\date{2026}
\begin{document}
\maketitle
\section{Introducción}
Este es el primer párrafo de la introducción, con una idea principal bastante clara. Y aquí viene una segunda frase que no debería salir.

Segundo párrafo corto.

\begin{itemize}
\item uno
\item dos
\end{itemize}

\begin{figure}[h]
\centering
\includegraphics[width=0.5\textwidth]{img.png}
\caption{Una figura}
\end{figure}

\subsection{Datos}
\begin{table}[h]
\centering
\caption{Datos}
\begin{tabular}{cc} a & b \\ 1 & 2 \end{tabular}
\end{table}

\begin{equation}
E = mc^2
\end{equation}

\section{Conclusiones}
Todo salió bien.
\end{document}`;

test('cada bloque se reconoce: título, texto, lista, figura, tabla, ecuación', () => {
  const { contents } = view(TESIS);
  const kinds = contents.map(blockKind);
  assert.deepEqual(kinds, ['skip', 'skip', 'head', 'text', 'text', 'list', 'figure', 'head', 'table', 'math', 'head', 'text']);
});

test('la idea clave de un párrafo es su primera frase', () => {
  const { doc } = view('');
  const box = doc.createElement('div');
  box.innerHTML = 'Este es el primer párrafo, con una idea <b>principal</b> clara. Segunda frase. Tercera.';
  assert.equal(keySentence(box).innerHTML, 'Este es el primer párrafo, con una idea <b>principal</b> clara.');
  box.innerHTML = 'Corto. Pero sigue la frase hasta pasar el mínimo de letras. Y otra.';
  assert.equal(keySentence(box).textContent, 'Corto. Pero sigue la frase hasta pasar el mínimo de letras.', 'una frase muy corta no basta');
  box.innerHTML = 'palabra '.repeat(60).trim();
  const cut = keySentence(box).textContent ?? '';
  assert.ok(cut.endsWith('…') && cut.length <= 222, cut);
});

test('presentación automática: portada, índice, viñetas, figura, tabla, ecuación y cierre', () => {
  const { contents } = view(TESIS);
  const cover = contents[1].querySelector<HTMLElement>('div.titleblock[data-role="title"]') ?? undefined;
  const slides = buildSlides(sections(contents), DECK_DEFAULTS, cover);
  const summary = slides.map((x) => `${x.kind}:${x.title}${x.points.length ? `:${x.points.length}` : ''}${x.media ? ':media' : ''}`);
  assert.deepEqual(summary, [
    'cover:Mi tesis',
    'agenda:Contenido',
    'part:Introducción',
    'content:Introducción:4',
    'media:Introducción (cont.):media',
    'media:Datos:media',
    'content:Datos (cont.):1',
    'content:Conclusiones:1',
    'end:¡Gracias!',
  ]);
  const intro = slides[3];
  assert.match(intro.points[0], /idea principal bastante clara\.$/, 'solo la primera frase');
  assert.deepEqual(intro.points.slice(1), ['Segundo párrafo corto.', 'uno', 'dos']);
  assert.ok(!/contenteditable|id="/.test(slides.map((x) => (x.media ?? '') + x.points.join('')).join('')), 'sin edición ni identificadores repetidos');
  assert.match(slides[slides.length - 1].html ?? '', /Ana Pérez/, 'el cierre lleva el autor');
});

test('solo lo elegido: sin portada, sin texto, sin figuras', () => {
  const { contents } = view(TESIS);
  const picked = sections(contents).filter((s) => s.title !== 'Conclusiones');
  const slides = buildSlides(picked, { ...DECK_DEFAULTS, cover: false, agenda: false, closing: false, text: 'none', figures: false });
  assert.deepEqual(
    slides.map((x) => `${x.kind}:${x.title}${x.points.length ? `:${x.points.length}` : ''}${x.media ? ':media' : ''}`),
    ['part:Introducción', 'content:Introducción:2', 'media:Datos:media', 'content:Datos (cont.):1'],
  );
});

test('con pocas viñetas la figura va al lado, en la misma diapositiva', () => {
  const { contents } = view(String.raw`\documentclass{article}
egin{document}
\section{Resultados}
El modelo acierta en casi todos los casos que se probaron durante el estudio.

egin{figure}[h]
\includegraphics{grafica.png}
\caption{Aciertos}
\end{figure}
\end{document}`);
  const slides = buildSlides(sections(contents), { ...DECK_DEFAULTS, cover: false, agenda: false, closing: false });
  assert.deepEqual(slides.map((x) => `${x.kind}:${x.title}:${x.points.length}:${x.media ? 'media' : ''}`), ['content:Resultados:1:media']);
  assert.match(slides[0].media ?? '', /Aciertos/);
});

test('portada y cierre con textos propios; lo que no se cambia sigue al documento', () => {
  const { contents } = view(TESIS);
  const cover = contents[1].querySelector<HTMLElement>('div.titleblock[data-role="title"]') ?? undefined;
  const o = { ...DECK_DEFAULTS, agenda: false, end: { title: 'Muchas gracias', subtitle: '', contact: 'ana@finca.org' } };
  const slides = buildSlides(sections(contents), o, cover, { subtitle: 'Defensa de tesis', date: '12 de noviembre de 2026' });
  const first = slides[0];
  const last = slides[slides.length - 1];
  assert.equal(first.title, 'Mi tesis', 'el título sigue siendo el del documento');
  assert.match(first.html ?? '', /<div class="docsub">Defensa de tesis<\/div>/);
  assert.match(first.html ?? '', /Ana Pérez/, 'el autor, el del documento');
  assert.match(first.html ?? '', /12 de noviembre de 2026/);
  assert.doesNotMatch(first.html ?? '', />2026</, 'la fecha propia sustituye a la del documento');
  assert.equal(last.title, 'Muchas gracias');
  assert.equal(last.html, '<div class="end-who">ana@finca.org</div>', 'sin subtítulo, con el contacto');
  // un autor vacío en la portada la deja sin autor
  const bare = buildSlides(sections(contents), DECK_DEFAULTS, cover, { author: '' });
  assert.doesNotMatch(bare[0].html ?? '', /Ana Pérez/);
  assert.match(bare[bare.length - 1].html ?? '', /¿Preguntas\?/);
});
