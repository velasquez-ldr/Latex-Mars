/** Historial de un documento en git: sus commits y el texto que tenía en cada uno. */

import { execFile, execFileSync } from 'child_process';
import * as path from 'path';

export interface Commit {
  hash: string;
  short: string;
  /** fecha y hora, ya con formato (AAAA-MM-DD HH:MM) */
  date: string;
  author: string;
  subject: string;
}

function git(cwd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' }, (err, stdout) => resolve(err ? undefined : stdout));
  });
}

/** Carpeta raíz del repositorio que contiene `file`, o `undefined` si no está en ninguno (o no hay git). */
export async function repoRoot(file: string): Promise<string | undefined> {
  const out = await git(path.dirname(file), ['rev-parse', '--show-toplevel']);
  return out?.trim() ? path.normalize(out.trim()) : undefined;
}

const relative = (root: string, file: string): string => path.relative(root, file).replace(/\\/g, '/');

/** Commits que tocaron `file`, del más reciente al más antiguo. */
export async function fileLog(root: string, file: string, limit = 60, skip = 0): Promise<Commit[]> {
  const out = await git(root, ['log', `-n${limit}`, `--skip=${skip}`, '--date=format:%Y-%m-%d %H:%M', '--format=%H%x1f%h%x1f%ad%x1f%an%x1f%s', '--', relative(root, file)]);
  if (!out) return [];
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, short, date, author, subject] = line.split('\x1f');
      return { hash, short, date, author, subject: subject ?? '' };
    });
}

const safeRef = (ref: string): boolean => /^[\w./^~-]+$/.test(ref) && !ref.startsWith('-');

/** Contenido de un archivo en una versión, de forma síncrona (para dibujar una versión antigua con sus archivos de entonces). */
export function fileAtSync(root: string, file: string, ref: string): Buffer | undefined {
  if (!safeRef(ref)) return undefined;
  try {
    return execFileSync('git', ['show', `${ref}:${relative(root, file)}`], { cwd: root, windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return undefined;
  }
}

/** Archivos .tex y .bib del repositorio que difieren de la versión `ref` (con lo que haya sin confirmar). */
export async function changedFiles(root: string, ref: string): Promise<string[]> {
  if (!safeRef(ref)) return [];
  // (sin core.quotepath=off git escribe entre comillas y con escapes los nombres con tildes o eñes)
  const tracked = await git(root, ['-c', 'core.quotepath=off', 'diff', '--name-only', ref, '--']);
  const fresh = await git(root, ['-c', 'core.quotepath=off', 'ls-files', '--others', '--exclude-standard']);
  return [...new Set(`${tracked ?? ''}\n${fresh ?? ''}`.split('\n').map((x) => x.trim()).filter((x) => /\.(tex|ltx|bib)$/i.test(x)))].map((x) => path.join(root, x));
}

/** Guarda en git el estado actual de `files` con ese mensaje. Devuelve el error, si lo hay. */
export async function commitFiles(root: string, files: string[], message: string): Promise<string | undefined> {
  const rel = files.map((f) => relative(root, f));
  if ((await git(root, ['add', '--', ...rel])) === undefined) return 'git no pudo preparar los archivos.';
  return new Promise((resolve) => {
    execFile('git', ['commit', '-m', message, '--', ...rel], { cwd: root, windowsHide: true, encoding: 'utf8' }, (err, stdout, stderr) =>
      resolve(err ? (stderr || stdout || String(err)).trim().split('\n').slice(0, 3).join(' ') : undefined),
    );
  });
}

/** Texto de `file` en la versión `ref` (un commit, `HEAD`, `abc123^`...); `undefined` si entonces no existía. */
export function fileAt(root: string, file: string, ref: string): Promise<string | undefined> {
  // (la referencia viene de la lista de commits; por si acaso, nada que git pueda tomar por una opción)
  if (!/^[\w./^~-]+$/.test(ref) || ref.startsWith('-')) return Promise.resolve(undefined);
  return git(root, ['show', `${ref}:${relative(root, file)}`]);
}
