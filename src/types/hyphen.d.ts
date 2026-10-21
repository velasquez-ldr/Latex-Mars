// Patrones de división de palabras de TeX (paquete `hyphen`): un módulo por idioma.
declare module 'hyphen/*' {
  export function hyphenateSync(text: string, options?: { hyphenChar?: string; minWordLength?: number }): string;
}
