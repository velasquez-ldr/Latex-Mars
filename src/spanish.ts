/*
 * Formación regular de palabras en español. Los diccionarios Hunspell no traen todas las palabras
 * que la lengua forma con reglas regulares: adverbios en -mente, prefijos, y derivados de verbos y
 * adjetivos («optimizador», «cardinalidad», «sintácticamente»). El corrector las da por buenas si
 * su base está en el diccionario.
 */

/** Prefijos productivos del español: «subconsulta», «reescritura», «plurinacional»... */
const PREFIXES = [
  'anti', 'auto', 'bi', 'ciber', 'co', 'contra', 'des', 'entre', 'extra', 'hiper', 'hipo', 'infra', 'inter', 'intra', 'macro', 'mega', 'meta', 'micro',
  'mini', 'mono', 'multi', 'neo', 'pluri', 'poli', 'pos', 'post', 'pre', 'pseudo', 're', 'semi', 'sobre', 'sub', 'super', 'supra', 'tele', 'trans', 'tri', 'ultra', 'uni',
];
/** Terminaciones regulares sobre un verbo: [terminación, infinitivos posibles]. */
const VERBAL: [RegExp, string[]][] = [
  [/(?:ador|adora|adores|adoras|able|ables|ación|aciones|amiento|amientos|ado|ada|ados|adas)$/, ['ar']],
  [/(?:edor|edora|edores|edoras|idor|idora|idores|idoras|ible|ibles|ición|iciones|imiento|imientos|ido|ida|idos|idas)$/, ['er', 'ir']],
];

/** ¿Es `word` un derivado regular de alguna palabra que `known` reconoce? */
export function derivedSpanish(word: string, known: (w: string) => boolean, depth = 0): boolean {
  const w = word.toLowerCase();
  if (w.length < 6) return false;
  if (w.endsWith('mente') && known(w.slice(0, -5))) return true;
  for (const [ending, infinitives] of VERBAL) {
    const m = ending.exec(w);
    if (m && m.index >= 3 && infinitives.some((inf) => known(w.slice(0, m.index) + inf))) return true;
  }
  let m = /(?:idad|idades)$/.exec(w);
  if (m && m.index >= 4 && [w.slice(0, m.index), w.slice(0, m.index) + 'o', w.slice(0, m.index) + 'e'].some(known)) return true;
  m = /(?:al|ales)$/.exec(w);
  if (m && m.index >= 4 && [w.slice(0, m.index) + 'a', w.slice(0, m.index) + 'o'].some(known)) return true;
  if (depth > 0) return false;
  for (const p of PREFIXES) {
    if (!w.startsWith(p) || w.length - p.length < 4) continue;
    const rest = w.slice(p.length);
    // tras prefijo, una erre inicial se duplica: «correlacionar», «prerrequisito»
    const bases = rest.startsWith('rr') ? [rest, rest.slice(1)] : [rest];
    if (bases.some((b) => known(b) || derivedSpanish(b, known, 1))) return true;
  }
  return false;
}
