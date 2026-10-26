/** Citas bibliográficas en el código de un bloque: `\cite{a}`, `\citep[p. 3]{a, b}`, `\nocite{*}`... */

/** Una orden de cita con sus argumentos opcionales; el grupo 1 son sus claves. */
export const CITE = /\\(?:[a-zA-Z]*cite[a-zA-Z]*|nocite)\*?\s*(?:\[[^\]]*\]\s*)*\{([^}]*)\}/g;

/** ¿Está la posición `at` dentro de un comentario (detrás de un `%` sin escapar en su línea)? */
function commented(src: string, at: number): boolean {
  const start = src.lastIndexOf('\n', at - 1) + 1;
  return /(^|[^\\])%/.test(src.slice(start, at));
}

/** Las citas del código que se ven en el documento (las comentadas no), en orden. */
export function citesIn(src: string): { at: number; text: string; keys: string[] }[] {
  return [...src.matchAll(CITE)]
    .filter((m) => !commented(src, m.index ?? 0))
    .map((m) => ({ at: m.index ?? 0, text: m[0], keys: m[1].split(',').map((k) => k.trim()).filter(Boolean) }));
}

/**
 * Quita `key` de la cita número `nth` (contando solo las que la citan) del código `src`. Si la
 * cita tenía más claves se queda con las demás; si era la única, se va la orden entera con el
 * espacio que la separaba del texto. Sin esa cita, `undefined`.
 */
export function removeCite(src: string, key: string, nth: number): string | undefined {
  const hit = citesIn(src).filter((c) => c.keys.includes(key))[nth];
  if (!hit) return undefined;
  const end = hit.at + hit.text.length;
  const rest = hit.keys.filter((k) => k !== key);
  if (rest.length) {
    const open = hit.text.lastIndexOf('{');
    const sep = /,\s/.test(hit.text.slice(open)) ? ', ' : ',';
    return src.slice(0, hit.at) + hit.text.slice(0, open + 1) + rest.join(sep) + '}' + src.slice(end);
  }
  // «Según \cite{a}.» -> «Según.»; al principio de una línea se lleva el espacio de detrás
  let a = hit.at;
  let b = end;
  while (a > 0 && ' \t~'.includes(src[a - 1])) a--;
  if (a === 0 || src[a - 1] === '\n') {
    a = hit.at;
    while (b < src.length && ' \t~'.includes(src[b])) b++;
  }
  return src.slice(0, a) + src.slice(b);
}
