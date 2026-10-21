import { build } from 'esbuild';
import { copyFileSync, cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/*
 * Construye lo que se publica: la extensión no lleva `node_modules`, sino unos pocos archivos.
 *   media/preview.js    el editor visual (webview)
 *   dist/extension.js   la extensión
 *   dist/spellWorker.js el corrector ortográfico (hilo aparte)
 *   dist/tikz.js        el motor TeX que dibuja las figuras TikZ (se carga solo si hace falta)
 *   media/vendor, dict, tex   fuentes, bibliotecas del webview, diccionarios y archivos de TeX
 */

// 1. el script del webview (incluye KaTeX para la vista previa de fórmulas en los diálogos)
await build({
  entryPoints: ['src/webview/main.ts'],
  bundle: true,
  format: 'iife',
  target: 'es2022',
  minify: true,
  outfile: 'media/preview.js',
  logLevel: 'info',
});

// 2. el código que corre en el host de extensiones
rmSync('dist', { recursive: true, force: true });
const host = { bundle: true, platform: 'node', format: 'cjs', target: 'node18', minify: true, legalComments: 'external', logLevel: 'info' };
await build({ ...host, entryPoints: ['src/extension.ts', 'src/spellWorker.ts'], outdir: 'dist', external: ['vscode'] });
await build({
  ...host,
  entryPoints: ['src/tikz.ts'],
  outdir: 'dist',
  // dependencias opcionales de jsdom que Mars no usa
  external: ['canvas', 'bufferutil', 'utf-8-validate'],
  logOverride: { 'require-resolve-not-external': 'silent' },
});
// jsdom comprueba al cargarse que este archivo existe (solo lo usaría para peticiones síncronas)
writeFileSync('dist/xhr-sync-worker.js', '// requerido por jsdom al cargarse; Mars no hace peticiones síncronas\n');

// 3. recursos que se sirven tal cual
const copy = (from, to) => {
  mkdirSync(dirname(to), { recursive: true });
  copyFileSync(from, to);
};
const modules = 'node_modules';
for (const dir of ['media/vendor', 'dict', 'tex']) rmSync(dir, { recursive: true, force: true });

copy(`${modules}/katex/dist/katex.min.css`, 'media/vendor/katex/katex.min.css');
// la hoja de estilos ofrece cada fuente en tres formatos; el webview (Chromium) solo pide woff2
for (const f of readdirSync(`${modules}/katex/dist/fonts`)) if (f.endsWith('.woff2')) copy(`${modules}/katex/dist/fonts/${f}`, `media/vendor/katex/fonts/${f}`);
copy(`${modules}/@vscode/codicons/dist/codicon.css`, 'media/vendor/codicons/codicon.css');
copy(`${modules}/@vscode/codicons/dist/codicon.ttf`, 'media/vendor/codicons/codicon.ttf');
copy(`${modules}/pdfjs-dist/build/pdf.min.mjs`, 'media/vendor/pdfjs/pdf.min.mjs');
copy(`${modules}/pdfjs-dist/build/pdf.worker.min.mjs`, 'media/vendor/pdfjs/pdf.worker.min.mjs');
copy(`${modules}/mathlive/mathlive.min.mjs`, 'media/vendor/mathlive/mathlive.min.mjs');
cpSync(`${modules}/mathlive/fonts`, 'media/vendor/mathlive/fonts', { recursive: true });
// fuentes con las que se dibuja el texto de las figuras TikZ
cpSync(`${modules}/node-tikzjax/css`, 'media/vendor/tikzjax', { recursive: true });
// TeX en WebAssembly y sus archivos: dist/tikz.js los busca en ../tex
cpSync(`${modules}/node-tikzjax/tex`, 'tex', { recursive: true });
// diccionarios Hunspell del corrector, con su licencia
for (const lang of ['es', 'en']) {
  copy(`${modules}/dictionary-${lang}/index.aff`, `dict/${lang}.aff`);
  copy(`${modules}/dictionary-${lang}/index.dic`, `dict/${lang}.dic`);
  copy(`${modules}/dictionary-${lang}/license`, `dict/LICENSE-${lang}.txt`);
}
console.log('recursos copiados a media/vendor, dict y tex');
