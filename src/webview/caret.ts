/*
 * Posición del cursor en "unidades": cada carácter de texto cuenta 1, cada átomo cuenta 1 y las
 * decoraciones cuentan 0. Así la posición sobrevive a que el bloque se vuelva a renderizar.
 */

const isEl = (n: Node): n is Element => n.nodeType === 1;
const isSkip = (n: Node): boolean => isEl(n) && n.hasAttribute('data-skip');
const isAtom = (n: Node): boolean => isEl(n) && n.hasAttribute('data-tex');

export function units(node: Node): number {
  let total = 0;
  for (const ch of Array.from(node.childNodes)) {
    if (ch.nodeType === 3) total += (ch as Text).length;
    else if (isSkip(ch)) continue;
    else if (isAtom(ch)) total += 1;
    else if (isEl(ch)) total += units(ch);
  }
  return total;
}

/** Unidades que hay en `root` antes del punto (node, offset). */
export function offsetOf(root: Element, node: Node, offset: number): number {
  const pre = root.ownerDocument.createRange();
  pre.selectNodeContents(root);
  pre.setEnd(node, offset);
  return units(pre.cloneContents());
}

export function caretOffset(root: Element): number | undefined {
  const sel = root.ownerDocument.getSelection();
  if (!sel || !sel.rangeCount) return undefined;
  const r = sel.getRangeAt(0);
  if (!root.contains(r.startContainer)) return undefined;
  return offsetOf(root, r.startContainer, r.startOffset);
}

type Pos = { node: Node; offset: number };

function locate(node: Node, remaining: number): Pos | number {
  const kids = Array.from(node.childNodes);
  for (let i = 0; i < kids.length; i++) {
    const ch = kids[i];
    if (ch.nodeType === 3) {
      const len = (ch as Text).length;
      if (remaining <= len) return { node: ch, offset: remaining };
      remaining -= len;
    } else if (isSkip(ch)) continue;
    else if (isAtom(ch)) {
      if (remaining === 0) return { node, offset: i };
      remaining -= 1;
    } else if (isEl(ch)) {
      const r = locate(ch, remaining);
      if (typeof r !== 'number') return r;
      if (remaining === 0) return { node: ch, offset: ch.childNodes.length };
      remaining = r;
    }
  }
  return remaining;
}

/** Punto del DOM que corresponde a una posición en unidades (el final de `root` si se pasa de largo). */
export function pointAt(root: Element, offset: number): Pos {
  const r = locate(root, Math.max(offset, 0));
  return typeof r === 'number' ? { node: root, offset: root.childNodes.length } : r;
}

/**
 * Envuelve en un elemento nuevo el texto que abarca `range`, tramo a tramo: cada nodo de texto
 * recibe su propio envoltorio, de modo que la estructura (elementos de lista, celdas, párrafos)
 * queda intacta aunque el rango la atraviese. No toca fórmulas ni adornos.
 */
export function wrapRange(range: Range, make: () => HTMLElement, already?: string): void {
  const doc = range.startContainer.ownerDocument as Document;
  const scope = range.commonAncestorContainer;
  const texts: Text[] = [];
  if (scope.nodeType === 3) texts.push(scope as Text);
  else {
    const walker = doc.createTreeWalker(scope, 4 /* NodeFilter.SHOW_TEXT */);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (range.intersectsNode(n)) texts.push(n as Text);
  }
  const { startContainer, startOffset, endContainer, endOffset } = range;
  for (let t of texts) {
    if (t.parentElement?.closest('[data-tex], [data-skip]')) continue;
    // lo que ya tiene ese formato (selector `already`) se deja como está
    if (already && t.parentElement?.closest(already)) continue;
    // primero el final: partir por el principio cambiaría sus posiciones
    if (t === endContainer && endOffset < t.length) t.splitText(endOffset);
    if (t === startContainer && startOffset > 0) t = t.splitText(startOffset);
    if (!t.data.trim()) continue;
    // los saltos de línea de los bordes quedan fuera: si delante hay un comentario, la apertura
    // del comando caería dentro de él y el documento quedaría con una llave sin cerrar
    const lead = /^\s*\n\s*/.exec(t.data);
    if (lead) t = t.splitText(lead[0].length);
    const trail = /\s*\n\s*$/.exec(t.data);
    if (trail) t.splitText(trail.index);
    const prev = t.previousSibling;
    const w = make();
    if (prev?.nodeType === 1 && (prev as Element).tagName === w.tagName && (prev as Element).getAttribute('data-o') === w.getAttribute('data-o') && (prev as Element & { _wrap?: boolean })._wrap) {
      // seguido de otro tramo recién envuelto con lo mismo: se une a él
      prev.appendChild(t);
      continue;
    }
    (w as HTMLElement & { _wrap?: boolean })._wrap = true;
    t.parentNode?.insertBefore(w, t);
    w.appendChild(t);
  }
}

export function setCaretOffset(root: Element, offset: number): void {
  const pos = pointAt(root, offset);
  const range = root.ownerDocument.createRange();
  range.setStart(pos.node, pos.offset);
  range.collapse(true);
  const sel = root.ownerDocument.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

export function caretToEnd(root: Element): void {
  setCaretOffset(root, units(root));
}
