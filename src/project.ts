/** Proyectos de varios archivos: qué documento principal trae a un capítulo con \input o \include. */

import * as path from 'path';

const uncomment = (text: string): string => text.replace(/(^|[^\\])%.*$/gm, '$1');

/** El archivo es un documento completo (tiene su \documentclass), no una parte de otro. */
export function isMain(text: string): boolean {
  return /\\documentclass\b/.test(uncomment(text));
}

/** Archivo que nombra un \input: relativo a la carpeta del documento principal y, sin extensión, .tex. */
export function texPath(dir: string, name: string): string {
  return path.resolve(dir, path.extname(name) ? name : name + '.tex');
}

export function samePath(a: string, b: string): boolean {
  return path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
}

/**
 * Texto de un archivo del proyecto (un capítulo, la bibliografía) leído del disco: UTF-8 o, si no
 * lo es —documentos antiguos escritos en Latin-1—, cada byte como su carácter.
 */
export function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return Buffer.from(bytes).toString('latin1');
  }
}

/** `main` trae a `target`, directamente o a través de otros archivos. */
export function includes(main: string, target: string, read: (file: string) => string | undefined): boolean {
  const dir = path.dirname(main);
  const seen = new Set<string>();
  const walk = (file: string, depth: number): boolean => {
    const text = read(file);
    if (text === undefined || depth > 4 || seen.has(file.toLowerCase())) return false;
    seen.add(file.toLowerCase());
    for (const m of uncomment(text).matchAll(/\\(?:input|include|subfile)\s*\{([^}]*)\}/g)) {
      // las rutas de \input son siempre relativas al documento principal
      const next = texPath(dir, m[1].trim());
      if (samePath(next, target) || walk(next, depth + 1)) return true;
    }
    return false;
  };
  return walk(main, 0);
}

/**
 * Documento principal de un archivo sin \documentclass: el que indica su comentario
 * `% !TEX root = ...` o, si no, un .tex de su carpeta (o de las dos de encima) que lo incluya.
 */
export function findRoot(file: string, read: (file: string) => string | undefined, list: (dir: string) => string[]): string | undefined {
  const own = read(file) ?? '';
  const magic = /^%\s*!\s*T[eE]X\s+root\s*=\s*(.+?)\s*$/m.exec(own.split(/\r?\n/).slice(0, 10).join('\n'));
  if (magic) {
    const root = path.resolve(path.dirname(file), magic[1]);
    if (!samePath(root, file) && read(root) !== undefined) return root;
  }
  let dir = path.dirname(file);
  for (let up = 0; up < 3; up++) {
    for (const name of [...list(dir)].sort()) {
      if (!/\.(tex|ltx)$/i.test(name)) continue;
      const candidate = path.join(dir, name);
      if (samePath(candidate, file)) continue;
      const text = read(candidate);
      if (text !== undefined && isMain(text) && includes(candidate, file, read)) return candidate;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
