# Componentes de terceros incluidos en Mars

Mars se distribuye bajo licencia MIT. El paquete incluye, sin modificar, estos componentes de otros
autores. Los textos completos de las licencias de lo que va dentro de `dist/` están en los archivos
`dist/*.LEGAL.txt`; las de los diccionarios, en `dict/`.

| Componente | Para qué se usa | Licencia |
| --- | --- | --- |
| [KaTeX](https://katex.org) | Dibujar las fórmulas | MIT |
| [MathLive](https://mathlive.io) | Editor visual de ecuaciones | MIT |
| [PDF.js](https://mozilla.github.io/pdf.js/) | Mostrar imágenes PDF | Apache-2.0 |
| [node-tikzjax](https://github.com/prinsss/node-tikzjax) (TeX en WebAssembly, fuentes BaKoMa) | Dibujar figuras TikZ sin LaTeX instalado | LPPL-1.3c |
| [jsdom](https://github.com/jsdom/jsdom), [SVGO](https://github.com/svg/svgo), [memfs](https://github.com/streamich/memfs) y sus dependencias | Usados por node-tikzjax | MIT y compatibles |
| [Codicons](https://github.com/microsoft/vscode-codicons) | Iconos de la interfaz | CC-BY-4.0 (iconos), MIT (código) |
| [nspell](https://github.com/wooorm/nspell) | Corrector ortográfico (Hunspell en JavaScript) | MIT |
| [dictionary-es](https://github.com/wooorm/dictionaries) (RLA-ES) | Diccionario español | GPL-3.0, LGPL-3.0 o MPL-1.1 (`dict/LICENSE-es.txt`) |
| [dictionary-en](https://github.com/wooorm/dictionaries) (SCOWL) | Diccionario inglés | MIT y BSD (`dict/LICENSE-en.txt`) |

Los diccionarios son archivos de datos independientes (`dict/*.aff`, `dict/*.dic`) que Mars lee en
tiempo de ejecución; se pueden sustituir por otros diccionarios Hunspell.

## hyphen

Patrones de división de palabras de TeX para JavaScript (inglés, francés, alemán, portugués, italiano y catalán).
Licencia MIT. Los patrones proceden del proyecto hyph-utf8 de TeX, cada uno con la licencia de sus autores.
https://github.com/ytiurin/hyphen
