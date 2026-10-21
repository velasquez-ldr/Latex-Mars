/** Comparación de textos: por líneas (qué bloques cambian entre dos versiones) y por palabras. */

/** Tramo que difiere: las líneas `a0..a1` de la versión antigua pasan a ser las `b0..b1` de la nueva. */
export interface Hunk {
  a0: number;
  a1: number;
  b0: number;
  b1: number;
}

/**
 * Operaciones de edición mínimas entre dos listas (algoritmo de Myers). Devuelve los tramos que
 * difieren; `undefined` si las listas son tan distintas que no merece la pena afinar.
 */
function myers<T>(a: T[], b: T[], limit: number): Hunk[] | undefined {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, limit);
  const off = max + 1;
  const trace: Int32Array[] = [];
  let v = new Int32Array(2 * max + 3);
  let found = -1;
  for (let d = 0; d <= max && found < 0; d++) {
    trace.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        found = d;
        break;
      }
    }
    if (found < 0) v = v.slice();
  }
  if (found < 0) return undefined;
  // se desanda el camino anotando cada inserción o borrado
  const hunks: Hunk[] = [];
  let x = n;
  let y = m;
  for (let d = found; d > 0; d--) {
    const prev = trace[d];
    const k = x - y;
    const down = k === -d || (k !== d && prev[off + k - 1] < prev[off + k + 1]);
    const pk = down ? k + 1 : k - 1;
    const px = prev[off + pk];
    const py = px - pk;
    // tras la edición, la diagonal de coincidencias
    const ex = down ? px : px + 1;
    const ey = down ? py + 1 : py;
    const last = hunks[hunks.length - 1];
    if (last && last.a0 === ex && last.b0 === ey) {
      last.a0 = px;
      last.b0 = py;
    } else hunks.push({ a0: px, a1: ex, b0: py, b1: ey });
    x = px;
    y = py;
  }
  return hunks.reverse();
}

/** Tramos de líneas que difieren entre dos versiones de un texto. */
export function diffLines(oldLines: string[], newLines: string[]): Hunk[] {
  // lo que coincide al principio y al final no se compara
  let head = 0;
  const top = Math.min(oldLines.length, newLines.length);
  while (head < top && oldLines[head] === newLines[head]) head++;
  let tail = 0;
  while (tail < top - head && oldLines[oldLines.length - 1 - tail] === newLines[newLines.length - 1 - tail]) tail++;
  const a = oldLines.slice(head, oldLines.length - tail);
  const b = newLines.slice(head, newLines.length - tail);
  if (!a.length && !b.length) return [];
  const inner = myers(a, b, 4000) ?? [{ a0: 0, a1: a.length, b0: 0, b1: b.length }];
  return inner.map((h) => ({ a0: h.a0 + head, a1: h.a1 + head, b0: h.b0 + head, b1: h.b1 + head }));
}

/** Trozo de una comparación palabra a palabra: igual (0), quitado (-1) o añadido (1). */
export type WordPart = [kind: -1 | 0 | 1, text: string];

/** Comparación palabra a palabra de dos textos (los espacios van con la palabra que los sigue). */
export function diffWords(oldText: string, newText: string): WordPart[] {
  const split = (s: string): string[] => s.match(/\s*\S+|\s+$/g) ?? [];
  const a = split(oldText);
  const b = split(newText);
  const hunks = diffLines(a, b);
  const out: WordPart[] = [];
  const push = (kind: -1 | 0 | 1, words: string[]): void => {
    if (!words.length) return;
    const last = out[out.length - 1];
    if (last && last[0] === kind) last[1] += words.join('');
    else out.push([kind, words.join('')]);
  };
  let x = 0;
  let y = 0;
  for (const h of hunks) {
    push(0, b.slice(y, h.b0));
    push(-1, a.slice(h.a0, h.a1));
    push(1, b.slice(h.b0, h.b1));
    x = h.a1;
    y = h.b1;
  }
  void x;
  push(0, b.slice(y));
  return out;
}

/** Cambio de un documento respecto a otra versión, en líneas del documento actual. */
export interface Change {
  /** add: líneas nuevas · mod: líneas que sustituyen a otras · del: había líneas donde ahora no hay nada */
  kind: 'add' | 'mod' | 'del';
  /** primera línea del tramo y cuántas ocupa en el documento actual (0 en un borrado) */
  s: number;
  n: number;
  /** las líneas que había en la otra versión */
  old: string[];
}

/** Cambios entre la versión `old` y la actual, sin contar los que solo mueven líneas en blanco. */
export function changesBetween(oldText: string, newText: string): Change[] {
  const a = oldText.split(/\r?\n/);
  const b = newText.split(/\r?\n/);
  const out: Change[] = [];
  for (const h of diffLines(a, b)) {
    const old = a.slice(h.a0, h.a1);
    const now = b.slice(h.b0, h.b1);
    if (!old.some((l) => l.trim()) && !now.some((l) => l.trim())) continue;
    const kind = !now.some((l) => l.trim()) ? 'del' : !old.some((l) => l.trim()) ? 'add' : 'mod';
    out.push({ kind, s: h.b0, n: h.b1 - h.b0, old });
  }
  return out;
}
