/** Gráficas del diálogo «Insertar gráfica»: el código pgfplots y un boceto en SVG mientras se rellena. */

import { calc } from '../latex/expand';
import { escHtml, escapeText } from './serialize';

/** Puntos escritos en el diálogo de gráficas: uno por línea, «x y», «x, y» o «x; y». */
export function plotPoints(data: string): [string, string][] {
  return data
    .split('\n')
    .map((l) => l.trim().split(/\s*[;\t]\s*|\s+|,\s+/).filter(Boolean))
    .filter((p) => p.length >= 2)
    .map((p) => [p[0].replace(',', '.'), p[1].replace(',', '.')] as [string, string]);
}

/** Boceto de la gráfica mientras se rellena el diálogo (el dibujo definitivo lo hace pgfplots). */
export function plotPreview(v: Record<string, string>): string {
  let pts: [number, number][];
  if (v.kind === 'func') {
    const f = v.data.trim().split('\n')[0].replace(/^y\s*=\s*/, '').trim();
    pts = [];
    for (let k = 0; k <= 60 && f; k++) {
      const x = -3 + k / 10;
      const y = calc(f.replace(/(?<![a-zA-Z])x(?![a-zA-Z])/g, `(${x})`));
      if (Number.isFinite(y)) pts.push([x, y]);
    }
  } else pts = plotPoints(v.data).map(([x, y]) => [parseFloat(x), parseFloat(y)] as [number, number]).filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (pts.length < (v.kind === 'bar' || v.kind === 'scatter' ? 1 : 2)) return '<div class="plot-empty">Escribe los datos para ver la gráfica.</div>';
  const W = 340;
  const H = 180;
  const pad = { l: 34, r: 10, t: v.title.trim() ? 20 : 8, b: 28 };
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  let [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  let [y0, y1] = [Math.min(...ys, v.kind === 'bar' ? 0 : Infinity), Math.max(...ys)];
  if (x0 === x1) [x0, x1] = [x0 - 1, x1 + 1];
  if (y0 === y1) [y0, y1] = [y0 - 1, y1 + 1];
  if (v.kind === 'bar') {
    const half = (x1 - x0) / Math.max(pts.length - 1, 1) / 2;
    x0 -= half;
    x1 += half;
  }
  const X = (x: number): number => pad.l + ((x - x0) / (x1 - x0)) * (W - pad.l - pad.r);
  const Y = (y: number): number => H - pad.b - ((y - y0) / (y1 - y0)) * (H - pad.t - pad.b);
  const n = (k: number): string => k.toFixed(1);
  let marks = '';
  if (v.kind === 'bar') {
    const w = Math.max(((W - pad.l - pad.r) / pts.length) * 0.55, 3);
    marks = pts.map(([x, y]) => `<rect x="${n(X(x) - w / 2)}" y="${n(Math.min(Y(y), Y(0)))}" width="${n(w)}" height="${n(Math.abs(Y(y) - Y(0)))}" fill="#6699ff" stroke="#1f4fbf"/>`).join('');
  } else {
    if (v.kind !== 'scatter') marks += `<polyline fill="none" stroke="#1f4fbf" stroke-width="1.6" points="${pts.map(([x, y]) => `${n(X(x))},${n(Y(y))}`).join(' ')}"/>`;
    if (v.kind !== 'func') marks += pts.map(([x, y]) => `<circle cx="${n(X(x))}" cy="${n(Y(y))}" r="2.6" fill="#1f4fbf"/>`).join('');
  }
  const label = (s: string): string => escHtml(s.trim());
  const num = (k: number): string => String(+k.toFixed(2));
  return (
    `<svg class="plot-prev" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}">` +
    `<rect x="${pad.l}" y="${pad.t}" width="${W - pad.l - pad.r}" height="${H - pad.t - pad.b}" fill="#fff" stroke="#999"/>` +
    marks +
    `<text x="${pad.l - 4}" y="${n(Y(y1) + 4)}" text-anchor="end">${num(y1)}</text><text x="${pad.l - 4}" y="${n(Y(y0))}" text-anchor="end">${num(y0)}</text>` +
    `<text x="${n(X(v.kind === 'bar' ? pts[0][0] : x0))}" y="${H - pad.b + 11}" text-anchor="middle">${num(v.kind === 'bar' ? pts[0][0] : x0)}</text><text x="${n(X(v.kind === 'bar' ? pts[pts.length - 1][0] : x1))}" y="${H - pad.b + 11}" text-anchor="middle">${num(v.kind === 'bar' ? pts[pts.length - 1][0] : x1)}</text>` +
    (v.title.trim() ? `<text x="${W / 2}" y="13" text-anchor="middle" font-weight="bold">${label(v.title)}</text>` : '') +
    (v.x.trim() ? `<text x="${(pad.l + W - pad.r) / 2}" y="${H - 4}" text-anchor="middle">${label(v.x)}</text>` : '') +
    (v.y.trim() ? `<text x="9" y="${(pad.t + H - pad.b) / 2}" text-anchor="middle" transform="rotate(-90 9 ${(pad.t + H - pad.b) / 2})">${label(v.y)}</text>` : '') +
    '</svg>'
  );
}

/** Código de una gráfica pgfplots a partir de lo elegido en el diálogo. */
export function plotTex(v: Record<string, string>): string | undefined {
  const opts = ['width=0.8\\textwidth', 'height=6cm', 'grid=major'];
  if (v.title.trim()) opts.unshift(`title={${escapeText(v.title.trim())}}`);
  if (v.x.trim()) opts.push(`xlabel={${escapeText(v.x.trim())}}`);
  if (v.y.trim()) opts.push(`ylabel={${escapeText(v.y.trim())}}`);
  let plot: string;
  if (v.kind === 'func') {
    const f = v.data.trim().split('\n')[0].replace(/^y\s*=\s*/, '').trim();
    if (!f) return undefined;
    plot = `\\addplot[blue, thick, domain=-3:3, samples=80] {${f}};`;
  } else {
    // un punto por línea: «x y», «x, y» o «x; y» (con coma decimal si hace falta)
    const points = plotPoints(v.data).map(([x, y]) => `(${x},${y})`);
    if (!points.length) return undefined;
    if (v.kind === 'bar') opts.push('ybar', 'bar width=0.5cm');
    const style = v.kind === 'bar' ? 'fill=blue!60' : v.kind === 'scatter' ? 'only marks, mark=*, blue' : 'blue, thick, mark=*';
    plot = `\\addplot[${style}] coordinates {\n    ${points.join(' ')}\n  };`;
  }
  const picture = `\\begin{tikzpicture}\n\\begin{axis}[\n  ${opts.join(',\n  ')}\n]\n  ${plot}\n\\end{axis}\n\\end{tikzpicture}`;
  const cap = v.caption.trim();
  return cap ? `\\begin{figure}[htbp]\n\\centering\n${picture}\n\\caption{${escapeText(cap)}}\n\\end{figure}` : `\\begin{center}\n${picture}\n\\end{center}`;
}
