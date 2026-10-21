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

/** Lleva la vista a un punto (página y posición en puntos desde arriba) y lo resalta un momento. */
function goto(g) {
  const holder = loading ? undefined : pages.querySelector(`.pg[data-page="${g.page}"]`);
  const size = sizes[g.page - 1];
  if (!holder || !size) {
    pendingGoto = g;
    return;
  }
  const k = holder.offsetHeight / size[1];
  pages.querySelectorAll('.mark').forEach((m) => m.remove());
  const mark = document.createElement('div');
  mark.className = 'mark';
  mark.style.top = `${Math.max(g.y * k - 2, 0)}px`;
  mark.style.height = `${Math.max(g.height * k + 4, 10)}px`;
  holder.appendChild(mark);
  const y = holder.getBoundingClientRect().top + window.scrollY + g.y * k;
  window.scrollTo({ top: Math.max(y - window.innerHeight / 3, 0), behavior: 'smooth' });
  setTimeout(() => mark.classList.add('out'), 1500);
  setTimeout(() => mark.remove(), 4200);
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
