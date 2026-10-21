import * as assert from 'assert/strict';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Frame } from 'playwright-core';
import { click, codeExe, launch, openMars, root } from './vscode';

/*
 * Prueba del paquete: instala el .vsix en una carpeta de extensiones vacía, como haría un
 * usuario, y comprueba en un VS Code real que todo lo que va dentro funciona sin el proyecto al
 * lado: el editor, las fórmulas, los iconos, el corrector con sus diccionarios, las figuras TikZ,
 * las imágenes PDF y el editor de ecuaciones.
 */

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function until(ok: () => Promise<boolean>, what: string, ms = 20000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await sleep(200);
  }
  throw new Error(`No ocurrió a tiempo: ${what}`);
}

const DOC = [
  '\\documentclass{article}',
  '\\usepackage[spanish]{babel}',
  '\\usepackage{tikz}',
  '\\usepackage{graphicx}',
  '\\begin{document}',
  '',
  '\\section{Prueba del paquete}',
  '',
  'Un párrafo con una fórmula $a^2 + b^2 = c^2$ y texto corriente.',
  '',
  '\\begin{tikzpicture}',
  '  \\draw[->] (0,0) -- (2,1) node[right] {$x$};',
  '\\end{tikzpicture}',
  '',
  '\\includegraphics[width=0.4\\textwidth]{grafico}',
  '',
  '\\end{document}',
  '',
].join('\n');

const PDF =
  '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
  '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R>>endobj\n' +
  '4 0 obj<</Length 27>>stream\n1 0 0 rg 20 20 160 60 re f\nendstream endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';

/** Instala el .vsix con la línea de órdenes de VS Code en una carpeta de extensiones propia. */
/** Nombre y publicador del paquete: el identificador de la extensión es «publicador.nombre». */
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { name: string; publisher: string; version: string };

function install(vsix: string): string {
  const extensions = fs.mkdtempSync(path.join(os.tmpdir(), 'mars-vsix-ext-'));
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'mars-vsix-data-'));
  const cli = path.join(path.dirname(codeExe()), 'bin', process.platform === 'win32' ? 'code.cmd' : 'code');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(`"${cli}"`, [`--extensions-dir="${extensions}"`, `--user-data-dir="${data}"`, '--install-extension', `"${vsix}"`], { shell: true, env, encoding: 'utf8' });
  fs.rmSync(data, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  const installed = fs.readdirSync(extensions).filter((d) => d.startsWith(`${pkg.publisher}.${pkg.name}-`));
  assert.equal(installed.length, 1, `la instalación no dejó la extensión en su carpeta:\n${r.stdout}\n${r.stderr}`);
  const dir = path.join(extensions, installed[0]);
  assert.ok(!fs.existsSync(path.join(dir, 'node_modules')), 'el paquete no lleva node_modules');
  assert.ok(!fs.existsSync(path.join(dir, 'src')), 'ni el código fuente');
  return extensions;
}

async function main(): Promise<void> {
  const vsix = path.join(root, 'releases', `${pkg.name}-${pkg.version}.vsix`);
  assert.ok(fs.existsSync(vsix), `no existe ${vsix}: ejecuta antes "npm run package"`);
  const extensions = install(vsix);
  console.log(`  ✔ ${path.basename(vsix)} instalado en una carpeta de extensiones vacía`);

  const s = await launch({ files: { 'paquete.tex': DOC, 'grafico.pdf': PDF }, open: 'paquete.tex', extensionsDir: extensions });
  const checks: [string, (frame: Frame) => Promise<void>][] = [
    [
      'el botón ▶ abre el editor visual, con fórmulas e iconos',
      async (frame) => {
        assert.ok((await frame.locator('#root .block').count()) >= 4);
        assert.ok((await frame.locator('.block .katex').count()) >= 1, 'KaTeX dibuja la fórmula');
        // las fuentes se cargan de verdad desde el paquete (no basta con que estén declaradas)
        const loaded = (family: string): Promise<boolean> =>
          frame.evaluate((f) => Array.from(document.fonts).some((x) => x.family.replace(/["']/g, '') === f && x.status === 'loaded'), family);
        await until(async () => (await loaded('codicon')) && (await loaded('KaTeX_Main')), 'fuentes de iconos y de fórmulas cargadas');
        const missing = await frame.evaluate(() => Array.from(document.querySelectorAll('#toolbar .codicon')).filter((i) => getComputedStyle(i, '::before').content === 'none').length);
        assert.equal(missing, 0, 'todos los iconos existen');
      },
    ],
    [
      'las figuras TikZ se dibujan con el motor TeX incluido',
      async (frame) => {
        await until(async () => (await frame.locator('.tikz svg').count()) === 1, 'figura TikZ dibujada', 90000);
        assert.equal(await frame.locator('.tikz-error').count(), 0);
      },
    ],
    [
      'las imágenes PDF se muestran con pdf.js',
      async (frame) => {
        await until(async () => (await frame.locator('canvas.pdfimg[data-done="ok"]').count()) === 1, 'imagen PDF dibujada', 30000);
      },
    ],
    [
      'el corrector carga su diccionario y subraya una palabra mal escrita',
      async (frame) => {
        const p = await click(frame, frame.locator('.block .content', { hasText: 'Un párrafo con' }).first());
        const state = await frame.evaluate(() => ({
          active: document.querySelector('.block.active')?.textContent?.slice(0, 30),
          focus: (document.activeElement as HTMLElement | null)?.className,
          y: window.scrollY,
          spell: document.querySelector('button[data-cmd="spell-toggle"]')?.className,
        }));
        assert.ok(state.active?.startsWith('Un párrafo'), `el clic en (${Math.round(p.x)}, ${Math.round(p.y)}) deja el párrafo en edición: ${JSON.stringify(state)}`);
        await s.win.keyboard.press('Control+End');
        await s.win.keyboard.type(' Y una palabrra más', { delay: 20 });
        await until(async () => (await frame.evaluate(() => CSS.highlights.get('mars-spell')?.size ?? 0)) === 1, 'palabra subrayada');
      },
    ],
    [
      'Ctrl+S guarda el documento',
      async () => {
        const file = path.join(s.work, 'paquete.tex');
        for (let i = 0; i < 5 && !fs.readFileSync(file, 'utf8').includes('palabrra'); i++) {
          await s.win.keyboard.press('Control+S');
          await sleep(800);
        }
        assert.match(fs.readFileSync(file, 'utf8'), /texto corriente\. Y una palabrra más\r?\n/);
      },
    ],
    [
      'el editor visual de ecuaciones (MathLive) se abre con su teclado de símbolos',
      async (frame) => {
        // en un panel estrecho el botón puede quedar fuera de la vista: la cinta se desplaza hasta él
        await frame.evaluate(() => document.querySelector('#toolbar button[data-cmd="ins-equation"]')?.scrollIntoView({ block: 'nearest', inline: 'center' }));
        await sleep(400);
        await click(frame, '#toolbar button[data-cmd="ins-equation"]', { scroll: false });
        await until(async () => (await frame.locator('.overlay math-field').count()) === 1, 'campo de fórmula visual', 30000);
        await until(async () => frame.evaluate(() => customElements.get('math-field') !== undefined), 'MathLive cargado');
        await s.win.keyboard.press('Escape');
      },
    ],
  ];
  const failed: string[] = [];
  try {
    const frame = await openMars(s.win);
    await sleep(1500);
    for (const [name, fn] of checks) {
      try {
        await fn(frame);
        console.log(`  ✔ ${name}`);
      } catch (err) {
        failed.push(name);
        console.log(`  ✖ ${name}\n${String((err as Error)?.stack ?? err).replace(/^/gm, '      ')}`);
        await s.win.screenshot({ path: path.join(root, 'tools', 'capturas', `vsix-fallo-${failed.length}.png`) }).catch(() => undefined);
        await s.win.keyboard.press('Escape').catch(() => undefined);
      }
    }
  } finally {
    await s.close();
    fs.rmSync(extensions, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  console.log(`\n${checks.length - failed.length} de ${checks.length} comprobaciones del paquete correctas`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
