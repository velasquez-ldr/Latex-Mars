/*
 * División de palabras al final de línea. LaTeX parte las palabras con guion al justificar; sin eso
 * los párrafos ocupan más líneas que en el PDF y las hojas cortan en otro punto. El navegador de
 * VS Code no trae diccionarios de división, así que Mars marca él mismo dónde puede partirse cada
 * palabra.
 *
 * Cada marca es un elemento vacío cuyo guion opcional (U+00AD) lo pone la hoja de estilos como
 * contenido generado: el texto del documento no cambia, de modo que ni el cursor, ni la selección,
 * ni la conversión a LaTeX, ni el corrector ortográfico se enteran.
 */

import { hyphenateSync as ca } from 'hyphen/ca';
import { hyphenateSync as de } from 'hyphen/de-1996';
import { hyphenateSync as enUs } from 'hyphen/en-us';
import { hyphenateSync as fr } from 'hyphen/fr';
import { hyphenateSync as it } from 'hyphen/it';
import { hyphenateSync as pt } from 'hyphen/pt';

const VOWELS = 'aeiouáéíóúü';
const isVowel = (ch: string): boolean => VOWELS.includes(ch);
/** Consonantes que empiezan sílaba juntas («pro-ble-ma», «co-che», «pe-rro»). */
const ONSETS = new Set(['pr', 'pl', 'br', 'bl', 'tr', 'dr', 'cr', 'cl', 'gr', 'gl', 'fr', 'fl', 'ch', 'll', 'rr']);
/** Prefijos tras los que la sílaba no sigue la regla general: «sub-rayar», «post-rema». */
const PREFIX = /^(?:sub|post)(?=[rl])/;

/**
 * Puntos por los que puede partirse una palabra española, según la división silábica: una
 * consonante entre vocales va con la vocal siguiente, dos se reparten (salvo los grupos que
 * empiezan sílaba) y las vocales seguidas nunca se separan. Como hace LaTeX con `babel`, a cada
 * lado quedan al menos dos letras.
 */
export function spanishBreaks(word: string): number[] {
  const w = word.toLowerCase();
  const n = w.length;
  const out: number[] = [];
  const prefix = PREFIX.exec(w)?.[0].length ?? 0;
  if (prefix) out.push(prefix);
  let i = prefix;
  while (i < n && !isVowel(w[i])) i++;
  while (i < n) {
    while (i < n && isVowel(w[i])) i++;
    const from = i;
    while (i < n && !isVowel(w[i])) i++;
    // las consonantes finales se quedan con su sílaba
    if (i >= n) break;
    if (i > from) out.push(i - (i - from >= 2 && ONSETS.has(w.slice(i - 2, i)) ? 2 : 1));
  }
  return out.filter((p) => p >= 2 && n - p >= 2);
}

/**
 * División con los patrones de TeX (los mismos que usa LaTeX), para los idiomas que no siguen una
 * regla silábica sencilla. `left` y `right`: letras que como mínimo quedan a cada lado del corte.
 */
function byPatterns(hyphenateSync: (text: string, options: { hyphenChar: string }) => string, left: number, right: number): (word: string) => number[] {
  const MARK = '\u0001';
  return (word) => {
    const out: number[] = [];
    let at = 0;
    for (const part of hyphenateSync(word, { hyphenChar: MARK }).split(MARK).slice(0, -1)) {
      at += part.length;
      if (at >= left && word.length - at >= right) out.push(at);
    }
    return out;
  };
}

const english = byPatterns(enUs, 2, 3);
/** Idiomas (nombre de `babel`) para los que Mars sabe dividir palabras. */
const BREAKERS: Record<string, (word: string) => number[]> = {
  spanish: spanishBreaks, galician: spanishBreaks,
  catalan: byPatterns(ca, 2, 2),
  english, american: english, USenglish: english, british: english, UKenglish: english, australian: english, canadian: english,
  french: byPatterns(fr, 2, 2), francais: byPatterns(fr, 2, 2),
  german: byPatterns(de, 2, 2), ngerman: byPatterns(de, 2, 2), austrian: byPatterns(de, 2, 2), naustrian: byPatterns(de, 2, 2),
  portuguese: byPatterns(pt, 2, 3), brazilian: byPatterns(pt, 2, 3), brazil: byPatterns(pt, 2, 3), portuges: byPatterns(pt, 2, 3),
  italian: byPatterns(it, 2, 2),
  // sin babel, LaTeX divide con los patrones del inglés
  '': english,
};

export const canHyphenate = (lang: string | undefined): boolean => BREAKERS[lang ?? ''] !== undefined;

const WORD = /\p{L}{5,}/gu;
/** Elementos en los que LaTeX no parte palabras, o que no son texto del documento. */
const OPAQUE = new Set(['CODE', 'PRE', 'A', 'H1', 'H2', 'H3', 'H4', 'TABLE', 'SVG', 'MATH', 'BUTTON']);

const isShy = (n: Node | null): n is HTMLElement => n?.nodeType === 1 && (n as Element).classList.contains('shy');

/**
 * Marca los puntos de división de las palabras de `root`. Solo en texto justificado: en el
 * centrado o alineado a un lado LaTeX apenas parte palabras, y tampoco lo hace en títulos, código
 * ni tablas.
 */
export function hyphenate(root: HTMLElement, lang: string | undefined): void {
  const breaks = BREAKERS[lang ?? ''];
  if (!breaks) return;
  const justified = new Map<Element, boolean>();
  const isJustified = (el: Element): boolean => {
    let j = justified.get(el);
    if (j === undefined) {
      j = getComputedStyle(el).textAlign === 'justify';
      justified.set(el, j);
    }
    return j;
  };
  const texts: Text[] = [];
  const walk = (node: Node): void => {
    for (let ch = node.firstChild; ch; ch = ch.nextSibling) {
      if (ch.nodeType === 3) {
        if ((ch as Text).data.trim()) texts.push(ch as Text);
        continue;
      }
      if (ch.nodeType !== 1) continue;
      const el = ch as Element;
      if (OPAQUE.has(el.tagName.toUpperCase()) || el.hasAttribute('data-tex') || el.hasAttribute('data-skip') || el.getAttribute('data-k') === 'head') continue;
      if (el.classList.contains('shy') || el.classList.contains('deco')) continue;
      walk(el);
    }
  };
  walk(root);
  // la última palabra no se parte: dejaría una sílaba suelta en la última línea del párrafo
  let lastText: Text | undefined;
  let lastAt = -1;
  for (let k = texts.length - 1; k >= 0 && !lastText; k--) {
    const words = [...texts[k].data.matchAll(/\p{L}+/gu)];
    if (!words.length) continue;
    lastText = texts[k];
    lastAt = words[words.length - 1].index;
  }
  for (const text of texts) {
    const parent = text.parentElement;
    if (!parent || !isJustified(parent)) continue;
    // de atrás hacia delante: partir el nodo no cambia las posiciones que quedan por tratar
    const cuts: number[] = [];
    for (const m of text.data.matchAll(WORD)) {
      if (text === lastText && m.index >= lastAt) continue;
      for (const p of breaks(m[0])) cuts.push(m.index + p);
    }
    for (let k = cuts.length - 1; k >= 0; k--) {
      const tail = text.splitText(cuts[k]);
      const shy = document.createElement('span');
      shy.className = 'shy';
      parent.insertBefore(shy, tail);
    }
  }
}

/** Quita las marcas de división de `root` y vuelve a unir el texto que separaban. */
export function unhyphenate(root: HTMLElement): void {
  root.querySelectorAll('.shy').forEach((m) => m.remove());
  root.normalize();
}

/**
 * Al escribir dentro de una palabra sus puntos de división dejan de valer: se quitan los que
 * tocan el texto donde está el cursor (se vuelven a calcular cuando el bloque se redibuja).
 */
export function dropHyphensAt(node: Node | null): void {
  if (node?.nodeType !== 3) return;
  for (let t = node as Text; isShy(t.previousSibling); ) {
    const before = t.previousSibling.previousSibling;
    t.previousSibling.remove();
    if (before?.nodeType !== 3 || /\s/.test((before as Text).data)) break;
    t = before as Text;
  }
  for (let t = node as Text; isShy(t.nextSibling); ) {
    const after = t.nextSibling.nextSibling;
    t.nextSibling.remove();
    if (after?.nodeType !== 3 || /\s/.test((after as Text).data)) break;
    t = after as Text;
  }
}
