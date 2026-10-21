/*
 * Referencias bibliográficas traídas de fuera: a partir de un DOI (doi.org devuelve la entrada
 * en BibTeX) o elegidas en Zotero (complemento Better BibTeX). Sin dependencias de VS Code.
 */

export interface BibEntry {
  /** article, book, misc... */
  type: string;
  key: string;
  fields: Record<string, string>;
}

/** Lee el valor de un campo a partir de `i`: entre llaves, entre comillas o suelto (número o abreviatura). */
function readValue(text: string, start: number): { value: string; end: number } {
  let i = start;
  let value = '';
  for (;;) {
    while (/\s/.test(text[i] ?? '')) i++;
    const c = text[i];
    if (c === '{') {
      let depth = 0;
      const from = i + 1;
      for (; i < text.length; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === '{') depth++;
        else if (text[i] === '}' && --depth === 0) break;
      }
      value += text.slice(from, i);
      i++;
    } else if (c === '"') {
      const from = ++i;
      let depth = 0;
      for (; i < text.length; i++) {
        if (text[i] === '\\') i++;
        else if (text[i] === '{') depth++;
        else if (text[i] === '}') depth--;
        else if (text[i] === '"' && depth === 0) break;
      }
      value += text.slice(from, i);
      i++;
    } else {
      const m = /^[^\s,#}]+/.exec(text.slice(i));
      if (!m) break;
      value += m[0];
      i += m[0].length;
    }
    while (/\s/.test(text[i] ?? '')) i++;
    // «#» concatena trozos
    if (text[i] !== '#') break;
    i++;
  }
  return { value, end: i };
}

/** Entradas de un texto BibTeX. Tolera lo que devuelven doi.org y Zotero; ignora @comment, @string y @preamble. */
export function parseBibtex(text: string): BibEntry[] {
  const out: BibEntry[] = [];
  const head = /@([a-zA-Z]+)\s*\{\s*([^,\s{}]+)\s*,/g;
  for (let m = head.exec(text); m; m = head.exec(text)) {
    const type = m[1].toLowerCase();
    if (type === 'comment' || type === 'string' || type === 'preamble') continue;
    const fields: Record<string, string> = {};
    let i = head.lastIndex;
    for (;;) {
      const f = /^\s*([a-zA-Z][\w-]*)\s*=\s*/.exec(text.slice(i));
      if (!f) break;
      const v = readValue(text, i + f[0].length);
      fields[f[1].toLowerCase()] = v.value.replace(/\s+/g, ' ').trim();
      i = v.end;
      if (text[i] === ',') i++;
    }
    out.push({ type, key: m[2], fields });
    head.lastIndex = i;
  }
  return out;
}

/** Autores de un campo `author`: separados por «and» (fuera de llaves), con apellidos y nombre aparte. */
export function authors(field: string): { last: string; first: string }[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  const words = field.replace(/\s+/g, ' ').trim();
  for (let i = 0; i < words.length; i++) {
    const ch = words[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    if (depth === 0 && words.startsWith(' and ', i)) {
      parts.push(cur);
      cur = '';
      i += 4;
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts.map((p) => {
    const name = p.trim();
    // entre llaves: una institución, que se cita entera
    if (/^\{.*\}$/.test(name)) return { last: name.slice(1, -1), first: '' };
    if (name.includes(',')) {
      const [last, ...rest] = name.split(',');
      return { last: last.trim(), first: rest.join(',').trim() };
    }
    const bits = name.split(' ');
    return { last: bits.pop() ?? '', first: bits.join(' ') };
  });
}

/** Autores como se citan en el texto: «Codd», «Elmasri and Navathe», «Chu et al.». */
export function citeAuthors(e: BibEntry): string {
  const list = authors(e.fields.author ?? e.fields.editor ?? '');
  if (!list.length) return e.key;
  if (list.length === 1) return list[0].last;
  return list.length === 2 ? `${list[0].last} and ${list[1].last}` : `${list[0].last} et al.`;
}

export const citeYear = (e: BibEntry): string => /\d{4}[a-z]?/.exec(e.fields.year ?? e.fields.date ?? '')?.[0] ?? 's.f.';

/** Autores como van en la lista de referencias: «Elmasri, R. and Navathe, S. B.». */
export function referenceAuthors(e: BibEntry): string {
  const list = authors(e.fields.author ?? e.fields.editor ?? '').map((a) => {
    const initials = a.first
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => w.split('-').map((x) => (x ? x[0] + '.' : '')).join('-'))
      .join(' ');
    return initials ? `${a.last}, ${initials}` : a.last;
  });
  if (list.length <= 1) return list[0] ?? '';
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(', ')}, and ${list[list.length - 1]}`;
}

/** Quita las llaves que solo protegen mayúsculas («{DNA}») y deja el resto del LaTeX como está. */
const unbrace = (s: string): string => s.replace(/\{([^{}\\]*)\}/g, '$1');

/** Deja un valor de BibTeX listo para ir en el texto del documento. */
function clean(s: string): string {
  return unbrace(unbrace(s))
    .replace(/&amp;/g, '&')
    .replace(/(^|[^\\])([&%#])/g, '$1\\$2')
    .replace(/\s+/g, ' ')
    .trim();
}

/** «Apellido, Nombre and Otro, Nombre» -> «Apellido, Nombre; Otro, Nombre». */
const people = (s: string): string =>
  clean(s)
    .split(/\s+and\s+/i)
    .map((a) => a.replace(/[,\s]+$/, ''))
    .filter(Boolean)
    .join('; ');

/** Primer apellido del primer autor, para construir la clave. */
function surname(author: string): string {
  const first = unbrace(unbrace(author)).split(/\s+and\s+/i)[0] ?? '';
  const last = first.includes(',') ? first.split(',')[0] : first.trim().split(/\s+/).pop() ?? '';
  return last
    .replace(/\\[a-zA-Z]+|\\./g, '')
    .normalize('NFD')
    .replace(/[^a-zA-Z]/g, '')
    .toLowerCase();
}

/** Clave para citar: apellido del primer autor y año («lecun2015»); si no hay, la clave original. */
export function citeKey(e: BibEntry): string {
  const year = /\d{4}/.exec(e.fields.year ?? e.fields.date ?? '')?.[0] ?? '';
  const base = surname(e.fields.author ?? e.fields.editor ?? '').slice(0, 18) + year;
  return base.length > 2 ? base : e.key.replace(/[^\w:.-]/g, '') || 'fuente';
}

/** Texto corto para la lista de fuentes: autor, título y año. */
export function sourceLabel(e: BibEntry): string {
  const f = e.fields;
  return [people(f.author ?? f.editor ?? ''), clean(f.title ?? ''), f.year ?? ''].filter(Boolean).join('. ').slice(0, 90);
}

/** Línea `\bibitem` equivalente a la entrada, para documentos que llevan la bibliografía escrita a mano. */
export function bibitem(e: BibEntry, key = e.key): string {
  const f = e.fields;
  const where = clean(f.journal ?? f.journaltitle ?? f.booktitle ?? f.publisher ?? f.howpublished ?? '');
  const detail = [
    f.volume ? `vol.~${clean(f.volume)}` : '',
    f.number ? `n.º~${clean(f.number)}` : '',
    f.pages ? `pp.~${clean(f.pages).replace(/[-–—]+/g, '--')}` : '',
  ].filter(Boolean);
  const year = /\d{4}/.exec(f.year ?? f.date ?? '')?.[0] ?? '';
  const parts = [
    people(f.author ?? f.editor ?? ''),
    f.title ? `\\textit{${clean(f.title)}}` : '',
    [where, ...detail].filter(Boolean).join(', '),
    year,
    f.doi ? `doi:${f.doi.replace(/([_%#&])/g, '\\$1')}` : '',
  ].filter(Boolean);
  return `\\bibitem{${key}} ${parts.join('. ')}.`;
}

/** La entrada como texto BibTeX, con otra clave si hace falta. */
export function bibtex(e: BibEntry, key = e.key): string {
  const body = Object.entries(e.fields).map(([k, v]) => `  ${k} = {${v}}`);
  return `@${e.type}{${key},\n${body.join(',\n')}\n}`;
}

/** DOI contenido en lo que haya escrito el usuario: suelto, con «doi:» delante o como dirección web. */
export function normalizeDoi(input: string): string | undefined {
  let raw = input.trim();
  try {
    raw = decodeURIComponent(raw);
  } catch {
    // no era una dirección codificada: se usa tal cual
  }
  const m = /10\.\d{4,9}\/[^\s"<>]+/.exec(raw);
  return m?.[0].replace(/[.,;)]+$/, '');
}

type Fetch = typeof fetch;

async function text(res: Response, what: string): Promise<string> {
  if (!res.ok) throw new Error(`${what} (${res.status})`);
  return res.text();
}

/** Entrada BibTeX de un DOI, pedida a doi.org (que la sirve Crossref, DataCite...). */
export async function fetchDoi(doi: string, fetcher: Fetch = fetch): Promise<string> {
  const res = await fetcher(`https://doi.org/${encodeURI(doi)}`, {
    headers: { Accept: 'application/x-bibtex; charset=utf-8' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  if (res.status === 404) throw new Error(`no existe el DOI ${doi}`);
  return text(res, 'doi.org no ha devuelto la referencia');
}

/**
 * Abre el selector de citas de Zotero (Better BibTeX, «cite as you write») y devuelve las claves
 * elegidas; lista vacía si el usuario cancela. `base` es la dirección local de Zotero.
 */
export async function zoteroPick(base: string, fetcher: Fetch = fetch): Promise<string[]> {
  const probe = await fetcher(`${base}/better-bibtex/cayw?probe=true`, { signal: AbortSignal.timeout(3000) });
  if (!probe.ok) throw new Error('Zotero responde, pero no tiene el complemento Better BibTeX');
  // sin límite corto: el usuario tarda lo que tarde en elegir
  const res = await fetcher(`${base}/better-bibtex/cayw?format=latex&command=cite`, { signal: AbortSignal.timeout(10 * 60 * 1000) });
  const picked = await text(res, 'Zotero no ha devuelto la cita');
  const keys = /\{([^{}]*)\}\s*$/.exec(picked.trim())?.[1] ?? '';
  return keys.split(',').map((k) => k.trim()).filter(Boolean);
}

/** Entradas BibTeX de unas claves de Zotero (JSON-RPC de Better BibTeX). */
export async function zoteroExport(base: string, keys: string[], fetcher: Fetch = fetch): Promise<string> {
  const res = await fetcher(`${base}/better-bibtex/json-rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'item.export', params: [keys, 'Better BibTeX'] }),
    signal: AbortSignal.timeout(20000),
  });
  const reply = JSON.parse(await text(res, 'Zotero no ha exportado las referencias')) as { result?: unknown; error?: { message?: string } };
  if (reply.error) throw new Error(reply.error.message ?? 'Zotero no ha exportado las referencias');
  // según la versión, el resultado es el texto o una lista [estado, tipo, texto]
  const parts = Array.isArray(reply.result) ? reply.result : [reply.result];
  return parts.filter((p): p is string => typeof p === 'string' && p.includes('@')).join('\n');
}
