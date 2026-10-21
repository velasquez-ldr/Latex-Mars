import * as fs from 'fs';
import { parentPort, workerData } from 'worker_threads';
import nspell = require('nspell');
import { derivedSpanish } from './spanish';

/*
 * Hilo aparte para el corrector ortográfico: cargar un diccionario Hunspell tarda alrededor de un
 * segundo y ocupa decenas de megas, y no debe frenar a la extensión mientras tanto.
 */

interface Request {
  id?: number;
  op: 'check' | 'suggest' | 'add';
  langs?: string[];
  words?: string[];
  word?: string;
}

type Dictionary = ReturnType<typeof nspell>;

const data = workerData as { dicts: Record<string, { aff: string; dic: string }>; words: string[] };
const loaded = new Map<string, Dictionary | null>();

/** Términos habituales en un documento LaTeX que ningún diccionario general trae. */
const BUILTIN = [
  'LaTeX', 'TeX', 'BibTeX', 'BibLaTeX', 'TikZ', 'KaTeX', 'XeLaTeX', 'LuaLaTeX', 'pdfLaTeX', 'Overleaf', 'Zotero',
  'Mars', 'PDF', 'DOI', 'URL', 'ISBN', 'ISSN', 'arXiv', 'Hunspell', 'preámbulo', 'tabulación', 'píxel', 'píxeles',
  // vocabulario académico y de informática frecuente que el diccionario general no trae
  'heurístico', 'heurística', 'heurísticos', 'heurísticas', 'predictor', 'predictores', 'predictora', 'predictivo', 'predictiva', 'predictivos', 'predictivas',
  'software', 'hardware', 'booleano', 'booleana', 'booleanos', 'booleanas', 'algoritmia', 'backend', 'frontend', 'framework', 'frameworks', 'token', 'tokens',
  'script', 'scripts', 'bit', 'bits', 'byte', 'bytes', 'pixelado', 'web', 'online', 'offline', 'email', 'bibliometría', 'metadato', 'metadatos',
  'cuantil', 'cuantiles', 'percentil', 'percentiles', 'covarianza', 'covarianzas', 'estocástico', 'estocástica', 'estocásticos', 'estocásticas',
];
const personal = new Set<string>();
const learn = (word: string): void => {
  personal.add(word);
  personal.add(word.toLowerCase());
};
[...BUILTIN, ...data.words].forEach(learn);

function dictionary(lang: string): Dictionary | null {
  let d = loaded.get(lang);
  if (d === undefined) {
    const files = data.dicts[lang];
    try {
      d = files ? nspell(fs.readFileSync(files.aff), fs.readFileSync(files.dic)) : null;
    } catch {
      d = null;
    }
    loaded.set(lang, d);
  }
  return d;
}

const plain = (word: string): string => word.replace(/’/g, "'");

/** Una palabra vale si la reconoce cualquiera de los idiomas activos o está en el diccionario personal. */
function correct(word: string, langs: string[]): boolean {
  const w = plain(word);
  if (personal.has(w) || personal.has(w.toLowerCase())) return true;
  const dicts = langs.map(dictionary).filter((d): d is Dictionary => d !== null);
  if (dicts.length === 0 || dicts.some((d) => d.correct(w))) return true;
  const es = langs.includes('es') ? dictionary('es') : null;
  return es !== null && derivedSpanish(w, (x) => es.correct(x));
}

function suggest(word: string, langs: string[]): string[] {
  const out: string[] = [];
  for (const lang of langs) {
    for (const s of dictionary(lang)?.suggest(plain(word)) ?? []) if (!out.includes(s)) out.push(s);
  }
  return out.slice(0, 7);
}

parentPort?.on('message', (m: Request) => {
  if (m.op === 'add') {
    (m.words ?? []).forEach(learn);
    return;
  }
  const langs = m.langs ?? [];
  if (m.op === 'check') parentPort?.postMessage({ id: m.id, bad: (m.words ?? []).filter((w) => !correct(w, langs)) });
  else parentPort?.postMessage({ id: m.id, list: suggest(m.word ?? '', langs) });
});
