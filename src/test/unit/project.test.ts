import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { renderLatex } from '../../latex/renderer';
import { decodeText, findRoot, includes, isMain, texPath } from '../../project';
import { TEMPLATES, TEMPLATE_FILES, TEMPLATE_LIST } from '../../templates';

const text = (html: string): string => (new JSDOM(`<div id="c">${html}</div>`).window.document.getElementById('c')?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** Un disco de mentira: rutas absolutas y su contenido. */
function disk(files: Record<string, string>): { read: (f: string) => string | undefined; list: (d: string) => string[]; at: (rel: string) => string } {
  const base = path.resolve('/proyecto');
  const at = (rel: string): string => path.resolve(base, rel);
  const all = new Map(Object.entries(files).map(([rel, content]) => [at(rel).toLowerCase(), { file: at(rel), content }]));
  return {
    at,
    read: (f) => all.get(path.resolve(f).toLowerCase())?.content,
    list: (d) => [...all.values()].filter((x) => path.dirname(x.file).toLowerCase() === path.resolve(d).toLowerCase()).map((x) => path.basename(x.file)),
  };
}

test('documento principal de un capítulo: el que lo incluye, aunque sea a través de otro archivo o desde la carpeta de arriba', () => {
  const d = disk({
    'tesis.tex': '\\documentclass{report}\n\\begin{document}\n\\include{capitulos/uno}\n\\input{capitulos/todos}\n% \\input{capitulos/suelto}\n\\end{document}',
    'otro.tex': '\\documentclass{article}\n\\begin{document}\nNada\n\\end{document}',
    'capitulos/uno.tex': '\\chapter{Uno}',
    'capitulos/todos.tex': '\\input{capitulos/dos}',
    'capitulos/dos.tex': '\\chapter{Dos}',
    'capitulos/suelto.tex': 'Sin dueño',
    'aparte/nota.tex': '% !TEX root = ../tesis.tex\nUna nota',
  });
  assert.ok(isMain('\\documentclass{article}'));
  assert.ok(!isMain('% \\documentclass{article}\nTexto'), 'un \\documentclass comentado no cuenta');
  assert.equal(texPath(d.at('.'), 'capitulos/uno'), d.at('capitulos/uno.tex'));
  assert.ok(includes(d.at('tesis.tex'), d.at('capitulos/dos.tex'), d.read), 'incluido a través de otro archivo');
  assert.equal(findRoot(d.at('capitulos/uno.tex'), d.read, d.list), d.at('tesis.tex'));
  assert.equal(findRoot(d.at('capitulos/dos.tex'), d.read, d.list), d.at('tesis.tex'));
  assert.equal(findRoot(d.at('capitulos/suelto.tex'), d.read, d.list), undefined, 'un \\input comentado no lo incluye');
  assert.equal(findRoot(d.at('aparte/nota.tex'), d.read, d.list), d.at('tesis.tex'), 'el comentario «!TEX root» manda');
});

test('los archivos del proyecto se leen en UTF-8 y, si no lo son, en Latin-1', () => {
  assert.equal(decodeText(Buffer.from('Capítulo de señales', 'utf8')), 'Capítulo de señales');
  assert.equal(decodeText(Buffer.from('Capítulo de señales', 'latin1')), 'Capítulo de señales', 'un documento antiguo no sale con los acentos rotos');
  assert.equal(decodeText(Buffer.from('﻿Con marca', 'utf8')), 'Con marca', 'la marca de orden de bytes no forma parte del texto');
  assert.equal(decodeText(new Uint8Array()), '');
});

test('un capítulo se dibuja con el preámbulo, la numeración, las etiquetas y las citas del documento principal', () => {
  const main = [
    '\\documentclass[12pt]{report}', '\\usepackage[spanish]{babel}', '\\newcommand{\\marca}{Mars}', '\\begin{document}', '',
    '\\include{cap/uno}', '', '\\include{cap/dos}', '', '\\include{cap/tres}', '',
    '\\begin{thebibliography}{9}', '\\bibitem{knuth} Knuth.', '\\bibitem{codd} Codd.', '\\end{thebibliography}', '', '\\end{document}',
  ].join('\n');
  const files: Record<string, string> = {
    'cap/uno': '\\chapter{Primero}\n\nTexto.\\footnote{Nota del primero.}\n\n\\begin{equation}\\label{eq:uno}\n a = b\n\\end{equation}\n\n\\section{Apartado}\\label{sec:uno}\n\nMás.',
    'cap/dos': '\\chapter{Segundo}\n\n\\section{Método}\n\nSegún \\cite{codd}, la ecuación \\ref{eq:uno}, el apartado \\ref{sec:uno} y el \\ref{sec:tres}, con \\marca.\\footnote{Nota del segundo.}\n\n\\begin{equation}\n c = d\n\\end{equation}',
    'cap/tres': '\\chapter{Tercero}\n\n\\section{Final}\\label{sec:tres}\n\nFin.',
  };
  const r = renderLatex(files['cap/dos'], { readInput: (n) => files[n], root: { text: main, isSelf: (p) => p === 'cap/dos' } });
  const blocks = r.blocks.map((b) => text(b.html));
  assert.match(blocks[0], /Capítulo 2/, 'es el segundo capítulo del documento');
  assert.match(blocks[0], /Segundo/);
  assert.match(blocks[1], /^2\.1\.? ?Método/);
  assert.match(blocks[2], /Según \[2\]/, 'la cita lleva el número de la bibliografía del principal');
  assert.match(blocks[2], /la ecuación 1\.1, el apartado 1\.1 y el 3\.1/, 'referencias a etiquetas de otros capítulos, anteriores y posteriores');
  assert.match(blocks[2], /con Mars\./, 'las macros del preámbulo del principal');
  assert.match(blocks[3], /\(2\.1\)/, 'las ecuaciones se numeran dentro de su capítulo');
  assert.equal(blocks.length, 5, 'título, sección, párrafo, ecuación y notas');
  assert.match(blocks[4], /^Nota del segundo\.$/, 'solo las notas al pie de este archivo');
  // las líneas son las del capítulo, no las del principal
  assert.deepEqual(r.blocks.slice(0, 3).map((b) => [b.s, b.e]), [[0, 0], [2, 2], [4, 4]]);
  assert.equal(r.insertLine, files['cap/dos'].split('\n').length);
  assert.equal(r.blocks[0].kind, 'rich', 'y se edita como cualquier documento');
  // sin documento principal se dibuja suelto, como antes
  assert.doesNotMatch(text(renderLatex(files['cap/dos']).blocks[0].html), /2/);
});

test('en el documento principal, los capítulos de otros archivos llevan número y una etiqueta para abrirlos', () => {
  const main = '\\documentclass{report}\n\\begin{document}\n\n\\include{cap/uno}\n\n\\include{cap/dos}\n\n\\end{document}';
  const files: Record<string, string> = { 'cap/uno': '\\chapter{Primero}\n\n\\section{A}', 'cap/dos': '\\chapter{Segundo}\n\n\\section{B}' };
  const r = renderLatex(main, { readInput: (n) => files[n] });
  const included = r.blocks.filter((b) => b.html.includes('class="included"'));
  assert.equal(included.length, 2);
  assert.match(included[1].html, /class="inc-bar" data-file="cap\/dos"/);
  assert.match(text(included[1].html), /cap\/dos\.tex.*2\.1\.? ?B/, 'con \\chapter solo en los archivos incluidos, las secciones llevan el número del capítulo');
  assert.equal(included[1].kind, 'atom');
});

test('plantillas de documento nuevo: todas tienen nombre y la tesis trae sus capítulos', () => {
  assert.deepEqual(TEMPLATE_LIST.map((t) => t.id).sort(), Object.keys(TEMPLATES).sort());
  const thesis = TEMPLATES.thesis;
  const chapters = [...thesis.matchAll(/\\include\{([^}]*)\}/g)].map((m) => m[1]);
  assert.equal(chapters.length, 5);
  for (const c of chapters) assert.ok(TEMPLATE_FILES.thesis[`${c}.tex`], `falta ${c}.tex`);
  assert.ok(TEMPLATE_FILES.thesis['referencias.bib']);
  // la tesis completa se dibuja, con sus capítulos numerados y la cita resuelta
  const read = (n: string): string | undefined => TEMPLATE_FILES.thesis[`${n}.tex`];
  const r = renderLatex(thesis, { readInput: read, readBib: () => TEMPLATE_FILES.thesis['referencias.bib'] });
  const all = r.blocks.map((b) => text(b.html)).join('\n');
  assert.doesNotMatch(r.blocks.map((b) => b.html).join(''), /tex-error|tex-unknown/);
  assert.match(all, /Capítulo 5/);
  assert.match(all, /las fuentes \[1\]/);
  assert.match(all, /Knuth/);
});
