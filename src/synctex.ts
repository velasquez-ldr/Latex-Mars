/**
 * SyncTeX: el archivo que LaTeX escribe al compilar con `-synctex=1` y que dice a qué línea del
 * código corresponde cada caja del PDF. Con él se salta de un párrafo a su sitio en el PDF y de
 * un punto del PDF a su párrafo.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';

/** Una caja o una marca de la página, en puntos del PDF (72 por pulgada) desde su esquina superior izquierda. */
interface Record {
  /** ( caja horizontal · [ caja vertical · h, v cajas vacías · x, k, g, $ marcas dentro de una línea */
  kind: string;
  page: number;
  file: number;
  line: number;
  /** x del principio y y de la línea base */
  x: number;
  y: number;
  width: number;
  height: number;
  depth: number;
}

export interface SyncTex {
  /** archivos del documento, por su número en el SyncTeX */
  files: Map<number, string>;
  records: Record[];
}

/** Punto del PDF: página (desde 1) y posición en puntos desde arriba a la izquierda. */
export interface PdfPoint {
  page: number;
  x: number;
  y: number;
  /** alto de la línea, para resaltarla */
  height: number;
}

const same = (a: string, b: string): boolean => path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();

/** Lee el texto de un SyncTeX. `dir`: carpeta respecto a la que van sus rutas relativas. */
export function parseSyncTex(text: string, dir: string): SyncTex {
  const files = new Map<number, string>();
  const records: Record[] = [];
  let unit = 1;
  let mag = 1000;
  let xOff = 0;
  let yOff = 0;
  let page = 0;
  // de «puntos escalados» de TeX a puntos del PDF
  const pt = (v: number): number => (v * unit * (mag / 1000)) / 65781.76;
  const item = /^([[(vhxkg$])(\d+),(\d+)(?:,-?\d+)?:(-?\d+),(-?\d+)(?::(-?\d+),(-?\d+),(-?\d+)|:(-?\d+))?/;
  for (const line of text.split(/\r?\n/)) {
    const c = line[0];
    if (c === 'I' && line.startsWith('Input:')) {
      const m = /^Input:(\d+):(.*)$/.exec(line);
      if (m) files.set(parseInt(m[1], 10), path.resolve(dir, m[2].trim()));
    } else if (c === 'U' && line.startsWith('Unit:')) unit = parseFloat(line.slice(5)) || 1;
    else if (c === 'M' && line.startsWith('Magnification:')) mag = parseFloat(line.slice(14)) || 1000;
    else if (c === 'X' && line.startsWith('X Offset:')) xOff = parseFloat(line.slice(9)) || 0;
    else if (c === 'Y' && line.startsWith('Y Offset:')) yOff = parseFloat(line.slice(9)) || 0;
    else if (c === '{') page = parseInt(line.slice(1), 10) || page + 1;
    else if (page > 0) {
      const m = item.exec(line);
      if (!m) continue;
      records.push({
        kind: m[1], page, file: parseInt(m[2], 10), line: parseInt(m[3], 10),
        x: pt(parseInt(m[4], 10) + xOff), y: pt(parseInt(m[5], 10) + yOff),
        width: pt(parseInt(m[6] ?? m[9] ?? '0', 10)), height: pt(parseInt(m[7] ?? '0', 10)), depth: pt(parseInt(m[8] ?? '0', 10)),
      });
    }
  }
  return { files, records };
}

/** El último SyncTeX leído: en un documento largo ocupa varios megas y cada salto lo consulta. */
let loaded: { key: string; data: SyncTex } | undefined;

/** Carga el SyncTeX que acompaña a un PDF (`documento.synctex.gz` o `documento.synctex`), si existe. */
export function loadSyncTex(pdf: string): SyncTex | undefined {
  const base = pdf.replace(/\.pdf$/i, '');
  for (const file of [`${base}.synctex.gz`, `${base}.synctex`]) {
    try {
      const st = fs.statSync(file);
      // mientras el archivo no cambie (no se ha vuelto a compilar) vale lo ya leído
      const key = `${file}:${st.mtimeMs}:${st.size}`;
      if (loaded?.key === key) return loaded.data;
      const bytes = fs.readFileSync(file);
      const data = parseSyncTex((file.endsWith('.gz') ? zlib.gunzipSync(bytes) : bytes).toString('latin1'), path.dirname(pdf));
      loaded = { key, data };
      return data;
    } catch {
      // no existe, o está dañado o a medio escribir: se prueba el siguiente
    }
  }
  return undefined;
}

/** Dónde cae en el PDF la línea `line` (desde 1) de `file`: la primera caja de esa línea o de la siguiente que tenga alguna. */
export function forward(s: SyncTex, file: string, line: number): PdfPoint | undefined {
  const tags = [...s.files].filter(([, f]) => same(f, file)).map(([k]) => k);
  if (!tags.length) return undefined;
  const mine = s.records.filter((r) => tags.includes(r.file) && r.kind !== '[');
  if (!mine.length) return undefined;
  // la línea pedida; si no dibuja nada (una orden, una línea en blanco), la más cercana por debajo y luego por arriba
  const after = mine.filter((r) => r.line >= line).sort((a, b) => a.line - b.line || a.page - b.page || a.y - b.y || a.x - b.x)[0];
  const before = mine.filter((r) => r.line < line).sort((a, b) => b.line - a.line || a.page - b.page || a.y - b.y)[0];
  const hit = after && (!before || after.line - line <= 3) ? after : before ?? after;
  // (de una marca suelta se toma la caja de su línea, que es la que da el alto)
  const box = s.records.find((r) => r.kind === '(' && r.page === hit.page && Math.abs(r.y - hit.y) < 0.5 && r.x <= hit.x + 0.5 && r.x + r.width >= hit.x - 0.5) ?? hit;
  return { page: hit.page, x: box.x, y: box.y - box.height, height: Math.max(box.height + box.depth, 8) };
}

/** A qué archivo y línea (desde 1) corresponde un punto del PDF. */
export function inverse(s: SyncTex, page: number, x: number, y: number): { file: string; line: number } | undefined {
  const here = s.records.filter((r) => r.page === page);
  // la caja horizontal más pequeña que contiene el punto (una línea de texto), con algo de holgura
  const boxes = here
    .filter((r) => (r.kind === '(' || r.kind === 'h') && x >= r.x - 2 && x <= r.x + r.width + 2 && y >= r.y - r.height - 2 && y <= r.y + r.depth + 2)
    .sort((a, b) => a.width * (a.height + a.depth) - b.width * (b.height + b.depth));
  let hit = boxes[0];
  if (hit) {
    // dentro de la línea, la marca más cercana en horizontal: afina cuando una línea junta texto de varias del código
    const marks = here.filter((r) => 'xkg$'.includes(r.kind) && Math.abs(r.y - hit.y) < 0.5 && r.x >= hit.x - 0.5 && r.x <= hit.x + hit.width + 0.5);
    const near = marks.sort((a, b) => Math.abs(a.x - x) - Math.abs(b.x - x))[0];
    if (near) hit = near;
  } else {
    // fuera de toda caja (un margen, un hueco): la línea más cercana en vertical
    hit = here.filter((r) => r.kind === '(').sort((a, b) => Math.abs(a.y - y) - Math.abs(b.y - y))[0];
  }
  const file = hit ? s.files.get(hit.file) : undefined;
  return hit && file ? { file, line: hit.line } : undefined;
}
