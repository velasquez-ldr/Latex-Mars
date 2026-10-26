/**
 * Presentación 16:9 hecha a partir del documento: los apartados que se eligen en el panel lateral
 * se convierten en diapositivas (ideas clave en viñetas, figuras, tablas y ecuaciones) y se
 * proyectan en la propia vista. No cambia el documento: se construye con lo ya dibujado.
 */
import { escHtml } from './serialize';

/** Un apartado del documento: su título y el contenido de los bloques que lo siguen. */
export interface DeckSection {
  key: string;
  num: string;
  title: string;
  /** 0 = capítulo o parte, 1 = sección, 2 = subsección... */
  level: number;
  blocks: HTMLElement[];
}

/** Textos propios de la portada; lo que falta se toma del documento (\title, \author, \date). */
export interface CoverText {
  title?: string;
  subtitle?: string;
  author?: string;
  institute?: string;
  date?: string;
}

/** Textos propios de la diapositiva de cierre; lo que falta, el de siempre. */
export interface ClosingText {
  title?: string;
  subtitle?: string;
  /** contacto o autor (por omisión, el autor de la portada) */
  contact?: string;
}

export const CLOSING_DEFAULTS = { title: '¡Gracias!', subtitle: '¿Preguntas?' };

export interface DeckOptions {
  /** texto: la idea clave de cada párrafo, los párrafos enteros o nada */
  text: 'key' | 'full' | 'none';
  lists: boolean;
  figures: boolean;
  tables: boolean;
  math: boolean;
  cover: boolean;
  agenda: boolean;
  closing: boolean;
  theme: 'light' | 'dark' | 'blue';
  /** textos del cierre (valen para todas las presentaciones) */
  end: ClosingText;
}

export const DECK_DEFAULTS: DeckOptions = {
  text: 'key', lists: true, figures: true, tables: true, math: true, cover: true, agenda: true, closing: true, theme: 'light', end: {},
};

/** Lo que dice la portada del documento (\maketitle), en HTML: el título puede llevar fórmulas. */
export function coverOf(cover?: HTMLElement): { title: string; author: string; institute: string; date: string } {
  const part = (sel: string): string => {
    const el = cover?.querySelector(sel);
    if (!el) return '';
    const box = copy([el], el.ownerDocument);
    return (box.firstElementChild as HTMLElement | null)?.innerHTML.trim() ?? '';
  };
  return { title: part('.doctitle'), author: part('.docauthor:not(.docinst)'), institute: part('.docinst'), date: part('.docdate') };
}

/** Texto plano de un trozo de HTML (para el pie y los cuadros de texto). */
export const plainOf = (html: string, doc: Document): string => {
  const box = doc.createElement('div');
  box.innerHTML = html;
  return (box.textContent ?? '').replace(/\s+/g, ' ').trim();
};

/** La portada con los textos propios donde los haya y los del documento en lo demás. */
export function coverHtml(cover: HTMLElement | undefined, text: CoverText): string {
  const doc = coverOf(cover);
  const line = (cls: string, own: string | undefined, fallback: string): string => {
    const html = own !== undefined ? escHtml(own) : fallback;
    return html.trim() ? `<div class="${cls}">${html}</div>` : '';
  };
  return (
    '<div class="titleblock">' +
    line('doctitle', text.title, doc.title || 'Presentación') +
    line('docsub', text.subtitle, '') +
    line('docauthor', text.author, doc.author) +
    line('docauthor docinst', text.institute, doc.institute) +
    line('docdate', text.date, doc.date) +
    '</div>'
  );
}

/** El cierre con sus textos: los propios o los de siempre; el contacto, por omisión, el autor. */
export function closingHtml(end: ClosingText, author: string): string {
  const contact = end.contact !== undefined ? end.contact : author;
  const sub = end.subtitle ?? CLOSING_DEFAULTS.subtitle;
  return (
    (sub.trim() ? `<div class="end-sub">${escHtml(sub)}</div>` : '') +
    (contact.trim() ? `<div class="end-who">${escHtml(contact)}</div>` : '')
  );
}

export interface Slide {
  kind: 'cover' | 'agenda' | 'part' | 'content' | 'media' | 'end';
  title: string;
  num: string;
  /** apartado del que sale */
  key?: string;
  /** viñetas o párrafos */
  points: string[];
  /** figura, tabla o ecuación grande (al lado de las viñetas si las hay) */
  media?: string;
  /** contenido propio de la portada, el índice y el cierre */
  html?: string;
}

/** lo que cabe en una diapositiva: cuántas viñetas y cuántos caracteres */
const MAX_POINTS = 5;
const MAX_CHARS = { key: 520, full: 760, none: 0 };
/** por debajo de esto una frase no se da por terminada («Dr.», «p. ej.») */
const MIN_SENTENCE = 40;
/** una idea clave sin punto se corta aquí */
const MAX_KEY = 220;

type Kind = 'head' | 'math' | 'figure' | 'table' | 'list' | 'text' | 'skip';

/** Qué es un bloque, mirando lo que lleva dentro. */
export function blockKind(c: HTMLElement): Kind {
  if (c.querySelector(':scope > [data-k="head"]')) return 'head';
  if (c.querySelector(':scope > .toc, :scope > .bib, :scope > .bib-title, :scope > .footnotes, :scope > .titleblock, :scope > .preamble, :scope > .atom.titleblock')) return 'skip';
  if (c.querySelector(':scope > .math')) return 'math';
  const fig = c.querySelector(':scope > figure');
  if (fig) return fig.querySelector('table') ? 'table' : 'figure';
  if (c.querySelector(':scope > table, :scope > .center > table')) return 'table';
  if (c.querySelector(':scope > .img, :scope > .center > .img, :scope > .tikz, :scope > .center > .tikz')) return 'figure';
  if (c.querySelector(':scope > ul, :scope > ol, :scope > dl')) return 'list';
  return (c.textContent ?? '').replace(/­/g, '').trim() ? 'text' : 'skip';
}

/** Copia de unos nodos lista para la diapositiva: sin edición, sin identificadores repetidos, sin guiones blandos. */
function copy(nodes: Iterable<Node>, doc: Document): HTMLElement {
  const box = doc.createElement('div');
  for (const n of nodes) box.appendChild(n.cloneNode(true));
  box.querySelectorAll('[contenteditable]').forEach((e) => e.removeAttribute('contenteditable'));
  box.querySelectorAll('[id]').forEach((e) => e.removeAttribute('id'));
  box.querySelectorAll('.atom.hid, [data-skip].secnum').forEach((e) => e.remove());
  box.querySelectorAll('.cite-here').forEach((e) => e.classList.remove('cite-here'));
  const walk = doc.createTreeWalker(box, 4 /* NodeFilter.SHOW_TEXT */);
  for (let t = walk.nextNode(); t; t = walk.nextNode()) if (t.nodeValue?.includes('­')) t.nodeValue = t.nodeValue.replace(/­/g, '');
  return box;
}

/** Texto visible (sin el de las fórmulas, que KaTeX escribe dos veces). */
const plainLength = (box: HTMLElement): number => {
  let n = 0;
  textNodes(box, (t) => {
    n += t.length;
    return false;
  });
  return n;
};

/** Recorre los nodos de texto que no son de una fórmula ni de otro átomo; para cuando `visit` devuelve true. */
function textNodes(box: HTMLElement, visit: (t: Text, before: number) => boolean): void {
  const walk = box.ownerDocument.createTreeWalker(box, 4);
  let before = 0;
  for (let t = walk.nextNode() as Text | null; t; t = walk.nextNode() as Text | null) {
    if (t.parentElement?.closest('.katex, .atom')) continue;
    if (visit(t, before)) return;
    before += t.length;
  }
}

/** Corta `box` en la posición `at` del nodo `t`: todo lo que viene detrás desaparece. */
function cutAfter(box: HTMLElement, t: Text, at: number, tail = ''): void {
  const r = box.ownerDocument.createRange();
  r.setStart(t, at);
  r.setEnd(box, box.childNodes.length);
  r.deleteContents();
  if (tail) t.appendData(tail);
}

/**
 * Se queda con la idea clave: la primera frase. Si no hay punto a tiempo, se corta en una palabra
 * hacia los `MAX_KEY` caracteres y se señala con «…».
 */
export function keySentence(box: HTMLElement): HTMLElement {
  // (un párrafo de una sola frase corta se queda entero)
  textNodes(box, (t, before) => {
    const text = t.data;
    const end = /[.!?…](?=\s+[\p{Lu}¿¡(«"]|\s*$)/gu;
    for (let m = end.exec(text); m; m = end.exec(text)) {
      if (before + m.index + 1 < MIN_SENTENCE) continue;
      cutAfter(box, t, m.index + 1);
      return true;
    }
    if (before + text.length > MAX_KEY) {
      const cut = text.lastIndexOf(' ', Math.max(MAX_KEY - before, 0));
      cutAfter(box, t, cut > 0 ? cut : Math.min(text.length, MAX_KEY - before), '…');
      return true;
    }
    return false;
  });
  return box;
}

type Unit = { kind: 'text'; html: string; size: number } | { kind: 'figure' | 'table' | 'math'; html: string };

/** Lo que aporta un bloque a la presentación. */
function unitsOf(c: HTMLElement, o: DeckOptions): Unit[] {
  const doc = c.ownerDocument;
  const kind = blockKind(c);
  const text = (box: HTMLElement): Unit[] => {
    if (o.text === 'key') keySentence(box);
    const size = plainLength(box);
    return size ? [{ kind: 'text', html: box.innerHTML.trim(), size }] : [];
  };
  switch (kind) {
    case 'head': case 'skip': return [];
    case 'math': return o.math ? [{ kind: 'math', html: copy(c.childNodes, doc).innerHTML }] : [];
    case 'figure': return o.figures ? [{ kind: 'figure', html: copy(c.childNodes, doc).innerHTML }] : [];
    case 'table': return o.tables ? [{ kind: 'table', html: copy(c.childNodes, doc).innerHTML }] : [];
    case 'list': {
      if (!o.lists) return [];
      const list = c.querySelector(':scope > ul, :scope > ol, :scope > dl') as HTMLElement;
      // cada elemento de la lista, una viñeta (con sus sublistas)
      return Array.from(list.children)
        .filter((li) => li.tagName === 'LI' || li.tagName === 'DD')
        .flatMap((li) => text(copy(li.childNodes, doc)));
    }
    default:
      return o.text === 'none' ? [] : text(copy(c.childNodes, doc));
  }
}

/** Las diapositivas de los apartados elegidos, en el orden del documento. */
export function buildSlides(sections: DeckSection[], o: DeckOptions, cover?: HTMLElement, text: CoverText = {}): Slide[] {
  const slides: Slide[] = [];
  const doc = cover?.ownerDocument ?? sections[0]?.blocks[0]?.ownerDocument;
  const fromDoc = coverOf(cover);
  const author = text.author ?? (doc ? plainOf(fromDoc.author, doc) : '');
  const title = text.title ?? (doc ? plainOf(fromDoc.title, doc) : '');
  if (o.cover) slides.push({ kind: 'cover', title: title || 'Presentación', num: '', points: [], html: coverHtml(cover, text) });
  if (o.agenda && sections.length > 1) {
    const top = Math.min(...sections.map((s) => s.level));
    // con muchos apartados, solo los del primer nivel
    const shown = sections.filter((s) => s.level <= top + (sections.filter((x) => x.level <= top + 1).length > 10 ? 0 : 1));
    const items = shown.map((s) => `<li class="ag-l${s.level - top}">${s.num ? `<span class="ag-num">${escHtml(s.num)}</span>` : ''}${escHtml(s.title)}</li>`);
    slides.push({ kind: 'agenda', title: 'Contenido', num: '', points: [], html: `<ol class="agenda${items.length > 7 ? ' two' : ''}">${items.join('')}</ol>` });
  }
  const budget = MAX_CHARS[o.text] || MAX_CHARS.key;
  sections.forEach((s, k) => {
    const units = s.blocks.flatMap((b) => unitsOf(b, o));
    const before = slides.length;
    let points: string[] = [];
    let chars = 0;
    const flush = (media?: string): void => {
      if (points.length || media) slides.push({ kind: points.length ? 'content' : 'media', title: s.title, num: s.num, key: s.key, points, media });
      points = [];
      chars = 0;
    };
    // un apartado del primer nivel con otros debajo abre con su propia portadilla
    if (s.level <= 0 && (sections[k + 1]?.level ?? 0) > s.level) slides.push({ kind: 'part', title: s.title, num: s.num, key: s.key, points: [] });
    for (const u of units) {
      if (u.kind === 'text') {
        if (points.length && (points.length >= MAX_POINTS || chars + u.size > budget)) flush();
        points.push(u.html);
        chars += u.size;
      } else if (u.kind === 'math') {
        if (points.length >= MAX_POINTS) flush();
        points.push(`<div class="s-eq">${u.html}</div>`);
        chars += 80;
      } else if (u.kind === 'figure' && points.length && points.length <= 3 && chars <= 320) {
        // pocas viñetas y una figura: van juntas, la figura al lado
        flush(u.html);
      } else {
        flush();
        flush(u.html);
      }
    }
    flush();
    // un apartado sin nada que mostrar se queda al menos con su título
    if (slides.length === before) slides.push({ kind: 'part', title: s.title, num: s.num, key: s.key, points: [] });
  });
  if (o.closing) slides.push({ kind: 'end', title: o.end?.title ?? CLOSING_DEFAULTS.title, num: '', points: [], html: closingHtml(o.end ?? {}, author) });
  // las que siguen a otra con el mismo título lo llevan como continuación
  slides.forEach((x, k) => {
    const prev = slides[k - 1];
    if (k && (x.kind === 'content' || x.kind === 'media') && prev.title === x.title && prev.num === x.num && prev.kind !== 'part') x.title += ' (cont.)';
  });
  return slides;
}

/** Una diapositiva en HTML, a su tamaño real (1280 × 720). */
export function slideHtml(x: Slide, k: number, total: number, footer: string): string {
  const foot = `<footer class="s-foot"><span>${escHtml(footer)}</span><span>${k + 1} / ${total}</span></footer>`;
  switch (x.kind) {
    case 'cover':
      return `<div class="slide s-cover"><div class="s-cover-body">${x.html || `<div class="doctitle">${escHtml(x.title)}</div>`}</div></div>`;
    case 'part':
      return `<div class="slide s-part"><div class="s-part-body">${x.num ? `<div class="s-part-num">${escHtml(x.num)}</div>` : ''}<h1>${escHtml(x.title)}</h1></div>${foot}</div>`;
    case 'end':
      return `<div class="slide s-end"><div class="s-part-body"><h1>${escHtml(x.title)}</h1>${x.html ?? ''}</div>${foot}</div>`;
    default: {
      const head = `<header class="s-head">${x.num ? `<span class="s-num">${escHtml(x.num)}</span>` : ''}<h1>${escHtml(x.title)}</h1></header>`;
      if (x.kind === 'agenda') return `<div class="slide s-content">${head}<div class="s-body">${x.html ?? ''}</div>${foot}</div>`;
      const pts = x.points.length ? `<ul class="s-points">${x.points.map((p) => (p.startsWith('<div class="s-eq">') ? `<li class="eq">${p}</li>` : `<li>${p}</li>`)).join('')}</ul>` : '';
      const media = x.media ? `<div class="s-media">${x.media}</div>` : '';
      const layout = pts && media ? ' split' : media ? ' only-media' : '';
      return `<div class="slide s-content">${head}<div class="s-body${layout}">${pts ? `<div class="s-text">${pts}</div>` : ''}${media}</div>${foot}</div>`;
    }
  }
}

/** Encoge el texto de una diapositiva hasta que quepa (como hace PowerPoint con el autoajuste). */
function fit(slide: HTMLElement): void {
  const body = slide.querySelector<HTMLElement>('.s-body');
  if (!body) return;
  for (let k = 1; k >= 0.5 && body.scrollHeight > body.clientHeight + 2; k -= 0.06) body.style.fontSize = `${k.toFixed(2)}em`;
}

// ------------------------------------------------------------------ proyectar

let deckEl: HTMLElement | undefined;

/** Proyecta las diapositivas a pantalla completa dentro de la vista, desde la número `start`. */
export function openDeck(slides: Slide[], o: DeckOptions, footer: string, start = 0, onClose?: () => void): void {
  closeDeck();
  if (!slides.length) return;
  const deck = document.createElement('div');
  deck.id = 'deck';
  deck.className = `deck-${o.theme}`;
  deck.tabIndex = -1;
  deck.innerHTML =
    '<div class="deck-stage"></div><div class="deck-grid" hidden></div><div class="deck-black" hidden></div>' +
    '<div class="deck-progress"><i></i></div>' +
    '<div class="deck-bar">' +
    '<button data-deck="prev" title="Anterior (←)"><i class="codicon codicon-chevron-left"></i></button>' +
    '<span class="deck-count"></span>' +
    '<button data-deck="next" title="Siguiente (→, espacio)"><i class="codicon codicon-chevron-right"></i></button>' +
    '<span class="deck-sep"></span>' +
    '<button data-deck="grid" title="Vista general (G)"><i class="codicon codicon-layout"></i></button>' +
    (document.fullscreenEnabled ? '<button data-deck="full" title="Pantalla completa (F)"><i class="codicon codicon-screen-full"></i></button>' : '') +
    '<button data-deck="close" title="Salir (Esc)"><i class="codicon codicon-close"></i></button>' +
    '</div>' +
    '<div class="deck-hint">← → para avanzar · G vista general · B pantalla en negro · Esc para salir</div>';
  document.body.appendChild(deck);
  deckEl = deck;
  // (sin la barra de desplazamiento del documento asomando por el borde)
  document.documentElement.classList.add('deck-on');
  const stage = deck.querySelector('.deck-stage') as HTMLElement;
  const grid = deck.querySelector('.deck-grid') as HTMLElement;
  const black = deck.querySelector('.deck-black') as HTMLElement;
  const bar = deck.querySelector('.deck-bar') as HTMLElement;
  const count = deck.querySelector('.deck-count') as HTMLElement;
  const progress = deck.querySelector('.deck-progress i') as HTMLElement;
  let at = Math.min(Math.max(start, 0), slides.length - 1);

  const scale = (): void => {
    const k = Math.min(deck.clientWidth / 1280, deck.clientHeight / 720);
    deck.style.setProperty('--k', String(k));
  };
  const show = (k: number): void => {
    at = Math.min(Math.max(k, 0), slides.length - 1);
    stage.innerHTML = slideHtml(slides[at], at, slides.length, footer);
    fit(stage.firstElementChild as HTMLElement);
    count.textContent = `${at + 1} / ${slides.length}`;
    progress.style.width = `${((at + 1) / slides.length) * 100}%`;
  };
  const openGrid = (): void => {
    if (!grid.hidden) {
      grid.hidden = true;
      return;
    }
    grid.innerHTML = slides.map((x, k) => `<button class="deck-thumb${k === at ? ' on' : ''}" data-go="${k}"><span class="deck-mini">${slideHtml(x, k, slides.length, footer)}</span><b>${k + 1}</b></button>`).join('');
    grid.hidden = false;
    grid.querySelectorAll<HTMLElement>('.deck-mini > .slide').forEach(fit);
    grid.querySelector('.deck-thumb.on')?.scrollIntoView({ block: 'center' });
  };
  const close = (): void => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    closeDeck();
    onClose?.();
  };
  const act = (what: string): void => {
    if (what === 'next') show(at + 1);
    else if (what === 'prev') show(at - 1);
    else if (what === 'grid') openGrid();
    else if (what === 'close') close();
    else if (what === 'full') {
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      else void deck.requestFullscreen().catch(() => undefined);
    }
  };

  // el teclado es de la presentación mientras está abierta: el documento no recibe nada
  const onKey = (e: KeyboardEvent): void => {
    if (!deck.isConnected) return;
    e.stopImmediatePropagation();
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    e.preventDefault();
    const k = e.key;
    if (!black.hidden && k !== 'Escape') {
      black.hidden = true;
      return;
    }
    if (k === 'Escape') {
      if (!black.hidden) black.hidden = true;
      else if (!grid.hidden) grid.hidden = true;
      else close();
    } else if (!grid.hidden && k === 'Enter') grid.hidden = true;
    else if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n'].includes(k)) {
      grid.hidden = true;
      show(at + 1);
    } else if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'p'].includes(k)) {
      grid.hidden = true;
      show(at - 1);
    } else if (k === 'Home') show(0);
    else if (k === 'End') show(slides.length - 1);
    else if (k === 'g' || k === 'G' || k === 'o') openGrid();
    else if (k === 'b' || k === 'B' || k === '.') black.hidden = false;
    else if (k === 'f' || k === 'F') act('full');
  };
  const onKeyUp = (e: KeyboardEvent): void => e.stopImmediatePropagation();
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('keyup', onKeyUp, true);
  deck.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const btn = t.closest<HTMLElement>('[data-deck]');
    if (btn) return act(btn.dataset.deck as string);
    const thumb = t.closest<HTMLElement>('[data-go]');
    if (thumb) {
      grid.hidden = true;
      return show(Number(thumb.dataset.go));
    }
    if (!black.hidden) {
      black.hidden = true;
      return;
    }
    // clic en el tercio izquierdo: atrás; en el resto: adelante
    if (t.closest('.deck-stage') || t === deck) show(e.clientX < deck.clientWidth / 3 ? at - 1 : at + 1);
  });
  // la barra se esconde sola cuando el ratón no se mueve
  let idle = 0;
  deck.addEventListener('mousemove', () => {
    bar.classList.add('on');
    window.clearTimeout(idle);
    idle = window.setTimeout(() => bar.classList.remove('on'), 2200);
  });
  const resize = new ResizeObserver(scale);
  resize.observe(deck);
  (deck as HTMLElement & { _stop?: () => void })._stop = () => {
    window.removeEventListener('keydown', onKey, true);
    window.removeEventListener('keyup', onKeyUp, true);
    resize.disconnect();
  };
  scale();
  show(at);
  deck.focus();
  window.setTimeout(() => deck.querySelector('.deck-hint')?.classList.add('gone'), 3500);
}

export function closeDeck(): void {
  const d = deckEl as (HTMLElement & { _stop?: () => void }) | undefined;
  d?._stop?.();
  d?.remove();
  deckEl = undefined;
  document.documentElement.classList.remove('deck-on');
}

export const isDeckOpen = (): boolean => deckEl?.isConnected === true;
