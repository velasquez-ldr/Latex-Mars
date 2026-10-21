import * as fs from 'fs';
import * as path from 'path';
import { Worker } from 'worker_threads';

/** Idiomas con diccionario incluido: código -> nombre de la opción `babel` que lo activa. */
export const SPELL_LANGS: Record<string, string> = { es: 'spanish', en: 'english' };
/** Otros nombres con que babel y polyglossia llaman a esos mismos idiomas (variantes regionales). */
const VARIANTS: Record<string, string> = {
  british: 'en', ukenglish: 'en', american: 'en', usenglish: 'en', australian: 'en', canadian: 'en', newzealand: 'en',
  castilian: 'es', mexican: 'es', espanol: 'es',
};

/**
 * Idiomas con los que se corrige un documento. `choice` es el ajuste del usuario («auto», «es»,
 * «en» o «es+en»); en automático manda el idioma declarado con babel y, si no hay, el de VS Code.
 */
export function spellLangs(choice: string, babel: string | undefined, uiLanguage: string): string[] {
  if (choice && choice !== 'auto') return choice.split('+').filter((l) => l in SPELL_LANGS);
  if (babel) {
    const lang = VARIANTS[babel.toLowerCase()] ?? Object.keys(SPELL_LANGS).find((l) => SPELL_LANGS[l] === babel);
    return lang ? [lang] : []; // idioma sin diccionario: no se corrige, en vez de marcarlo todo
  }
  return [uiLanguage.toLowerCase().startsWith('es') ? 'es' : 'en'];
}

interface Reply {
  id: number;
  bad?: string[];
  list?: string[];
}

/**
 * Corrector ortográfico (Hunspell mediante nspell) en un hilo aparte, que se arranca la primera
 * vez que hace falta. Las palabras añadidas por el usuario se guardan con `persist`.
 */
export class Spell {
  private worker: Worker | undefined;
  private seq = 0;
  private readonly waiting = new Map<number, (r: Reply) => void>();

  constructor(
    private readonly root: string,
    private words: string[],
    private readonly persist: (words: string[]) => void,
  ) {}

  /** Archivos del diccionario de un idioma: los empaquetados con la extensión o los de node_modules. */
  private files(lang: string): { aff: string; dic: string } | undefined {
    const options = [
      { aff: path.join(this.root, 'dict', `${lang}.aff`), dic: path.join(this.root, 'dict', `${lang}.dic`) },
      { aff: path.join(this.root, 'node_modules', `dictionary-${lang}`, 'index.aff'), dic: path.join(this.root, 'node_modules', `dictionary-${lang}`, 'index.dic') },
    ];
    return options.find((o) => fs.existsSync(o.aff) && fs.existsSync(o.dic));
  }

  has(lang: string): boolean {
    return lang in SPELL_LANGS && this.files(lang) !== undefined;
  }

  get userWords(): string[] {
    return this.words;
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const dicts: Record<string, { aff: string; dic: string }> = {};
    for (const lang of Object.keys(SPELL_LANGS)) {
      const f = this.files(lang);
      if (f) dicts[lang] = f;
    }
    const w = new Worker(path.join(__dirname, 'spellWorker.js'), { workerData: { dicts, words: this.words } });
    w.on('message', (m: Reply) => {
      const done = this.waiting.get(m.id);
      this.waiting.delete(m.id);
      done?.(m);
    });
    const stop = (err?: unknown): void => {
      if (err) console.error('[mars] corrector ortográfico:', err);
      if (this.worker === w) this.worker = undefined;
      // lo que estuviera pendiente se da por bueno: mejor no subrayar que subrayar de más
      for (const done of this.waiting.values()) done({ id: 0 });
      this.waiting.clear();
    };
    w.on('error', stop);
    w.on('exit', () => stop());
    w.unref();
    this.worker = w;
    return w;
  }

  private ask(msg: Record<string, unknown>): Promise<Reply> {
    return new Promise((resolve) => {
      const id = ++this.seq;
      this.waiting.set(id, resolve);
      try {
        this.start().postMessage({ id, ...msg });
      } catch (err) {
        console.error('[mars] corrector ortográfico:', err);
        this.waiting.delete(id);
        resolve({ id });
      }
    });
  }

  /** De `words`, las que ningún idioma de `langs` reconoce. */
  async check(langs: string[], words: string[]): Promise<string[]> {
    const usable = langs.filter((l) => this.has(l));
    if (!usable.length || !words.length) return [];
    return (await this.ask({ op: 'check', langs: usable, words })).bad ?? [];
  }

  async suggest(langs: string[], word: string): Promise<string[]> {
    const usable = langs.filter((l) => this.has(l));
    if (!usable.length) return [];
    return (await this.ask({ op: 'suggest', langs: usable, word })).list ?? [];
  }

  /** Añade una palabra al diccionario personal. */
  add(word: string): void {
    const w = word.trim();
    if (!w) return;
    if (!this.words.includes(w)) {
      this.words = [...this.words, w];
      this.persist(this.words);
    }
    this.worker?.postMessage({ op: 'add', words: [w] });
  }

  dispose(): void {
    void this.worker?.terminate();
    this.worker = undefined;
  }
}
