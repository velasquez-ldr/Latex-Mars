import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { Assets } from './assets';
import { type BibEntry, bibitem, bibtex, citeKey, fetchDoi, normalizeDoi, parseBibtex, zoteroExport, zoteroPick } from './citations';
import { type Layout, landscapeSwap, pageGeometry, readLayout, textWidthCm, writeHeadFoot, writeLayout } from './latex/layout';
import { effectiveSource } from './latex/preamble';
import { renderLatex } from './latex/renderer';
import { Spell, spellLangs } from './spell';
import { type Change, changesBetween } from './diff';
import { changedFiles, commitFiles, fileAt, fileAtSync, fileLog, repoRoot } from './git';
import { type PdfResult, compilePdf } from './pdf';
import { PdfView } from './pdfview';
import { type PdfPoint, forward, inverse, loadSyncTex } from './synctex';
import { TEMPLATES, TEMPLATE_FILES, TEMPLATE_LIST } from './templates';
import { decodeText, findRoot, isMain, samePath, texPath } from './project';

/** Una fuente bibliográfica citable. */
interface Source {
  key: string;
  label: string;
  /** la entrada tal cual está escrita (en el .bib o como \bibitem), para editarla */
  raw?: string;
  /** dónde vive: en el archivo .bib o en el propio documento */
  where?: 'bib' | 'doc';
}

/** Dónde termina la entrada de un .bib que empieza en `start` (en su «@»): tras la llave que la cierra. */
function bibEntryEnd(content: string, start: number): number {
  const open = content.indexOf('{', start);
  if (open < 0) return content.length;
  let depth = 0;
  for (let i = open; i < content.length; i++) {
    if (content[i] === '\\') i++;
    else if (content[i] === '{') depth++;
    else if (content[i] === '}' && --depth === 0) return i + 1;
  }
  return content.length;
}

/** Tramo del texto que ocupa una fuente: su entrada del .bib o su \bibitem (hasta el siguiente). */
export function sourceSpan(content: string, key: string, where: 'bib' | 'doc'): { start: number; end: number } | undefined {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (where === 'bib') {
    const m = new RegExp(`@\\w+\\s*\\{\\s*${esc}\\s*,`).exec(content);
    return m ? { start: m.index, end: bibEntryEnd(content, m.index) } : undefined;
  }
  const m = new RegExp(`^[ \\t]*\\\\bibitem\\s*(?:\\[[^\\]]*\\])?\\s*\\{\\s*${esc}\\s*\\}`, 'm').exec(content);
  if (!m) return undefined;
  const rest = content.slice(m.index + m[0].length);
  const next = /^[ \t]*\\(?:bibitem\b|end\{thebibliography\})/m.exec(rest);
  let end = m.index + m[0].length + (next ? next.index : rest.length);
  // (las líneas en blanco que la separan de la siguiente no son suyas)
  while (end > m.index && /\s/.test(content[end - 1])) end--;
  return { start: m.index, end };
}

const VIEW_TYPE = 'mars.editor';
/** Esquema de los documentos de solo lectura que muestran un .tex tal como estaba en un commit. */
const GIT_SCHEME = 'mars-git';
/** El documento corresponde a un archivo del disco (el propio archivo o una versión suya en git). */
const onDisk = (uri: vscode.Uri): boolean => uri.scheme === 'file' || uri.scheme === GIT_SCHEME;
/** Clave del diccionario personal del corrector en el almacenamiento de la extensión. */
const USER_WORDS = 'mars.userWords';
/** preferencias de la vista que valen para todos los documentos: papel, zoom, cinta, colores recientes */
const VIEW_PREFS = 'mars.viewPrefs';
const PREF_KEYS = ['paper', 'ribbonMin', 'colors', 'view', 'zoom', 'deck'];
/**
 * Ajustes que cambian solo mientras se presenta: sin pestañas en el modo zen, ni barra de título a
 * pantalla completa, ni la ruta del archivo encima del editor. Lo que había se guarda aquí hasta
 * restaurarlo (también si VS Code se cierra a mitad de una presentación: al volver a abrirlo).
 */
const PRESENT_SETTINGS: [section: string, key: string, value: unknown][] = [
  ['zenMode', 'showTabs', 'none'],
  ['window', 'customTitleBarVisibility', 'windowed'],
  ['breadcrumbs', 'enabled', false],
];
const PRESENT_RESTORE = 'mars.presentRestore';

async function changePresentSettings(ctx: vscode.ExtensionContext): Promise<void> {
  if (ctx.globalState.get(PRESENT_RESTORE)) return;
  const before: Record<string, unknown> = {};
  for (const [section, key] of PRESENT_SETTINGS) {
    // (lo que hay en la configuración del usuario; null = no lo tenía)
    before[`${section}.${key}`] = vscode.workspace.getConfiguration(section).inspect(key)?.globalValue ?? null;
  }
  await ctx.globalState.update(PRESENT_RESTORE, before);
  for (const [section, key, value] of PRESENT_SETTINGS) {
    const config = vscode.workspace.getConfiguration(section);
    if (config.get(key) !== value) await Promise.resolve(config.update(key, value, vscode.ConfigurationTarget.Global)).catch(() => undefined);
  }
}

async function restorePresentSettings(ctx: vscode.ExtensionContext): Promise<void> {
  const before = ctx.globalState.get<Record<string, unknown>>(PRESENT_RESTORE);
  if (!before) return;
  for (const [section, key] of PRESENT_SETTINGS) {
    const id = `${section}.${key}`;
    if (!(id in before)) continue;
    const config = vscode.workspace.getConfiguration(section);
    if (config.inspect(key)?.globalValue !== (before[id] ?? undefined)) await Promise.resolve(config.update(key, before[id] ?? undefined, vscode.ConfigurationTarget.Global)).catch(() => undefined);
  }
  await ctx.globalState.update(PRESENT_RESTORE, undefined);
}
/**
 * .tex que Mars abre a propósito en el editor de código (ir a una línea, abrir un archivo desde
 * un aviso): no se pasan al editor visual aunque haya otro abierto.
 */
const codeWanted = new Set<string>();
/** Extensiones que se prueban cuando \includegraphics no indica ninguna (en el orden de pdflatex). */
const IMAGE_EXT = ['', '.pdf', '.png', '.jpg', '.jpeg', '.eps', '.svg', '.gif', '.webp'];


/**
 * Resolución (puntos por pulgada) guardada en un PNG o un JPEG, si la declara. LaTeX la usa para
 * decidir el tamaño de una imagen incluida sin medidas; si no hay, toma 72.
 */
/** Ancho y alto en píxeles de un PNG, un GIF o un JPEG, leídos de su cabecera. */
function imageSize(file: string): [number, number] | undefined {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const b = buf.subarray(0, n);
    if (n > 24 && b.readUInt32BE(0) === 0x89504e47) return [b.readUInt32BE(16), b.readUInt32BE(20)];
    if (n > 10 && b.toString('latin1', 0, 3) === 'GIF') return [b.readUInt16LE(6), b.readUInt16LE(8)];
    if (n > 4 && b[0] === 0xff && b[1] === 0xd8) {
      // JPEG: se recorren los segmentos hasta el que declara las medidas (SOF0..SOF15, salvo DHT, JPG y DAC)
      let p = 2;
      while (p + 9 < n) {
        if (b[p] !== 0xff) return undefined;
        const marker = b[p + 1];
        const len = b.readUInt16BE(p + 2);
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return [b.readUInt16BE(p + 7), b.readUInt16BE(p + 5)];
        p += 2 + len;
      }
    }
  } catch {
    // sin medidas: la imagen ocupará su sitio cuando cargue
  }
  return undefined;
}

function imageDpi(file: string): number | undefined {
  try {
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(4096);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const head = buf.subarray(0, n);
    if (head.readUInt32BE(0) === 0x89504e47) {
      // PNG: bloque pHYs = píxeles por unidad (x, y) y unidad (1 = metro)
      const at = head.indexOf('pHYs', 0, 'latin1');
      if (at > 0 && at + 13 <= n && head[at + 12] === 1) return Math.round(head.readUInt32BE(at + 4) * 0.0254);
    } else if (head[0] === 0xff && head[1] === 0xd8) {
      // JPEG: cabecera JFIF con densidad en puntos por pulgada (1) o por centímetro (2)
      const at = head.indexOf('JFIF\0', 0, 'latin1');
      if (at > 0 && at + 12 <= n) {
        const unit = head[at + 7];
        const density = head.readUInt16BE(at + 8);
        if (density > 0 && unit === 1) return density;
        if (density > 0 && unit === 2) return Math.round(density * 2.54);
      }
    }
  } catch {
    // archivo ilegible: se tratará como una imagen sin resolución declarada
  }
  return undefined;
}

const isTexFile = (uri: vscode.Uri): boolean => /\.(tex|ltx)$/i.test(uri.path);
const isTex = (d: vscode.TextDocument): boolean => d.languageId === 'latex' || d.languageId === 'tex' || isTexFile(d.uri);

/** Sustituye `d` líneas a partir de la línea `s` por `lines`. */
interface Splice {
  s: number;
  d: number;
  lines: string[];
}

interface SpliceMsg extends Splice {
  seq: number;
  /** líneas que el webview cree estar sustituyendo */
  expect?: string[];
  /** en una inserción: texto que el webview cree que hay en la línea anterior y en la siguiente */
  prev?: string;
  next?: string;
  full?: boolean;
  packages?: string[];
}

type Origin = 'preview' | 'editor' | 'full';

/**
 * Un editor visual abierto sobre un documento. El documento de texto de VS Code es la única
 * fuente de verdad: las ediciones se aplican con WorkspaceEdit y deshacer/rehacer son los del
 * propio documento, compartidos con el editor de código.
 */
export class Preview {
  private timer: NodeJS.Timeout | undefined;
  private applying = false;
  private queue: Promise<void> = Promise.resolve();
  private lastSeq = 0;
  /** versión del documento tras la última edición hecha desde la vista previa */
  private ownVersion = -1;
  private revealedAt = 0;
  /** ediciones propias aplicadas por la tarea en curso */
  private ownEdits = 0;
  /** línea a la que llevar el cursor tras un deshacer/rehacer */
  private focusAfter: number | undefined;
  /** ediciones descartadas por no coincidir con el documento (las pruebas exigen que sea 0) */
  rejected = 0;
  /** las pruebas pueden fijar aquí la imagen que devolvería el selector de archivos */
  pickImageOverride: string | undefined;
  // contadores usados por las pruebas para saber cuándo el webview está al día
  private sent = 0;
  private got = 0;
  private busy = 0;
  private testId = 0;
  private tests = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  constructor(
    private readonly ctx: vscode.ExtensionContext,
    private readonly doc: vscode.TextDocument,
    private readonly panel: vscode.WebviewPanel,
    private readonly assets: Assets,
    private readonly cacheDir: string,
    private readonly spell: Spell,
    /** todos los editores visuales abiertos (para avisarles de lo que les afecta a todos) */
    private readonly peers: Iterable<Preview>,
  ) {
    // media incluye media/vendor: KaTeX, MathLive, pdf.js, iconos y fuentes (los copia esbuild.mjs)
    const roots = [path.join(ctx.extensionPath, 'media'), cacheDir, ...(vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath)];
    if (onDisk(doc.uri)) roots.push(path.dirname(doc.uri.fsPath));
    // las imágenes de un capítulo se nombran desde la carpeta del documento principal
    const main = this.project();
    if (main) roots.push(path.dirname(main));
    panel.webview.options = { enableScripts: true, localResourceRoots: roots.map((r) => vscode.Uri.file(r)) };
    panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
    panel.onDidDispose(() => void this.presentMode(false));
    if (this.readonly) {
      void this.repo().then((root) => {
        this.gitDir = root;
        if (root && this.sent > 0) this.render('full');
      });
    }
    panel.webview.html = this.html();
  }

  /** dónde se guardan los textos propios de la portada de la presentación de este documento */
  private get coverKey(): string {
    return `mars.deckCover:${this.doc.uri.toString()}`;
  }

  /** cómo estaba la ventana antes de presentar: las órdenes que se dieron y el reparto de los editores */
  private stage: { steps: string[]; layout: unknown } | undefined;

  /**
   * La presentación ocupa toda la pantalla, como en PowerPoint: modo zen (pantalla completa, sin
   * barras), sin pestañas ni barra de título, el grupo del editor visual maximizado y sin el
   * centrado del modo zen. Una vista web no puede pedir la pantalla completa por sí misma: lo hace
   * VS Code. Al salir, todo vuelve a como estaba.
   */
  private async presentMode(on: boolean): Promise<void> {
    const run = (cmd: string, ...args: unknown[]): Thenable<unknown> => vscode.commands.executeCommand(cmd, ...args).then(undefined, () => undefined);
    if (on && !this.stage) {
      const steps = ['workbench.action.toggleZenMode', 'workbench.action.toggleMaximizeEditorGroup'];
      if (vscode.workspace.getConfiguration('zenMode').get<boolean>('centerLayout', true)) steps.push('workbench.action.toggleCenteredLayout');
      this.stage = { steps, layout: await run('vscode.getEditorLayout') };
      await changePresentSettings(this.ctx);
      // las órdenes actúan sobre el grupo activo: el del editor visual
      this.panel.reveal(this.panel.viewColumn, false);
      for (const cmd of steps) await run(cmd);
    } else if (!on && this.stage) {
      const { steps, layout } = this.stage;
      this.stage = undefined;
      try {
        if (!this.panel.active) this.panel.reveal(this.panel.viewColumn, false);
      } catch {
        // (la pestaña se ha cerrado presentando: la ventana se restaura igual)
      }
      for (const cmd of [...steps].reverse()) await run(cmd);
      await restorePresentSettings(this.ctx);
      // (al salir de la pantalla completa los editores no recuperan solos su anchura)
      if (layout) await run('vscode.setEditorLayout', layout);
    }
  }

  get document(): vscode.TextDocument {
    return this.doc;
  }

  // ------------------------------------------------------------ historial (git)

  /** el documento es una versión antigua sacada de git: se ve, pero no se edita */
  get readonly(): boolean {
    return this.doc.uri.scheme === GIT_SCHEME;
  }

  /** versión con la que se compara el documento mientras el panel de cambios está abierto */
  private gitRef: string | undefined;
  private gitRoot: Promise<string | undefined> | undefined;
  private gitChanges: Change[] = [];
  /** texto del documento sobre el que se calcularon esos cambios */
  private gitText = '';
  private gitRun = 0;

  private repo(): Promise<string | undefined> {
    if (!onDisk(this.doc.uri)) return Promise.resolve(undefined);
    return (this.gitRoot ??= repoRoot(this.doc.uri.fsPath));
  }

  /** Lista de commits del documento para el panel de cambios. */
  private async sendLog(skip = 0): Promise<void> {
    const root = await this.repo();
    const commits = root ? await fileLog(root, this.doc.uri.fsPath, 60, skip) : [];
    this.post({ type: 'gitLog', repo: root !== undefined, commits, skip, more: commits.length === 60, viewing: this.readonly ? this.doc.uri.query : '' });
    void this.sendOthers();
  }

  /** Otros archivos del proyecto (.tex y .bib) que también cambian respecto a la versión elegida. */
  private async sendOthers(): Promise<void> {
    const root = await this.repo();
    const ref = this.gitRef;
    if (!root || !ref || this.readonly) return;
    const files = (await changedFiles(root, ref)).filter((f) => !samePath(f, this.doc.uri.fsPath) && fs.existsSync(f));
    this.post({ type: 'gitOthers', files: files.map((f) => ({ path: f, name: path.relative(path.dirname(this.doc.uri.fsPath), f).replace(/\\/g, '/') })) });
  }

  /** Guarda en git el documento (y, si se pide, los demás archivos cambiados del proyecto). */
  private async commit(message: string, all: boolean): Promise<void> {
    const root = await this.repo();
    if (!root || this.readonly || !message.trim()) return;
    await this.queue;
    if (this.doc.isDirty) await this.doc.save();
    const files = [this.doc.uri.fsPath, ...(all ? (await changedFiles(root, 'HEAD')).filter((f) => !samePath(f, this.doc.uri.fsPath) && fs.existsSync(f)) : [])];
    const error = await commitFiles(root, files, message.trim());
    if (error) void vscode.window.showErrorMessage(`Mars: git no pudo hacer el commit. ${error}`);
    this.gitRef = 'HEAD';
    await this.sendLog();
    await this.sendDiff();
  }

  /** Cambios del documento respecto a la versión elegida, para marcarlos al margen. */
  private async sendDiff(): Promise<void> {
    const ref = this.gitRef;
    const run = ++this.gitRun;
    const root = ref ? await this.repo() : undefined;
    if (!ref || !root) return;
    const base = await fileAt(root, this.doc.uri.fsPath, ref);
    if (run !== this.gitRun || ref !== this.gitRef) return;
    void this.sendOthers();
    this.gitText = this.doc.getText().replace(/\r\n/g, '\n');
    this.gitChanges = changesBetween((base ?? '').replace(/\r\n/g, '\n'), this.gitText);
    const lines = this.doc.getText().split(/\r?\n/);
    // (con las líneas de ahora, para enseñar palabra a palabra qué ha cambiado)
    this.post({ type: 'gitDiff', ref, missing: base === undefined, changes: this.gitChanges.map((c) => ({ ...c, now: lines.slice(c.s, c.s + c.n) })) });
  }

  /** Abre al lado el documento tal como estaba en un commit, en solo lectura. */
  private openVersion(ref: string): void {
    if (!onDisk(this.doc.uri) || !/^[0-9a-f]{6,40}$/.test(ref)) return;
    const uri = vscode.Uri.file(this.doc.uri.fsPath).with({ scheme: GIT_SCHEME, query: ref });
    // junto al documento actual: en la columna del código si está abierta (para verlos lado a lado), o al lado
    const column = this.editorFor(this.doc)?.viewColumn ?? vscode.ViewColumn.Beside;
    void vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, column);
  }

  /** Devuelve un tramo cambiado a como estaba en la versión con la que se compara. */
  private restoreChange(index: number): Promise<void> {
    return this.enqueue(async (doc) => {
      const c = this.gitChanges[index];
      if (!c || this.readonly || c.s + c.n > doc.lineCount) return;
      // los cambios se calcularon sobre un texto concreto: si el documento ya es otro, sus líneas no
      // valen (se restauraría otro tramo). Se vuelven a calcular y no se toca nada.
      if (doc.getText().replace(/\r\n/g, '\n') !== this.gitText) {
        void this.sendDiff();
        return;
      }
      await this.apply(doc, [{ s: c.s, d: c.n, lines: c.old }]);
      this.render('full');
    });
  }

  // ------------------------------------------------------------ proyecto de varios archivos

  /** documento principal del que este archivo es una parte (un capítulo traído con \input) */
  private rootFile: string | undefined;
  private rootChecked = 0;

  /** Texto de un archivo: el abierto en VS Code, si lo está, o el del disco. */
  /** raíz del repositorio, ya resuelta (solo hace falta en una versión antigua) */
  private gitDir: string | undefined;

  /** Un archivo tal como estaba en la versión que se está viendo; `undefined` si no es una versión antigua o no existía. */
  private old(file: string): Buffer | undefined {
    return this.readonly && this.gitDir ? fileAtSync(this.gitDir, file, this.doc.uri.query) : undefined;
  }

  private readFile = (file: string): string | undefined => {
    const then = this.old(file);
    if (then) return then.toString('utf8');
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && samePath(d.uri.fsPath, file));
    if (open) return open.getText();
    try {
      return decodeText(fs.readFileSync(file));
    } catch {
      return undefined;
    }
  };

  /** Documento principal de este archivo, si es una parte de otro. */
  private project(): string | undefined {
    if (!onDisk(this.doc.uri) || isMain(this.doc.getText())) return (this.rootFile = undefined);
    const now = Date.now();
    // se vuelve a buscar de vez en cuando: el principal puede crearse o empezar a incluirlo más tarde
    if (this.rootFile === undefined ? now - this.rootChecked > 3000 : !fs.existsSync(this.rootFile)) {
      this.rootChecked = now;
      this.rootFile = findRoot(this.doc.uri.fsPath, this.readFile, (dir) => {
        try {
          return fs.readdirSync(dir);
        } catch {
          return [];
        }
      });
    }
    return this.rootFile;
  }

  /** Carpeta desde la que se nombran imágenes, \input y bibliografía: la del documento principal. */
  private get baseDir(): string {
    return path.dirname(this.rootFile ?? this.doc.uri.fsPath);
  }

  /** En un capítulo, los paquetes que hacen falta van al preámbulo del documento principal. */
  private async rootPackages(packages: string[] | undefined): Promise<void> {
    if (!this.rootFile || !packages?.length) return;
    const root = await vscode.workspace.openTextDocument(this.rootFile);
    const add = this.packageSplice(root, packages);
    if (!add) return;
    const saved = !root.isDirty;
    const edit = new vscode.WorkspaceEdit();
    const { range, text } = this.toEdit(root, add);
    edit.replace(root.uri, range, text);
    // el principal no está a la vista: se guarda para que no quede un cambio pendiente escondido
    if ((await vscode.workspace.applyEdit(edit)) && saved) await root.save();
  }

  /** Abre otro archivo del proyecto en el editor visual; con `line`, en el bloque de esa línea. */
  private openFile(file: string | undefined, line?: number): void {
    if (!file || !fs.existsSync(file)) {
      void vscode.window.showInformationMessage('Mars: no se encuentra ese archivo.');
      return;
    }
    if (line !== undefined) {
      const open = [...this.peers].find((p) => p.doc.uri.scheme === 'file' && samePath(p.doc.uri.fsPath, file));
      if (open) open.post({ type: 'cursor', line, scroll: true });
      else pendingLine.set(path.normalize(file).toLowerCase(), line);
    }
    void vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(file), VIEW_TYPE, this.panel.viewColumn);
  }

  // ------------------------------------------------------------ exportar a PDF

  /**
   * Compila el documento (el principal, si este es un capítulo) con el LaTeX instalado y abre el
   * PDF. Sin `show` no abre nada ni avisa: devuelve el resultado (lo usan las pruebas).
   */
  async exportPdf(show = true): Promise<PdfResult> {
    if (this.doc.uri.scheme !== 'file') return { ok: false, error: 'Guarda primero el documento.' };
    await this.queue;
    const file = this.project() ?? this.doc.uri.fsPath;
    // se compila lo que hay en el disco: antes se guarda lo pendiente
    for (const d of vscode.workspace.textDocuments) if (d.isDirty && d.uri.scheme === 'file' && /\.(tex|ltx|bib|sty|cls)$/i.test(d.uri.fsPath)) await d.save();
    const custom = vscode.workspace.getConfiguration('mars').get<string>('pdf.command', '');
    const text = this.readFile(file) ?? '';
    const work = (): Promise<PdfResult> => compilePdf(file, text, custom);
    const r = show ? await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Mars: compilando el PDF…' }, work) : await work();
    if (!show) return r;
    if (r.missing) {
      const pick = await vscode.window.showWarningMessage(
        'Mars: para exportar a PDF hace falta tener LaTeX instalado (MiKTeX, TeX Live o Tectonic). Mars no lo necesita para editar, pero el PDF lo compone LaTeX.',
        'Cómo instalarlo',
      );
      if (pick) void vscode.env.openExternal(vscode.Uri.parse('https://www.latex-project.org/get/'));
    } else if (r.ok && r.pdf) {
      // se enseña al lado, enlazado con el documento: doble clic en el PDF lleva a su párrafo
      this.showPdf(r.pdf);
      const pdf = r.pdf;
      const what = r.fresh === false ? 'El PDF ya estaba al día' : `PDF creado con ${r.tool}`;
      void vscode.window.showInformationMessage(`Mars: ${what}: ${path.basename(pdf)}`, 'Abrir con el visor del sistema').then((pick) => {
        if (pick) void vscode.env.openExternal(vscode.Uri.file(pdf));
      });
    } else {
      // con errores leves LaTeX deja igualmente un PDF: se enseña, avisando de que no está bien del todo
      if (r.pdf) this.showPdf(r.pdf);
      const fix = r.fix ? `Añadir ${r.fix} y reintentar` : undefined;
      const actions = [...(fix ? [fix] : []), ...(r.log ? ['Ver el registro'] : [])];
      const head = r.pdf ? 'LaTeX compuso el PDF con errores (puede faltar algo).' : 'LaTeX no pudo componer el PDF.';
      const pick = await vscode.window.showErrorMessage(`Mars: ${head} ${r.error ?? ''}${r.hint ? ` — ${r.hint}` : ''}`, ...actions);
      if (pick === 'Ver el registro' && r.log) void vscode.window.showTextDocument(vscode.Uri.file(r.log));
      else if (pick && pick === fix && r.fix) {
        if (await this.addToPreamble(file, r.fix)) return this.exportPdf(show);
        void vscode.window.showWarningMessage(`Mars: no se pudo añadir ${r.fix} al preámbulo; escríbelo a mano antes de \\begin{document}.`);
      }
    }
    return r;
  }

  /** Añade una línea al preámbulo de `file` (tras el último \usepackage) y lo guarda. */
  private async addToPreamble(file: string, line: string): Promise<boolean> {
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const lines = doc.getText().split(/\r?\n/);
    const end = lines.findIndex((l) => /^\s*\\begin\{document\}/.test(l));
    let at = -1;
    for (let i = 0; i < (end < 0 ? lines.length : end); i++) if (/^\s*\\(usepackage|documentclass)\b/.test(lines[i])) at = i;
    if (at < 0) return false;
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, new vscode.Position(at + 1, 0), `${line}${doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n'}`);
    return (await vscode.workspace.applyEdit(edit)) && (await doc.save());
  }

  /** El PDF de este documento (el del principal, si es un capítulo). */
  private pdfPath(): string | undefined {
    if (this.doc.uri.scheme !== 'file') return undefined;
    return (this.project() ?? this.doc.uri.fsPath).replace(/\.[^.\\/]+$/, '') + '.pdf';
  }

  /** Abre el PDF en el visor de Mars, al lado del documento. */
  showPdf(pdf = this.pdfPath()): PdfView | undefined {
    if (!pdf || !fs.existsSync(pdf)) return undefined;
    const column = this.editorFor(this.doc)?.viewColumn ?? vscode.ViewColumn.Beside;
    return PdfView.show(this.ctx, pdf, column, (page, x, y) => void this.pdfInverse(page, x, y));
  }

  /**
   * Del documento al PDF: dónde cae la línea `line` (desde 0). Con `show` lleva allí el visor;
   * sin él solo devuelve el punto (lo usan las pruebas).
   */
  pdfForward(line: number, show = true): PdfPoint | undefined {
    const pdf = this.pdfPath();
    const sync = pdf && fs.existsSync(pdf) ? loadSyncTex(pdf) : undefined;
    if (!pdf || !fs.existsSync(pdf) || !sync) {
      if (show) {
        void vscode.window.showInformationMessage(
          pdf && fs.existsSync(pdf)
            ? 'Mars: este PDF no trae la información para enlazarlo con el documento (SyncTeX). Vuelve a exportarlo desde Mars.'
            : 'Mars: todavía no hay PDF. Expórtalo primero con el botón de PDF.',
        );
      }
      return undefined;
    }
    const point = forward(sync, this.doc.uri.fsPath, line + 1);
    if (show) {
      if (point) this.showPdf(pdf)?.goto(point);
      else void vscode.window.showInformationMessage('Mars: ese párrafo no aparece en el PDF (puede que se haya escrito después de exportarlo).');
    }
    return point;
  }

  /** Del PDF al documento: abre el archivo y el párrafo que corresponden a un punto de una página. */
  pdfInverse(page: number, x: number, y: number, show = true): { file: string; line: number } | undefined {
    const pdf = this.pdfPath();
    const sync = pdf ? loadSyncTex(pdf) : undefined;
    const hit = sync ? inverse(sync, page, x, y) : undefined;
    if (!show) return hit;
    if (!hit) {
      void vscode.window.showInformationMessage('Mars: no se sabe a qué párrafo corresponde ese punto del PDF.');
      return undefined;
    }
    if (samePath(hit.file, this.doc.uri.fsPath)) {
      this.panel.reveal(undefined, false);
      this.post({ type: 'cursor', line: hit.line - 1, scroll: true });
    } else this.openFile(hit.file, hit.line - 1);
    return hit;
  }

  get active(): boolean {
    return this.panel.active;
  }

  /** columna en la que está el editor visual */
  get column(): vscode.ViewColumn | undefined {
    return this.panel.viewColumn;
  }

  reveal(): void {
    this.panel.reveal(undefined, false);
  }

  private html(): string {
    const webview = this.panel.webview;
    const uri = (...p: string[]): string => webview.asWebviewUri(vscode.Uri.file(path.join(this.ctx.extensionPath, ...p))).toString();
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    const csp = webview.cspSource;
    const policy = [
      "default-src 'none'",
      `img-src ${csp} https: data:`,
      `style-src ${csp} 'unsafe-inline'`,
      `font-src ${csp}`,
      `script-src 'nonce-${nonce}' ${csp}`,
      'worker-src blob:',
      `connect-src ${csp}`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${policy}">
<link rel="stylesheet" href="${uri('media', 'vendor', 'katex', 'katex.min.css')}">
<link rel="stylesheet" href="${uri('media', 'vendor', 'tikzjax', 'fonts.css')}">
<link rel="stylesheet" href="${uri('media', 'vendor', 'codicons', 'codicon.css')}">
<link rel="stylesheet" href="${uri('media', 'preview.css')}">
</head>
<body data-prefs="${JSON.stringify(this.ctx.globalState.get(VIEW_PREFS, {})).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}" data-cover="${JSON.stringify(this.ctx.workspaceState.get(this.coverKey, {})).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}" data-pdfjs="${uri('media', 'vendor', 'pdfjs', 'pdf.min.mjs')}" data-pdfworker="${uri('media', 'vendor', 'pdfjs', 'pdf.worker.min.mjs')}" data-mathlive="${uri('media', 'vendor', 'mathlive', 'mathlive.min.mjs')}" data-mathfonts="${uri('media', 'vendor', 'mathlive', 'fonts')}">
<div id="toolbar"></div>
<div id="page">
  <div id="root"></div>
  <div id="empty" hidden>
    <p>Este documento está vacío.</p>
    <button data-cmd="newdoc" class="primary">Crear documento base</button>
    <button data-cmd="start">Empezar a escribir</button>
  </div>
  <div id="tail"></div>
</div>
<script nonce="${nonce}" src="${uri('media', 'preview.js')}"></script>
</body>
</html>`;
  }

  // ------------------------------------------------------------ render

  private resolveImage = (p: string): string | undefined => {
    if (!onDisk(this.doc.uri)) return undefined;
    const base = this.baseDir;
    const web = (file: string): string => this.panel.webview.asWebviewUri(vscode.Uri.file(file)).toString();
    for (const ext of IMAGE_EXT) {
      const file = path.resolve(base, p + ext);
      const kind = path.extname(file).toLowerCase();
      if (kind === '' || !IMAGE_EXT.includes(kind)) continue;
      // en una versión antigua, la imagen de entonces (se saca de git a la caché)
      const then = this.old(file);
      if (then) {
        const copy = path.join(this.cacheDir, 'git', this.doc.uri.query.slice(0, 12), path.relative(base, file).replace(/\.\.[\\/]/g, ''));
        try {
          if (!fs.existsSync(copy)) {
            fs.mkdirSync(path.dirname(copy), { recursive: true });
            fs.writeFileSync(copy, then);
          }
          if (kind !== '.pdf' && kind !== '.eps') return web(copy);
        } catch {
          // sin caché: se usa la imagen actual
        }
      }
      try {
        if (!fs.statSync(file).isFile()) continue;
      } catch {
        continue; // no existe: probar la siguiente extensión
      }
      if (kind === '.pdf') return web(file) + '#mars-pdf';
      if (kind === '.eps') {
        const png = this.assets.epsToPng(file);
        return png ? web(png) : undefined;
      }
      // la resolución guardada en la imagen decide su tamaño natural, como en LaTeX
      const dpi = imageDpi(file);
      // con sus píxeles por delante, el editor le reserva el hueco antes de que termine de cargarse
      const size = imageSize(file);
      return web(file) + (size ? `#mars-size=${size[0]}x${size[1]}` : '') + (dpi ? `#mars-dpi=${dpi}` : '');
    }
    return undefined;
  };

  /** Contenido de un archivo .bib del documento (el abierto en VS Code, si lo está, o el del disco). */
  private readBib = (name: string): string | undefined => {
    if (!onDisk(this.doc.uri)) return undefined;
    return this.readFile(path.resolve(this.baseDir, /\.bib$/i.test(name) ? name : name + '.bib'));
  };

  private readInput = (p: string): string | undefined => {
    if (!onDisk(this.doc.uri)) return undefined;
    return this.readFile(texPath(this.baseDir, p));
  };

  render(origin: Origin, extra: { shift?: number; focusLine?: number; startWriting?: boolean } = {}): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    // un capítulo se dibuja con el preámbulo y la numeración de su documento principal
    const main = this.project();
    const mainText = main ? this.readFile(main) : undefined;
    const self = this.doc.uri.fsPath;
    const base = this.baseDir;
    const res = renderLatex(this.doc.getText(), {
      resolveImage: this.resolveImage,
      readInput: this.readInput,
      readBib: this.readBib,
      renderTikz: (src, pre) => this.assets.renderTikz(src, pre),
      root: mainText === undefined ? undefined : { text: mainText, isSelf: (p) => samePath(texPath(base, p), self) },
    });
    this.sent++;
    // la disposición se lee del preámbulo ya resuelto: condicionales, clase propia y paquetes locales
    const layout = readLayout(effectiveSource(mainText ?? this.doc.getText(), this.readInput).text);
    const spell = this.spellInfo(layout);
    this.spellLangs = spell.langs;
    void this.panel.webview.postMessage({
      type: 'update', origin, ack: this.lastSeq, blocks: res.blocks, macros: res.macros, labels: res.labels,
      issues: res.issues, insertLine: res.insertLine, tailGap: res.tailGap, meta: res.meta, sources: this.sources().list, authorYear: res.authorYear, furniture: res.furniture,
      layout: layout ? { ...layout, textWidth: textWidthCm(layout) } : undefined, page: pageGeometry(layout), spell,
      hyphenate: vscode.workspace.getConfiguration('mars').get<boolean>('hyphenation', true),
      landscape: vscode.workspace.getConfiguration('mars').get<string>('landscapePages', 'edit'),
      part: main && mainText !== undefined ? path.basename(main) : undefined, readonly: this.readonly, math: res.math, ...extra,
    });
    if (this.gitRef) void this.sendDiff();
  }

  // ------------------------------------------------------------ ortografía

  /** idiomas con los que se está corrigiendo este documento */
  private spellLangs: string[] = [];

  /** Ajustes del corrector y los idiomas que resultan para este documento. */
  private spellInfo(layout: Layout | undefined): { enabled: boolean; choice: string; langs: string[] } {
    const cfg = vscode.workspace.getConfiguration('mars');
    const choice = cfg.get<string>('spellCheck.language', 'auto');
    const langs = spellLangs(choice, layout?.lang || undefined, vscode.env.language).filter((l) => this.spell.has(l));
    return { enabled: cfg.get<boolean>('spellCheck.enabled', true), choice, langs };
  }

  private async setSpellConfig(m: { enabled?: unknown; language?: unknown }): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('mars');
    if (typeof m.language === 'string') await cfg.update('spellCheck.language', m.language, vscode.ConfigurationTarget.Global);
    if (typeof m.enabled === 'boolean') await cfg.update('spellCheck.enabled', m.enabled, vscode.ConfigurationTarget.Global);
  }

  /** Envía un mensaje al editor visual. */
  post(message: unknown): void {
    void this.panel.webview.postMessage(message);
  }

  // ------------------------------------------------------------ bibliografía

  /** Archivo .bib declarado en el documento (\bibliography o \addbibresource), si existe. */
  private bibFile(text: string): string | undefined {
    if (!onDisk(this.doc.uri)) return undefined;
    const declared = /\\(?:bibliography|addbibresource)\s*\{([^},]*)/;
    // en un capítulo, la bibliografía es la que declara el documento principal
    const m = declared.exec(text) ?? (this.rootFile ? declared.exec(this.readFile(this.rootFile) ?? '') : null);
    if (!m) return undefined;
    const name = m[1].trim();
    const file = path.resolve(this.baseDir, /\.bib$/i.test(name) ? name : name + '.bib');
    return fs.existsSync(file) ? file : undefined;
  }

  /** Fuentes que se pueden citar: las de `thebibliography` y las del archivo .bib. */
  private sources(): { list: Source[]; bib?: string } {
    const text = this.doc.getText();
    const list: Source[] = [];
    const short = (s: string): string => s.replace(/\\[a-zA-Z]+\s*|[{}]/g, '').replace(/\s+/g, ' ').trim().slice(0, 70);
    for (const m of text.matchAll(/\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}\s*([^\n]*)/g)) {
      const span = sourceSpan(text, m[1].trim(), 'doc');
      list.push({ key: m[1].trim(), label: short(m[2]) || m[1].trim(), where: 'doc', raw: span ? text.slice(span.start, span.end).replace(/\r\n/g, '\n').replace(/^[ \t]+/, '') : undefined });
    }
    const bib = this.bibFile(text);
    if (bib) {
      const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath.toLowerCase() === bib.toLowerCase());
      let content = '';
      try {
        content = open ? open.getText() : fs.readFileSync(bib, 'utf8');
      } catch {
        // sin acceso al archivo: solo se listan las fuentes del propio documento
      }
      const entries = [...content.matchAll(/@(\w+)\s*\{\s*([^,\s]+)\s*,/g)].filter((m) => !/^(comment|string|preamble)$/i.test(m[1]));
      entries.forEach((m, k) => {
        const body = content.slice(m.index, k + 1 < entries.length ? entries[k + 1].index : content.length);
        const field = (name: string): string => short(new RegExp(`\\b${name}\\s*=\\s*[{"]([^\\n]*?)[}"]\\s*,?\\s*$`, 'im').exec(body)?.[1] ?? '');
        const label = [field('author'), field('title'), field('year')].filter(Boolean).join('. ');
        list.push({ key: m[2], label: label || m[2], where: 'bib', raw: content.slice(m.index, bibEntryEnd(content, m.index)).replace(/\r\n/g, '\n') });
      });
    }
    return { list, bib };
  }

  /**
   * Cambia o quita una fuente de la bibliografía: su entrada del .bib (que se guarda) o su \bibitem.
   * `text` vacío la quita. Las citas que haya en el documento no se tocan.
   */
  private async changeSource(key: string, text: string): Promise<void> {
    await this.queue;
    const src = this.sources();
    const item = src.list.find((s) => s.key === key);
    if (!item?.where) return;
    const next = text.trim();
    if (item.where === 'bib' && src.bib) {
      const target = await vscode.workspace.openTextDocument(src.bib);
      const content = target.getText();
      const span = sourceSpan(content, key, 'bib');
      if (!span) return;
      // al quitarla se va también el hueco que la separaba de la siguiente
      let end = span.end;
      if (!next) while (end < content.length && /\s/.test(content[end])) end++;
      const eol = target.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
      const edit = new vscode.WorkspaceEdit();
      edit.replace(target.uri, new vscode.Range(target.positionAt(span.start), target.positionAt(end)), next.replace(/\r?\n/g, eol));
      if (await vscode.workspace.applyEdit(edit)) await target.save();
      this.render('full');
      return;
    }
    await this.enqueue(async (doc) => {
      const content = doc.getText();
      const span = sourceSpan(content, key, 'doc');
      if (!span) return;
      const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
      const edit = new vscode.WorkspaceEdit();
      if (next) {
        const indent = /^[ \t]*/.exec(content.slice(span.start))?.[0] ?? '';
        edit.replace(doc.uri, new vscode.Range(doc.positionAt(span.start), doc.positionAt(span.end)), indent + next.replace(/\r?\n/g, eol));
      } else {
        // la línea entera, con su salto
        let end = span.end;
        if (content.startsWith('\r\n', end)) end += 2;
        else if (content[end] === '\n') end++;
        edit.replace(doc.uri, new vscode.Range(doc.positionAt(span.start), doc.positionAt(end)), '');
      }
      await this.applyEdit(doc, edit);
      this.render('full');
    });
  }

  /**
   * Añade fuentes a la bibliografía del documento: al archivo .bib si usa uno (y lo guarda); si
   * no, como `\bibitem` dentro de `thebibliography`, que se crea si aún no existe.
   */
  private async appendSources(doc: vscode.TextDocument, items: { bib: string; item: string }[]): Promise<void> {
    if (!items.length) return;
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const edit = new vscode.WorkspaceEdit();
    const text = doc.getText();
    const bib = this.bibFile(text);
    if (bib) {
      const target = await vscode.workspace.openTextDocument(bib);
      const last = target.lineAt(target.lineCount - 1);
      const entries = items.map((x) => x.bib.replace(/\r?\n/g, eol) + eol).join(eol);
      edit.insert(target.uri, last.range.end, (last.text.trim() ? eol + eol : target.lineCount > 1 ? eol : '') + entries);
      await vscode.workspace.applyEdit(edit);
      // el .bib no está a la vista: se guarda para que no quede un cambio pendiente escondido
      await target.save();
      return;
    }
    const rows = items.map((x) => `  ${x.item}`);
    const lines = text.split(/\r?\n/);
    const close = lines.findIndex((l) => /^\s*\\end\{thebibliography\}/.test(l));
    if (close >= 0) edit.insert(doc.uri, new vscode.Position(close, 0), rows.map((r) => r + eol).join(''));
    else {
      let at = lines.findIndex((l) => /^\s*\\end\{document\}/.test(l));
      if (at < 0) at = doc.lineCount;
      const block = ['\\begin{thebibliography}{99}', ...rows, '\\end{thebibliography}', ''].join(eol) + eol;
      if (at >= doc.lineCount) edit.insert(doc.uri, doc.lineAt(doc.lineCount - 1).range.end, eol + eol + block);
      else edit.insert(doc.uri, new vscode.Position(at, 0), block);
    }
    await this.applyEdit(doc, edit);
  }

  private addSource(m: { key: string; author: string; title: string; year: string; extra: string }): Promise<void> {
    return this.enqueue(async (doc) => {
      const key = m.key.trim();
      if (!key || this.sources().list.some((s) => s.key === key)) return;
      const fields = [['author', m.author], ['title', m.title], ['year', m.year], ['note', m.extra]].filter(([, v]) => v.trim());
      const parts = [m.author.trim(), m.title.trim() ? `\\textit{${m.title.trim()}}` : '', m.extra.trim(), m.year.trim()].filter(Boolean);
      await this.appendSources(doc, [
        { bib: `@misc{${key},\n${fields.map(([k, v]) => `  ${k} = {${v.trim()}}`).join(',\n')}\n}`, item: `\\bibitem{${key}} ${parts.join('. ')}.` },
      ]);
      this.render('full');
    });
  }

  /** las pruebas pueden sustituir aquí el acceso a la red (doi.org y Zotero) */
  fetcher: typeof fetch | undefined;

  /**
   * Incorpora a la bibliografía las entradas BibTeX que aún no estén y devuelve la clave con la que
   * se cita cada una. Las claves se normalizan («apellido + año») sin pisar las que ya existen.
   */
  private async importEntries(doc: vscode.TextDocument, entries: BibEntry[], keepKeys: boolean): Promise<string[]> {
    const taken = new Set(this.sources().list.map((s) => s.key));
    const keys: string[] = [];
    const fresh: { bib: string; item: string }[] = [];
    for (const e of entries) {
      // una clave de Zotero que ya está en el documento es la misma referencia
      let key = keepKeys ? e.key : citeKey(e);
      if (!keepKeys) {
        // misma clave para otra obra (mismo autor y año): se distingue con una letra, como «perez2020b»
        const doi = (e.fields.doi ?? '').toLowerCase();
        const same = (k: string): boolean => doi !== '' && this.sourceDoi(k) === doi;
        const base = key;
        for (let n = 0; n < 24 && taken.has(key) && !same(key); n++) key = base + String.fromCharCode(98 + n);
      }
      if (!taken.has(key)) fresh.push({ bib: bibtex(e, key), item: bibitem(e, key) });
      taken.add(key);
      keys.push(key);
    }
    await this.appendSources(doc, fresh);
    return keys;
  }

  /** DOI de una fuente ya presente en el documento o en su .bib (en minúsculas), si lo declara. */
  private sourceDoi(key: string): string {
    const text = this.doc.getText();
    const bib = this.bibFile(text);
    let all = text;
    if (bib) {
      try {
        all += '\n' + (vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath.toLowerCase() === bib.toLowerCase())?.getText() ?? fs.readFileSync(bib, 'utf8'));
      } catch {
        // sin acceso al .bib: solo cuenta lo que hay en el documento
      }
    }
    const k = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const item = new RegExp(`\\\\bibitem\\s*(?:\\[[^\\]]*\\])?\\s*\\{${k}\\}([^\\n]*)`).exec(all)?.[1] ?? '';
    const entry = parseBibtex(all).find((e) => e.key === key);
    const doi = entry?.fields.doi ?? /doi:\s*(\S+?)\.?\s*$/i.exec(item)?.[1] ?? '';
    return doi.replace(/\\([_%#&])/g, '$1').toLowerCase();
  }

  /** Añade a la bibliografía la referencia de un DOI y, si se pide, la cita donde está el cursor. */
  private async addDoi(m: { doi?: unknown; cite?: unknown }): Promise<void> {
    const doi = normalizeDoi(String(m.doi ?? ''));
    if (!doi) {
      void vscode.window.showWarningMessage('Mars: eso no parece un DOI. Tiene esta forma: 10.1038/nature14539');
      return;
    }
    this.busy++;
    try {
      const raw = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Mars: buscando ${doi}…` }, () => fetchDoi(doi, this.fetcher));
      const entries = parseBibtex(raw);
      if (!entries.length) throw new Error('la respuesta no contiene ninguna referencia');
      entries[0].fields.doi ??= doi;
      await this.adopt(entries.slice(0, 1), false, m.cite === true);
    } catch (err) {
      void vscode.window.showErrorMessage(`Mars: no se pudo obtener la referencia: ${(err as Error).message}`);
    } finally {
      this.busy--;
    }
  }

  /** Abre el selector de Zotero y cita lo elegido, incorporando sus datos a la bibliografía. */
  private async citeZotero(): Promise<void> {
    const base = vscode.workspace.getConfiguration('mars').get<string>('zotero.url', 'http://127.0.0.1:23119').replace(/\/+$/, '');
    this.busy++;
    try {
      let keys: string[];
      try {
        keys = await zoteroPick(base, this.fetcher);
      } catch (err) {
        void vscode.window.showErrorMessage(
          `Mars: no se pudo abrir el selector de Zotero (${(err as Error).message}). Zotero debe estar abierto y tener instalado el complemento Better BibTeX.`,
        );
        return;
      }
      if (!keys.length) return; // el usuario canceló
      this.panel.reveal(undefined, false);
      let entries: BibEntry[] = [];
      try {
        entries = parseBibtex(await zoteroExport(base, keys, this.fetcher));
      } catch (err) {
        void vscode.window.showWarningMessage(`Mars: Zotero no ha entregado los datos de las referencias (${(err as Error).message}). Se inserta la cita; añade las entradas a tu bibliografía.`);
      }
      const known = new Set(entries.map((e) => e.key));
      await this.adopt(entries, true, false);
      // la cita lleva todas las claves elegidas, también las que no se pudieron exportar
      this.post({ type: 'cmd', cmd: 'cite', arg: keys.join(',') });
      if (entries.length && keys.some((k) => !known.has(k))) void vscode.window.showWarningMessage('Mars: alguna referencia de Zotero no se pudo exportar; revisa la bibliografía.');
    } finally {
      this.busy--;
    }
  }

  /** Incorpora referencias y repinta sin sacar al usuario del párrafo que está escribiendo. */
  private async adopt(entries: BibEntry[], keepKeys: boolean, cite: boolean): Promise<void> {
    let keys: string[] = [];
    await this.enqueue(async (doc) => {
      keys = await this.importEntries(doc, entries, keepKeys);
      this.render('preview');
    });
    if (cite && keys.length) this.post({ type: 'cmd', cmd: 'cite', arg: keys.join(',') });
  }

  /** Cambia la configuración de página reescribiendo solo el preámbulo. */
  private setLayout(patch: Partial<Layout>): Promise<void> {
    return this.editPreamble((text) => writeLayout(text, patch));
  }

  /** Cambia el preámbulo con `change` (en un capítulo, el del documento principal) y vuelve a dibujar. */
  private editPreamble(change: (text: string) => string): Promise<void> {
    return this.enqueue(async (own) => {
      // la disposición de un capítulo es la de su documento principal: se cambia allí
      const doc = this.rootFile ? await vscode.workspace.openTextDocument(this.rootFile) : own;
      const saved = doc !== own && !doc.isDirty;
      const before = doc.getText();
      const after = change(before);
      if (after === before) {
        if (!readLayout(before)) void vscode.window.showInformationMessage('Mars: este archivo no tiene \\documentclass; la disposición se configura en el documento principal.');
        return;
      }
      const cut = (s: string): number => s.search(/^[ \t]*\\begin\{document\}/m);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(doc.uri, new vscode.Range(new vscode.Position(0, 0), doc.positionAt(cut(before))), after.slice(0, cut(after)));
      if (doc === own) await this.applyEdit(doc, edit);
      else if ((await vscode.workspace.applyEdit(edit)) && saved) await doc.save();
      this.render('full');
    });
  }

  onDocumentChange(e: vscode.TextDocumentChangeEvent): void {
    const doc = e.document;
    if (doc === this.doc) {
      if (this.applying || doc.version <= this.ownVersion) return; // eco de una edición propia
      if (e.reason !== undefined && e.contentChanges.length) {
        // deshacer/rehacer: el cursor irá al punto donde cambió el texto
        this.focusAfter = Math.min(...e.contentChanges.map((c) => c.range.start.line));
      }
    } else if (isTex(doc) || /\.bib$/i.test(doc.uri.path)) {
      // otro .tex (\input) o la bibliografía: este documento no ha cambiado, así que lo que se
      // esté escribiendo en el editor visual sigue en su sitio
      this.scheduleRender(true);
      return;
    } else return;
    this.scheduleRender();
  }

  /** el redibujado pendiente se debe solo a cambios en otros archivos (\input, .bib) */
  private outside = true;

  private scheduleRender(outside = false): void {
    if (this.timer === undefined) this.outside = true;
    this.outside &&= outside;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      const focusLine = this.panel.active ? this.focusAfter : undefined;
      this.focusAfter = undefined;
      this.render(this.outside ? 'preview' : 'editor', focusLine === undefined ? {} : { focusLine });
    }, 60);
  }

  onScroll(e: vscode.TextEditorVisibleRangesChangeEvent): void {
    if (e.textEditor.document !== this.doc || this.applying || !e.visibleRanges.length) return;
    if (Date.now() - this.revealedAt < 400) return; // desplazamiento provocado por la propia vista previa
    if (!vscode.workspace.getConfiguration('mars').get<boolean>('scrollSync', true)) return;
    void this.panel.webview.postMessage({ type: 'scroll', line: e.visibleRanges[0].start.line });
  }

  onSelection(e: vscode.TextEditorSelectionChangeEvent): void {
    if (e.textEditor.document !== this.doc || e.textEditor !== vscode.window.activeTextEditor) return;
    // solo movimientos hechos por el usuario (teclado o ratón), no los que provoca la extensión
    if (e.kind !== vscode.TextEditorSelectionChangeKind.Keyboard && e.kind !== vscode.TextEditorSelectionChangeKind.Mouse) return;
    void this.panel.webview.postMessage({ type: 'cursor', line: e.selections[0].active.line });
  }

  // ------------------------------------------------------------ edición desde la vista previa

  /** Rango y texto equivalentes a un `Splice` sobre el documento actual. */
  private toEdit(doc: vscode.TextDocument, sp: Splice): { range: vscode.Range; text: string } {
    const total = doc.lineCount;
    const s = Math.min(Math.max(sp.s, 0), total);
    const d = Math.max(0, Math.min(sp.d, total - s));
    const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    if (s + d < total) return { range: new vscode.Range(s, 0, s + d, 0), text: sp.lines.map((l) => l + eol).join('') };
    const end = doc.lineAt(total - 1).text.length;
    if (s === 0) return { range: new vscode.Range(0, 0, total - 1, end), text: sp.lines.join(eol) };
    return { range: new vscode.Range(s - 1, doc.lineAt(s - 1).text.length, total - 1, end), text: sp.lines.map((l) => eol + l).join('') };
  }

  /** Aplica varios cambios como una sola edición (un único paso de deshacer). */
  private async apply(doc: vscode.TextDocument, splices: Splice[]): Promise<boolean> {
    if (process.env.MARS_TRACE) console.log('[mars:splice]', JSON.stringify(splices));
    const edit = new vscode.WorkspaceEdit();
    for (const sp of splices) {
      const { range, text } = this.toEdit(doc, sp);
      edit.replace(doc.uri, range, text);
    }
    return this.applyEdit(doc, edit);
  }

  private async applyEdit(doc: vscode.TextDocument, edit: vscode.WorkspaceEdit): Promise<boolean> {
    const v = doc.version;
    const ok = await vscode.workspace.applyEdit(edit);
    if (doc.version > v) this.ownEdits++;
    this.ownVersion = doc.version;
    return ok;
  }

  private matches(doc: vscode.TextDocument, m: SpliceMsg): boolean {
    if (!m.expect) return true;
    if (m.expect.length !== m.d || m.s < 0 || m.s + m.d > doc.lineCount) return false;
    // las líneas vecinas también deben ser las que el webview tenía a la vista
    const at = (i: number): string | undefined => (i >= 0 && i < doc.lineCount ? doc.lineAt(i).text : undefined);
    if (m.prev !== undefined && at(m.s - 1) !== m.prev) return false;
    if (m.next !== undefined && at(m.s + m.d) !== m.next) return false;
    return m.expect.every((l, i) => doc.lineAt(m.s + i).text === l);
  }

  /** `\usepackage` que faltan para lo que se acaba de insertar. */
  private packageSplice(doc: vscode.TextDocument, packages: string[]): Splice | undefined {
    let classLine = -1;
    let lastPkg = -1;
    const present = new Set<string>();
    for (let i = 0; i < doc.lineCount; i++) {
      const line = doc.lineAt(i).text;
      if (/^\s*\\begin\{document\}/.test(line)) break;
      if (/^\s*\\documentclass/.test(line)) classLine = i;
      const m = /^\s*\\usepackage\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/.exec(line);
      if (m) {
        lastPkg = i;
        for (const p of m[1].split(',')) present.add(p.trim());
      }
    }
    // una entrada que empieza por «\» no es un paquete: es una línea que hay que tener en el preámbulo
    const head = doc.getText().split(/^\s*\\begin\{document\}/m)[0];
    const missing = packages.filter((p) => (p.startsWith('\\') ? !head.includes(p) : !present.has(p)));
    if (classLine < 0 || !missing.length) return undefined;
    // ulem sin `normalem` convertiría el énfasis (\emph) en subrayado
    const line = (p: string): string => (p.startsWith('\\') ? p : p === 'ulem' ? '\\usepackage[normalem]{ulem}' : `\\usepackage{${p}}`);
    return { s: Math.max(classLine, lastPkg) + 1, d: 0, lines: missing.map(line) };
  }

  private enqueue(task: (doc: vscode.TextDocument) => Promise<void>): Promise<void> {
    this.busy++;
    this.queue = this.queue
      .then(async () => {
        const doc = this.doc;
        if (doc.isClosed) return;
        const before = doc.version;
        this.ownEdits = 0;
        this.applying = true;
        try {
          await task(doc);
        } finally {
          this.applying = false;
        }
        if (doc.version > before + this.ownEdits) {
          // alguien más editó el documento mientras se aplicaba el cambio
          this.ownVersion = -1;
          this.scheduleRender();
        }
      })
      .catch((err) => console.error('[mars]', err))
      .finally(() => {
        this.busy--;
      });
    return this.queue;
  }

  private handleSplice(m: SpliceMsg): Promise<void> {
    return this.enqueue(async (doc) => {
      this.lastSeq = m.seq;
      if (!this.matches(doc, m)) {
        // la vista previa iba desfasada respecto al documento: no se toca nada y se resincroniza
        console.warn(`[mars] edición descartada en la línea ${m.s}: el documento no coincide`);
        this.rejected++;
        this.render('full');
        return;
      }
      const pkg = m.packages?.length ? this.packageSplice(doc, m.packages) : undefined;
      const ok = await this.apply(doc, pkg && pkg.s <= m.s ? [pkg, m] : [m]);
      if (ok) await this.rootPackages(m.packages);
      const shift = ok && pkg && pkg.s <= m.s ? pkg.lines.length : 0;
      this.render(ok && !m.full && !shift ? 'preview' : 'full', shift ? { shift } : {});
    });
  }

  /**
   * Varios cambios a la vez (borrar o dar formato a una selección que abarca varios bloques): se
   * aplican todos o ninguno, como una sola edición y un solo paso de deshacer.
   */
  private handleBatch(m: { seq: number; list: SpliceMsg[]; packages?: string[] }): Promise<void> {
    return this.enqueue(async (doc) => {
      this.lastSeq = m.seq;
      const list = [...m.list].sort((a, b) => a.s - b.s);
      const overlap = list.some((sp, i) => i > 0 && list[i - 1].s + list[i - 1].d > sp.s);
      if (!list.length || overlap || !list.every((sp) => this.matches(doc, sp))) {
        console.warn('[mars] edición múltiple descartada: el documento no coincide');
        this.rejected++;
        this.render('full');
        return;
      }
      const pkg = m.packages?.length ? this.packageSplice(doc, m.packages) : undefined;
      const above = pkg && pkg.s <= list[0].s ? pkg : undefined;
      const ok = await this.apply(doc, above ? [above, ...list] : list);
      if (ok) await this.rootPackages(m.packages);
      this.render('full', ok && above ? { shift: above.lines.length } : {});
    });
  }

  /** Deshacer/rehacer del propio documento (el mismo historial que el editor de código). */
  private async history(command: 'undo' | 'redo'): Promise<void> {
    this.busy++;
    try {
      await this.queue;
      if (!this.panel.active) {
        this.panel.reveal(undefined, false);
        await new Promise((r) => setTimeout(r, 150));
      }
      const before = this.doc.version;
      await vscode.commands.executeCommand(command);
      // sin cambios no llega ningún evento del documento: se resincroniza igualmente
      if (this.doc.version === before) this.render('full');
    } finally {
      this.busy--;
    }
  }

  undo(): Promise<void> {
    return this.history('undo');
  }

  redo(): Promise<void> {
    return this.history('redo');
  }

  /**
   * Cambia el texto de una «variable» del documento: el cuerpo de su \newcommand (o \def), en este
   * archivo o, si es un capítulo, en el principal.
   */
  private async setMacro(name: string, body: string): Promise<void> {
    if (!/^\\[a-zA-Z@]+$/.test(name)) return;
    const find = (text: string): { start: number; end: number } | undefined => {
      const esc = name.replace(/\\/g, '\\\\');
      const re = new RegExp(`\\\\(?:(?:re)?newcommand|providecommand|DeclareRobustCommand)\\*?\\s*(?:\\{\\s*${esc}\\s*\\}|${esc}(?![a-zA-Z@]))\\s*(?:\\[[^\\]]*\\]\\s*)*\\{|\\\\def\\s*${esc}(?![a-zA-Z@])\\s*\\{`, 'g');
      let last: RegExpExecArray | null = null;
      // (la última definición es la que vale)
      for (let m = re.exec(text); m; m = re.exec(text)) last = m;
      if (!last) return undefined;
      const start = last.index + last[0].length;
      let depth = 1;
      let end = start;
      for (; end < text.length && depth > 0; end++) {
        if (text[end] === '\\') end++;
        else if (text[end] === '{') depth++;
        else if (text[end] === '}') depth--;
      }
      return depth === 0 ? { start, end: end - 1 } : undefined;
    };
    await this.queue;
    const here = find(this.doc.getText());
    const root = this.rootFile;
    const target = here || !root ? this.doc : await vscode.workspace.openTextDocument(vscode.Uri.file(root));
    const at = here ?? find(target.getText());
    if (!at) {
      void vscode.window.showWarningMessage(`Mars: no encuentro dónde se define ${name}; cámbialo en el preámbulo.`);
      return;
    }
    if (target === this.doc) {
      await this.enqueue(async (doc) => {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, new vscode.Range(doc.positionAt(at.start), doc.positionAt(at.end)), body);
        await this.applyEdit(doc, edit);
        this.render('full');
      });
    } else {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(target.uri, new vscode.Range(target.positionAt(at.start), target.positionAt(at.end)), body);
      if (await vscode.workspace.applyEdit(edit)) await target.save();
      this.render('full');
    }
  }

  private setMeta(m: { title: string; author: string; date: string }): Promise<void> {
    return this.enqueue(async (doc) => {
      const text = doc.getText();
      const edit = new vscode.WorkspaceEdit();
      const missing: string[] = [];
      for (const key of ['title', 'author', 'date'] as const) {
        const value = m[key];
        const found = new RegExp(`\\\\${key}\\s*(\\[[^\\]]*\\])?\\s*\\{`).exec(text);
        if (!found) {
          if (value.trim()) missing.push(`\\${key}{${value}}`);
          continue;
        }
        const start = found.index + found[0].length;
        let depth = 1;
        let end = start;
        for (; end < text.length && depth > 0; end++) {
          if (text[end] === '\\') end++;
          else if (text[end] === '{') depth++;
          else if (text[end] === '}') depth--;
        }
        edit.replace(doc.uri, new vscode.Range(doc.positionAt(start), doc.positionAt(end - 1)), value);
      }
      if (missing.length) {
        const at = text.search(/^[ \t]*\\begin\{document\}/m);
        const eol = doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
        edit.insert(doc.uri, doc.positionAt(Math.max(at, 0)), missing.join(eol) + eol + eol);
      }
      await this.applyEdit(doc, edit);
      this.render('full');
    });
  }

  /** Guarda junto al documento una imagen pegada desde el portapapeles y la ofrece para insertar. */
  private async pasteImage(m: { data: string; ext: string }): Promise<void> {
    if (!onDisk(this.doc.uri)) {
      void vscode.window.showInformationMessage('Mars: guarda primero el documento para poder pegar imágenes.');
      return;
    }
    const ext = /^(png|jpg|jpeg|gif|webp)$/.test(m.ext) ? m.ext : 'png';
    const dir = path.join(this.baseDir, 'img');
    fs.mkdirSync(dir, { recursive: true });
    let n = 1;
    while (fs.existsSync(path.join(dir, `imagen-${n}.${ext}`))) n++;
    fs.writeFileSync(path.join(dir, `imagen-${n}.${ext}`), Buffer.from(m.data, 'base64'));
    void this.panel.webview.postMessage({ type: 'imagePicked', path: `img/imagen-${n}.${ext}` });
  }

  private newDocument(template = 'article', startWriting = false): Promise<void> {
    const TEMPLATE = TEMPLATES[template] ?? TEMPLATES.article;
    return this.enqueue(async (doc) => {
      if (doc.getText().trim()) {
        // el archivo ya tiene algo (un comentario, un preámbulo a medias) aunque no dibuje nada: no se
        // toca, pero «Empezar a escribir» abre igualmente el primer párrafo
        if (startWriting) this.render('full', { startWriting: true });
        return;
      }
      if (doc.uri.scheme === 'file') writeCompanions(path.dirname(doc.uri.fsPath), template);
      const edit = new vscode.WorkspaceEdit();
      const last = doc.lineAt(doc.lineCount - 1);
      edit.replace(doc.uri, new vscode.Range(0, 0, last.lineNumber, last.text.length), TEMPLATE);
      await this.applyEdit(doc, edit);
      this.render('full', startWriting ? { startWriting: true } : {});
    });
  }

  private async pickImage(replace = false): Promise<void> {
    const doc = this.doc;
    const dir = doc.uri.scheme === 'file' ? this.baseDir : undefined;
    let file = this.pickImageOverride;
    if (!file) {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false,
        defaultUri: dir ? vscode.Uri.file(dir) : undefined,
        filters: { Imágenes: ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'pdf', 'eps'] },
        title: 'Insertar imagen',
      });
      if (!picked?.length) return;
      file = picked[0].fsPath;
      this.panel.reveal(undefined, false);
    }
    void this.panel.webview.postMessage({ type: 'imagePicked', path: this.localImage(file), replace });
  }

  /**
   * Ruta con la que el documento debe nombrar una imagen. Si está en su carpeta (o por debajo), la
   * ruta relativa; si viene de otro sitio, se copia a `img/` para que el documento no dependa de
   * una ruta de este equipo.
   */
  private localImage(file: string): string {
    const dir = this.doc.uri.scheme === 'file' ? this.baseDir : undefined;
    if (!dir) return file.replace(/\\/g, '/');
    const rel = path.relative(dir, file);
    if (!rel.startsWith('..') && !path.isAbsolute(rel)) return rel.replace(/\\/g, '/');
    try {
      const target = path.join(dir, 'img');
      fs.mkdirSync(target, { recursive: true });
      const ext = path.extname(file);
      const base = path.basename(file, ext).replace(/[^\w.-]+/g, '-') || 'imagen';
      let name = base + ext;
      // el mismo archivo ya copiado antes se reutiliza; otro con el mismo nombre recibe un número
      for (let n = 2; fs.existsSync(path.join(target, name)); n++) {
        if (fs.statSync(path.join(target, name)).size === fs.statSync(file).size && fs.readFileSync(path.join(target, name)).equals(fs.readFileSync(file))) break;
        name = `${base}-${n}${ext}`;
      }
      if (!fs.existsSync(path.join(target, name))) fs.copyFileSync(file, path.join(target, name));
      return `img/${name}`;
    } catch {
      return rel.replace(/\\/g, '/');
    }
  }

  /** Pone una imagen del documento en el portapapeles del sistema (cuando el editor visual no ha podido). */
  private copyImage(rel: string): void {
    const file = this.doc.uri.scheme === 'file' ? path.resolve(this.baseDir, rel) : rel;
    if (process.platform !== 'win32' || !fs.existsSync(file) || !/\.(png|jpe?g|gif|bmp)$/i.test(file)) {
      void vscode.window.showInformationMessage('Mars: no se pudo copiar la imagen al portapapeles; se ha copiado su código LaTeX.');
      return;
    }
    const script = `Add-Type -AssemblyName System.Windows.Forms, System.Drawing; $i = [Drawing.Image]::FromFile('${file.replace(/'/g, "''")}'); [Windows.Forms.Clipboard]::SetImage($i); $i.Dispose()`;
    execFile('powershell.exe', ['-NoProfile', '-STA', '-Command', script], { windowsHide: true }, (err) => {
      if (err) void vscode.window.showInformationMessage('Mars: no se pudo copiar la imagen al portapapeles.');
    });
  }

  private editorFor(doc: vscode.TextDocument): vscode.TextEditor | undefined {
    return vscode.window.visibleTextEditors.find((e) => e.document === doc);
  }

  save(): void {
    // deja llegar primero lo que el webview esté enviando en este instante
    void new Promise((r) => setTimeout(r, 60)).then(() => this.queue).then(() => this.doc.save());
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private onMessage(m: any): void {
    const doc = this.doc;
    // una versión antigua no se toca: de lo que pida el editor solo se atiende lo que no cambia nada
    if (this.readonly && !['ready', 'rendered', 'testResult', 'info', 'spell', 'spellSuggest', 'gitPanel', 'gitCompare', 'gitMore', 'gitOpen', 'pdfForward'].includes(m.type)) return;
    switch (m.type) {
      case 'gitPanel':
        // se abre (o se cierra) el panel de cambios: por defecto se compara con el último commit,
        // y una versión antigua, con la anterior a ella
        this.gitRef = m.open ? (this.readonly ? `${this.doc.uri.query}^` : 'HEAD') : undefined;
        if (m.open) void this.sendLog().then(() => this.sendDiff());
        break;
      case 'gitCompare':
        if (typeof m.ref === 'string' && /^(HEAD|[0-9a-f]{6,40})\^?$/.test(m.ref)) {
          this.gitRef = m.ref;
          void this.sendDiff();
        }
        break;
      case 'gitMore':
        void this.sendLog(Number(m.skip) || 0);
        break;
      case 'gitOpen':
        this.openVersion(String(m.ref ?? ''));
        break;
      case 'gitRestore':
        void this.restoreChange(Number(m.index));
        break;
      case 'gitCommit':
        void this.commit(String(m.message ?? ''), m.all === true);
        break;
      case 'openPath':
        // otro archivo del proyecto con cambios
        if (typeof m.path === 'string' && /\.(tex|ltx)$/i.test(m.path)) this.openFile(m.path);
        else if (typeof m.path === 'string' && fs.existsSync(m.path)) void vscode.window.showTextDocument(vscode.Uri.file(m.path));
        break;
      case 'exportPdf':
        void this.exportPdf();
        break;
      case 'pdfForward':
        if (typeof m.line === 'number') {
          const line = m.line;
          const pdf = this.pdfPath();
          // sin PDF, o con uno anterior a lo último que se ha escrito: se compone primero y luego se va al párrafo
          const age = (f: string): number => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0);
          if (pdf && (!fs.existsSync(pdf) || this.doc.isDirty || age(this.doc.uri.fsPath) > age(pdf))) {
            void this.exportPdf().then((r) => {
              if (r.pdf) this.pdfForward(line);
            });
          } else this.pdfForward(line);
        }
        break;
      case 'ready': {
        this.render('full');
        // se abrió para ir a un párrafo concreto (desde el documento que lo incluye)
        const key = this.doc.uri.scheme === 'file' ? path.normalize(this.doc.uri.fsPath).toLowerCase() : '';
        const line = pendingLine.get(key);
        if (line !== undefined) {
          pendingLine.delete(key);
          this.post({ type: 'cursor', line, scroll: true });
        }
        break;
      }
      case 'splice':
        void this.handleSplice(m as SpliceMsg);
        break;
      case 'splices':
        void this.handleBatch(m);
        break;
      case 'undo':
        void this.undo();
        break;
      case 'redo':
        void this.redo();
        break;
      case 'save':
        this.save();
        break;
      case 'setMeta':
        void this.setMeta(m);
        break;
      case 'setMacro':
        if (typeof m.name === 'string' && typeof m.body === 'string') void this.setMacro(m.name, m.body);
        break;
      case 'newDoc':
        void this.newDocument(m.template, m.startWriting === true);
        break;
      case 'pasteImage':
        void this.pasteImage(m);
        break;
      case 'layout':
        void this.setLayout(m.patch);
        break;
      case 'headfoot': {
        // encabezado y pie de página (fancyhdr); sin `spec`, se quitan y vuelve el estilo de la clase
        const cells = (v: unknown): [string, string, string] | undefined =>
          Array.isArray(v) && v.length === 3 && v.every((x) => typeof x === 'string') ? (v as [string, string, string]) : undefined;
        const head = cells(m.spec?.head);
        const foot = cells(m.spec?.foot);
        const spec = head && foot ? { head, foot, headRule: m.spec.headRule === true, footRule: m.spec.footRule === true } : undefined;
        if (m.spec && !spec) break;
        void this.editPreamble((text) => writeHeadFoot(text, spec));
        break;
      }
      case 'preamble':
        // definiciones que el editor necesita en el preámbulo (un estilo propio, un paquete)
        void this.enqueue(async (doc) => {
          const add = Array.isArray(m.lines) ? this.packageSplice(doc, m.lines.map(String)) : undefined;
          if (add && (await this.apply(doc, [add]))) this.render('full', { shift: add.lines.length });
          else if (Array.isArray(m.lines)) await this.rootPackages(m.lines.map(String));
        });
        break;
      case 'openFile':
        // un archivo traído con \input (o el documento principal de este capítulo)
        this.openFile(m.root === true ? this.rootFile : typeof m.file === 'string' ? texPath(this.baseDir, m.file) : undefined, typeof m.line === 'number' ? m.line : undefined);
        break;
      case 'setSource':
        // editar (con `text`) o quitar (sin él) una fuente desde el panel de referencias
        if (typeof m.key === 'string') void this.changeSource(m.key, typeof m.text === 'string' ? m.text : '');
        break;
      case 'addSource':
        void this.addSource(m);
        break;
      case 'addDoi':
        void this.addDoi(m);
        break;
      case 'citeZotero':
        void this.citeZotero();
        break;
      case 'pickImage':
        void this.pickImage(m.replace === true);
        break;
      case 'dropImage':
        // un archivo de imagen soltado sobre el documento
        if (typeof m.file === 'string' && fs.existsSync(m.file)) void this.panel.webview.postMessage({ type: 'imagePicked', path: this.localImage(m.file) });
        break;
      case 'info':
        if (typeof m.text === 'string') void vscode.window.showInformationMessage(`Mars: ${m.text}`);
        break;
      case 'presentMode':
        void this.presentMode(m.on === true);
        break;
      case 'deckCover':
        // textos propios de la portada de la presentación, para este documento
        if (m.value && typeof m.value === 'object') void this.ctx.workspaceState.update(this.coverKey, m.value);
        break;
      case 'copyImage':
        if (typeof m.path === 'string') this.copyImage(m.path);
        break;
      case 'spell': {
        const langs = this.spellLangs;
        void this.spell.check(langs, Array.isArray(m.words) ? m.words : []).then((bad) => this.post({ type: 'spellResult', id: m.id, bad }));
        break;
      }
      case 'spellSuggest':
        void this.spell.suggest(this.spellLangs, String(m.word ?? '')).then((list) => this.post({ type: 'spellSuggestions', id: m.id, list }));
        break;
      case 'spellAdd':
        this.spell.add(String(m.word ?? ''));
        // la palabra deja de estar subrayada en todos los documentos abiertos
        for (const p of this.peers) p.post({ type: 'spellLearned', word: m.word });
        break;
      case 'spellConfig':
        void this.setSpellConfig(m);
        break;
      case 'prefs': {
        // una preferencia de la vista cambiada aquí vale para todos los editores, abiertos o futuros
        if (!m.patch || typeof m.patch !== 'object') break;
        const patch = Object.fromEntries(Object.entries(m.patch as Record<string, unknown>).filter(([k]) => PREF_KEYS.includes(k)));
        const prefs = { ...this.ctx.globalState.get<Record<string, unknown>>(VIEW_PREFS, {}), ...patch };
        void this.ctx.globalState.update(VIEW_PREFS, prefs);
        for (const p of this.peers) if (p !== this) p.post({ type: 'prefs', prefs });
        break;
      }
      case 'landscapeView':
        if (typeof m.value === 'string') void vscode.workspace.getConfiguration('mars').update('landscapePages', m.value, vscode.ConfigurationTarget.Global);
        break;
      case 'landscapePackage':
        // lscape <-> pdflscape: el mismo giro al imprimir; pdflscape pone además la hoja apaisada en el visor de PDF
        void this.enqueue(async (doc) => {
          const swap = landscapeSwap(doc.getText(), m.pdf === true);
          if (swap && (await this.apply(doc, [{ s: swap.line, d: 1, lines: [swap.text] }]))) this.render('full');
        });
        break;
      case 'goto': {
        const line = Math.min(Math.max(m.line, 0), doc.lineCount - 1);
        const column = this.editorFor(doc)?.viewColumn ?? (this.panel.viewColumn === vscode.ViewColumn.One ? vscode.ViewColumn.Two : vscode.ViewColumn.One);
        codeWanted.add(doc.uri.toString());
        void vscode.commands.executeCommand('vscode.openWith', doc.uri, 'default', { viewColumn: column, selection: new vscode.Range(line, 0, line, 0) });
        break;
      }
      case 'reveal': {
        const editor = this.editorFor(doc);
        if (!editor) break;
        const line = Math.min(Math.max(m.line, 0), doc.lineCount - 1);
        this.revealedAt = Date.now();
        editor.revealRange(new vscode.Range(line, 0, line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        break;
      }
      case 'rendered':
        this.got++;
        break;
      case 'testResult': {
        const t = this.tests.get(m.id);
        this.tests.delete(m.id);
        if (m.error) t?.reject(new Error(m.error));
        else t?.resolve(m.result);
        break;
      }
    }
  }

  // ------------------------------------------------------------ soporte para las pruebas

  /** Ejecuta una acción dentro del webview (ver `runTest` en webview/main.ts). */
  test(action: string, args: Record<string, unknown> = {}): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const id = ++this.testId;
      this.tests.set(id, { resolve, reject });
      void this.panel.webview.postMessage({ type: 'test', id, action, args });
    });
  }

  /** Espera a que no queden ediciones en cola y el webview haya pintado la última versión. */
  async settle(): Promise<void> {
    const idle = (): boolean =>
      this.busy === 0 && this.timer === undefined && this.assets.pending === 0 && this.sent > 0 && this.got >= this.sent;
    let calm = 0;
    for (let i = 0; i < 300 && calm < 3; i++) {
      await new Promise((r) => setTimeout(r, 100));
      calm = idle() ? calm + 1 : 0;
    }
    if (calm < 3) throw new Error('La vista previa no terminó de actualizarse');
  }
}

class MarsProvider implements vscode.CustomTextEditorProvider {
  readonly previews = new Set<Preview>();
  private readonly cacheDir: string;
  private readonly assets: Assets;
  readonly spell: Spell;

  constructor(private readonly ctx: vscode.ExtensionContext) {
    this.cacheDir = path.join(ctx.globalStorageUri.fsPath, 'cache');
    // cuando termina una figura en segundo plano se repintan los editores abiertos
    this.assets = new Assets(this.cacheDir, () => this.previews.forEach((p) => p.render('preview')));
    // el diccionario personal se guarda con la extensión y vale para todos los documentos
    this.spell = new Spell(ctx.extensionPath, ctx.globalState.get<string[]>(USER_WORDS, []), (words) => void ctx.globalState.update(USER_WORDS, words));
  }

  /** el editor visual que tuvo el foco por última vez */
  last: Preview | undefined;

  resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): void {
    const preview = new Preview(this.ctx, document, panel, this.assets, this.cacheDir, this.spell, this.previews);
    this.previews.add(preview);
    this.last = preview;
    panel.onDidChangeViewState(() => {
      if (panel.active) this.last = preview;
    });
    panel.onDidDispose(() => {
      // «Volver a abrir con el editor de texto» cierra el visual y abre el código: ese se respeta
      const key = document.uri.toString();
      codeWanted.add(key);
      setTimeout(() => codeWanted.delete(key), 3000);
      this.previews.delete(preview);
      if (this.last === preview) this.last = [...this.previews].pop();
    });
  }

  /** .tex que ya se veían como código en alguna pestaña la última vez que cambiaron las pestañas */
  private codeTabs = codeTexTabs();

  /**
   * Con un editor visual abierto, un .tex que se abre como código pasa también al editor visual:
   * a la columna del editor visual si está al lado (el código queda junto a él, como con ▶), o en
   * lugar del código si está en la misma. Solo el que acaba de aparecer (también en la pestaña de
   * vista previa, que VS Code reutiliza al abrir con un clic) y tiene el foco: no las pestañas de
   * código que ya había ni el código que Mars abre a propósito.
   */
  onTabsChanged(): void {
    const now = codeTexTabs();
    // (la pestaña aparece antes de tener el foco: se espera a que lo tenga, unos segundos como mucho)
    for (const k of now.keys()) if (!this.codeTabs.has(k)) this.arriving.set(k, Date.now());
    this.codeTabs = now;
    for (const [k, since] of this.arriving) {
      const tab = now.get(k);
      if (!tab || Date.now() - since > 5000) this.arriving.delete(k);
      else if (tab.isActive) {
        this.arriving.delete(k);
        void this.followVisual(tab);
      }
    }
  }

  /** .tex recién aparecidos como código, a la espera de que su pestaña tenga el foco */
  private arriving = new Map<string, number>();

  private async followVisual(tab: vscode.Tab): Promise<void> {
    if (!(tab.input instanceof vscode.TabInputText)) return;
    const uri = tab.input.uri;
    if (codeWanted.delete(uri.toString())) return;
    if (!vscode.workspace.getConfiguration('mars').get<boolean>('openInVisualEditor', true)) return;
    const visual = this.last && this.previews.has(this.last) && !this.last.readonly ? this.last : [...this.previews].find((p) => !p.readonly);
    if (!visual || this.for(uri)) return;
    const here = tab.group.viewColumn;
    const column = visual.column ?? here;
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, column);
    if (column === here) await vscode.window.tabGroups.close(tab, true);
  }

  for(uri: vscode.Uri): Preview | undefined {
    return [...this.previews].find((p) => p.document.uri.toString() === uri.toString());
  }

  get current(): Preview | undefined {
    return [...this.previews].find((p) => p.active);
  }
}

/** Pestañas de código con un .tex del disco, por archivo. */
function codeTexTabs(): Map<string, vscode.Tab> {
  const found = new Map<string, vscode.Tab>();
  for (const tab of vscode.window.tabGroups.all.flatMap((g) => g.tabs)) {
    if (tab.input instanceof vscode.TabInputText && tab.input.uri.scheme === 'file' && isTexFile(tab.input.uri)) found.set(tab.input.uri.toString(), tab);
  }
  return found;
}

/** Línea a la que ir al abrir un archivo (por su ruta), pedida antes de que su editor exista. */
const pendingLine = new Map<string, number>();

/** Escribe junto al documento los archivos que acompañan a su plantilla, sin pisar los que ya existan. */
function writeCompanions(dir: string, template: string): void {
  for (const [rel, content] of Object.entries(TEMPLATE_FILES[template] ?? {})) {
    const file = path.join(dir, rel);
    if (fs.existsSync(file)) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
}

/**
 * «Mars: Nuevo documento»: pregunta la plantilla y dónde guardarlo, crea el archivo (y, en una
 * tesis, sus capítulos) y lo abre en el editor visual. `where`: carpeta donde proponerlo (desde el
 * explorador) o el .tex que hay que crear; `template`: la plantilla, si ya está elegida.
 */
async function newDocument(where: unknown, template: unknown): Promise<vscode.Uri | undefined> {
  let id = typeof template === 'string' && TEMPLATES[template] ? template : undefined;
  if (!id) {
    const pick = await vscode.window.showQuickPick(
      TEMPLATE_LIST.map((t) => ({ label: t.label, detail: t.detail, id: t.id })),
      { title: 'Mars: documento nuevo', placeHolder: 'Elige una plantilla' },
    );
    if (!pick) return undefined;
    id = pick.id;
  }
  let target = where instanceof vscode.Uri && /\.(tex|ltx)$/i.test(where.path) ? where : undefined;
  if (!target) {
    const active = vscode.window.activeTextEditor?.document.uri;
    const dir =
      where instanceof vscode.Uri
        ? where
        : vscode.workspace.workspaceFolders?.[0]?.uri ?? (active?.scheme === 'file' ? vscode.Uri.file(path.dirname(active.fsPath)) : vscode.Uri.file(os.homedir()));
    target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(dir, id === 'thesis' ? 'tesis.tex' : 'documento.tex'),
      filters: { LaTeX: ['tex'] },
      title: id === 'thesis' ? 'Guardar la tesis (sus capítulos irán en la carpeta «capitulos», al lado)' : 'Guardar el documento nuevo',
    });
    if (!target) return undefined;
  }
  try {
    fs.mkdirSync(path.dirname(target.fsPath), { recursive: true });
    fs.writeFileSync(target.fsPath, TEMPLATES[id]);
    writeCompanions(path.dirname(target.fsPath), id);
  } catch (err) {
    void vscode.window.showErrorMessage(`Mars: no se pudo crear el documento (${(err as Error).message}).`);
    return undefined;
  }
  await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE);
  return target;
}

/** Hace que los .tex se abran siempre con el editor visual (o deja de hacerlo). */
async function toggleDefaultEditor(): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('workbench');
  const current = { ...(cfg.get<Record<string, string>>('editorAssociations') ?? {}) };
  const on = current['*.tex'] === VIEW_TYPE;
  if (on) delete current['*.tex'];
  else current['*.tex'] = VIEW_TYPE;
  await cfg.update('editorAssociations', current, vscode.ConfigurationTarget.Global);
  void vscode.window.showInformationMessage(
    on ? 'Mars: los .tex vuelven a abrirse con el editor de código.' : 'Mars: desde ahora los .tex se abren con el editor visual. Repite la orden para deshacerlo.',
  );
}

export interface MarsApi {
  /** editor visual abierto sobre ese archivo, si lo hay */
  previewFor(uri: vscode.Uri): Preview | undefined;
  /** palabras del diccionario personal del corrector */
  userWords(): string[];
}

export function activate(ctx: vscode.ExtensionContext): MarsApi {
  // VS Code se cerró a mitad de una presentación: sus ajustes vuelven a como estaban
  void restorePresentSettings(ctx);
  const provider = new MarsProvider(ctx);
  const open = async (uri: unknown, column: vscode.ViewColumn): Promise<void> => {
    const target = uri instanceof vscode.Uri ? uri : vscode.window.activeTextEditor?.document.uri;
    if (!target || !isTexFile(target)) {
      void vscode.window.showInformationMessage('Mars: abre un archivo .tex para usar el editor visual.');
      return;
    }
    const existing = provider.for(target);
    if (existing) existing.reveal();
    else await vscode.commands.executeCommand('vscode.openWith', target, VIEW_TYPE, column);
  };
  ctx.subscriptions.push(
    vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, {
      // enableFindWidget: Ctrl+F abre el buscador nativo de VS Code sobre el documento visual
      webviewOptions: { retainContextWhenHidden: true, enableFindWidget: true },
      supportsMultipleEditorsPerDocument: false,
    }),
    vscode.commands.registerCommand('mars.openPreviewToSide', (uri?: unknown) => open(uri, vscode.ViewColumn.Beside)),
    vscode.commands.registerCommand('mars.openPreview', (uri?: unknown) => open(uri, vscode.ViewColumn.Active)),
    vscode.commands.registerCommand('mars.save', () => provider.current?.save()),
    // el texto de un documento en un commit: mars-git:/ruta/al/archivo.tex?<commit>
    vscode.workspace.registerTextDocumentContentProvider(GIT_SCHEME, {
      provideTextDocumentContent: async (uri) => {
        const root = await repoRoot(uri.fsPath);
        return (root ? await fileAt(root, uri.fsPath, uri.query) : undefined) ?? '';
      },
    }),
    vscode.commands.registerCommand('mars.exportPdf', () => provider.current?.exportPdf()),
    vscode.commands.registerCommand('mars.newDocument', (where?: unknown, template?: unknown) => newDocument(where, template)),
    vscode.commands.registerCommand('mars.toggleDefaultEditor', () => toggleDefaultEditor()),
    vscode.commands.registerCommand('mars.noop', () => undefined),
    vscode.window.tabGroups.onDidChangeTabs(() => provider.onTabsChanged()),
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.contentChanges.length) provider.previews.forEach((p) => p.onDocumentChange(e));
    }),
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => provider.previews.forEach((p) => p.onScroll(e))),
    vscode.window.onDidChangeTextEditorSelection((e) => provider.previews.forEach((p) => p.onSelection(e))),
    vscode.workspace.onDidChangeConfiguration((e) => {
      // el corrector se activa, se desactiva o cambia de idioma en todos los editores a la vez
      if (e.affectsConfiguration('mars.spellCheck') || e.affectsConfiguration('mars.hyphenation') || e.affectsConfiguration('mars.landscapePages')) provider.previews.forEach((p) => p.render('preview'));
    }),
    { dispose: () => provider.spell.dispose() },
  );
  return { previewFor: (uri) => provider.for(uri), userWords: () => provider.spell.userWords };
}

export function deactivate(): void {
  // nada que liberar: todo está en ctx.subscriptions
}
