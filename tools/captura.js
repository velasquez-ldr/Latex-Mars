// Arnés: carga el webview real de Mars fuera de VS Code para poder capturarlo.
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const root = process.argv[2];
const out = process.argv[3];
const theme = process.argv[4] || 'dark';
const actions = JSON.parse(fs.readFileSync(process.argv[5], 'utf8') || '[]');
const texFile = process.argv[6] || path.join(root, 'ejemplo.tex');
const { renderLatex } = require(path.join(root, 'out/latex/renderer.js'));
const layoutMod = require(path.join(root, 'out/latex/layout.js'));
const text = texFile === 'vacio' ? '' : fs.readFileSync(texFile, 'utf8');
const res = renderLatex(text, {});
const l = layoutMod.readLayout(text);
const layout = l ? { ...l, textWidth: layoutMod.textWidthCm(l) } : undefined;
const page = layoutMod.pageGeometry(l);
const u = (...p) => pathToFileURL(path.join(root, ...p)).href;
const dark = {
  'editor-foreground': '#cccccc', 'editor-background': '#1f1f1f', descriptionForeground: '#9d9d9d', 'editorWidget-border': '#454545',
  focusBorder: '#0078d4', 'toolbar-hoverBackground': 'rgba(90,93,94,0.31)', 'editorWidget-background': '#252526', 'menu-background': '#252526',
  'button-background': '#0e639c', 'button-foreground': '#ffffff', 'input-foreground': '#cccccc', 'input-background': '#3c3c3c',
  'textLink-foreground': '#3794ff', 'font-family': 'Segoe UI, sans-serif', 'editor-font-family': 'Consolas, monospace', 'textCodeBlock-background': '#0a0a0a66',
};
const light = {
  'editor-foreground': '#3b3b3b', 'editor-background': '#ffffff', descriptionForeground: '#717171', 'editorWidget-border': '#c8c8c8',
  focusBorder: '#005fb8', 'toolbar-hoverBackground': 'rgba(184,184,184,0.31)', 'editorWidget-background': '#f8f8f8', 'menu-background': '#ffffff',
  'button-background': '#005fb8', 'button-foreground': '#ffffff', 'input-foreground': '#3b3b3b', 'input-background': '#ffffff',
  'textLink-foreground': '#005fb8', 'font-family': 'Segoe UI, sans-serif', 'editor-font-family': 'Consolas, monospace', 'textCodeBlock-background': '#dcdcdc66',
};
const css = Object.entries(theme === 'dark' ? dark : light).map(([k, v]) => `--vscode-${k}:${v};`).join('');
const msg = { type: 'update', origin: 'full', ack: 0, blocks: res.blocks, macros: res.macros, labels: res.labels, insertLine: res.insertLine, meta: res.meta, sources: [], layout, page, furniture: res.furniture, math: res.math };
const html = `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"><style>:root{${css}}</style>
<link rel="stylesheet" href="${u('node_modules/katex/dist/katex.min.css')}">
<link rel="stylesheet" href="${u('node_modules/node-tikzjax/css/fonts.css')}">
<link rel="stylesheet" href="${u('node_modules/@vscode/codicons/dist/codicon.css')}">
<link rel="stylesheet" href="${u('media/preview.css')}"></head>
<body class="vscode-${theme}" data-pdfjs="${u('node_modules/pdfjs-dist/build/pdf.min.mjs')}" data-pdfworker="${u('node_modules/pdfjs-dist/build/pdf.worker.min.mjs')}" data-mathlive="${u('node_modules/mathlive/mathlive.min.mjs')}" data-mathfonts="${u('node_modules/mathlive/fonts')}">
<div id="toolbar"></div><div id="page"><div id="root"></div><div id="empty" hidden><p>Este documento está vacío.</p><button data-cmd="newdoc" class="primary">Crear documento base</button><button data-cmd="start">Empezar a escribir</button></div><div id="tail"></div></div>
<script>window.acquireVsCodeApi = () => ({ postMessage() {}, getState() { return undefined; }, setState() {} });</script>
<script src="${u('media/preview.js')}"></script>
<script>
window.postMessage(${JSON.stringify(msg)}, '*');
const acts = ${JSON.stringify(actions)};
let i = 0;
setTimeout(function next() { if (i >= acts.length) return; window.postMessage({ type: 'test', id: i, ...acts[i++] }, '*'); setTimeout(next, 350); }, 500);
</script></body></html>`;
fs.writeFileSync(out, html);
