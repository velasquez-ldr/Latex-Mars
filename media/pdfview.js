// Visor del PDF compilado (lo carga src/pdfview.ts). Dibuja las páginas con pdf.js, avisa a la
// extensión del punto en que se hace doble clic y resalta el que ella le pide.
const vscode = acquireVsCodeApi();
const pages = document.getElementById('pages');
const zoomLabel = document.getElementById('zoom');
const countLabel = document.getElementById('count');
let scale = 1;
let doc;
/** tamaño de cada página en puntos del PDF */
let sizes = [];
let pendingGoto;
/** mientras se abre o se vuelve a abrir el PDF, lo que se pida espera a que estén sus páginas */
let loading = true;
/** cada vez que se recolocan las páginas cambia: lo que quedara por pintar de la tanda anterior se descarta */
let round = 0;
let watcher;

async function library() {
  const lib = await import(document.body.dataset.pdfjs);
  try {
    // el worker vive en otro origen: se descarga y se lanza desde un blob
    const code = await (await fetch(document.body.dataset.pdfworker)).blob();
    lib.GlobalWorkerOptions.workerPort = new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })), { type: 'module' });
  } catch {
    lib.GlobalWorkerOptions.workerSrc = document.body.dataset.pdfworker;
  }
  return lib;
}
const pdfjs = library();

/** Ancho al que cabe una página en el panel, por el zoom elegido. */
function fit(width) {
  return (Math.max(document.documentElement.clientWidth - 40, 200) / width) * scale;
}

/** Pinta una página (una sola vez por tanda), a más densidad que la pantalla para que el texto salga nítido. */
async function paint(holder, mine) {
  if (holder.dataset.state) return;
  holder.dataset.state = 'painting';
  try {
    const page = await doc.getPage(Number(holder.dataset.page));
    if (mine !== round) return;
    const k = holder.offsetWidth / page.getViewport({ scale: 1 }).width;
    const viewport = page.getViewport({ scale: k * Math.max(window.devicePixelRatio || 1, 1.5) });
    const canvas = holder.querySelector('canvas');
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext('2d'), canvas, viewport }).promise;
    holder.dataset.state = 'done';
  } catch {
    if (mine === round) delete holder.dataset.state;
  }
  if (mine !== round) return;
  const done = pages.querySelectorAll('.pg[data-state="done"]').length;
  document.body.dataset.drawn = String(done);
  // (la extensión cuenta el documento como dibujado en cuanto lo están las páginas a la vista)
  vscode.postMessage({ type: 'drawn', page: doc.numPages, painted: done });
}

async function draw(keepScroll = false) {
  if (!doc) return;
  const mine = ++round;
  const top = keepScroll ? document.documentElement.scrollTop / Math.max(document.documentElement.scrollHeight, 1) : 0;
  const frag = document.createDocumentFragment();
  const next = [];
  for (let n = 1; n <= doc.numPages; n++) {
    const page = await doc.getPage(n);
    if (mine !== round) return;
    const base = page.getViewport({ scale: 1 });
    next.push([base.width, base.height]);
    const k = fit(base.width);
    const holder = document.createElement('div');
    holder.className = 'pg';
    holder.dataset.page = String(n);
    holder.style.width = `${base.width * k}px`;
    holder.style.height = `${base.height * k}px`;
    holder.appendChild(document.createElement('canvas'));
    frag.appendChild(holder);
  }
  sizes = next;
  pages.replaceChildren(frag);
  countLabel.textContent = `${doc.numPages} ${doc.numPages === 1 ? 'página' : 'páginas'}`;
  zoomLabel.textContent = `${Math.round(scale * 100)} %`;
  if (keepScroll) document.documentElement.scrollTop = top * document.documentElement.scrollHeight;
  // solo se pintan las páginas que están a la vista o cerca: un documento largo abre igual de rápido
  watcher?.disconnect();
  watcher = new IntersectionObserver(
    (entries) => {
      for (const e of entries) if (e.isIntersecting) void paint(e.target, mine);
    },
    { rootMargin: '900px 0px' },
  );
  pages.querySelectorAll('.pg').forEach((p) => watcher.observe(p));
  loading = false;
  if (pendingGoto) {
    const g = pendingGoto;
    pendingGoto = undefined;
    goto(g);
  }
}

async function open(url, keepScroll) {
  loading = true;
  try {
    doc = await (await pdfjs).getDocument({ url }).promise;
    texts = new Map();
    await draw(keepScroll);
  } catch (err) {
    loading = false;
    pages.innerHTML = '';
    const msg = document.createElement('div');
    msg.id = 'msg';
    msg.textContent = `No se pudo abrir el PDF: ${err}`;
    pages.appendChild(msg);
  }
}

/** Desplaza la vista para que un punto de una página quede a un tercio de la altura. */
function scrollToPoint(holder, k, y) {
  const top = holder.getBoundingClientRect().top + window.scrollY + y * k;
  window.scrollTo({ top: Math.max(top - window.innerHeight / 3, 0), behavior: 'smooth' });
}

/** Un rectángulo de resaltado sobre una página, en puntos del PDF. */
function markAt(holder, k, cls, x, y, width, height) {
  const mark = document.createElement('div');
  mark.className = `mark ${cls}`;
  mark.style.left = `${Math.max(x * k - 2, 0)}px`;
  mark.style.top = `${Math.max(y * k - 2, 0)}px`;
  mark.style.width = `${Math.max(width * k + 4, 3)}px`;
  mark.style.height = `${Math.max(height * k + 4, 10)}px`;
  holder.appendChild(mark);
  return mark;
}

/**
 * Lleva la vista a un punto (página y posición en puntos desde arriba) y lo resalta: el párrafo entero
 * con el ancho de sus líneas, y después, si se sabe el texto que rodea al cursor, la palabra exacta.
 */
let gotoRound = 0;
function goto(g) {
  const holder = loading ? undefined : pages.querySelector(`.pg[data-page="${g.page}"]`);
  const size = sizes[g.page - 1];
  if (!holder || !size) {
    pendingGoto = g;
    return;
  }
  const mine = ++gotoRound;
  const k = holder.offsetHeight / size[1];
  pages.querySelectorAll('.mark').forEach((m) => m.remove());
  const marks = [];
  for (const b of g.boxes ?? []) {
    const h = pages.querySelector(`.pg[data-page="${b.page}"]`);
    const sz = sizes[b.page - 1];
    if (h && sz) marks.push(markAt(h, h.offsetHeight / sz[1], 'para', b.x, b.y, b.width, b.height));
  }
  // sin las líneas del párrafo, la de la posición, de lado a lado de la página como antes
  if (!marks.length) marks.push(markAt(holder, k, 'para', 0, g.y, size[0], g.height));
  scrollToPoint(holder, k, g.y);
  const fade = (list) => {
    setTimeout(() => list.forEach((m) => m.classList.add('out')), 2200);
    setTimeout(() => list.forEach((m) => m.remove()), 5200);
  };
  if (!g.before && !g.after) {
    fade(marks);
    return;
  }
  void findWord(g).then((w) => {
    if (mine !== gotoRound) return;
    if (w) {
      const h = pages.querySelector(`.pg[data-page="${w.page}"]`);
      const sz = sizes[w.page - 1];
      if (h && sz) {
        const kk = h.offsetHeight / sz[1];
        for (const r of w.rects) marks.push(markAt(h, kk, 'word', r.x, r.y, r.width, r.height));
        const caret = markAt(h, kk, 'caret', w.caret.x, w.caret.y, 0, w.caret.height);
        caret.style.width = '2px';
        caret.style.left = `${w.caret.x * kk - 1}px`;
        marks.push(caret);
        scrollToPoint(h, kk, w.caret.y);
      }
    }
    fade(marks);
  });
}

/** Igual que en la extensión: solo letras y números, sin tildes ni mayúsculas (las ligaduras se separan). */
const plain = (s) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
/** el texto de cada página, leído una sola vez por PDF abierto */
let texts = new Map();

async function pageText(n) {
  if (!texts.has(n)) {
    texts.set(
      n,
      (async () => {
        const page = await doc.getPage(n);
        const vp = page.getViewport({ scale: 1 });
        const content = await page.getTextContent();
        return content.items
          .filter((it) => typeof it.str === 'string' && it.str.length)
          .map((it) => {
            const [x, y] = vp.convertToViewportPoint(it.transform[4], it.transform[5]);
            const size = Math.hypot(it.transform[2], it.transform[3]) || it.height || 10;
            return { str: it.str, x, base: y, size, width: it.width };
          });
      })(),
    );
  }
  return texts.get(n);
}

/**
 * Compara el texto del editor con el del PDF a partir del punto `cut` de `flat`: hacia atrás con `b`
 * (lo de antes del cursor) y hacia delante con `a`. El PDF puede haber perdido letras (con las fuentes
 * de siempre de pdflatex, «fi» sale como un hueco y la «í» se queda sin letra) o tener alguna de más:
 * se toleran unas pocas. Devuelve cuántas coinciden y dónde empieza y acaba en `flat` la palabra del
 * cursor (que tiene `left` letras antes de él y `right` después).
 */
function align(flat, cut, b, a, left, right) {
  let miss = 0;
  const budget = 2 + Math.floor((b.length + a.length) / 10);
  // recorre `t` (desde su principio) contra `flat` desde `k0`, avanzando en la dirección `d`;
  // devuelve las coincidencias y dónde está `flat` cuando se han pasado `want` letras de `t`
  const walk = (t, k0, d, want) => {
    let hits = 0;
    let mark = want ? undefined : k0;
    let i = 0;
    let k = k0;
    const ok = (kk) => kk >= 0 && kk < flat.length;
    while (i < t.length && ok(k) && miss <= budget) {
      if (t[i] === flat[k]) {
        hits++;
        i++;
        k += d;
      } else {
        // la letra que más cerca vuelve a coincidir: 1 o 2 que faltan en el PDF, o que sobran en él
        const gap = [[1, 0], [0, 1], [2, 0], [0, 2], [1, 1]].find(([si, sk]) => i + si < t.length && ok(k + sk * d) && t[i + si] === flat[k + sk * d]) ?? [1, 1];
        i += gap[0];
        k += gap[1] * d;
        miss += Math.max(gap[0], gap[1]);
      }
      if (mark === undefined && i >= want) mark = k;
    }
    return { hits, mark: mark ?? k };
  };
  const back = walk([...b].reverse().join(''), cut - 1, -1, left);
  const fwd = walk(a, cut, 1, right);
  return { hits: back.hits + fwd.hits, start: left ? back.mark + 1 : cut, end: right ? fwd.mark : cut };
}

/**
 * Busca en el texto del PDF, dentro de las líneas del párrafo, el punto donde mejor encaja el texto
 * de antes del cursor seguido del de después. Se compara solo con letras y números: los espacios,
 * los guiones de final de línea y las tildes no cuentan.
 */
async function findWord(g) {
  const boxes = g.boxes?.length ? g.boxes : [{ page: g.page, x: 0, y: g.y, width: Infinity, height: g.height }];
  const b = plain(g.before ?? '').slice(-30);
  const a = plain(g.after ?? '').slice(0, 30);
  if (b.length + a.length < 3) return undefined;
  const left = plain(/[\p{L}\p{N}\u0300-\u036f]*$/u.exec(g.before ?? '')?.[0] ?? '').length;
  const right = plain(/^[\p{L}\p{N}\u0300-\u036f]*/u.exec(g.after ?? '')?.[0] ?? '').length;
  // (con menos de esto coincidiría por casualidad con cualquier sitio)
  const enough = Math.max(3, Math.ceil((b.length + a.length) * 0.6));
  let best;
  for (const n of [...new Set([g.page, ...boxes.map((x) => x.page)])]) {
    const rows = boxes.filter((x) => x.page === n);
    const items = (await pageText(n)).filter((it) => rows.some((r) => it.base >= r.y - 2 && it.base <= r.y + r.height + 2 && it.x >= r.x - 4 && it.x <= r.x + r.width + 4));
    // el texto de la zona, letra a letra, sabiendo de qué trozo y de qué carácter sale cada una
    let flat = '';
    const from = [];
    items.forEach((it, i) => {
      for (let j = 0; j < it.str.length; j++) {
        const p = plain(it.str[j]);
        flat += p;
        for (let q = 0; q < p.length; q++) from.push([i, j]);
      }
    });
    if (!from.length) continue;
    for (let cut = 0; cut <= flat.length; cut++) {
      const m = align(flat, cut, b, a, left, right);
      if (m.hits < enough) continue;
      // a igualdad, la más cercana a la línea del cursor
      const [i] = from[Math.min(cut, from.length - 1)];
      const dist = Math.abs(items[i].base - g.y) + (n === g.page ? 0 : 10000);
      if (!best || m.hits > best.hits || (m.hits === best.hits && dist < best.dist)) best = { ...m, dist, page: n, items, from, cut };
    }
  }
  return best && wordAt(best, /[\p{L}\p{N}]$/u.test(g.before ?? ''));
}

/** Para medir letras: un lienzo con una letra de imprenta parecida a la del documento. */
let ruler;
/**
 * Dónde empieza cada carácter de un trozo de texto del PDF, en puntos desde su principio. pdf.js solo
 * da el ancho del trozo entero: se reparte según lo que mide cada letra (una «m» más que una «i»).
 */
function edges(it) {
  if (it.edges) return it.edges;
  let w = Array.from(it.str, () => 1);
  try {
    ruler ??= document.createElement('canvas').getContext('2d');
    ruler.font = '100px "Latin Modern Roman", "Computer Modern", "Times New Roman", serif';
    w = Array.from(it.str, (c) => ruler.measureText(c).width || 30);
  } catch {
    // sin lienzo, todas las letras miden lo mismo
  }
  const total = w.reduce((a, b) => a + b, 0) || 1;
  const out = [0];
  for (const v of w) out.push(out[out.length - 1] + (v / total) * it.width);
  it.edges = out;
  return out;
}

/**
 * Los rectángulos de la palabra del cursor (uno por trozo del PDF, si la parte una tilde o un salto
 * de línea) y la posición del cursor, en puntos de la página. `inWord`: el cursor va pegado detrás de
 * una letra; si no, delante de la siguiente.
 */
function wordAt(best, inWord) {
  const box = (it) => ({ y: it.base - it.size * 0.8, height: it.size * 1.05 });
  const rects = [];
  for (let q = best.start; q < best.end; q++) {
    const [i, j] = best.from[q];
    const it = best.items[i];
    const e = edges(it);
    const r = rects[rects.length - 1];
    if (r && r.i === i) r.end = it.x + e[j + 1];
    else rects.push({ i, x: it.x + e[j], end: it.x + e[j + 1], ...box(it) });
  }
  const back = (inWord || best.cut >= best.from.length) && best.cut > 0;
  const [ci, cj] = best.from[back ? best.cut - 1 : best.cut];
  const cit = best.items[ci];
  const caret = { x: cit.x + edges(cit)[back ? cj + 1 : cj], ...box(cit) };
  return { page: best.page, rects: rects.map((r) => ({ x: r.x, y: r.y, width: Math.max(r.end - r.x, 2), height: r.height })), caret };
}

pages.addEventListener('dblclick', (e) => {
  const holder = e.target.closest?.('.pg');
  const size = holder ? sizes[Number(holder.dataset.page) - 1] : undefined;
  if (!holder || !size) return;
  const r = holder.getBoundingClientRect();
  vscode.postMessage({ type: 'click', page: Number(holder.dataset.page), x: ((e.clientX - r.left) / r.width) * size[0], y: ((e.clientY - r.top) / r.height) * size[1] });
});
document.getElementById('in').addEventListener('click', () => {
  scale = Math.min(scale * 1.2, 4);
  void draw(true);
});
document.getElementById('out').addEventListener('click', () => {
  scale = Math.max(scale / 1.2, 0.3);
  void draw(true);
});
let resizeTimer;
let lastWidth = document.documentElement.clientWidth;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    // (solo si cambia el ancho: que aparezca o desaparezca una barra de desplazamiento no obliga a repintar)
    if (Math.abs(document.documentElement.clientWidth - lastWidth) < 24) return;
    lastWidth = document.documentElement.clientWidth;
    void draw(true);
  }, 200);
});
window.addEventListener('message', (e) => {
  const m = e.data;
  if (m.type === 'goto') goto(m);
  else if (m.type === 'reload') void open(m.url, true);
});

void open(document.body.dataset.pdf, false).then(() => vscode.postMessage({ type: 'ready' }));
