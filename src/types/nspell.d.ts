declare module 'nspell' {
  interface NSpell {
    correct(word: string): boolean;
    suggest(word: string): string[];
    add(word: string): this;
    remove(word: string): this;
  }
  /** Corrector Hunspell en JavaScript: recibe el contenido de los archivos .aff y .dic. */
  function nspell(aff: Uint8Array | string, dic?: Uint8Array | string): NSpell;
  export = nspell;
}
