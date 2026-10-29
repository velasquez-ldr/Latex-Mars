/** Visor del PDF compilado, dentro de VS Code, enlazado con el documento por SyncTeX. */

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import type { PdfPoint } from './synctex';

export class PdfView {
  private static readonly open = new Map<string, PdfView>();
  /** las pruebas leen aquí lo último que se le pidió al visor */
  lastGoto: PdfPoint | undefined;
  /** páginas que el visor ha terminado de dibujar (0 mientras carga) */
  pages = 0;
  private ready = false;
  /** fecha del PDF que está cargado */
  private stamp = -1;
  private static stampOf(pdf: string): number {
    return fs.existsSync(pdf) ? fs.statSync(pdf).mtimeMs : 0;
  }
  private queued: unknown[] = [];

  private constructor(
    private readonly ctx: vscode.ExtensionContext,
    readonly pdf: string,
    private readonly panel: vscode.WebviewPanel,
    private click: (page: number, x: number, y: number) => void,
  ) {
    panel.webview.onDidReceiveMessage((m: { type?: string; page?: number; x?: number; y?: number }) => {
      if (m.type === 'ready') {
        this.ready = true;
        for (const q of this.queued) void panel.webview.postMessage(q);
        this.queued = [];
      } else if (m.type === 'drawn' && typeof m.page === 'number') this.pages = m.page;
      else if (m.type === 'click' && typeof m.page === 'number' && typeof m.x === 'number' && typeof m.y === 'number') this.click(m.page, m.x, m.y);
    });
    panel.onDidDispose(() => PdfView.open.delete(pdf.toLowerCase()));
    this.load();
  }

  /** Abre (o trae al frente y recarga) el visor de `pdf`. `click`: lo que hacer al pulsar un punto del PDF. */
  static show(ctx: vscode.ExtensionContext, pdf: string, column: vscode.ViewColumn, click: (page: number, x: number, y: number) => void): PdfView {
    const existing = PdfView.open.get(pdf.toLowerCase());
    if (existing) {
      existing.click = click;
      // solo se vuelve a cargar si el PDF ha cambiado: recargarlo borraría la posición y el resaltado
      if (existing.stamp !== PdfView.stampOf(pdf)) existing.load();
      existing.panel.reveal(undefined, true);
      return existing;
    }
    const panel = vscode.window.createWebviewPanel('mars.pdf', `PDF · ${path.basename(pdf)}`, { viewColumn: column, preserveFocus: true }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.file(path.join(ctx.extensionPath, 'media')), vscode.Uri.file(path.dirname(pdf))],
    });
    const view = new PdfView(ctx, pdf, panel, click);
    PdfView.open.set(pdf.toLowerCase(), view);
    return view;
  }

  static for(pdf: string): PdfView | undefined {
    return PdfView.open.get(pdf.toLowerCase());
  }

  /** Lleva el visor a un punto del PDF y lo resalta un momento. */
  goto(p: PdfPoint): void {
    this.lastGoto = p;
    this.send({ type: 'goto', ...p });
    this.panel.reveal(undefined, true);
  }

  private send(m: unknown): void {
    if (this.ready) void this.panel.webview.postMessage(m);
    else this.queued.push(m);
  }

  /** (Re)carga el PDF: tras compilar de nuevo, el visor enseña el resultado sin perder la posición. */
  private load(): void {
    const w = this.panel.webview;
    const media = (...p: string[]): string => w.asWebviewUri(vscode.Uri.file(path.join(this.ctx.extensionPath, 'media', ...p))).toString();
    const stamp = PdfView.stampOf(this.pdf);
    this.stamp = stamp;
    const url = `${w.asWebviewUri(vscode.Uri.file(this.pdf)).toString()}?v=${stamp}`;
    if (this.ready) {
      this.send({ type: 'reload', url });
      return;
    }
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const policy = ["default-src 'none'", `img-src ${w.cspSource} data: blob:`, "style-src 'unsafe-inline'", `font-src ${w.cspSource}`, `script-src 'nonce-${nonce}' ${w.cspSource}`, 'worker-src blob:', `connect-src ${w.cspSource}`].join('; ');
    w.html = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<style>
  html, body { margin: 0; padding: 0; background: var(--vscode-editor-background); color: var(--vscode-editor-foreground); font: 12.5px var(--vscode-font-family, sans-serif); }
  #bar { position: sticky; top: 0; z-index: 5; display: flex; align-items: center; gap: 10px; padding: 6px 12px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); border-bottom: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.35)); }
  #bar button { background: transparent; color: inherit; border: 1px solid var(--vscode-editorWidget-border, rgba(128,128,128,.35)); border-radius: 5px; padding: 2px 9px; cursor: pointer; font: inherit; }
  #bar button:hover { background: var(--vscode-toolbar-hoverBackground, rgba(128,128,128,.18)); }
  #hint { color: var(--vscode-descriptionForeground); margin-left: auto; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  #pages { display: flex; flex-direction: column; align-items: center; gap: 14px; padding: 16px 12px 40px; }
  .pg { position: relative; background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.25), 0 8px 24px rgba(0,0,0,.18); }
  .pg canvas { display: block; width: 100%; height: 100%; cursor: crosshair; }
  .mark { position: absolute; pointer-events: none; transition: opacity .9s ease-out 1.2s; border-radius: 2px; }
  .mark.para { background: rgba(255, 196, 0, .22); box-shadow: inset 3px 0 0 #f5a700; }
  .mark.word { background: rgba(255, 150, 0, .45); outline: 1.5px solid #e07b00; }
  .mark.caret { background: #d14b00; border-radius: 1px; }
  .mark.out { opacity: 0; }
  #msg { padding: 40px 20px; text-align: center; color: var(--vscode-descriptionForeground); }
</style>
</head>
<body data-pdf="${url}" data-pdfjs="${media('vendor', 'pdfjs', 'pdf.min.mjs')}" data-pdfworker="${media('vendor', 'pdfjs', 'pdf.worker.min.mjs')}">
<div id="bar"><button id="out" title="Alejar">−</button><span id="zoom">100 %</span><button id="in" title="Acercar">+</button><span id="count"></span><span id="hint">Doble clic en el PDF: ir a ese párrafo en Mars</span></div>
<div id="pages"><div id="msg">Abriendo el PDF…</div></div>
<script type="module" nonce="${nonce}" src="${media('pdfview.js')}"></script>
</body>
</html>`;
  }
}
