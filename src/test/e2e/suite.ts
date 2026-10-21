import * as assert from 'assert/strict';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';
import * as vscode from 'vscode';
import type { MarsApi, Preview } from '../../extension';
import { renderLatex } from '../../latex/renderer';

interface Snapshot {
  ahead?: string;
  active: number;
  caret?: number;
  dialog: boolean;
  /** hay un párrafo nuevo, aún vacío, esperando texto */
  pending: boolean;
  /** índices de los bloques que pasan enteros a una hoja nueva */
  starts: number[];
  /** índices de los bloques que abren una hoja nueva o están partidos entre dos */
  breaks: number[];
  /** texto justo antes y después de cada corte dentro de un bloque */
  splits: string[];
  blocks: { kind: string; s: number; e: number; text: string }[];
}

interface Ui {
  slash?: string[];
  slashVisible: boolean;
  bubble: boolean;
  bubbleButtons: number;
  navOpen: boolean;
  outline: string[];
  selected: number;
  templates: number;
  part: string;
  included: string[];
  missingIcons: string[];
}

interface Ribbon {
  /** estado de carga de las fuentes del documento ('loaded' cuando ya están) */
  fonts: string;
  /** márgenes de la hoja en pantalla: superior, inferior, izquierdo, derecho */
  margins: string;
  rulerMarks: number;
  sheet: string;
  pages: number;
  view: string;
  statusIcons: string[];
  tab: string;
  tabs: string[];
  groups: string[];
  checked: string[];
  sources: string[];
  icons: number;
  pageWidth: string;
  /** fuentes con las que se dibuja el texto del documento */
  pageFont: string;
  /** lo que muestran los cuadros de fuente y tamaño de Inicio */
  fontBox: [string, string];
  /** vista de varias páginas: hojas del mosaico, hojas por fila y continuaciones copiadas */
  grid: { on: boolean; sheets: number; perRow: number; mirrors: number; clipped: number };
  /** número impreso al pie de cada hoja ('' = sin número) y alto de cada espacio elástico (\vfill) */
  nums: string[];
  vfill: number[];
  widowsOn: boolean;
  tracking: boolean;
  /** estilos propios del documento que ofrece el menú de estilos */
  ustyles: string[];
  /** encabezados, pies y notas al pie de cada hoja, flotantes desplazados y hoja de cada bloque */
  furn: { head: string[][]; foot: string[][]; ruled: number; notes: number[][]; styles: string[]; floated: number[]; pageOf: number[]; endNotes: number };
  twoCol: boolean;
  missingIcons: string[];
  /** medidas en bruto, para entender un fallo */
  debug: unknown;
}

interface Formula {
  /** botones de «Recientes» */
  recent: number;
  /** huecos dibujados en las estructuras de la paleta */
  holes: number;
  codeShown: boolean;
  matrixShown: boolean;
  visual: boolean;
  fieldValue?: string;
  code: string;
  tabs: number;
  items: number;
  rendered: number;
}

interface Spell {
  enabled: boolean;
  choice: string;
  langs: string[];
  pending: boolean;
  /** palabras subrayadas, en el orden del documento */
  bad: string[];
  count: number;
  selected: string;
  menu?: { loading: boolean; suggestions: string[] };
  highlights: number;
}

interface XSel {
  on: boolean;
  /** índices de los bloques seleccionados */
  blocks: number[];
  latex: string;
  /** texto seleccionado en cada bloque de texto */
  text: string[];
  marks: number;
  /** bloques marcados enteros (ecuaciones, figuras) */
  tinted: number;
}

interface Media {
  pdf: string[];
  tikz: number;
  tikzError: string[];
  img: number[];
}

/** Lo que devuelve doi.org para 10.1038/nature14539 (copiado de una respuesta real). */
const DOI_REPLY =
  ' @article{LeCun_2015, title={Deep learning}, volume={521}, ISSN={1476-4687}, url={http://dx.doi.org/10.1038/nature14539}, DOI={10.1038/nature14539}, number={7553}, journal={Nature}, publisher={Springer Science and Business Media LLC}, author={LeCun, Yann and Bengio, Yoshua and Hinton, Geoffrey}, year={2015}, month=May, pages={436–444} }\n';

const dir = process.env.MARS_E2E_DIR as string;
let api: MarsApi;
let preview: Preview;

const text = (): string => preview.document.getText().replace(/\r\n/g, '\n');
const snap = async (): Promise<Snapshot> => (await preview.test('snapshot')) as Snapshot;
const media = async (): Promise<Media> => (await preview.test('media')) as Media;
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
let pristine = '';
/** Deshace lo que quede hasta volver al documento original (el historial es el del propio documento). */
const intact = async (): Promise<void> => {
  for (let k = 0; k < 8 && text() !== pristine; k++) await cmd('undo');
  assert.equal(text(), pristine, 'el documento no volvió a su estado original');
};
const find = (s: Snapshot, needle: string | RegExp): number => {
  const i = s.blocks.findIndex((b) => (typeof needle === 'string' ? b.text.includes(needle) : needle.test(b.text)));
  assert.ok(i >= 0, `no hay ningún bloque con "${needle}"`);
  return i;
};
const act = async (action: string, args: Record<string, unknown> = {}): Promise<unknown> => {
  const r = await preview.test(action, args);
  await preview.settle();
  return r;
};
const cmd = (name: string, arg?: string): Promise<unknown> => act('cmd', { name, arg });
const norm = (html: string): string => html.replace(/\s+/g, ' ').replace(/ ?(<\/?(li|ul|ol|td|tr|table|div|figure)\b)/g, '$1');
const html = (tex: string): string => renderLatex(tex).blocks.filter((b) => b.kind !== 'ro').map((b) => b.html).join('\n');

/** Espera a que el panel recién abierto tenga sus fuentes cargadas y la paginación hecha. */
async function laidOut(): Promise<Ribbon> {
  let r = (await preview.test('ribbon')) as Ribbon;
  let stable = 0;
  for (let k = 0; k < 80 && stable < 3; k++) {
    await sleep(100);
    const next = (await preview.test('ribbon')) as Ribbon;
    stable = next.fonts === 'loaded' && next.pages === r.pages ? stable + 1 : 0;
    r = next;
  }
  return r;
}

async function open(file: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument(path.join(dir, file));
  await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
  // el mismo comando que lanza el botón ▶ del editor
  await vscode.commands.executeCommand('mars.openPreviewToSide', doc.uri);
  for (let k = 0; k < 100 && !api.previewFor(doc.uri); k++) await sleep(100);
  const p = api.previewFor(doc.uri);
  assert.ok(p, 'no se abrió el editor visual');
  preview = p;
  await preview.settle();
  assert.equal(preview.document, doc);
}

const tests: [string, () => Promise<void>][] = [
  [
    'abre el editor visual y dibuja el documento',
    async () => {
      await open('ejemplo.tex');
      const s = await snap();
      assert.ok(s.blocks.length > 15, `solo ${s.blocks.length} bloques`);
      assert.equal(s.blocks[0].kind, 'atom');
      assert.match(s.blocks[0].text, /Preámbulo/);
      find(s, 'Mars: LaTeX sin compilar');
      find(s, 'Teorema 1 (Pitágoras)');
      pristine = text();
    },
  ],
  [
    'el DOM real se serializa a LaTeX equivalente (ida y vuelta)',
    async () => {
      const pairs = (await preview.test('roundtrip')) as { src: string; tex: string }[];
      assert.ok(pairs.length > 8);
      for (const p of pairs) {
        assert.equal(norm(html(p.tex)), norm(html(p.src)), `\n${p.src}\n=>\n${p.tex}`);
        assert.equal(p.tex, p.src.replace(/[ \t]+\n/g, '\n').trim(), 'un bloque sin modificar conserva su formato exacto');
      }
    },
  ],
  [
    'editar una celda o un elemento de lista solo cambia esa línea del código',
    async () => {
      const s = await snap();
      const t = find(s, 'Tierra');
      await act('caretIn', { index: t, selector: 'td', nth: 3 });
      await act('typeMore', { text: 'X' });
      assert.equal(text(), pristine.replace('    Tierra & 1 & 6371 \\\\', '    TierraX & 1 & 6371 \\\\'));
      await act('blur');
      await intact();
      const l = find(await snap(), 'Primer elemento');
      await act('caretIn', { index: l, selector: 'li', nth: 2 });
      await act('typeMore', { text: '!' });
      assert.equal(text(), pristine.replace('    \\item Anidado uno', '    \\item Anidado uno!'));
      await act('blur');
      await intact();
    },
  ],
  [
    'pegar: el texto corriente se escapa y el código LaTeX se interpreta',
    async () => {
      const i = find(await snap(), 'Un párrafo con');
      await act('caret', { index: i });
      await act('paste', { text: ' 100% de A&B' });
      assert.match(text(), /\\\$10\. 100\\% de A\\&B\n/);
      await act('paste', { text: ' \\textbf{pegado} con $x^2$' });
      assert.match(text(), /A\\&B\\textbf\{pegado\} con \$x\^2\$\n/);
      const s = await snap();
      assert.match(s.blocks[i].text, /de A&Bpegado con x2/, 'el LaTeX pegado se dibuja, no se muestra como código');
      // una ruta de Windows o una llave suelta no son código: se escapan y se ven como se pegaron
      await act('paste', { text: ' C:\\Users\\ana y {suelta' });
      assert.match(text(), / C:\\textbackslash\{\}Users\\textbackslash\{\}ana y \\\{suelta\n/);
      assert.match((await snap()).blocks[i].text, /C:\\Users\\ana y \{suelta/);
      await act('blur');
      await intact();
    },
  ],
  [
    'las flechas pasan de un bloque al siguiente y al anterior',
    async () => {
      const s = await snap();
      const i = find(s, 'Un párrafo con');
      await act('caret', { index: i });
      assert.equal(await act('key', { key: 'ArrowDown' }), true);
      let now = await snap();
      assert.equal(now.active, i + 1);
      assert.equal(now.caret, 0);
      assert.equal(await act('key', { key: 'ArrowUp' }), true);
      now = await snap();
      assert.equal(now.active, i);
      assert.equal(now.ahead, '', 'el cursor queda al final del bloque anterior');
      assert.equal(await act('key', { key: 'ArrowRight' }), true);
      assert.equal((await snap()).active, i + 1);
      assert.equal(await act('key', { key: 'ArrowLeft' }), true);
      assert.equal((await snap()).active, i);
      await act('blur');
      await intact();
    },
  ],
  [
    'insertar una imagen elegida en el selector de archivos',
    async () => {
      const i = find(await snap(), 'Un párrafo con');
      await act('caret', { index: i });
      preview.pickImageOverride = path.join(dir, 'img', 'pixel.png');
      await cmd('ins-image');
      for (let k = 0; k < 50 && !(await snap()).dialog; k++) await sleep(100);
      await act('dialog', { values: { width: '40', caption: 'Un píxel' } });
      assert.match(text(), /\\begin\{figure\}\[h\]\n {2}\\centering\n {2}\\includegraphics\[width=0\.4\\textwidth\]\{img\/pixel\.png\}\n {2}\\caption\{Un píxel\}\n\\end\{figure\}/);
      find(await snap(), 'Figura 1: Un píxel');
      for (let k = 0; k < 50 && !(await media()).img.some((w) => w > 0); k++) await sleep(100);
      assert.deepEqual((await media()).img, [1], 'la imagen se carga en la vista previa');
      assert.equal(await act('resizeImage', { frac: 0.25 }), '25%', 'arrastrar el borde cambia el ancho');
      assert.match(text(), /\\includegraphics\[width=0\.25\\textwidth\]\{img\/pixel\.png\}/);
      await intact();
    },
  ],
  [
    'la cinta tiene pestañas con grupos e iconos',
    async () => {
      let r = (await preview.test('ribbon')) as Ribbon;
      assert.deepEqual(r.tabs, ['Inicio', 'Insertar', 'Disposición', 'Referencias', 'Revisar', 'Vista', 'Tabla', 'Imagen']);
      assert.deepEqual(r.groups, ['Fuente', 'Párrafo', 'Estilos', 'Ecuación']);
      assert.ok(r.icons > 40, `solo ${r.icons} iconos`);
      assert.deepEqual(r.missingIcons, [], 'todos los iconos existen en la fuente');
      r = (await preview.test('ribbon', { click: '[data-tab="insert"]' })) as Ribbon;
      assert.deepEqual(r.groups, ['Páginas', 'Tablas', 'Ilustraciones', 'Vínculos', 'Texto', 'Símbolos']);
      r = (await preview.test('ribbon', { click: '[data-tab="layout"]' })) as Ribbon;
      assert.deepEqual(r.groups, ['Configurar página', 'Texto', 'Documento']);
      assert.ok(r.checked.includes('lang=spanish') && r.checked.includes('orientation=portrait'), r.checked.join());
      // la fuente y el tamaño de letra están en Inicio, en sus cuadros, no en Disposición
      assert.deepEqual(r.fontBox, ['Computer Modern', '10']);
      assert.ok(!r.checked.some((c) => /^font(Size)?=/.test(c)), r.checked.join());
      r = (await preview.test('ribbon', { click: '[data-tab="refs"]' })) as Ribbon;
      assert.deepEqual(r.groups, ['Tabla de contenido', 'Notas al pie', 'Citas y bibliografía', 'Títulos']);
      r = (await preview.test('ribbon', { click: '[data-tab="review"]' })) as Ribbon;
      assert.deepEqual(r.groups, ['Edición', 'Cambios', 'Comentarios', 'Ortografía']);
      assert.deepEqual(r.missingIcons, [], 'todos los iconos existen en la fuente');
      await preview.test('ribbon', { click: '[data-tab="home"]' });
    },
  ],
  [
    'vista de página: hojas con el tamaño del papel, paginadas, y vista continua',
    async () => {
      let r = (await preview.test('ribbon')) as Ribbon;
      assert.equal(r.view, 'page', 'la vista de página es la predeterminada');
      assert.equal(r.sheet, '993.14px x 1285.24px', 'hoja carta: 21,59 × 27,94 cm, a 46 px por cm');
      assert.ok(r.pages >= 2, `el ejemplo ocupa más de una hoja (${r.pages})`);
      assert.deepEqual(r.statusIcons, [], 'iconos de la barra de estado');
      const s = await snap();
      assert.ok(s.breaks.length === r.pages - 1 && s.breaks.every((b) => b > 0), `saltos de hoja: ${s.breaks.join()}`);
      await cmd('view', 'flow');
      r = (await preview.test('ribbon')) as Ribbon;
      assert.equal(r.view, 'flow');
      assert.equal((await snap()).breaks.length, 0, 'en vista continua no hay saltos');
      await cmd('view', 'page');
      r = (await preview.test('ribbon')) as Ribbon;
      assert.ok(r.view === 'page' && r.pages >= 2);
    },
  ],
  [
    'panel de navegación: esquema del documento y salto a una sección',
    async () => {
      let u = (await preview.test('ui')) as Ui;
      if (!u.navOpen) await cmd('nav');
      u = (await preview.test('ui')) as Ui;
      assert.deepEqual(u.outline, ['nav-lt:Mars: LaTeX sin compilar', 'nav-l0:1.Texto', 'nav-l1:1.1.Listas', 'nav-l0:2.Matemáticas', 'nav-l0:3.Tablas y código']);
      assert.deepEqual(u.missingIcons, []);
      u = (await preview.test('ui', { navClick: 3 })) as Ui;
      assert.equal(u.selected, find(await snap(), /^2\.Matemáticas/), 'al pulsar una entrada se va a esa sección');
      // en un panel estrecho el esquema flota y se cierra solo al elegir; si está acoplado, se cierra a mano
      if (u.navOpen) await cmd('nav');
      assert.equal(((await preview.test('ui')) as Ui).navOpen, false);
    },
  ],
  [
    'comandos con «/»: menú filtrable que inserta sin dejar rastro de lo tecleado',
    async () => {
      const i = find(await snap(), 'Un párrafo con');
      await act('caret', { index: i });
      await act('typeMore', { text: ' ' });
      await act('typeMore', { text: '/' });
      let u = (await preview.test('ui')) as Ui;
      assert.ok(u.slashVisible && (u.slash?.length ?? 0) >= 15, `menú abierto con ${u.slash?.length} comandos`);
      await act('typeMore', { text: 'tab' });
      u = (await preview.test('ui')) as Ui;
      assert.deepEqual(u.slash, ['Tabla'], 'lo escrito tras la barra filtra los comandos');
      u = (await preview.test('ui', { slashPick: 0 })) as Ui;
      assert.equal(u.slashVisible, false);
      assert.equal((await snap()).dialog, true, 'se abre el diálogo de tabla');
      await act('dialog', { values: { rows: '2', cols: '2', caption: '' } });
      assert.doesNotMatch(text(), /\/tab/);
      assert.match(text(), /\\\$10\.\n\n\\begin\{center\}\n\\begin\{tabular\}\{\|c\|c\|\}/);
      await intact();
    },
  ],
  [
    'atajos tipo Markdown: «# » crea un título y «1. » una lista numerada',
    async () => {
      const i = find(await snap(), 'Un párrafo con');
      await act('enter', { index: i });
      await act('typeMore', { text: '#' });
      await act('typeMore', { text: ' ' });
      await act('typeMore', { text: 'Nuevo título' });
      assert.match(text(), /\\\$10\.\n\n\\section\{Nuevo título\}\n/);
      await act('blur');
      await intact();
      await act('enter', { index: find(await snap(), 'Un párrafo con') });
      await act('typeMore', { text: '1.' });
      await act('typeMore', { text: ' ' });
      await act('typeMore', { text: 'uno' });
      assert.match(text(), /\\\$10\.\n\n\\begin\{enumerate\}\n {2}\\item uno\n\\end\{enumerate\}\n/);
      await act('blur');
      await intact();
    },
  ],
  [
    'barra flotante al seleccionar texto',
    async () => {
      const i = find(await snap(), 'Un párrafo con');
      await preview.test('select', { index: i, from: 3, to: 10 });
      let u = (await preview.test('ui', { bubble: true })) as Ui;
      assert.ok(u.bubble && u.bubbleButtons === 8, JSON.stringify(u));
      await cmd('to-math');
      assert.match(text(), /\nUn \$párrafo\$ con \\textbf/);
      await act('blur');
      u = (await preview.test('ui', { bubble: true })) as Ui;
      assert.equal(u.bubble, false, 'sin selección no hay barra');
      await intact();
    },
  ],
  [
    'pegar con formato (Word, web): negritas, enlaces, títulos y listas pasan a LaTeX',
    async () => {
      const i = find(await snap(), 'Un párrafo con');
      await act('caret', { index: i });
      await act('pasteHtml', { html: ' con <b>negrita pegada</b> y <a href="https://x.y">enlace</a>', text: ' con negrita pegada y enlace' });
      assert.match(text(), /\\\$10\.con \\textbf\{negrita pegada\} y \\href\{https:\/\/x\.y\}\{enlace\}\n/);
      await act('pasteHtml', { html: '<h2>Pegado</h2><p>Un párrafo <i>nuevo</i>.</p><ul><li>a</li><li>b</li></ul>', text: 'Pegado\nUn párrafo nuevo.\na\nb' });
      assert.match(text(), /\n\n\\subsection\{Pegado\}\n\nUn párrafo \\textit\{nuevo\}\.\n\n\\begin\{itemize\}\n {2}\\item a\n {2}\\item b\n\\end\{itemize\}\n/);
      const s = await snap();
      find(s, /^1\.1\.Pegado/);
      await intact();
    },
  ],
  [
    'tabla: alinear una columna y quitar o poner bordes',
    async () => {
      const i = find(await snap(), 'Tierra');
      await act('caretIn', { index: i, selector: 'td', nth: 3 });
      await cmd('table', 'align-r');
      const right = pristine.replace('{|l|c|r|}', '{|r|c|r|}');
      assert.equal(text(), right, 'solo cambia la letra de la columna');
      await act('caretIn', { index: i, selector: 'td', nth: 3 });
      await cmd('table', 'borders');
      assert.match(text(), /\\begin\{tabular\}\{rcr\}\n\s+\\textbf\{Planeta\} & \\textbf\{Lunas\} & \\textbf\{Radio \(km\)\} \\\\\n\s+Tierra & 1 & 6371 \\\\\n\s+Marte & 2 & 3390 \\\\\n\s+\\end\{tabular\}/);
      await act('caretIn', { index: i, selector: 'td', nth: 3 });
      await cmd('table', 'borders');
      assert.equal(text(), right, 'al volver a poner los bordes la tabla queda como estaba');
      await act('blur');
      await intact();
    },
  ],
  [
    'pegar una imagen del portapapeles la guarda junto al documento y la inserta',
    async () => {
      const i = find(await snap(), 'Un párrafo con');
      await act('caret', { index: i });
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      (preview as unknown as { onMessage(m: unknown): void }).onMessage({ type: 'pasteImage', data: png, ext: 'png' });
      for (let k = 0; k < 50 && !(await snap()).dialog; k++) await sleep(100);
      await act('dialog', { values: { caption: 'Pegada' } });
      assert.match(text(), /\\includegraphics\[width=0\.6\\textwidth\]\{img\/imagen-1\.png\}\n {2}\\caption\{Pegada\}/);
      const saved = vscode.Uri.file(path.join(dir, 'img', 'imagen-1.png'));
      assert.equal((await vscode.workspace.fs.stat(saved)).size > 50, true, 'el archivo se ha guardado');
      await intact();
    },
  ],
  [
    'Disposición: papel, márgenes y columnas se escriben en el preámbulo',
    async () => {
      await cmd('layout', 'paper=a4paper');
      assert.match(text(), /^\\documentclass\[a4paper\]\{article\}\n/);
      await cmd('layout', 'margin=2.54cm');
      assert.match(text(), /\\usepackage\{hyperref\}\n\\usepackage\[margin=2\.54cm\]\{geometry\}\n/);
      let r = (await preview.test('ribbon')) as Ribbon;
      assert.ok(r.checked.includes('paper=a4paper') && r.checked.includes('margins=2.54cm,2.54cm,2.54cm,2.54cm'), r.checked.join());
      assert.ok(r.rulerMarks >= 14, `la regla marca los centímetros del ancho de texto (${r.rulerMarks} marcas; ${JSON.stringify(r.debug)})`);
      assert.equal(r.pageWidth, '732.32px', 'la caja de texto toma el ancho real (15,92 cm a 46 px/cm)');
      assert.equal(r.sheet, '966px x 1366.2px', 'la hoja tiene las proporciones de un A4');
      await cmd('layout', 'columns=2');
      await cmd('layout', 'spacing=1.5');
      assert.match(text(), /^\\documentclass\[a4paper, twocolumn\]\{article\}\n/);
      assert.match(text(), /\\usepackage\{setspace\}\n\\onehalfspacing\n/);
      r = (await preview.test('ribbon')) as Ribbon;
      assert.equal(r.twoCol, true);
      assert.equal(text().split('\\begin{document}')[1], pristine.split('\\begin{document}')[1], 'el cuerpo no se toca');
      await intact();
    },
  ],
  [
    'márgenes por lado: ajustes predefinidos y diálogo personalizado',
    async () => {
      await cmd('layout', 'margins=2.54cm,2.54cm,1.91cm,1.91cm');
      assert.match(text(), /\\usepackage\[top=2\.54cm, bottom=2\.54cm, left=1\.91cm, right=1\.91cm\]\{geometry\}\n/);
      let r = (await preview.test('ribbon')) as Ribbon;
      assert.ok(r.checked.includes('margins=2.54cm,2.54cm,1.91cm,1.91cm'), 'el menú marca «Moderado»');
      assert.equal(r.margins, '116.84px 116.84px 87.86px 87.86px', 'la hoja aplica cada margen (46 px por cm)');
      assert.equal(r.pageWidth, '817.42px');
      await cmd('layout', 'margins=custom');
      assert.equal((await snap()).dialog, true);
      await act('dialog', { values: { top: '3', bottom: '2', left: '4', right: '1,5' } });
      assert.match(text(), /\\usepackage\[top=3cm, bottom=2cm, left=4cm, right=1\.5cm\]\{geometry\}\n/);
      r = (await preview.test('ribbon')) as Ribbon;
      assert.equal(r.margins, '138px 92px 184px 69px');
      await cmd('layout', 'margins=');
      assert.equal(text(), pristine, 'volver a los márgenes de LaTeX quita el paquete geometry');
      await intact();
    },
  ],
  [
    'tamaños de hoja: A3 (vía geometry) y tamaño personalizado',
    async () => {
      await cmd('layout', 'paper=a3paper');
      assert.match(text(), /\\usepackage\[a3paper\]\{geometry\}\n/);
      let r = (await preview.test('ribbon')) as Ribbon;
      assert.equal(r.sheet, '1366.2px x 1932px');
      assert.ok(r.checked.includes('paper=a3paper'));
      await cmd('layout', 'paper=custom');
      await act('dialog', { values: { w: '18', h: '24' } });
      assert.match(text(), /\\usepackage\[paperwidth=18cm, paperheight=24cm\]\{geometry\}\n/);
      r = (await preview.test('ribbon')) as Ribbon;
      assert.equal(r.sheet, '828px x 1104px');
      await cmd('layout', 'orientation=landscape');
      r = (await preview.test('ribbon')) as Ribbon;
      assert.equal(r.sheet, '1104px x 828px', 'en horizontal se intercambian ancho y alto');
      await intact();
    },
  ],
  [
    'tipo de letra: del texto seleccionado y de todo el documento',
    async () => {
      // texto seleccionado: palo seco y romana
      const i = find(await snap(), 'Un párrafo con');
      assert.equal(await act('select', { index: i, from: 3, to: 10 }), 'párrafo');
      await cmd('wrap', 'sf');
      assert.match(text(), /\nUn \\textsf\{párrafo\} con \\textbf\{negrita\}/);
      await act('blur');
      await cmd('undo');
      await intact();
      // texto seleccionado: una fuente concreta, solo para esas palabras
      assert.equal(await act('select', { index: i, from: 3, to: 10 }), 'párrafo');
      await cmd('font', 'times');
      assert.match(text(), /\nUn \{\\fontfamily\{ptm\}\\selectfont párrafo\} con \\textbf\{negrita\}/);
      assert.doesNotMatch(text(), /mathptmx/, 'la letra del documento no cambia');
      let r = (await preview.test('ribbon')) as Ribbon;
      assert.deepEqual(r.fontBox, ['Times', '10'], 'el cuadro muestra la fuente de lo seleccionado');
      // otra fuente sobre lo mismo sustituye a la anterior; la del documento la quita
      await cmd('font', 'palatino');
      assert.match(text(), /\nUn \{\\fontfamily\{ppl\}\\selectfont párrafo\} con/);
      await cmd('font', '');
      assert.equal(text(), pristine, 'elegir la fuente del documento deja el texto como estaba');
      await act('blur');
      // todo el documento (sin nada seleccionado): Times
      r = (await preview.test('ribbon')) as Ribbon;
      assert.deepEqual(r.fontBox, ['Computer Modern', '10'], 'por defecto, la letra de LaTeX');
      assert.match(r.pageFont, /KaTeX_Main/);
      await cmd('font', 'times');
      assert.match(text(), /\\usepackage\{hyperref\}\n\\usepackage\{mathptmx\}\n/);
      r = (await preview.test('ribbon')) as Ribbon;
      assert.equal(r.fontBox[0], 'Times');
      assert.match(r.pageFont, /^"?Times New Roman/, 'la hoja se dibuja con esa letra');
      // palo seco: el paquete y la familia por defecto
      await cmd('font', 'helvetica');
      assert.doesNotMatch(text(), /mathptmx/);
      assert.match(text(), /\\usepackage\{helvet\}\n\\renewcommand\{\\familydefault\}\{\\sfdefault\}\n/);
      r = (await preview.test('ribbon')) as Ribbon;
      assert.match(r.pageFont, /^"?Helvetica/);
      assert.equal(text().split('\\begin{document}')[1], pristine.split('\\begin{document}')[1], 'el cuerpo no se toca');
      // volver a la letra de LaTeX deja el preámbulo como estaba
      await cmd('font', '');
      assert.equal(text(), pristine);
      await intact();
    },
  ],
  [
    'tamaño de letra en puntos: del texto seleccionado y de todo el documento',
    async () => {
      const i = find(await snap(), 'Un párrafo con');
      assert.equal(await act('select', { index: i, from: 3, to: 10 }), 'párrafo');
      await cmd('fsize', '14');
      assert.match(text(), /\nUn \{\\fontsize\{14\}\{16\.8\}\\selectfont párrafo\} con \\textbf\{negrita\}/);
      assert.match(text(), /\\usepackage\{hyperref\}\n\\usepackage\{anyfontsize\}\n/, 'con el paquete que admite cualquier tamaño');
      let r = (await preview.test('ribbon')) as Ribbon;
      assert.equal(r.fontBox[1], '14', 'el cuadro muestra el tamaño de lo seleccionado');
      assert.equal((await snap()).active, i, 'el párrafo sigue en edición aunque el preámbulo haya cambiado');
      // otro tamaño sobre lo mismo lo sustituye; los botones de agrandar y reducir pasan al siguiente de la lista
      await cmd('fsize', '24');
      assert.match(text(), /\nUn \{\\fontsize\{24\}\{28\.8\}\\selectfont párrafo\} con/);
      await cmd('fsize-step', '1');
      assert.match(text(), /\{\\fontsize\{26\}\{31\.2\}\\selectfont párrafo\}/);
      await cmd('fsize-step', '-1');
      await cmd('fsize-step', '-1');
      assert.match(text(), /\{\\fontsize\{22\}\{26\.4\}\\selectfont párrafo\}/);
      assert.equal(text().match(/fontsize\{/g)?.length, 1, 'sin anidar un tamaño dentro de otro');
      // el tamaño del documento quita el cambio
      await cmd('fsize', '10');
      assert.match(text(), /\nUn párrafo con \\textbf\{negrita\}/);
      await act('blur');
      await intact();
      // sin selección: 12 pt es una opción de la clase; 14 pt, del paquete scrextend
      await cmd('fsize', '12');
      assert.match(text(), /^\\documentclass\[12pt\]\{article\}\n/);
      r = (await preview.test('ribbon')) as Ribbon;
      assert.equal(r.fontBox[1], '12');
      await cmd('fsize-step', '1');
      assert.match(text(), /^\\documentclass\{article\}\n/);
      assert.match(text(), /\\usepackage\[fontsize=14pt\]\{scrextend\}\n/);
      r = (await preview.test('ribbon')) as Ribbon;
      assert.equal(r.fontBox[1], '14');
      assert.equal(text().split('\\begin{document}')[1], pristine.split('\\begin{document}')[1], 'el cuerpo no se toca');
      await cmd('fsize', '10');
      assert.equal(text(), pristine, 'volver a 10 pt deja el preámbulo como estaba');
      await intact();
    },
  ],
  [
    'párrafo: interlineado y sangría propios desde Inicio',
    async () => {
      const i = find(await snap(), 'Un párrafo con');
      await act('caret', { index: i });
      await cmd('par-spacing', '1.25');
      assert.match(text(), /\n\\begin\{spacing\}\{1\.25\}\nUn párrafo con [\s\S]*\\\$10\.\n\\end\{spacing\}\n/);
      assert.match(text(), /\\usepackage\{setspace\}\n/, 'con su paquete');
      // otro interlineado sobre el mismo párrafo cambia el que tenía, sin anidar
      await cmd('par-spacing', '1.667');
      assert.match(text(), /\\begin\{spacing\}\{1\.667\}\nUn párrafo con/);
      assert.equal(text().match(/\\begin\{spacing\}/g)?.length, 1);
      // sangría: un centímetro más cada vez, alrededor de lo que ya había
      await cmd('par-indent', '+');
      assert.match(text(), /\\begin\{adjustwidth\}\{1cm\}\{0cm\}\n\\begin\{spacing\}\{1\.667\}\n[\s\S]*\\end\{spacing\}\n\\end\{adjustwidth\}\n/);
      assert.match(text(), /\\usepackage\{changepage\}\n/);
      await cmd('par-indent', '+');
      assert.match(text(), /\\begin\{adjustwidth\}\{2cm\}\{0cm\}/);
      await cmd('par-indent', '-');
      await cmd('par-indent', '-');
      assert.doesNotMatch(text(), /adjustwidth\}/, 'al volver a cero la sangría desaparece');
      await cmd('par-spacing', '');
      assert.doesNotMatch(text(), /\\begin\{spacing\}/);
      assert.match(text(), /\n\nUn párrafo con \\textbf\{negrita\}/, 'el párrafo queda como estaba');
      await act('blur');
      for (let k = 0; k < 12 && text() !== pristine; k++) await cmd('undo');
      assert.equal(text(), pristine);
    },
  ],
  [
    'viñetas y numeración: símbolo de la lista y formato de los números',
    async () => {
      const i = find(await snap(), 'Primer elemento');
      await act('caretIn', { index: i, selector: 'li', nth: 0 });
      await cmd('list-style', 'itemize|$\\circ$');
      assert.match(text(), /\\begin\{itemize\}\[label=\$\\circ\$\]\n {2}\\item Primer elemento/);
      assert.match(text(), /\\usepackage\{enumitem\}\n/);
      await act('caretIn', { index: i, selector: 'li', nth: 0 });
      await cmd('list-style', 'enumerate|(\\alph*)');
      assert.match(text(), /\\begin\{enumerate\}\[label=\(\\alph\*\)\]\n {2}\\item Primer elemento[\s\S]*\\end\{enumerate\}\n\\end\{enumerate\}/);
      await act('caretIn', { index: i, selector: 'li', nth: 0 });
      await cmd('list-style', 'itemize|');
      assert.match(text(), /\\begin\{itemize\}\n {2}\\item Primer elemento/, 'la viñeta normal no necesita opción');
      await act('blur');
      await intact();
    },
  ],
  [
    'copiar formato: el del texto del cursor pasa a lo siguiente que se selecciona',
    async () => {
      const i = find(await snap(), 'Un párrafo con');
      assert.equal(await act('select', { index: i, from: 15, to: 22 }), 'negrita');
      await cmd('brush');
      assert.equal(await act('select', { index: i, from: 3, to: 10 }), 'párrafo');
      assert.equal(await act('brush'), true, 'el pincel se suelta tras usarlo');
      assert.match(text(), /\nUn \\textbf\{párrafo\} con \\textbf\{negrita\}/);
      await act('blur');
      await intact();
    },
  ],
  [
    'buscar y reemplazar: cuenta las coincidencias y las cambia todas en un solo paso',
    async () => {
      const count = (re: RegExp): number => text().match(re)?.length ?? 0;
      let f = (await act('find', { q: 'elemento' })) as { found: number; label: string; marks: number };
      assert.equal(f.found, 2, 'sin distinguir mayúsculas: «Primer elemento» y «Segundo elemento»');
      assert.equal(f.label, '1 de 2');
      assert.equal(f.marks, 2, 'las dos quedan resaltadas');
      f = (await act('find', { q: 'ELEMENTO', matchCase: true })) as typeof f;
      assert.equal(f.found, 0);
      const before = count(/elemento/g);
      await act('find', { q: 'elemento', r: 'punto', replace: 'one' });
      assert.match(text(), /\\item Primer punto\n {2}\\item Segundo elemento/);
      await cmd('undo');
      await act('find', { q: 'elemento', r: 'punto 50%', replace: 'all', close: true });
      assert.equal(count(/elemento/g), before - 2);
      assert.match(text(), /\\item Primer punto 50\\%\n {2}\\item Segundo punto 50\\% con/, 'el texto de reemplazo se escribe como texto, con sus símbolos escapados');
      await cmd('undo');
      assert.equal(text(), pristine, 'reemplazar todo es un solo paso de deshacer');
    },
  ],
  [
    'control de cambios: lo escrito y lo borrado queda marcado, y se acepta o se rechaza todo',
    async () => {
      const i = find(await snap(), 'Un párrafo con');
      await cmd('track');
      assert.equal(((await preview.test('ribbon')) as Ribbon).tracking, true);
      await act('caret', { index: i, offset: 3 });
      assert.equal(await act('input', { inputType: 'insertText', data: 'X' }), true);
      assert.match(text(), /\nUn \\added\{X\}párrafo con/);
      assert.match(text(), /\\usepackage\{changes\}\n/);
      // dentro de un añadido propio se sigue escribiendo con normalidad
      await act('input', { inputType: 'insertText', data: 'Y' });
      assert.match(text(), /\nUn \\added\{XY\}párrafo con/);
      // borrar texto del documento no lo quita: lo deja marcado
      await act('input', { inputType: 'deleteContentForward' });
      assert.match(text(), /\nUn \\added\{XY\}\\deleted\{p\}árrafo con/);
      // borrar un añadido propio sí lo borra
      await act('caret', { index: i, offset: 5 });
      await act('input', { inputType: 'deleteContentBackward' });
      assert.match(text(), /\nUn \\added\{X\}\\deleted\{p\}árrafo con/);
      await act('blur');
      const marked = text();
      await cmd('chg-accept');
      assert.match(text(), /\nUn Xárrafo con \\textbf/, 'aceptar: queda lo nuevo');
      await cmd('undo');
      assert.equal(text(), marked);
      await cmd('chg-reject');
      assert.match(text(), /\nUn párrafo con \\textbf/, 'rechazar: queda lo de antes');
      await cmd('track');
      assert.equal(((await preview.test('ribbon')) as Ribbon).tracking, false);
      for (let k = 0; k < 12 && text() !== pristine; k++) await cmd('undo');
      assert.equal(text(), pristine);
    },
  ],
  [
    'comentario al margen, donde está el cursor',
    async () => {
      const i = find(await snap(), 'Un párrafo con');
      await act('caret', { index: i });
      await cmd('ins-comment');
      assert.equal((await snap()).dialog, true);
      await act('dialog', { values: { text: 'Revisar esta frase' } });
      assert.match(text(), /y \\\$10\.\\todo\{Revisar esta frase\}\n/);
      assert.match(text(), /\\usepackage\{todonotes\}\n/);
      await act('blur');
      await intact();
    },
  ],
  [
    'tabla: combinar celdas, dividirlas, ancho de columna y pegar celdas de una hoja de cálculo',
    async () => {
      const i = find(await snap(), 'Tierra');
      const cell = (): Promise<unknown> => act('caretIn', { index: i, selector: 'td', nth: 3 });
      await cell();
      await cmd('table', 'merge-r');
      assert.match(text(), /\n {4}\\multicolumn\{2\}\{\|c\|\}\{Tierra 1\} & 6371 \\\\\n/);
      await cell();
      await cmd('table', 'split');
      assert.match(text(), /\n {4}Tierra 1 &  & 6371 \\\\\n/, 'al dividir vuelven a ser dos celdas');
      await act('blur');
      await intact();
      await cell();
      await cmd('table', 'merge-d');
      assert.match(text(), /\n {4}\\multirow\{2\}\{\*\}\{Tierra Marte\} & 1 & 6371 \\\\\n {4}\\hline\n {5}& 2 & 3390 \\\\\n/);
      assert.match(text(), /\\usepackage\{multirow\}\n/);
      await act('blur');
      await intact();
      // ancho de columna: su letra pasa a ser p{...}; lo demás de la tabla no se toca
      await cell();
      await act('colWidth', { cm: 3.04 });
      assert.equal(text(), pristine.replace('{|l|c|r|}', '{|p{3cm}|c|r|}'));
      await act('blur');
      await intact();
      // celdas copiadas de una hoja de cálculo: rellenan desde la celda del cursor
      await cell();
      assert.equal(await act('pasteGrid', { text: 'Venus\t0\r\nJúpiter\t95\r\n' }), true);
      assert.match(text(), /\n {4}Venus & 0 & 6371 \\\\\n {4}\\hline\n {4}Júpiter & 95 & 3390 \\\\\n/);
      await act('blur');
      await intact();
    },
  ],
  [
    'estilos de tabla: líneas, bordes y sombreado de toda la tabla con un clic',
    async () => {
      const i = find(await snap(), 'Tierra');
      const cell = (): Promise<unknown> => act('caretIn', { index: i, selector: 'td', nth: 3 });
      const table = (): string => /\\begin\{tabular\}[\s\S]*?\\end\{tabular\}/.exec(text())?.[0] ?? '';
      const before = table();
      await cell();
      await cmd('table', 'style-book');
      assert.equal(
        table(),
        '\\begin{tabular}{lcr}\n    \\toprule\n    \\textbf{Planeta} & \\textbf{Lunas} & \\textbf{Radio (km)} \\\\\n    \\midrule\n    Tierra & 1 & 6371 \\\\\n    Marte & 2 & 3390 \\\\\n    \\bottomrule\n  \\end{tabular}',
      );
      assert.match(text(), /\\usepackage\{booktabs\}\n/);
      await cell();
      await cmd('table', 'style-striped');
      assert.match(table(), /\\midrule\n {4}Tierra & 1 & 6371 \\\\\n {4}\\rowcolor\{gray!15\}\n {4}Marte & 2 & 3390 \\\\\n {4}\\bottomrule/);
      assert.match(text(), /\\usepackage\{colortbl\}\n/);
      await cell();
      await cmd('table', 'style-header');
      assert.match(table(), /\\toprule\n {4}\\rowcolor\{gray!25\}\n {4}\\textbf\{Planeta\}/);
      assert.doesNotMatch(table(), /gray!15/, 'un estilo sustituye al anterior');
      await cell();
      await cmd('table', 'style-plain');
      assert.doesNotMatch(table(), /rule|hline|rowcolor|\|/);
      // la cuadrícula deja la tabla como estaba al principio
      await cell();
      await cmd('table', 'style-grid');
      assert.equal(table(), before);
      await act('blur');
      for (let k = 0; k < 12 && text() !== pristine; k++) await cmd('undo');
      assert.equal(text(), pristine);
    },
  ],
  [
    'estilos propios: el formato del cursor se guarda como una orden nueva y se aplica a otro texto',
    async () => {
      const i = find(await snap(), 'Un párrafo con');
      assert.equal(await act('select', { index: i, from: 15, to: 22 }), 'negrita');
      await cmd('style-new');
      await act('dialog', { values: { name: 'destacado' } });
      assert.match(text(), /\\newcommand\{\\destacado\}\[1\]\{\\textbf\{#1\}\}\n/);
      assert.deepEqual(((await preview.test('ribbon')) as Ribbon).ustyles, ['destacado']);
      const j = find(await snap(), 'Un párrafo con');
      assert.equal(await act('select', { index: j, from: 3, to: 10 }), 'párrafo');
      await cmd('style-use', 'destacado');
      assert.match(text(), /\nUn \\destacado\{párrafo\} con \\textbf\{negrita\}/);
      // el texto con ese estilo sigue siendo texto: se ve con su formato y se puede escribir en él
      await act('blur');
      const s = await snap();
      assert.equal(s.blocks[find(s, 'Un párrafo con')].kind, 'rich');
      await act('type', { index: find(s, 'Un párrafo con'), text: ' fin' });
      assert.match(text(), /\nUn \\destacado\{párrafo\} con [\s\S]*\\\$10\. fin\n/);
      await act('blur');
      for (let k = 0; k < 12 && text() !== pristine; k++) await cmd('undo');
      assert.equal(text(), pristine);
    },
  ],
  [
    'Referencias: agregar una fuente crea la bibliografía y permite citarla',
    async () => {
      const i = find(await snap(), 'Un párrafo con');
      await act('caret', { index: i });
      await cmd('add-source');
      await act('dialog', { values: { author: 'Knuth, Donald', title: 'The TeXbook', year: '1984' } });
      assert.match(text(), /\\\$10\.\\cite\{knuth1984\}\n/);
      assert.match(text(), /\n\\begin\{thebibliography\}\{99\}\n {2}\\bibitem\{knuth1984\} Knuth, Donald\. \\textit\{The TeXbook\}\. 1984\.\n\\end\{thebibliography\}\n\n\\end\{document\}/);
      const s = await snap();
      assert.match(s.blocks[find(s, 'Un párrafo con')].text, /\$10\.\[1\]/, 'la cita se resuelve a su número');
      find(s, 'Knuth, Donald. The TeXbook. 1984.');
      const r = (await preview.test('ribbon')) as Ribbon;
      assert.deepEqual(r.sources, ['knuth1984'], 'la fuente aparece en el menú Insertar cita');
      await act('blur');
      await intact();
    },
  ],
  [
    'editor de ecuaciones visual con paleta gráfica',
    async () => {
      const i = find(await snap(), 'Un párrafo con');
      await act('caret', { index: i });
      await cmd('ins-equation');
      let f = (await preview.test('formula')) as Formula;
      for (let k = 0; k < 100 && !f.visual; k++) {
        await sleep(100);
        f = (await preview.test('formula')) as Formula;
      }
      assert.equal(f.visual, true, 'el campo visual (MathLive) se carga');
      assert.ok(f.tabs >= 9 && f.items > 15 && f.rendered === f.items, JSON.stringify(f));
      f = (await preview.test('formula', { do: 'palette', arg: 0, item: 0 })) as Formula;
      assert.match(f.code, /^\\frac\{\}\{\}$/, 'el botón de fracción inserta la estructura');
      f = (await preview.test('formula', { do: 'type', arg: 'x+1' })) as Formula;
      assert.match(f.code, /^\\frac\{x\+1\}\{\}$/, 'lo escrito en el campo visual pasa al código');
      f = (await preview.test('formula', { do: 'palette', arg: 1, item: 0 })) as Formula;
      assert.match(f.code, /\\alpha/);
      assert.equal(f.recent, 2, 'lo insertado queda en «Recientes»');
      assert.equal(f.codeShown, false, 'con el campo visual, el código LaTeX queda plegado');
      // las estructuras se dibujan con sus huecos
      f = (await preview.test('formula', { do: 'palette', arg: 8, item: 0 })) as Formula;
      assert.ok(f.holes >= 8, `huecos dibujados en la paleta: ${f.holes}`);
      // buscador: por nombre en español, sin acentos, o por el código
      f = (await preview.test('formula', { do: 'search', arg: 'flecha' })) as Formula;
      assert.ok(f.items >= 8 && f.items <= 20 && f.rendered === f.items, JSON.stringify(f));
      f = (await preview.test('formula', { do: 'search', arg: 'fraccion' })) as Formula;
      assert.equal(f.items, 1);
      f = (await preview.test('formula', { do: 'search', arg: 'sqrt' })) as Formula;
      assert.equal(f.items, 2, 'raíz cuadrada y raíz enésima');
      f = (await preview.test('formula', { do: 'search', arg: '' })) as Formula;
      assert.ok(f.items >= 10, 'al borrar la búsqueda vuelve la categoría');
      // deshacer, rehacer y vaciar
      const before = f.code;
      f = (await preview.test('formula', { do: 'tool', arg: 0 })) as Formula;
      assert.notEqual(f.code, before, 'deshacer quita lo último');
      f = (await preview.test('formula', { do: 'tool', arg: 1 })) as Formula;
      assert.equal(f.code, before, 'rehacer lo devuelve');
      f = (await preview.test('formula', { do: 'tool', arg: 2 })) as Formula;
      assert.equal(f.code, '');
      // matrices: tamaño elegido en la cuadrícula y tipo de delimitador
      f = (await preview.test('formula', { do: 'palette', arg: 7, item: 0 })) as Formula;
      assert.equal(f.matrixShown, true);
      f = (await preview.test('formula', { do: 'tool', arg: 2 })) as Formula;
      f = (await preview.test('formula', { do: 'matrix', arg: '2,3,bmatrix' })) as Formula;
      assert.match(f.code, /^\\begin\{bmatrix\}[\s&\\]*\\end\{bmatrix\}$/);
      assert.equal(f.code.match(/&/g)?.length, 4, 'dos filas de tres columnas');
      f = (await preview.test('formula', { do: 'tool', arg: 3 })) as Formula;
      assert.equal(f.codeShown, true, 'el botón </> enseña el código');
      await preview.test('formula', { do: 'tool', arg: 3 });
      await act('dialog', { values: { tex: 'E = mc^2' } });
      assert.match(text(), /\$10\.\n\n\\begin\{equation\}\n {2}E = mc\^2\n\\end\{equation\}\n/);
      await intact();
    },
  ],
  [
    'formato de carácter, color y alineación',
    async () => {
      const i = find(await snap(), 'Un párrafo con');
      await preview.test('select', { index: i, from: 0, to: 2 });
      await cmd('wrap', 'sup');
      assert.match(text(), /\n\\textsuperscript\{Un\} párrafo con/);
      await cmd('wrap', 'sup');
      assert.equal(text(), pristine, 'repetir el formato lo quita');
      await preview.test('select', { index: i, from: 0, to: 2 });
      await cmd('color', 'red');
      assert.match(text(), /\n\\textcolor\{red\}\{Un\} párrafo con/);
      assert.match(text(), /\\usepackage\{xcolor\}\n/);
      await act('blur');
      await intact();
      await act('caret', { index: find(await snap(), 'Un párrafo con') });
      await cmd('align', 'center');
      assert.match(text(), /\n\\begin\{center\}\nUn párrafo con [\s\S]*\\\$10\.\n\\end\{center\}\n/);
      await cmd('align', '');
      assert.equal(text(), pristine);
      await act('blur');
      await intact();
    },
  ],
  [
    'Insertar: tabla desde la cuadrícula y dibujo TikZ de plantilla',
    async () => {
      const i = find(await snap(), 'Un párrafo con');
      await act('caret', { index: i });
      await cmd('ins-grid', '2,3');
      assert.match(text(), /\\begin\{tabular\}\{\|c\|c\|c\|\}\n {2}\\hline\n {2}\\textbf\{Columna 1\} & \\textbf\{Columna 2\} & \\textbf\{Columna 3\} \\\\/);
      await intact();
      await act('caret', { index: find(await snap(), 'Un párrafo con') });
      await cmd('ins-tikz', 'axes');
      assert.match(text(), /\\usepackage\{tikz\}\n/);
      assert.match(text(), /\\begin\{center\}\n\\begin\{tikzpicture\}/);
      const m = await media();
      assert.deepEqual(m.tikzError, []);
      assert.equal(m.tikz, 1, 'la plantilla se dibuja');
      await intact();
    },
  ],
  [
    'escribir sobre un párrafo actualiza el .tex sin perder comentarios ni formato',
    async () => {
      const before = await snap();
      const i = find(before, 'Un párrafo con');
      await act('type', { index: i, text: ' NUEVO' });
      assert.match(text(), /y \\\$10\. NUEVO\n/);
      assert.match(text(), /% este comentario no se pierde al editar/);
      assert.match(text(), /\\textbf\{negrita\}, \\textit\{cursiva\}/);
      await act('typeMore', { text: 'X' });
      assert.match(text(), /NUEVOX\n/);
      const after = await snap();
      assert.equal(after.blocks.length, before.blocks.length);
      assert.equal(after.active, i, 'el bloque sigue activo mientras se escribe');
    },
  ],
  [
    'deshacer y rehacer desde el editor visual',
    async () => {
      const edited = text();
      await cmd('undo');
      assert.match(text(), /NUEVO\n/, 'cada pausa al escribir es un paso de deshacer');
      await cmd('undo');
      assert.equal(text(), pristine);
      const s = await snap();
      assert.equal(s.active, find(s, 'Un párrafo con'), 'tras deshacer, el cursor vuelve al bloque afectado');
      await cmd('redo');
      await cmd('redo');
      assert.equal(text(), edited);
      await intact();
    },
  ],
  [
    'el historial de deshacer es el mismo que el del editor de código',
    async () => {
      const i = find(await snap(), 'Un párrafo con');
      await act('type', { index: i, text: ' VISUAL' });
      await act('blur');
      // un cambio hecho en el código, después del cambio visual
      const doc = preview.document;
      const edit = new vscode.WorkspaceEdit();
      edit.insert(doc.uri, new vscode.Position(doc.lineCount - 1, 0), '% desde el código\n');
      await vscode.workspace.applyEdit(edit);
      await preview.settle();
      assert.match(text(), /VISUAL/);
      assert.match(text(), /% desde el código/);
      await cmd('undo');
      assert.doesNotMatch(text(), /% desde el código/, 'primero se deshace lo último, hecho en el código');
      assert.match(text(), /VISUAL/);
      await cmd('undo');
      assert.equal(text(), pristine);
    },
  ],
  [
    'Enter parte el párrafo en dos y deja el cursor al inicio del segundo',
    async () => {
      const before = await snap();
      const i = find(before, 'Un párrafo con');
      await act('enter', { index: i, offset: 10 });
      assert.match(text(), /\nUn párrafo\n\ncon \\textbf\{negrita\}/);
      const after = await snap();
      assert.equal(after.blocks.length, before.blocks.length + 1);
      assert.equal(after.active, i + 1);
      assert.equal(after.caret, 0);
      await cmd('undo');
      await intact();
    },
  ],
  [
    'negrita sobre una selección',
    async () => {
      const i = find(await snap(), 'Un párrafo con');
      assert.equal(await preview.test('select', { index: i, from: 0, to: 2 }), 'Un');
      await cmd('bold');
      assert.match(text(), /\n\\textbf\{Un\} párrafo con/);
      await act('blur');
      await cmd('undo');
      await intact();
    },
  ],
  [
    'cambiar el estilo de un título',
    async () => {
      const i = find(await snap(), /^1\.Texto/);
      await act('caret', { index: i });
      await cmd('style', 'subsection');
      assert.match(text(), /\\subsection\{Texto\} \\label\{sec:texto\}/);
      await cmd('style', '');
      assert.match(text(), /\nTexto \\label\{sec:texto\}/);
      await cmd('undo');
      await cmd('undo');
      await intact();
    },
  ],
  [
    'insertar una ecuación con el diálogo de fórmulas',
    async () => {
      const i = find(await snap(), 'Un párrafo con');
      await act('caret', { index: i });
      await cmd('ins-equation');
      assert.equal((await snap()).dialog, true);
      await act('dialog', { values: { tex: 'a^2+b^2' } });
      assert.match(text(), /\$10\.\n\n\\begin\{equation\}\n {2}a\^2\+b\^2\n\\end\{equation\}\n/);
      assert.equal((await snap()).dialog, false);
      await cmd('undo');
      await intact();
    },
  ],
  [
    'insertar una fórmula en línea en la posición del cursor',
    async () => {
      const i = find(await snap(), 'Un párrafo con');
      await act('caret', { index: i, offset: 2 });
      await cmd('ins-math');
      await act('dialog', { values: { tex: 'z_1' } });
      assert.match(text(), /\nUn\$z_1\$ párrafo con/);
      const s = await snap();
      assert.equal(s.active, i);
      assert.equal(s.caret, 3, 'el cursor queda detrás de la fórmula');
      await act('blur');
      await cmd('undo');
      await intact();
    },
  ],
  [
    'insertar una tabla y editar una celda',
    async () => {
      const i = find(await snap(), 'Un párrafo con');
      await act('caret', { index: i });
      await cmd('ins-table');
      await act('dialog', { values: { rows: '2', cols: '2', caption: '' } });
      assert.match(text(), /\\begin\{center\}\n\\begin\{tabular\}\{\|c\|c\|\}\n {2}\\hline\n {2}\\textbf\{Columna 1\} & \\textbf\{Columna 2\} \\\\/);
      const s = await snap();
      const t = find(s, 'Columna 1');
      await act('caretIn', { index: t, selector: 'td strong' });
      await act('typeMore', { text: 'A' });
      assert.match(text(), /\\textbf\{Columna 1A\} & \\textbf\{Columna 2\} \\\\/);
      await act('blur');
      await cmd('undo');
      await cmd('undo');
      await intact();
    },
  ],
  [
    'convertir un párrafo en lista y añadir elementos con Enter',
    async () => {
      const i = find(await snap(), 'Una fórmula en línea como');
      await act('caret', { index: i });
      await cmd('list', 'itemize');
      assert.match(text(), /\\begin\{itemize\}\n {2}\\item Una fórmula en línea como \$e\^\{i\\pi\} \+ 1 = 0\$/);
      const j = find(await snap(), 'Una fórmula en línea como');
      await act('enter', { index: j });
      await act('typeMore', { text: 'Segundo punto' });
      assert.match(text(), /final\.\}\.\n {2}\\item Segundo punto\n\\end\{itemize\}/);
      await act('blur');
      for (let k = 0; k < 4; k++) await cmd('undo');
      await intact();
    },
  ],
  [
    'Enter al final crea un párrafo nuevo',
    async () => {
      const before = await snap();
      const i = find(before, 'Un párrafo con');
      await act('enter', { index: i });
      await act('typeMore', { text: 'Párrafo recién creado' });
      // separado de sus vecinos por una sola línea en blanco: no se acumulan huecos en el código
      assert.match(text(), /\$10\.\n\nPárrafo recién creado\n\nUna fórmula en línea/);
      const after = await snap();
      assert.equal(after.blocks.length, before.blocks.length + 1);
      assert.equal(after.active, i + 1);
      await act('blur');
      await cmd('undo');
      await intact();
    },
  ],
  [
    'Retroceso al inicio une el párrafo con el anterior',
    async () => {
      const before = await snap();
      const i = find(before, 'Una fórmula en línea como');
      await act('caret', { index: i, offset: 0 });
      assert.equal(await act('key', { key: 'Backspace' }), true);
      assert.match(text(), /\\\$10\.\nUna fórmula en línea como/);
      const after = await snap();
      assert.equal(after.blocks.length, before.blocks.length - 1);
      assert.equal(after.active, i - 1);
      assert.match(after.ahead ?? '', /^Una fórmula en línea/, 'el cursor queda en el punto de unión');
      await cmd('undo');
      await intact();
    },
  ],
  [
    'Tab anida un elemento de lista',
    async () => {
      const i = find(await snap(), 'Primer elemento');
      await act('caretIn', { index: i, selector: 'li', nth: 1, start: true });
      assert.equal(await act('key', { key: 'Tab' }), true);
      assert.match(text(), /\n {2}\\item Primer elemento\n {4}\\begin\{itemize\}\n {6}\\item Segundo elemento con \$x \\in \\R\$\n\s*\\begin\{enumerate\}/);
      assert.match(text(), /\\end\{enumerate\}\n {4}\\end\{itemize\}\n\\end\{itemize\}/);
      await act('key', { key: 'Tab', shift: true });
      assert.equal(text(), pristine, 'al deshacer la sangría la lista queda como estaba escrita');
      await act('blur');
      await intact();
    },
  ],
  [
    'añadir y quitar filas y columnas de una tabla',
    async () => {
      const i = find(await snap(), 'Tierra');
      await act('caretIn', { index: i, selector: 'td', nth: 3 });
      await cmd('table', 'row+');
      assert.match(text(), /Tierra & 1 & 6371 \\\\\n\s*\\hline\n\s*&\s*&\s*\\\\\n\s*\\hline\n\s*Marte/);
      await act('caretIn', { index: i, selector: 'td', nth: 3 });
      await cmd('table', 'col+');
      assert.match(text(), /\\begin\{tabular\}\{\|l\|c\|r\|c\|\}/);
      assert.match(text(), /Tierra & {2}& 1 & 6371 \\\\/);
      await act('caretIn', { index: i, selector: 'td', nth: 1 });
      await cmd('table', 'col-');
      assert.match(text(), /\\textbf\{Planeta\} & \\textbf\{Lunas\} & \\textbf\{Radio \(km\)\} \\\\/);
      assert.match(text(), /\\begin\{tabular\}\{\|l\|c\|r\|\}/);
      await act('blur');
      for (let k = 0; k < 3; k++) await cmd('undo');
      await intact();
    },
  ],
  [
    'insertar un enlace',
    async () => {
      const i = find(await snap(), 'Un párrafo con');
      await act('caret', { index: i, offset: 2 });
      await cmd('ins-link');
      await act('dialog', { values: { url: 'https://mars.nasa.gov', text: 'NASA' } });
      assert.match(text(), /\nUn\\href\{https:\/\/mars\.nasa\.gov\}\{NASA\} párrafo con/);
      const s = await snap();
      assert.match(s.blocks[i].text, /^UnNASA párrafo/);
      await act('blur');
      await cmd('undo');
      await intact();
    },
  ],
  [
    'editar el código de un bloque y eliminar un bloque',
    async () => {
      const before = await snap();
      const i = find(before, 'def hola()');
      await act('tool', { index: i, act: 'src' });
      await act('dialog', { values: { src: '\\begin{verbatim}\nprint("Marte")\n\\end{verbatim}' } });
      assert.match(text(), /\\begin\{verbatim\}\nprint\("Marte"\)\n\\end\{verbatim\}/);
      await act('tool', { index: find(await snap(), 'print("Marte")'), act: 'del' });
      assert.doesNotMatch(text(), /verbatim/);
      assert.match(text(), /\\end\{table\}\n\n\\end\{document\}/, 'al eliminar un bloque no quedan dos líneas en blanco seguidas');
      assert.equal((await snap()).blocks.length, before.blocks.length - 1);
      await cmd('undo');
      await cmd('undo');
      await intact();
    },
  ],
  [
    'aceptar el código de un párrafo sin cambiarlo no altera el documento',
    async () => {
      const i = find(await snap(), 'Una fórmula en línea como');
      await act('tool', { index: i, act: 'src' });
      assert.equal((await snap()).dialog, true);
      await act('dialog', { values: {} });
      await intact();
      await act('caret', { index: i });
      await act('tool', { index: i, act: 'src' });
      await act('dialog', { values: {} });
      await intact();
    },
  ],
  [
    'editar una ecuación con doble clic (editor de fórmulas)',
    async () => {
      const s = await snap();
      const i = s.blocks.findIndex((b) => b.kind === 'atom' && b.text.includes('(1)'));
      assert.ok(i >= 0);
      await act('tool', { index: i, act: 'src' });
      await act('dialog', { values: { tex: 'E = mc^2' } });
      assert.match(text(), /\\begin\{equation\}\n {2}E = mc\^2\n\\end\{equation\}/);
      await cmd('undo');
      await intact();
    },
  ],
  [
    'cambiar título y autor desde el bloque de título',
    async () => {
      await cmd('meta');
      await act('dialog', { values: { title: 'Viaje a Marte', author: 'Ada', date: '2026' } });
      assert.match(text(), /\\title\{Viaje a Marte\}\n\\author\{Ada\}\n\\date\{2026\}/);
      find(await snap(), 'Viaje a MarteAda2026');
    },
  ],
  [
    'los cambios hechos en el editor de código llegan al editor visual',
    async () => {
      const doc = preview.document as vscode.TextDocument;
      const before = await snap();
      const edit = new vscode.WorkspaceEdit();
      const line = doc.getText().split(/\r?\n/).findIndex((l) => l.startsWith('\\subsection{Listas}'));
      edit.insert(doc.uri, new vscode.Position(line, 0), 'Escrito desde el código.\n\n');
      await vscode.workspace.applyEdit(edit);
      await preview.settle();
      const after = await snap();
      assert.equal(after.blocks.length, before.blocks.length + 1);
      find(after, 'Escrito desde el código.');
    },
  ],
  [
    'al insertar se añaden los paquetes que faltan y se deshace todo junto',
    async () => {
      await open('min.tex');
      const original = text();
      const i = find(await snap(), 'Hola');
      await act('caret', { index: i });
      await cmd('ins-align');
      assert.match(text(), /\\documentclass\{article\}\n\\usepackage\{amsmath\}\n\\begin\{document\}/);
      assert.match(text(), /Hola\n\n\\begin\{align\}/);
      await cmd('undo');
      assert.equal(text(), original);
    },
  ],
  [
    'una edición desfasada se descarta sin dañar el documento',
    async () => {
      const original = text();
      // una edición que cree estar sustituyendo una línea que ya no es la que hay en el documento
      const host = preview as unknown as { lastSeq: number; onMessage(m: unknown): void };
      host.onMessage({ type: 'splice', s: 3, d: 1, lines: ['Adiós'], expect: ['Otra cosa'], seq: host.lastSeq, full: true });
      await preview.settle();
      assert.equal(text(), original);
      assert.equal(preview.rejected, 1);
      preview.rejected = 0;
      // la misma edición con la línea correcta sí se aplica
      host.onMessage({ type: 'splice', s: 3, d: 1, lines: ['Adiós'], expect: ['Hola'], seq: host.lastSeq, full: true });
      await preview.settle();
      assert.equal(text(), original.replace('Hola', 'Adiós'));
      find(await snap(), 'Adiós');
      // una inserción no sustituye nada, pero también se descarta si la línea vecina no es la esperada
      const now = text();
      host.onMessage({ type: 'splice', s: 4, d: 0, lines: ['', 'Nuevo'], expect: [], prev: 'Hola', seq: host.lastSeq, full: true });
      await preview.settle();
      assert.equal(text(), now);
      assert.equal(preview.rejected, 1);
      preview.rejected = 0;
      host.onMessage({ type: 'splice', s: 4, d: 0, lines: ['', 'Nuevo'], expect: [], prev: 'Adiós', seq: host.lastSeq, full: true });
      await preview.settle();
      assert.match(text(), /Adiós\n\nNuevo\n/);
    },
  ],
  [
    'las inserciones no acumulan líneas en blanco: bloque nuevo, párrafo detrás y borrado',
    async () => {
      const original = text();
      const i = find(await snap(), 'Adiós');
      await act('caret', { index: i });
      await cmd('ins-toc');
      assert.match(text(), /Adiós\n\n\\tableofcontents\n\nNuevo\n/);
      // párrafo nuevo con el botón «+» del bloque recién insertado
      const toc = find(await snap(), /Índice|Contents/);
      await act('tool', { index: toc, act: 'add' });
      await act('typeMore', { text: 'Entre medias' });
      assert.match(text(), /\\tableofcontents\n\nEntre medias\n\nNuevo\n/);
      await act('blur');
      // al borrar el párrafo, sus vecinos vuelven a quedar separados por una sola línea
      await act('tool', { index: find(await snap(), 'Entre medias'), act: 'del' });
      assert.match(text(), /\\tableofcontents\n\nNuevo\n/);
      assert.equal(preview.rejected, 0);
      for (let n = 0; n < 6 && text() !== original; n++) await cmd('undo');
      assert.equal(text(), original);
    },
  ],
  [
    'corrector ortográfico: subraya, sugiere, corrige y aprende palabras',
    async () => {
      await open('ejemplo.tex');
      const original = text();
      const cfg = vscode.workspace.getConfiguration('mars');
      await cfg.update('spellCheck.enabled', true, vscode.ConfigurationTarget.Global);
      await cfg.update('spellCheck.language', 'auto', vscode.ConfigurationTarget.Global);
      const spell = async (args: Record<string, unknown> = {}): Promise<Spell> => (await preview.test('spell', args)) as Spell;
      /** espera a que el corrector termine y se cumpla la condición */
      const when = async (ok: (s: Spell) => boolean, what: string, args: Record<string, unknown> = {}): Promise<Spell> => {
        let s = await spell(args);
        for (let k = 0; k < 100 && (s.pending || !ok(s)); k++) {
          await sleep(100);
          s = await spell();
        }
        assert.ok(ok(s), `${what}: ${JSON.stringify(s)}`);
        return s;
      };
      // el documento de ejemplo está en español (babel) y no tiene faltas
      let s = await when((x) => x.enabled, 'corrector activo');
      assert.deepEqual(s.langs, ['es']);
      assert.deepEqual(s.bad, [], 'el documento de ejemplo no tiene palabras sin reconocer');
      // una palabra mal escrita y otra inventada
      const invented = `zarquil${Array.from({ length: 6 }, () => String.fromCharCode(97 + Math.floor(Math.random() * 26))).join('')}`;
      const i = find(await snap(), 'Un párrafo con');
      await act('caret', { index: i });
      await act('typeMore', { text: ` Una palabrra y ${invented} más.` });
      s = await when((x) => x.bad.length === 2, 'dos palabras subrayadas');
      assert.deepEqual(s.bad, ['palabrra', invented]);
      assert.equal(s.highlights, 2, 'subrayadas con la API de resaltados, sin tocar el DOM');
      assert.equal(s.count, 2);
      // sugerencias y corrección
      s = await when((x) => x.menu !== undefined && !x.menu.loading, 'sugerencias', { menu: 'palabrra' });
      const fix = s.menu?.suggestions.indexOf('palabra') ?? -1;
      assert.ok(fix >= 0, `sugerencias: ${s.menu?.suggestions.join()}`);
      await act('spell', { fix });
      assert.match(text(), /\$10\. Una palabra y zarquil/);
      s = await when((x) => x.bad.length === 1, 'queda una');
      // añadir al diccionario personal
      await when((x) => x.menu !== undefined && !x.menu.loading, 'menú', { menu: invented });
      await act('spell', { act: 'add' });
      s = await when((x) => x.bad.length === 0, 'la palabra añadida deja de subrayarse');
      assert.ok(api.userWords().includes(invented), 'y queda guardada en el diccionario personal');
      // cambiar de idioma y desactivar
      await preview.test('cmd', { name: 'spell-lang', arg: 'en' });
      s = await when((x) => x.choice === 'en' && x.bad.length > 20, 'en inglés casi todo el texto queda subrayado');
      await preview.test('cmd', { name: 'spell-lang', arg: 'es+en' });
      await when((x) => x.choice === 'es+en' && x.bad.length === 0, 'con los dos idiomas no hay faltas');
      await preview.test('cmd', { name: 'spell-toggle' });
      s = await when((x) => !x.enabled && x.bad.length === 0 && x.highlights === 0, 'desactivado no subraya nada');
      await preview.test('cmd', { name: 'spell-toggle' });
      await preview.test('cmd', { name: 'spell-lang', arg: 'auto' });
      await when((x) => x.enabled && x.choice === 'auto', 'activo de nuevo');
      await act('blur');
      for (let n = 0; n < 6 && text() !== original; n++) await cmd('undo');
      assert.equal(text(), original);
      assert.equal(preview.rejected, 0);
    },
  ],
  [
    'selección de varios bloques: copiar, dar formato, borrar y escribir encima en una sola edición',
    async () => {
      const original = text();
      const before = await snap();
      const p1 = find(before, 'Un párrafo con');
      const p2 = find(before, 'Una fórmula en línea como');
      const xsel = async (args: Record<string, unknown> = {}): Promise<XSel> => (await preview.test('xsel', args)) as XSel;
      const pick = { from: { index: p1, offset: 3 }, to: { index: p2, offset: 11 } };
      // de la mitad de un párrafo a la mitad del siguiente
      let x = await xsel(pick);
      assert.deepEqual(x.blocks, [p1, p2]);
      assert.equal(x.marks, 2, 'pintada con la API de resaltados');
      assert.match(x.text[0], /^párrafo con negrita, cursiva/);
      assert.equal(x.text[1], 'Una fórmula');
      assert.match(x.latex, /^párrafo con \\textbf\{negrita\}, \\textit\{cursiva\}[\s\S]*\\\$10\.\n\nUna fórmula$/, 'lo que se copia es el LaTeX de lo seleccionado');
      assert.equal((await snap()).active, -1, 'sin ningún bloque en edición');
      // negrita sobre todo lo seleccionado: una edición, y la selección sigue en su sitio
      await cmd('bold');
      assert.match(text(), /\nUn \\textbf\{párrafo con \}\\textbf\{negrita\}\\textbf\{, \}\\textit\{\\textbf\{cursiva\}\}/, 'lo que ya estaba en negrita no se repite');
      assert.match(text(), /\n\\textbf\{Una fórmula\} en línea como \$e/);
      assert.match(text(), /¿qué tal\? \}% este comentario no se pierde al editar\n\\textbf\{También las comillas/, 'un comando nunca se abre en la línea de un comentario');
      x = await xsel();
      assert.deepEqual([x.on, x.blocks, x.text[1]], [true, [p1, p2], 'Una fórmula']);
      await cmd('undo');
      assert.equal(text(), original, 'un solo paso de deshacer');
      assert.equal((await xsel()).on, false, 'un cambio hecho por otro lado quita la selección');
      // borrar: los dos párrafos quedan unidos por donde se cortó y el cursor va a la unión
      await xsel(pick);
      await act('xsel', { key: 'Delete' });
      assert.match(text(), /\n\nUn en línea como \$e\^\{i\\pi\} \+ 1 = 0\$ se edita/);
      let s = await snap();
      assert.equal(s.blocks.length, before.blocks.length - 1);
      assert.deepEqual([s.active, s.caret], [p1, 3]);
      await act('typeMore', { text: 'texto ' });
      assert.match(text(), /\nUn texto en línea como/);
      await act('blur');
      await cmd('undo');
      await cmd('undo');
      assert.equal(text(), original);
      // pegar encima de la selección la sustituye
      await xsel(pick);
      await preview.test('xsel', { paste: 'PEGADO ' });
      await sleep(600);
      await preview.settle();
      assert.match(text(), /\nUn PEGADO en línea como/);
      await act('blur');
      for (let n = 0; n < 4 && text() !== original; n++) await cmd('undo');
      assert.equal(text(), original);
      // varios párrafos a la vez pasan a ser una lista: uno por elemento, y el comentario sigue en su línea
      await xsel({ from: { index: p1, offset: 5 }, to: { index: p2, offset: 2 } });
      await cmd('list', 'itemize');
      assert.match(
        text(),
        /\n\n\\begin\{itemize\}\n {2}\\item Un párrafo con \\textbf\{negrita\}[^\n]*\n {4}Los acentos funcionan: canción, niño, ¿qué tal\? % este comentario no se pierde al editar\n {4}También las comillas[^\n]*\n {2}\\item Una fórmula en línea como [^\n]*sección~\\ref\{sec:mates\}[^\n]*\n\\end\{itemize\}\n\n/,
      );
      assert.equal((await snap()).blocks.length, before.blocks.length - 1);
      await cmd('undo');
      assert.equal(text(), original);
      // bloques enteros, incluidas ecuaciones: de un título al final del teorema
      const h = find(before, /^2\.Matemáticas/);
      const t = find(before, 'Teorema 1');
      x = await xsel({ from: { index: h, offset: 0 }, to: { index: t } });
      assert.deepEqual(x.blocks, [h, h + 1, h + 2, t]);
      assert.equal(x.tinted, 2, 'las ecuaciones se marcan enteras');
      assert.match(x.latex, /^\\section\{Matemáticas\} \\label\{sec:mates\}\n\n\\begin\{equation\} \\label\{eq:gauss\}\n[\s\S]*\\end\{align\}\n\n\\begin\{teorema\}\[Pitágoras\]\n[\s\S]*\\end\{teorema\}$/);
      await act('xsel', { key: 'Backspace' });
      assert.match(text(), /\\end\{itemize\}\n\n\\section\{Tablas y código\}\n/, 'sin dejar líneas en blanco de más');
      s = await snap();
      assert.match(s.blocks[s.active]?.text ?? '', /Tablas y código/, 'el cursor queda en lo que sigue');
      await act('blur');
      await cmd('undo');
      assert.equal(text(), original);
      // todo el documento: escribir encima lo sustituye entero
      x = await xsel({ all: true });
      assert.equal(x.blocks.length, before.blocks.filter((b) => b.kind !== 'ro').length - 1, 'todo menos el preámbulo y las notas');
      assert.match(x.latex, /^\\maketitle\n\n\\begin\{abstract\}[\s\S]*\\end\{verbatim\}$/);
      await preview.test('xsel', { key: 'Z' });
      await sleep(600);
      await preview.settle();
      assert.match(text(), /\\begin\{document\}\n\nZ\n\n\\end\{document\}\n$/);
      await act('blur');
      for (let n = 0; n < 4 && text() !== original; n++) await cmd('undo');
      assert.equal(text(), original);
      assert.equal(preview.rejected, 0);
    },
  ],
  [
    'Referencias: una fuente a partir de su DOI se añade a la bibliografía y se cita en el cursor',
    async () => {
      const original = text();
      // doi.org simulado: devuelve lo mismo que el servicio real para este DOI
      const asked: string[] = [];
      preview.fetcher = (async (input: unknown) => {
        asked.push(String(input));
        return String(input).endsWith('nature14539') ? new Response(DOI_REPLY, { status: 200 }) : new Response('DOI Not Found', { status: 404 });
      }) as typeof fetch;
      const i = find(await snap(), 'Un párrafo con');
      const addDoi = async (doi: string): Promise<void> => {
        await act('caret', { index: i });
        await cmd('add-doi');
        await act('dialog', { values: { doi } });
        await sleep(400);
        await preview.settle();
      };
      await addDoi('https://doi.org/10.1038/nature14539');
      assert.deepEqual(asked, ['https://doi.org/10.1038/nature14539']);
      assert.match(
        text(),
        /\n\n\\begin\{thebibliography\}\{99\}\n {2}\\bibitem\{lecun2015\} LeCun, Yann; Bengio, Yoshua; Hinton, Geoffrey\. \\textit\{Deep learning\}\. Nature, vol\.~521, n\.º~7553, pp\.~436--444\. 2015\. doi:10\.1038\/nature14539\.\n\\end\{thebibliography\}\n\n\\end\{document\}/,
      );
      assert.match(text(), /\\\$10\.\\cite\{lecun2015\}\n/, 'la cita va donde estaba el cursor');
      assert.ok(((await preview.test('ribbon')) as Ribbon).sources.includes('lecun2015'), 'la fuente queda disponible para citarla de nuevo');
      assert.match((await snap()).blocks[i].text, /\$10\.\[1\]$/, 'y la cita se dibuja con su número');
      // el mismo DOI otra vez: se cita la fuente que ya está, sin duplicarla
      await addDoi('10.1038/nature14539');
      assert.equal(text().match(/\\bibitem\{lecun/g)?.length, 1);
      assert.equal(text().match(/\\cite\{lecun2015\}/g)?.length, 2);
      // un DOI que no existe o un texto que no es un DOI no cambian nada
      const now = text();
      await addDoi('10.9999/no-existe');
      await addDoi('esto no es un doi');
      assert.equal(text(), now);
      assert.equal(asked.length, 3, 'lo que no es un DOI ni siquiera se consulta');
      await act('blur');
      for (let n = 0; n < 6 && text() !== original; n++) await cmd('undo');
      assert.equal(text(), original);
      assert.equal(preview.rejected, 0);
    },
  ],
  [
    'Referencias: con un archivo .bib, la fuente del DOI se guarda en él',
    async () => {
      await open('biblio.tex');
      preview.fetcher = (async () => new Response(DOI_REPLY, { status: 200 })) as typeof fetch;
      assert.deepEqual(((await preview.test('ribbon')) as Ribbon).sources, ['knuth1984']);
      await act('caret', { index: find(await snap(), 'Un texto con citas') });
      await cmd('add-doi');
      await act('dialog', { values: { doi: '10.1038/nature14539' } });
      await sleep(400);
      await preview.settle();
      const bib = fs.readFileSync(path.join(dir, 'refs.bib'), 'utf8').replace(/\r\n/g, '\n');
      assert.match(bib, /^@book\{knuth1984,[\s\S]*\}\n\n@article\{lecun2015,\n {2}title = \{Deep learning\},[\s\S]*\n {2}pages = \{436–444\}\n\}\n$/, 'la entrada queda guardada en el .bib');
      assert.match(text(), /Un texto con citas\.\\cite\{lecun2015\}\n/);
      assert.doesNotMatch(text(), /thebibliography/);
      assert.deepEqual(((await preview.test('ribbon')) as Ribbon).sources, ['knuth1984', 'lecun2015']);
    },
  ],
  [
    'Referencias: citar desde Zotero (Better BibTeX) trae las referencias elegidas',
    async () => {
      // un servidor local que responde como el complemento Better BibTeX de Zotero
      let picked = '\\cite{lamport1994,knuth1984}';
      const exported: string[][] = [];
      const server = http.createServer((req, res) => {
        const url = req.url ?? '';
        if (url.startsWith('/better-bibtex/cayw')) {
          res.end(url.includes('probe=true') ? 'ready' : picked);
          return;
        }
        if (url === '/better-bibtex/json-rpc' && req.method === 'POST') {
          let body = '';
          req.on('data', (c) => (body += c));
          req.on('end', () => {
            const rpc = JSON.parse(body) as { id: number; method: string; params: [string[], string] };
            exported.push(rpc.params[0]);
            const result = rpc.params[0].map((k) => `@book{${k},\n  author = {Autor de ${k}},\n  title = {Libro ${k}},\n  year = {${k.slice(-4)}}\n}`).join('\n\n');
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result }));
          });
          return;
        }
        res.statusCode = 404;
        res.end('No endpoint found');
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const cfg = vscode.workspace.getConfiguration('mars');
      await cfg.update('zotero.url', `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, vscode.ConfigurationTarget.Global);
      preview.fetcher = undefined; // peticiones HTTP de verdad
      const zotero = async (): Promise<void> => {
        await act('caret', { index: find(await snap(), 'Un texto con citas') });
        await preview.test('cmd', { name: 'cite-zotero' });
        await sleep(700);
        await preview.settle();
      };
      try {
        await zotero();
        assert.deepEqual(exported, [['lamport1994', 'knuth1984']]);
        assert.match(text(), /\\cite\{lecun2015\}\\cite\{lamport1994,knuth1984\}\n/);
        const bib = fs.readFileSync(path.join(dir, 'refs.bib'), 'utf8').replace(/\r\n/g, '\n');
        assert.equal(bib.match(/@book\{knuth1984,/g)?.length, 1, 'lo que ya estaba en el .bib no se duplica');
        assert.match(bib, /\n\n@book\{lamport1994,\n {2}author = \{Autor de lamport1994\},\n {2}title = \{Libro lamport1994\},\n {2}year = \{1994\}\n\}\n$/);
        assert.deepEqual(((await preview.test('ribbon')) as Ribbon).sources, ['knuth1984', 'lecun2015', 'lamport1994']);
        // cerrar el selector sin elegir nada no cambia el documento
        const now = text();
        picked = '';
        await zotero();
        assert.equal(text(), now);
        // Zotero cerrado: se avisa y el documento queda como estaba
        await new Promise((r) => {
          server.close(r);
          server.closeAllConnections();
        });
        await zotero();
        assert.equal(text(), now);
        assert.equal(preview.rejected, 0);
      } finally {
        server.close();
        await cfg.update('zotero.url', undefined, vscode.ConfigurationTarget.Global);
      }
    },
  ],
  [
    'saltos de página: los párrafos se parten por líneas entre hojas y se pueden seguir editando',
    async () => {
      await open('largo.tex');
      const original = text();
      const r = await laidOut();
      assert.ok(r.pages >= 2, `${r.pages} hojas`);
      const s = await snap();
      assert.equal(s.breaks.length, r.pages - 1, 'un corte por cada cambio de hoja');
      assert.ok(s.splits.length >= 1, 'al menos un párrafo queda partido entre dos hojas');
      for (const cut of s.splits) {
        const [before, after] = cut.split('|');
        assert.ok(before.trim() && after.trim(), `hay texto a ambos lados del corte: «${cut}»`);
      }
      // escribir en un párrafo partido no deja rastro del corte en el código
      const k = s.breaks.find((b) => s.blocks[b].text.startsWith('Este es un párrafo') && s.splits.length > 0) as number;
      await act('type', { index: k, text: ' FIN' });
      assert.equal((text().match(/ FIN/g) ?? []).length, 1);
      assert.equal(text().replace(' FIN', ''), original, 'solo se añade lo escrito');
      const again = await snap();
      assert.ok(again.splits.length >= 1, 'el párrafo sigue partido mientras se edita');
      assert.equal(again.active, k);
      await act('blur');
      await cmd('undo');
      assert.equal(text(), original);
    },
  ],
  [
    'varias páginas: con el zoom alejado las hojas van en mosaico, con el mismo reparto y los párrafos partidos',
    async () => {
      const before = (await preview.test('ribbon')) as Ribbon;
      const flow = await snap();
      assert.equal(before.grid.on, false);
      await cmd('zoom', 'multi');
      await sleep(400);
      let r = (await preview.test('ribbon')) as Ribbon;
      assert.equal(r.grid.on, true, JSON.stringify(r.debug));
      assert.equal(r.pages, before.pages, 'las mismas páginas que en la vista de una hoja');
      assert.equal(r.grid.sheets, r.pages, 'una hoja dibujada por página');
      assert.ok(r.grid.perRow >= 2, `varias hojas por fila (${r.grid.perRow})`);
      const s = await snap();
      assert.deepEqual(s.splits, flow.splits, 'los párrafos se parten por las mismas líneas');
      assert.ok(r.grid.clipped >= 1 && r.grid.mirrors >= r.grid.clipped, `cada párrafo partido continúa en la hoja siguiente (${JSON.stringify(r.grid)})`);
      assert.equal(r.rulerMarks, 0, 'sin regla: no hay una única hoja a la que referirla');
      // el documento sigue siendo editable y lo copiado no deja rastro en el código
      const original = text();
      const k = find(s, /^1\.Primera sección/) + 1;
      await act('type', { index: k, text: ' MOSAICO' });
      assert.equal(text().replace(' MOSAICO', ''), original);
      await act('blur');
      await cmd('undo');
      assert.equal(text(), original);
      // al acercar vuelve a haber una hoja por fila
      await cmd('zoom', 'fit');
      await sleep(300);
      r = (await preview.test('ribbon')) as Ribbon;
      assert.deepEqual([r.grid.on, r.grid.mirrors, r.grid.clipped], [false, 0, 0]);
      assert.equal(r.rulerMarks, before.rulerMarks, 'y la regla reaparece');
      assert.equal(r.pages, before.pages);
      assert.deepEqual((await snap()).splits, flow.splits);
    },
  ],
  [
    'salto de página manual: al final del párrafo abre un párrafo en la hoja siguiente; en medio, lo parte',
    async () => {
      const original = text();
      const back = async (): Promise<void> => {
        await act('blur');
        for (let k = 0; k < 6 && text() !== original; k++) await cmd('undo');
        assert.equal(text(), original);
      };
      const pagesBefore = ((await preview.test('ribbon')) as Ribbon).pages;
      // con el cursor al final del párrafo (lo mismo que hace Ctrl+Enter)
      const first = find(await snap(), /^1\.Primera sección/);
      await act('caret', { index: first + 1 });
      await cmd('ins-newpage');
      assert.match(text(), /\\section\{Primera sección\}\n\n.+\n\n\\newpage\n/);
      let now = await snap();
      assert.equal(now.pending, true, 'queda un párrafo nuevo esperando texto');
      await act('typeMore', { text: 'Nueva hoja' });
      assert.match(text(), /\n\\newpage\n\nNueva hoja\n/);
      now = await snap();
      assert.ok(now.starts.includes(find(now, 'Nueva hoja')), `lo escrito tras el salto abre hoja (${now.starts.join()})`);
      let r = (await preview.test('ribbon')) as Ribbon;
      assert.equal(now.breaks.length, r.pages - 1);
      assert.ok(r.pages > pagesBefore, 'el salto manual añade una hoja');
      await back();
      // con el cursor en mitad del párrafo: se parte ahí
      await act('caret', { index: find(await snap(), /^1\.Primera sección/) + 1, offset: 20 });
      await cmd('ins-newpage');
      assert.match(text(), /\nEste es un párrafo l\n\n\\newpage\n\nargo de prueba para comprobar/);
      now = await snap();
      assert.match(now.ahead ?? '', /^argo de prueba/, 'el cursor sigue en el texto que pasó a la hoja siguiente');
      assert.ok(now.starts.includes(now.active), 'ese texto abre la hoja siguiente');
      r = (await preview.test('ribbon')) as Ribbon;
      assert.equal(now.breaks.length, r.pages - 1);
      await back();
    },
  ],
  [
    'citas por autor y año (natbib): se ven como en el PDF, con la lista de referencias del .bib',
    async () => {
      await open('autores.tex');
      const s = await snap();
      const para = s.blocks[find(s, 'El modelo relacional')].text.replace(/\s+/g, ' ');
      assert.match(para, /El modelo relacional \(Codd, 1970\) y su optimización, según Selinger et al\. \(1979\)\./);
      const refs = s.blocks[find(s, /^Referencias/)].text.replace(/\s+/g, ' ');
      assert.match(refs, /Codd, E\. F\. \(1970\)\. A relational model of data for large shared data banks/);
      assert.match(refs, /Selinger, P\. G\., Astrahan, M\. M\., and Chamberlin, D\. D\. \(1979\)/);
      assert.doesNotMatch(refs, /Elmasri/, 'las fuentes sin citar no aparecen');
      // las tres fuentes del .bib se pueden citar, y la cita nueva va entre paréntesis
      assert.deepEqual(((await preview.test('ribbon')) as Ribbon).sources, ['codd1970', 'selinger1979', 'elmasri2016']);
      const original = text();
      await act('caret', { index: find(s, 'El modelo relacional') });
      await cmd('cite', 'elmasri2016');
      assert.match(text(), /según \\citet\{selinger1979\}\.\\citep\{elmasri2016\}\n/);
      const now = await snap();
      assert.match(now.blocks[find(now, 'El modelo relacional')].text, /\(Elmasri and Navathe, 2016\)/);
      assert.match(now.blocks[find(now, /^Referencias/)].text, /Elmasri, R\. and Navathe, S\. B\. \(2016\)/, 'y pasa a la lista de referencias');
      await act('blur');
      await cmd('undo');
      assert.equal(text(), original);
    },
  ],
  [
    'encabezado y pie (fancyhdr), notas al pie al fondo de su hoja y figura que pasa al principio de la siguiente',
    async () => {
      await open('muebles.tex');
      const r = await laidOut();
      const s = await snap();
      assert.equal(r.pages, 3);
      // fancyhdr: lo que el documento pone a cada lado, con el título de la sección en curso y el total de páginas
      assert.deepEqual(r.furn.head, [['Mi tesis', '', '1. Primera sección'], ['Mi tesis', '', '2. Segunda sección'], ['Mi tesis', '', '2. Segunda sección']]);
      assert.deepEqual(r.furn.foot.map((f) => f[1]), ['Página 1 de 3', 'Página 2 de 3', 'Página 3 de 3']);
      assert.equal(r.furn.ruled, 3, 'con la raya bajo el encabezado');
      // cada nota va al fondo de la hoja donde está su llamada, y la lista del final ya no se ve
      const fig = find(s, 'FIGURA');
      const noted = (n: number): number => r.furn.pageOf[s.blocks.findIndex((b, k) => k > 0 && new RegExp('\\.' + n + '( |$)').test(b.text))];
      assert.deepEqual(r.furn.notes[0], [1, 2]);
      assert.equal(noted(1), 0);
      assert.ok(r.furn.notes.flat().includes(3) && r.furn.notes.flat().length === 3, JSON.stringify(r.furn.notes));
      assert.equal(r.furn.endNotes, 0);
      // la figura no cabía al pie de la primera hoja: abre la segunda, y el texto que la sigue llena el hueco
      assert.deepEqual(r.furn.floated, [fig]);
      assert.equal(r.furn.pageOf[fig], 1);
      assert.equal(r.furn.pageOf[fig + 1], 0, 'el párrafo siguiente empieza en la primera hoja');
      assert.ok(!s.starts.includes(fig), 'sin hueco delante de la figura');
      // en el mosaico el reparto es el mismo
      await cmd('zoom', 'multi');
      // (el mosaico vuelve a repartir las hojas: se espera a que termine, tarde lo que tarde el equipo)
      let g = (await preview.test('ribbon')) as Ribbon;
      for (let k = 0; k < 30 && JSON.stringify(g.furn.pageOf) !== JSON.stringify(r.furn.pageOf); k++) {
        await sleep(150);
        g = (await preview.test('ribbon')) as Ribbon;
      }
      assert.equal(g.grid.on, true);
      assert.deepEqual([g.pages, g.furn.pageOf, g.furn.notes, g.furn.foot], [r.pages, r.furn.pageOf, r.furn.notes, r.furn.foot]);
      await cmd('zoom', 'fit');
      await sleep(300);
      // en la vista continua no hay hojas: las notas vuelven a su lista al final
      await cmd('view', 'flow');
      const flow = (await preview.test('ribbon')) as Ribbon;
      assert.deepEqual([flow.furn.head.length, flow.furn.floated.length, flow.furn.endNotes], [0, 0, 1]);
      await cmd('view', 'page');
    },
  ],
  [
    'numeración de páginas: romana y arábiga (\\pagenumbering) y hojas sin número (\\thispagestyle)',
    async () => {
      await open('romanos.tex');
      const r = await laidOut();
      assert.deepEqual(r.nums, ['i', 'ii', '1', '2', '3'], 'cada \\pagenumbering vuelve a empezar la cuenta');
      assert.deepEqual(r.furn.styles, ['plain', 'plain', 'plain', 'empty', 'plain']);
      assert.deepEqual(r.furn.foot.map((f) => f[1]), ['i', 'ii', '1', '3'], 'la hoja con \\thispagestyle{empty} no lleva pie');
    },
  ],
  [
    'viudas y huérfanas: el botón de Disposición las prohíbe en el preámbulo y el reparto lo respeta',
    async () => {
      await open('largo.tex');
      const original = text();
      await laidOut();
      const cuts = (s: Snapshot): string[] => s.splits.map((c) => c.split('|')[1].slice(0, 12));
      const before = await snap();
      await cmd('widows');
      assert.match(text(), /\\widowpenalty=10000\n\\clubpenalty=10000\n\\begin\{document\}/);
      let r = (await preview.test('ribbon')) as Ribbon;
      assert.equal(r.widowsOn, true, 'el botón queda marcado');
      // cada corte deja al menos dos líneas del párrafo a cada lado
      const lines = (await preview.test('splitLines')) as [number, number][];
      assert.ok(lines.length >= 1 && lines.every(([a, b]) => a >= 2 && b >= 2), JSON.stringify(lines));
      await cmd('widows');
      assert.equal(text(), original, 'al quitarlo el preámbulo queda como estaba');
      r = (await preview.test('ribbon')) as Ribbon;
      assert.equal(r.widowsOn, false);
      assert.deepEqual(cuts(await snap()), cuts(before));
    },
  ],
  [
    'imagen: alinearla, rodearla de texto y recortarla desde su pestaña',
    async () => {
      await open('imagen.tex');
      const original = text();
      const pick = async (): Promise<{ tab: boolean; trim: string; crop: boolean }> => {
        const s = await snap();
        return (await act('pickImage', { index: find(s, 'Un píxel') })) as { tab: boolean; trim: string; crop: boolean };
      };
      assert.equal((await pick()).tab, true, 'con una imagen elegida aparece la pestaña Imagen');
      await cmd('img-align', 'r');
      assert.match(text(), /\\begin\{figure\}\[h\]\n {2}\\raggedleft\n {2}\\includegraphics\[width=0\.5\\textwidth\]\{img\/pixel\.png\}\n {2}\\caption\{Un píxel\}\n\\end\{figure\}/);
      // el texto la rodea: wrapfigure del ancho que tenía la imagen
      await pick();
      await cmd('img-wrap', 'r');
      assert.match(text(), /\\begin\{wrapfigure\}\{r\}\{0\.5\\textwidth\}\n {2}\\centering\n {2}\\includegraphics\[width=\\linewidth\]\{img\/pixel\.png\}\n {2}\\caption\{Un píxel\}\n\\end\{wrapfigure\}/);
      assert.match(text(), /\\usepackage\{wrapfig\}\n/);
      const r = (await preview.test('ribbon')) as Ribbon;
      assert.equal(r.pages, 1);
      // de vuelta al centro, con su ancho de antes
      await pick();
      await cmd('img-align', 'c');
      assert.match(text(), /\\begin\{figure\}\[h\]\n {2}\\centering\n {2}\\includegraphics\[width=0\.5\\textwidth\]\{img\/pixel\.png\}/);
      // recorte: un 20 % por la izquierda (la imagen mide 1 px, es decir, 1 bp a 72 ppp)
      await pick();
      await cmd('img-crop');
      await act('dialog', { values: { l: '20', r: '0', t: '0', b: '0' } });
      assert.match(text(), /\\includegraphics\[width=0\.5\\textwidth, trim=0\.2 0 0 0, clip\]\{img\/pixel\.png\}/);
      for (let k = 0; k < 12 && text() !== original; k++) await cmd('undo');
      assert.equal(text(), original);
    },
  ],
  [
    'imágenes: pegar sin cursor, menú del botón derecho, copiar, cambiar el archivo y traer una de otra carpeta',
    async () => {
      await open('imagen.tex');
      const original = text();
      const back = async (): Promise<void> => {
        for (let k = 0; k < 12 && text() !== original; k++) await cmd('undo');
        assert.equal(text(), original);
      };
      const fig = async (): Promise<number> => find(await snap(), 'Un píxel');
      // Ctrl+V con una imagen en el portapapeles y ningún párrafo en edición
      await act('blur');
      const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
      assert.equal(await act('pasteImage', { data: png }), true, 'el editor se encarga del pegado');
      for (let k = 0; k < 50 && !(await snap()).dialog; k++) await sleep(100);
      await act('dialog', { values: { caption: 'Captura pegada' } });
      const pasted = /\\includegraphics\[width=0\.6\\textwidth\]\{(img\/imagen-\d+\.png)\}\n {2}\\caption\{Captura pegada\}/.exec(text());
      assert.ok(pasted, 'la imagen pegada queda como figura');
      assert.ok(fs.existsSync(path.join(dir, pasted[1])), 'y su archivo, guardado junto al documento');
      await back();
      // botón derecho: sobre una imagen, sus órdenes; sobre el texto, las del portapapeles
      const onImage = (await act('context', { index: await fig(), image: true })) as string[];
      assert.deepEqual(onImage.slice(0, 3), ['Copiar imagen', 'Cortar imagen', 'Pegar']);
      assert.ok(['Recortar…', 'Cambiar imagen…', 'Con el texto alrededor', 'Eliminar'].every((l) => onImage.includes(l)), onImage.join());
      const onText = (await act('context', { index: (await fig()) - 1 })) as string[];
      assert.deepEqual(onText.slice(0, 3), ['Cortar', 'Copiar', 'Pegar']);
      // una orden del menú: alinear a la derecha
      await act('context', { index: await fig(), image: true, pick: 'A la derecha' });
      await preview.settle();
      assert.match(text(), /\\begin\{figure\}\[h\]\n {2}\\raggedleft\n/);
      await back();
      // copiar: la imagen va al portapapeles (o, si el sistema no deja, al menos su código LaTeX)
      const copy = (await act('copyImage', { index: await fig() })) as { ok: boolean; how: string };
      assert.ok(copy.how === 'image' || copy.how === 'text', JSON.stringify(copy));
      assert.equal(text(), original, 'copiar no cambia el documento');
      // cortar la quita del documento
      await act('copyImage', { index: await fig(), cut: true });
      await preview.settle();
      assert.doesNotMatch(text(), /includegraphics/);
      await back();
      // cambiar el archivo conserva el tamaño y el pie; uno de otra carpeta se copia a img/
      const outside = path.join(path.dirname(dir), `mars-fuera-${Date.now()}.png`);
      fs.writeFileSync(outside, Buffer.from(png, 'base64'));
      preview.pickImageOverride = outside;
      await act('pickImage', { index: await fig() });
      await cmd('img-change');
      for (let k = 0; k < 50 && text() === original; k++) await sleep(100);
      const name = path.basename(outside);
      assert.ok(text().includes(`\\includegraphics[width=0.5\\textwidth]{img/${name}}\n  \\caption{Un píxel}`), text());
      assert.ok(fs.existsSync(path.join(dir, 'img', name)), 'la copia está junto al documento');
      preview.pickImageOverride = path.join(dir, 'img', 'pixel.png');
      fs.rmSync(outside);
      await back();
    },
  ],
  [
    'portada: ocupa su hoja, \\vfill reparte lo que queda libre y la numeración empieza después de ella',
    async () => {
      await open('portada.tex');
      const r = await laidOut();
      assert.equal(r.pages, 3, 'portada, índice y texto');
      assert.deepEqual(r.nums, ['', '1', '2'], 'la portada no lleva número y la hoja siguiente es la 1');
      assert.ok(r.vfill.length === 1 && r.vfill[0] > 500, `el espacio elástico empuja el pie de la portada hacia abajo (${r.vfill.join()} px)`);
      const s = await snap();
      assert.deepEqual(s.starts, [find(s, /^Índice/), find(s, /^1\.Introducción/)], 'el índice y la sección abren hoja');
      assert.deepEqual(s.splits, [], 'la portada no se reparte entre dos hojas');
    },
  ],
  [
    'un título nunca se queda solo al pie de una hoja',
    async () => {
      await open('pie.tex');
      await laidOut();
      const doc = preview.document;
      const line = doc.getText().split(/\r?\n/).findIndex((l) => l.startsWith('\\vspace'));
      let moved = 0;
      let stayed = 0;
      // se empuja el título cada vez más abajo: 2 mm por paso, hasta que ya no cabe en la hoja
      for (let cm = 21.2; cm < 24.3; cm += 0.2) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(doc.uri, doc.lineAt(line).range, `\\vspace{${cm.toFixed(1)}cm}`);
        await vscode.workspace.applyEdit(edit);
        await preview.settle();
        const s = await snap();
        const title = find(s, /^1Título al pie/);
        assert.ok(!s.starts.includes(title + 1), `con ${cm.toFixed(1)} cm el título se queda solo y su texto empieza en la hoja siguiente`);
        if (s.starts.includes(title)) moved++;
        else {
          stayed++;
          // si el título se queda, le acompaña al menos una línea de su párrafo en la misma hoja
          const cut = s.splits[0]?.split('|')[0] ?? 'todo el párrafo cabe';
          assert.ok(cut.trim().length > 0);
        }
      }
      assert.ok(moved >= 3 && stayed >= 3, `el título se queda ${stayed} veces y pasa a la hoja siguiente ${moved}`);
    },
  ],
  [
    'dibuja figuras TikZ e imágenes PDF sin LaTeX instalado',
    async () => {
      await open('figuras.tex');
      const s = await snap();
      assert.equal(s.blocks.filter((b) => b.kind !== 'ro').length, 4, JSON.stringify(s.blocks.map((b) => b.text.slice(0, 30))));
      let m = await media();
      assert.deepEqual(m.tikzError, []);
      assert.equal(m.tikz, 2, 'un tikzpicture y una gráfica pgfplots');
      for (let k = 0; k < 150 && !/^(ok|error)/.test(m.pdf[0] ?? ''); k++) {
        await sleep(100);
        m = await media();
      }
      assert.equal(m.pdf.length, 1);
      assert.match(m.pdf[0], /^ok:400x200:/, 'la primera página del PDF se dibuja a 2x');
    },
  ],
  [
    'al escribir solo se reparten las hojas afectadas, con el mismo resultado que un reparto completo',
    async () => {
      interface Perf { full: number; pagesDone: number; pages: number; sig: string }
      const more = ' Texto añadido para que el párrafo ocupe varias líneas más y empuje a lo que viene detrás hasta la hoja siguiente.'.repeat(3);
      for (const file of ['muebles.tex', 'largo.tex']) {
        await open(file);
        await laidOut();
        const s = await snap();
        const rich = s.blocks.map((b, k) => (b.kind === 'rich' && b.text.length > 200 ? k : -1)).filter((k) => k >= 0);
        // un párrafo del principio, que mueve todo lo demás, y el último, que solo toca la hoja final
        for (const i of [rich[0], rich[rich.length - 1]]) {
          await act('type', { index: i, text: more });
          await act('blur');
          await preview.settle();
          const part = (await preview.test('perf', {})) as Perf;
          const whole = (await preview.test('perf', { all: true })) as Perf;
          assert.equal(whole.full, 1);
          assert.equal(part.pages, whole.pages, `${file}: número de hojas`);
          assert.equal(part.sig, whole.sig, `${file}: el reparto parcial tras escribir en el bloque ${i} no coincide con el completo`);
        }
        // y al deshacer, lo mismo
        await cmd('undo');
        await preview.settle();
        const part = (await preview.test('perf', {})) as Perf;
        const whole = (await preview.test('perf', { all: true })) as Perf;
        assert.equal(part.sig, whole.sig, `${file}: tras deshacer`);
      }
    },
  ],
  [
    'Nuevo documento: la tesis se crea con un archivo por capítulo y cada capítulo se edita con el contexto del principal',
    async () => {
      const main = vscode.Uri.file(path.join(dir, 'mitesis', 'tesis.tex'));
      const opened = (await vscode.commands.executeCommand('mars.newDocument', main, 'thesis')) as vscode.Uri | undefined;
      assert.equal(opened?.fsPath, main.fsPath);
      for (const f of ['capitulos/introduccion.tex', 'capitulos/conclusiones.tex', 'referencias.bib']) assert.ok(fs.existsSync(path.join(dir, 'mitesis', f)), f);
      for (let k = 0; k < 100 && !api.previewFor(main); k++) await sleep(100);
      let p = api.previewFor(main);
      assert.ok(p, 'el documento nuevo se abre en el editor visual');
      preview = p;
      await preview.settle();
      let s = await snap();
      find(s, 'Título de la tesis');
      find(s, /Capítulo 3[\s\S]*Metodología/);
      let ui = (await preview.test('ui')) as Ui;
      assert.equal(ui.part, '');
      assert.equal(ui.included.length, 5, 'cada capítulo lleva su etiqueta para abrirlo');
      assert.equal(ui.included[1], 'capitulos/marco-teorico');
      // como en LaTeX, en un informe van en hoja propia el título, el resumen, el índice, cada capítulo y la bibliografía
      await laidOut();
      const sheets = (await preview.test('perf', {})) as { nums: string };
      assert.equal(sheets.nums, ',,1,2,3,4,5,6,7', 'título y resumen sin número; el índice es la página 1');

      // el panel de navegación cuenta las palabras de cada apartado
      if (!((await preview.test('ui')) as Ui).navOpen) await cmd('nav');
      assert.ok(((await preview.test('ui')) as Ui & { navWords: number[] }).navWords.some((n) => n > 5), 'palabras por apartado');
      // el segundo capítulo: doble clic en uno de sus párrafos, dentro del principal, lo abre para editarlo
      const chapter = vscode.Uri.file(path.join(dir, 'mitesis', 'capitulos', 'marco-teorico.tex'));
      const perFile = ((await preview.test('ui')) as Ui & { incBlocks: number[] }).incBlocks;
      assert.ok(perFile[0] >= 3 && perFile[1] >= 3, `bloques de cada capítulo: ${perFile.join(',')}`);
      // (el segundo párrafo del segundo capítulo: detrás de los bloques del primero y de su título)
      await preview.test('ui', { incDbl: perFile[0] + 1 });
      for (let k = 0; k < 100 && !api.previewFor(chapter); k++) await sleep(100);
      p = api.previewFor(chapter);
      assert.ok(p, 'el capítulo se abre en el editor visual');
      preview = p;
      await preview.settle();
      s = await snap();
      assert.match(s.blocks[0].text, /Capítulo 2[\s\S]*Marco teórico/, 'numerado como en el documento completo');
      find(s, /las fuentes \[1\]/);
      find(s, /2\.1\.? ?Antecedentes/);
      ui = (await preview.test('ui')) as Ui;
      assert.equal(ui.part, 'tesis.tex');
      const r = await laidOut();
      assert.equal(r.fonts, 'loaded');
      // se edita como cualquier documento, y lo que necesita un paquete lo añade al principal
      const i = find(s, 'Trabajos anteriores');
      await act('type', { index: i, text: ' Y más.' });
      assert.match(text(), /Trabajos anteriores relacionados con este\. Y más\.\n/);
      await preview.test('select', { index: i, from: 0, to: 8 });
      await cmd('color', 'red');
      assert.match(text(), /\\textcolor\{red\}\{Trabajos\} anteriores/);
      assert.doesNotMatch(text(), /usepackage|documentclass/, 'el capítulo sigue sin preámbulo');
      for (let k = 0; k < 50 && !/\{xcolor\}/.test(fs.readFileSync(main.fsPath, 'utf8')); k++) await sleep(100);
      assert.match(fs.readFileSync(main.fsPath, 'utf8'), /\\usepackage\{xcolor\}\n/, 'el paquete va al preámbulo del documento principal');
      await act('blur');
    },
  ],
  [
    'historial de git: barras de cambio al margen, detalle, restaurar y ver una versión antigua',
    async () => {
      interface Git { open: boolean; repo: boolean; ref: string; commits: string[]; changes: string[]; marks: string[]; list: string[]; pop: string }
      const git = async (args: Record<string, unknown> = {}): Promise<Git> => ((await preview.test('ui', args)) as Ui & { git: Git }).git;
      const until = async (ok: (g: Git) => boolean, what: string): Promise<Git> => {
        let g = await git();
        for (let k = 0; k < 80 && !ok(g); k++) {
          await sleep(100);
          g = await git();
        }
        assert.ok(ok(g), `${what}: ${JSON.stringify(g)}`);
        return g;
      };
      // un repositorio con dos commits y cambios sin confirmar
      const repo = path.join(dir, 'repo');
      fs.mkdirSync(repo);
      const run = (...a: string[]): string => execFileSync('git', ['-c', 'user.name=Mars', '-c', 'user.email=mars@example.com', '-c', 'commit.gpgsign=false', ...a], { cwd: repo, encoding: 'utf8' });
      const file = path.join(repo, 'doc.tex');
      const body = (p: string[]): string => `\\documentclass{article}\n\\begin{document}\n\n${p.join('\n\n')}\n\n\\end{document}\n`;
      run('init', '-q');
      run('config', 'user.name', 'Mars');
      run('config', 'user.email', 'mars@example.com');
      run('config', 'commit.gpgsign', 'false');
      fs.writeFileSync(file, body(['Primer párrafo original.', 'Segundo párrafo.', 'Tercer párrafo.']));
      run('add', '.');
      run('commit', '-q', '-m', 'Primera versión');
      const first = run('rev-parse', 'HEAD').trim();
      fs.writeFileSync(file, body(['Primer párrafo original.', 'Segundo párrafo, revisado.', 'Tercer párrafo.']));
      run('commit', '-q', '-am', 'Revisa el segundo');
      fs.writeFileSync(file, body(['Primer párrafo cambiado.', 'Segundo párrafo, revisado.', 'Cuarto párrafo, nuevo.']));

      await open('repo/doc.tex');
      assert.equal((await git()).open, false);
      await cmd('git');
      let g = await until((x) => x.commits.length === 2 && x.changes.length > 0, 'el panel lista los commits y los cambios');
      assert.deepEqual(g.commits, ['Revisa el segundo', 'Primera versión']);
      assert.equal(g.ref, 'HEAD', 'por defecto se compara con el último commit');
      const s = await snap();
      const i1 = find(s, 'Primer párrafo cambiado.');
      const i4 = find(s, 'Cuarto párrafo, nuevo.');
      assert.deepEqual(g.marks, [`${i1}:mod`, `${i4}:mod`], 'el segundo párrafo no ha cambiado desde el último commit');
      assert.match(g.list[0], /Modificado ?Primer párrafo cambiado\./);
      // el detalle enseña lo quitado y lo añadido
      g = await git({ gitShow: 0 });
      assert.match(g.pop, /Primer párrafo original\. ?cambiado\./);
      // respecto al primer commit también cuenta lo que se revisó en el segundo
      await git({ gitPick: 1 });
      await until((x) => x.ref === first && x.marks.length === 3, 'compara con el commit elegido');
      await git({ gitPick: 0 });
      await until((x) => x.ref === 'HEAD' && x.marks.length === 2, 'vuelve a comparar con el último');
      // restaurar deja el párrafo como estaba, y es una edición normal (se puede deshacer)
      await git({ gitRestore: 0 });
      await until((x) => x.marks.length === 1, 'tras restaurar queda un solo cambio');
      assert.match(text(), /\n\nPrimer párrafo original\.\n\nSegundo párrafo, revisado\.\n\nCuarto párrafo, nuevo\.\n/);
      await cmd('undo');
      assert.match(text(), /Primer párrafo cambiado\./);
      await until((x) => x.marks.length === 2, 'al deshacer vuelve la marca');

      // el documento tal como estaba en el primer commit: de solo lectura y con lo que cambió en él
      const current = preview;
      await git({ gitOpen: 1 });
      const old = vscode.Uri.file(file).with({ scheme: 'mars-git', query: first });
      for (let k = 0; k < 100 && !api.previewFor(old); k++) await sleep(100);
      const p = api.previewFor(old);
      assert.ok(p, 'la versión antigua se abre en el editor visual');
      preview = p;
      await preview.settle();
      const then = await snap();
      find(then, 'Primer párrafo original.');
      find(then, 'Tercer párrafo.');
      assert.ok(!then.blocks.some((b) => b.text.includes('revisado')), 'es el texto de entonces');
      assert.equal(((await preview.test('ui')) as Ui & { readonly: boolean }).readonly, true);
      await act('type', { index: find(then, 'Segundo párrafo.'), text: ' NO' });
      assert.doesNotMatch(preview.document.getText(), /NO/, 'una versión antigua no se edita');
      await until((x) => x.open && x.changes.length > 0, 'la versión antigua enseña lo que cambió en ella');
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
      preview = current;
      // commit desde el panel: lo pendiente queda guardado en git y deja de estar marcado
      assert.equal(((await git()) as Git & { commitBox: boolean }).commitBox, true);
      await git({ gitCommit: 'Cambios hechos desde Mars' });
      g = await until((x) => x.commits.length === 3 && x.changes.length === 0, 'tras el commit no queda nada pendiente');
      assert.equal(g.commits[0], 'Cambios hechos desde Mars');
      assert.equal(run('status', '--porcelain', '--', 'doc.tex').trim(), '');
      assert.match(run('show', 'HEAD:doc.tex'), /Cuarto párrafo, nuevo\./);
      await cmd('git');
      assert.deepEqual((await git()).marks, [], 'al cerrar el panel desaparecen las marcas');
    },
  ],
  [
    'exportar a PDF, avisos del documento y gráfica desde datos',
    async () => {
      const file = path.join(dir, 'avisos.tex');
      fs.writeFileSync(file, '\\documentclass{article}\n\\begin{document}\n\n\\section{Uno}\\label{sec:uno}\n\nVer \\ref{sec:uno} y \\ref{sec:nada}.\n\n\\includegraphics{img/no-existe}\n\n\\end{document}\n');
      await open('avisos.tex');
      interface Extra { issues: string[]; issueList: string[] }
      let ui = (await preview.test('ui')) as Ui & Extra;
      assert.deepEqual(ui.issues.sort(), ['image:img/no-existe', 'ref:sec:nada']);
      ui = (await preview.test('ui', { issues: true })) as Ui & Extra;
      assert.equal(ui.issueList.length, 2);
      assert.match(ui.issueList.join('|'), /Referencia sin definir ?sec:nada/);
      await preview.test('ui', { issues: true });

      // la gráfica que escribe el diálogo
      const plot = (await preview.test('ui', { plot: { kind: 'bar', title: 'Ventas', x: 'Mes', y: '', data: '1 20\n2; 35\n3\t12,5', caption: 'Ventas por mes' } })) as string;
      assert.equal(plot, '\\begin{figure}[htbp]\n\\centering\n\\begin{tikzpicture}\n\\begin{axis}[\n  title={Ventas},\n  width=0.8\\textwidth,\n  height=6cm,\n  grid=major,\n  xlabel={Mes},\n  ybar,\n  bar width=0.5cm\n]\n  \\addplot[fill=blue!60] coordinates {\n    (1,20) (2,35) (3,12.5)\n  };\n\\end{axis}\n\\end{tikzpicture}\n\\caption{Ventas por mes}\n\\end{figure}');

      // exportar: con un «compilador» de mentira que escribe el PDF, y con uno que falla
      const fake = path.join(dir, 'compila.js');
      fs.writeFileSync(fake, "const f = process.argv[2]; require('fs').writeFileSync(f.replace(/\\.tex$/, '.pdf'), '%PDF-1.4 de prueba');\n");
      const cfg = vscode.workspace.getConfiguration('mars');
      await cfg.update('pdf.command', `node "${fake}" %DOC%`, vscode.ConfigurationTarget.Global);
      try {
        // del documento al PDF y vuelta, con el SyncTeX que deja el compilador (aquí, uno escrito a mano)
        const unit = (pt: number): number => Math.round(pt * 65781.76);
        const line = (n: number, y: number): string => `(1,${n}:${unit(72)},${unit(y)}:${unit(400)},${unit(8)},${unit(2)}\nx1,${n}:${unit(72)},${unit(y)}\n)`;
        fs.writeFileSync(
          fake,
          "const fs = require('fs'); const f = process.argv[2]; const base = f.replace(/\\.tex$/, '');\n" +
            `fs.copyFileSync(${JSON.stringify(path.join(dir, 'img', 'grafico.pdf'))}, base + '.pdf');\n` +
            `fs.writeFileSync(base + '.synctex', ${JSON.stringify(`SyncTeX Version:1\nInput:1:./avisos.tex\nOutput:pdf\nMagnification:1000\nUnit:1\nX Offset:0\nY Offset:0\nContent:\n{1\n${line(4, 30)}\n${line(6, 60)}\n}1\n`)});\n`,
        );
        assert.equal(preview.pdfForward(5, false), undefined, 'sin PDF todavía no hay adónde ir');
        const ok = await preview.exportPdf(false);
        assert.equal(ok.ok, true, JSON.stringify(ok));
        // el párrafo de la línea 6 del código (la 5 contando desde 0) cae en la segunda línea del PDF
        const point = preview.pdfForward(5, false);
        assert.deepEqual([point?.page, Math.round(point?.y ?? 0)], [1, 52]);
        assert.deepEqual([preview.pdfForward(3, false)?.page, Math.round(preview.pdfForward(3, false)?.y ?? 0)], [1, 22], 'el título, en la primera');
        const back = preview.pdfInverse(1, 100, 58, false);
        assert.equal(back?.line, 6);
        assert.equal(back?.file.toLowerCase(), file.toLowerCase());
        // el visor: abre el PDF al lado, dibuja su página y recibe el punto al que ir
        const view = preview.showPdf();
        assert.ok(view, 'el visor de PDF se abre');
        for (let k = 0; k < 150 && view.pages === 0; k++) await sleep(100);
        assert.equal(view.pages, 1, 'el visor dibuja la página del PDF');
        preview.pdfForward(5);
        assert.equal(Math.round(view.lastGoto?.y ?? 0), 52);
        // doble clic en el PDF: el editor va al bloque de esa línea
        preview.pdfInverse(1, 100, 28);
        await preview.settle();
        assert.match(((await preview.test('ui')) as Ui & { selectedText: string }).selectedText, /Uno/, 'se selecciona el título al que apunta el PDF');
        await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
        assert.equal(ok.pdf?.toLowerCase(), path.join(dir, 'avisos.pdf').toLowerCase());
        assert.ok(fs.existsSync(path.join(dir, 'avisos.pdf')));
        await cfg.update('pdf.command', 'node -e "console.error(\'! Undefined control sequence.\'); process.exit(1)"', vscode.ConfigurationTarget.Global);
        const bad = await preview.exportPdf(false);
        assert.equal(bad.ok, false);
        assert.match(bad.error ?? '', /Undefined control sequence/);
      } finally {
        await cfg.update('pdf.command', undefined, vscode.ConfigurationTarget.Global);
      }
    },
  ],
  [
    'un documento grande se dibuja por tandas y queda igual que dibujado de una vez',
    async () => {
      interface Perf { full: number; pages: number; sig: string }
      const sentence = 'Los sistemas gestores de bases de datos relacionales son la infraestructura de la mayoría de los sistemas de información. ';
      const parts: string[] = ['\\documentclass[a4paper]{article}', '\\usepackage[spanish]{babel}', '\\begin{document}', ''];
      for (let s = 1; s <= 30; s++) {
        parts.push(`\\section{Sección ${s}}`, '');
        for (let p = 0; p < 8; p++) parts.push(sentence.repeat(2 + (p % 3)).trim() + (p === 3 ? `\\footnote{Nota de la sección ${s}.}` : ''), '');
      }
      parts.push('\\end{document}', '');
      fs.writeFileSync(path.join(dir, 'tandas.tex'), parts.join('\n'));
      await open('tandas.tex');
      await laidOut();
      const s = await snap();
      // 30 títulos, 240 párrafos, el preámbulo y el bloque de las notas al pie
      assert.equal(s.blocks.length, 30 + 240 + 2);
      find(s, 'Sección 30');
      assert.match(s.blocks[s.blocks.length - 1].text, /Nota de la sección 30\./);
      const tandas = (await preview.test('perf', {})) as Perf;
      const entero = (await preview.test('perf', { all: true })) as Perf;
      assert.ok(entero.pages > 20, `hojas: ${entero.pages}`);
      assert.equal(tandas.pages, entero.pages);
      assert.equal(tandas.sig, entero.sig, 'el reparto hecho por tandas coincide con el completo');
      // y se edita con normalidad
      const i = find(s, 'Sección 30') + 1;
      await act('type', { index: i, text: ' Fin.' });
      assert.match(text(), /información\. Fin\.\n/);
      await cmd('undo');
      // boceto de la gráfica en su diálogo
      const svg = (await preview.test('ui', { plotPreview: { kind: 'bar', title: 'T', x: 'x', y: '', data: '1 2\n2 5', caption: '' } })) as string;
      assert.match(svg, /^<svg class="plot-prev"/);
      assert.equal((svg.match(/<rect /g) ?? []).length, 3, 'el marco y dos barras');
    },
  ],
  [
    'Inicio: cambiar mayúsculas y minúsculas del texto seleccionado',
    async () => {
      fs.writeFileSync(path.join(dir, 'caja.tex'), '\\documentclass{article}\n\\begin{document}\n\nel sistema \\textbf{relacional} y su consulta. otra oración, con $x^2$ dentro.\n\n\\end{document}\n');
      await open('caja.tex');
      const i = find(await snap(), 'el sistema');
      const whole = { index: i, from: 0, to: 200 };
      await preview.test('select', whole);
      await cmd('case', 'upper');
      assert.match(text(), /\nEL SISTEMA \\textbf\{RELACIONAL\} Y SU CONSULTA\. OTRA ORACIÓN, CON \$x\^2\$ DENTRO\.\n/, 'el formato y las fórmulas no se tocan');
      await preview.test('select', whole);
      await cmd('case', 'sentence');
      assert.match(text(), /\nEl sistema \\textbf\{relacional\} y su consulta\. Otra oración, con \$x\^2\$ dentro\.\n/);
      await preview.test('select', whole);
      await cmd('case', 'title');
      assert.match(text(), /\nEl Sistema \\textbf\{Relacional\} Y Su Consulta\. Otra Oración, Con \$x\^2\$ Dentro\.\n/);
      await preview.test('select', whole);
      await cmd('case', 'lower');
      assert.match(text(), /\nel sistema \\textbf\{relacional\} y su consulta\. otra oración, con \$x\^2\$ dentro\.\n/);
      // solo lo seleccionado
      await preview.test('select', { index: i, from: 3, to: 10 });
      await cmd('case', 'toggle');
      assert.match(text(), /\nel SISTEMA \\textbf\{relacional\}/);
      const sample = async (mode: string): Promise<string> => (await preview.test('ui', { recase: '¿qué ES esto? no sé. ya-veremos', mode })) as string;
      assert.equal(await sample('sentence'), '¿Qué es esto? No sé. Ya-veremos');
      assert.equal(await sample('title'), '¿Qué Es Esto? No Sé. Ya-Veremos');
      assert.equal(await sample('toggle'), '¿QUÉ es ESTO? NO SÉ. YA-VEREMOS');
      await act('blur');
    },
  ],
  [
    'la cinta se minimiza y la paleta ofrece los colores del tema, los estándar, los recientes y cualquier otro',
    async () => {
      fs.writeFileSync(path.join(dir, 'cinta.tex'), '\\documentclass{article}\n\\begin{document}\n\nUn texto para dar color aquí.\n\n\\end{document}\n');
      await open('cinta.tex');
      interface Bar { tab: string; min: boolean; peek: boolean; panelShown: boolean; barHeight: number; swatches: number; recent: string[] }
      const bar = async (click?: string): Promise<Bar> => (await preview.test('ribbon', click ? { click } : {})) as Bar;
      const full = await bar();
      assert.deepEqual([full.min, full.panelShown], [false, true]);
      assert.ok(full.swatches >= 70, `la paleta tiene ${full.swatches} colores`);
      // minimizar: quedan solo las pestañas y el documento gana ese alto
      await cmd('ribbon-min');
      let b = await bar();
      assert.deepEqual([b.min, b.peek, b.panelShown], [true, false, false]);
      assert.ok(b.barHeight < full.barHeight - 60, `la barra pasa de ${full.barHeight} a ${b.barHeight} px`);
      // una pestaña despliega sus botones un momento, sin empujar el documento; usar uno los recoge
      b = await bar('.tab[data-tab="insert"]');
      assert.deepEqual([b.tab, b.peek, b.panelShown], ['insert', true, true]);
      assert.ok(b.barHeight < full.barHeight - 60, 'desplegada flota sobre el documento');
      b = await bar('.tab[data-tab="home"]');
      assert.deepEqual([b.tab, b.peek], ['home', true]);
      const i = find(await snap(), 'Un texto para');
      await preview.test('select', { index: i, from: 3, to: 8 });
      await preview.test('ribbon', { click: '#dd-color button[data-arg="4472C4"]' });
      await preview.settle();
      assert.match(text(), /\nUn \\textcolor\[HTML\]\{4472C4\}\{texto\} para dar color aquí\.\n/);
      assert.match(text(), /\\usepackage\{xcolor\}\n/);
      b = await bar();
      assert.deepEqual([b.min, b.peek, b.recent], [true, false, ['4472C4']], 'el color queda entre los recientes');
      // «Más colores»: cualquier código; los que xcolor conoce por su nombre se escriben con él
      await preview.test('select', { index: i, from: 0, to: 2 });
      await cmd('color-more');
      await act('dialog', { values: { hex: '1f4e79' } });
      assert.match(text(), /\n\\textcolor\[HTML\]\{1F4E79\}\{Un\} \\textcolor/);
      await preview.test('select', { index: i, from: 20, to: 24 });
      await cmd('color', 'FF0000');
      assert.match(text(), /\\textcolor\{red\}\{/);
      await act('blur');
      assert.match(html('\\textcolor[HTML]{1F4E79}{Un} texto'), /color:\s*rgb\(31,\s*78,\s*121\)/, 'el color se ve en el documento');
      // y vuelve a su sitio
      await cmd('ribbon-min');
      b = await bar();
      assert.deepEqual([b.min, b.panelShown, b.barHeight], [false, true, full.barHeight]);
    },
  ],
  [
    'variables del documento: se ve su nombre y su texto, y el texto se cambia desde donde se usan',
    async () => {
      const src = (titulo: string, cuerpo: string): string =>
        `\\documentclass{article}\n\\newcommand{\\titulo}{${titulo}}\n\\newcommand{\\anio}{2026}\n\\begin{document}\n\n${cuerpo}\n\nOtra vez \\titulo{} al final.\n\n\\end{document}\n`;
      fs.writeFileSync(path.join(dir, 'variables.tex'), src('Mi tesis', 'El trabajo \\titulo{} es de \\anio.'));
      await open('variables.tex');
      const i = find(await snap(), 'El trabajo Mi tesis es de 2026.');
      // el cuadro enseña las dos cosas: el nombre que hay escrito y el texto que vale
      const seen = (await preview.test('editVar', { index: i })) as { name: string; shown: string; fields: string[] };
      assert.match(seen.name, /^\\titulo/);
      assert.equal(seen.shown, 'Mi tesis');
      assert.equal(seen.fields[0], 'body=Mi tesis');
      assert.match(seen.fields[1], /^tex=\\titulo/);
      // cambiar el texto cambia la definición, y con ella todos los sitios donde se usa
      await act('dialog', { values: { body: 'Sistema de evaluación' } });
      await act('blur');
      assert.equal(text(), src('Sistema de evaluación', 'El trabajo \\titulo{} es de \\anio.'));
      const s = await snap();
      find(s, 'El trabajo Sistema de evaluación es de 2026.');
      find(s, 'Otra vez Sistema de evaluación al final.');
      // «solo aquí»: la variable se sustituye por texto normal en ese punto
      await preview.test('editVar', { index: find(s, 'El trabajo Sistema'), n: 1 });
      await act('dialog', { values: { body: '2027', only: '1' } });
      await act('blur');
      assert.equal(text(), src('Sistema de evaluación', 'El trabajo \\titulo{} es de 2027.'));
    },
  ],
  [
    'panel de referencias: lista las fuentes con sus citas y permite buscar, citar, editar y quitar',
    async () => {
      interface Refs { mode: string; sum: string; items: string[]; asking: boolean }
      const refs = async (args: Record<string, unknown> = {}): Promise<Refs> => (await act('refs', args)) as Refs;
      const eventually = async (ok: () => boolean, what: string): Promise<void> => {
        for (let k = 0; k < 40 && !ok(); k++) await sleep(100);
        assert.ok(ok(), what);
        await preview.settle();
      };
      const bibFile = path.join(dir, 'gestion.bib');
      const knuth = '@book{knuth1984,\n  author = {Knuth, Donald},\n  title = {The TeXbook},\n  year = {1984}\n}';
      fs.writeFileSync(bibFile, `${knuth}\n\n@article{lamport1994,\n  author = {Lamport, Leslie},\n  title = {LaTeX},\n  year = {1994}\n}\n`);
      fs.writeFileSync(path.join(dir, 'gestion.tex'), '\\documentclass{article}\n\\begin{document}\n\nSegún \\cite{knuth1984} y otra vez \\cite{knuth1984, fantasma}.\n\n\\bibliographystyle{plain}\n\\bibliography{gestion}\n\n\\end{document}\n');
      await open('gestion.tex');
      const bib = (): string => fs.readFileSync(bibFile, 'utf8').replace(/\r\n/g, '\n');
      let r = await refs({ open: true });
      assert.equal(r.mode, 'refs');
      assert.deepEqual(r.items, ['knuth1984|2 citas', 'lamport1994|sin citar', 'fantasma|1 cita|falta']);
      assert.match(r.sum, /^2 referencias · 1 sin citar/);
      // el buscador filtra por autor, título o clave, sin tildes ni mayúsculas
      r = await refs({ filter: 'LÁMPORT' });
      assert.deepEqual(r.items.filter((x) => !x.endsWith('falta')), ['lamport1994|sin citar']);
      await refs({ filter: '' });
      // cada clic en una fuente lleva a su cita siguiente, y tras la última vuelve a la primera
      interface Turn { turn: string; here: string[]; on: string }
      const go = async (): Promise<Turn> => (await refs({ key: 'knuth1984', act: 'go' })) as unknown as Turn;
      let t = await go();
      assert.deepEqual([t.turn, t.on], ['knuth1984:0', '1 de 2']);
      assert.match(t.here.join('|'), /^\d+:\\cite\{knuth1984\}$/, 'se resalta la primera cita');
      t = await go();
      assert.deepEqual([t.turn, t.on], ['knuth1984:1', '2 de 2']);
      assert.match(t.here.join('|'), /^\d+:\\cite\{knuth1984, fantasma\}$/, 'y luego la segunda');
      t = await go();
      assert.deepEqual([t.turn, t.on], ['knuth1984:0', '1 de 2'], 'después de la última, otra vez la primera');
      // quitar pide confirmación en el propio panel, y borra la entrada del .bib
      r = await refs({ key: 'lamport1994', act: 'del' });
      assert.equal(r.asking, true);
      assert.ok(bib().includes('lamport1994'), 'todavía no se ha quitado');
      await refs({ key: 'lamport1994', act: 'yes' });
      await eventually(() => !bib().includes('lamport1994'), 'la entrada sale del .bib');
      assert.equal(bib().trim(), knuth, 'la otra entrada queda intacta');
      assert.deepEqual((await refs()).items, ['knuth1984|2 citas', 'fantasma|1 cita|falta']);
      // editar: la entrada tal cual, en un cuadro
      await refs({ key: 'knuth1984', act: 'edit' });
      await act('dialog', { values: { raw: knuth.replace('{1984}', '{1986}').replace('Donald}', 'Donald E.}') } });
      await eventually(() => bib().includes('year = {1986}') && bib().includes('Donald E.'), 'la entrada editada se guarda en el .bib');
      // citar donde está el cursor
      await preview.test('select', { index: find(await snap(), 'Según'), from: 5, to: 5 });
      await refs({ key: 'knuth1984', act: 'cite' });
      await act('blur');
      assert.equal(text().split('knuth1984').length - 1, 3, text());
      assert.deepEqual((await refs()).items[0], 'knuth1984|3 citas');

      // sin .bib: las fuentes son los \bibitem del propio documento
      const lista = (rows: string[]): string => `\\documentclass{article}\n\\begin{document}\n\nVer \\cite{dos}.\n\n\\begin{thebibliography}{9}\n${rows.join('\n')}\n\\end{thebibliography}\n\n\\end{document}\n`;
      fs.writeFileSync(path.join(dir, 'gestion2.tex'), lista(['  \\bibitem{uno} Autor Uno. \\textit{Libro}. 2001.', '  \\bibitem{dos} Autor Dos. \\textit{Otro}. 2002.']));
      await open('gestion2.tex');
      r = await refs({ open: true });
      assert.deepEqual(r.items, ['uno|sin citar', 'dos|1 cita']);
      await refs({ key: 'uno', act: 'del' });
      await refs({ key: 'uno', act: 'yes' });
      await eventually(() => !text().includes('\\bibitem{uno}'), 'el \\bibitem desaparece del documento');
      assert.equal(text(), lista(['  \\bibitem{dos} Autor Dos. \\textit{Otro}. 2002.']));
      await refs({ key: 'dos', act: 'edit' });
      await act('dialog', { values: { raw: '\\bibitem{dos} Autor Dos. \\textit{Otro libro}. 2003.' } });
      await eventually(() => text().includes('Otro libro'), 'el \\bibitem editado');
      assert.equal(text(), lista(['  \\bibitem{dos} Autor Dos. \\textit{Otro libro}. 2003.']));
      await cmd('nav');
    },
  ],
  [
    'bloques: subir, bajar, duplicar y arrastrar, cada cosa en un solo paso de deshacer',
    async () => {
      const wrap = (b: string): string => `\\documentclass{article}\n\\begin{document}\n\n${b}\n\n\\end{document}\n`;
      const eq = '\\[\n  x = 1\n\\]';
      const original = wrap(['\\section{Uno}', 'Primero.', 'Segundo.', 'Tercero.', eq, 'Cuarto.'].join('\n\n'));
      fs.writeFileSync(path.join(dir, 'mover.tex'), original);
      await open('mover.tex');
      const is = (parts: string[], why?: string): void => assert.equal(text(), wrap(parts.join('\n\n')), why);
      const at = async (needle: string): Promise<number> => find(await snap(), needle);
      const undo = async (): Promise<void> => {
        await cmd('undo');
        assert.equal(text(), original, 'un solo paso de deshacer lo devuelve a su sitio');
      };
      // con los botones del bloque
      await act('tool', { index: await at('Primero.'), act: 'down' });
      is(['\\section{Uno}', 'Segundo.', 'Primero.', 'Tercero.', eq, 'Cuarto.']);
      await undo();
      await act('tool', { index: (await at('Tercero.')) + 1, act: 'up' });
      is(['\\section{Uno}', 'Primero.', 'Segundo.', eq, 'Tercero.', 'Cuarto.'], 'una ecuación se mueve con su código intacto');
      await undo();
      await act('tool', { index: await at('Cuarto.'), act: 'dup' });
      is(['\\section{Uno}', 'Primero.', 'Segundo.', 'Tercero.', eq, 'Cuarto.', 'Cuarto.']);
      await undo();
      // con el teclado: el cursor sigue en el párrafo, así que se puede repetir
      await preview.test('select', { index: await at('Segundo.'), from: 3, to: 3 });
      assert.equal(await act('blockKey', { key: 'ArrowUp', alt: true }), true);
      is(['\\section{Uno}', 'Segundo.', 'Primero.', 'Tercero.', eq, 'Cuarto.']);
      let s = await snap();
      assert.equal(s.active, find(s, 'Segundo.'), 'el párrafo movido sigue en edición');
      await act('blockKey', { key: 'ArrowUp', alt: true });
      is(['Segundo.', '\\section{Uno}', 'Primero.', 'Tercero.', eq, 'Cuarto.']);
      await act('blockKey', { key: 'ArrowUp', alt: true });
      is(['Segundo.', '\\section{Uno}', 'Primero.', 'Tercero.', eq, 'Cuarto.'], 'el primero ya no sube más');
      await act('blockKey', { key: 'd', ctrl: true });
      is(['Segundo.', 'Segundo.', '\\section{Uno}', 'Primero.', 'Tercero.', eq, 'Cuarto.']);
      await act('blur');
      for (let k = 0; k < 6 && text() !== original; k++) await cmd('undo');
      assert.equal(text(), original);
      // varios bloques seleccionados viajan juntos y siguen seleccionados
      const xsel = async (args: Record<string, unknown> = {}): Promise<XSel> => (await preview.test('xsel', args)) as XSel;
      await xsel({ from: { index: await at('Segundo.'), offset: 0 }, to: { index: await at('Tercero.') } });
      await act('blockKey', { key: 'ArrowDown', alt: true });
      is(['\\section{Uno}', 'Primero.', eq, 'Segundo.', 'Tercero.', 'Cuarto.']);
      assert.deepEqual((await xsel()).blocks, [await at('Segundo.'), await at('Tercero.')]);
      await act('blockKey', { key: 'ArrowDown', alt: true });
      is(['\\section{Uno}', 'Primero.', eq, 'Cuarto.', 'Segundo.', 'Tercero.']);
      await act('xsel', { key: 'Escape' });
      for (let k = 0; k < 6 && text() !== original; k++) await cmd('undo');
      assert.equal(text(), original);
      // arrastrar: soltar delante de otro bloque lo mueve; con Ctrl, lo copia
      assert.equal(await act('dropBlock', { index: await at('Cuarto.'), target: await at('Primero.'), before: true }), true);
      is(['\\section{Uno}', 'Cuarto.', 'Primero.', 'Segundo.', 'Tercero.', eq]);
      await undo();
      assert.equal(await act('dropBlock', { index: await at('Primero.'), target: await at('Segundo.'), before: true }), false, 'soltarlo donde estaba no cambia nada');
      assert.equal(await act('dropBlock', { index: await at('Primero.'), target: await at('Tercero.'), before: false, copy: true }), true);
      is(['\\section{Uno}', 'Primero.', 'Segundo.', 'Tercero.', 'Primero.', eq, 'Cuarto.']);
      await undo();
      s = await snap();
      assert.equal(s.blocks.filter((b) => b.text.includes('Primero.')).length, 1);
    },
  ],
  [
    'imagen: ancho, alto, medidas exactas, escala, giro y tamaño original',
    async () => {
      await open('imagen.tex');
      const original = text();
      const pick = async (): Promise<{ tab: boolean; turn: string }> => (await act('pickImage', { index: find(await snap(), 'Un píxel') })) as { tab: boolean; turn: string };
      const img = (opts: string): void => assert.ok(text().includes(`\\includegraphics${opts}{img/pixel.png}\n  \\caption{Un píxel}`), text());
      await pick();
      await cmd('img-width', '0.75');
      img('[width=0.75\\textwidth]');
      // el alto manda y el ancho pasa a ser el proporcional
      await pick();
      await cmd('img-height', '0.25');
      img('[height=0.25\\textheight]');
      await pick();
      await cmd('img-size');
      await act('dialog', { values: { w: '6', wu: 'cm', h: '4,5', hu: 'cm', keep: '1', scale: '', angle: '0' } });
      img('[width=6cm, height=4.5cm, keepaspectratio]');
      await pick();
      await cmd('img-rotate', '90');
      img('[width=6cm, height=4.5cm, keepaspectratio, angle=90]');
      let turn = '';
      for (let k = 0; k < 30 && !turn; k++) {
        await sleep(100);
        turn = (await pick()).turn;
      }
      assert.equal(turn, 'rotate(-90deg)', 'la imagen se dibuja girada');
      // el formulario enseña las medidas que hay y la escala sustituye a ancho y alto
      await pick();
      await cmd('img-size');
      await act('dialog', { values: { w: '', h: '', scale: '50', angle: '0' } });
      img('[scale=0.5]');
      await pick();
      await cmd('img-width', '1');
      img('[width=\\textwidth]');
      await pick();
      await cmd('img-natural');
      img('');
      for (let k = 0; k < 12 && text() !== original; k++) await cmd('undo');
      assert.equal(text(), original);
      // arrastrar el borde de abajo fija el alto (aquí, la orden que deja el arrastre)
      await act('resizeImage', { cm: 3.24 });
      await act('blur');
      img('[height=3.2cm]');
      for (let k = 0; k < 6 && text() !== original; k++) await cmd('undo');
      assert.equal(text(), original);
    },
  ],
  [
    'fidelidad en español: comillas latinas, coma decimal, referencias con nombre y la página de \\pageref',
    async () => {
      await open('fiel.tex');
      const r = await laidOut();
      assert.equal(r.pages, 2);
      const para = async (): Promise<string> => {
        const s = await snap();
        return (s.blocks[find(s, 'Dijo')].text ?? '').replace(/\s+/g, ' ');
      };
      // la página de cada etiqueta solo se sabe con el documento ya repartido en hojas
      assert.match(await para(), /Dijo «hola» y vale 3,14; Sección 2 está en la página 2 y Sección 1 en la 1\./);
      // sin editar nada, el código sigue como estaba escrito («<<», el punto decimal)
      const pairs = (await preview.test('roundtrip')) as { src: string; tex: string }[];
      for (const p of pairs) assert.equal(p.tex, p.src.replace(/[ \t]+\n/g, '\n').trim());
      // en la vista continua no hay hojas: la página queda sin saberse
      await cmd('view', 'flow');
      assert.match(await para(), /está en la página \? y Sección 1 en la \?\./);
      await cmd('view', 'page');
      assert.match(await para(), /está en la página 2 y Sección 1 en la 1\./);
    },
  ],
  [
    '«Empezar a escribir»: en un archivo vacío y en uno que tiene algo pero no dibuja nada',
    async () => {
      await open('vacio2.tex');
      assert.equal((await snap()).blocks.length, 0);
      await cmd('start');
      assert.match(text(), /\\begin\{document\}\n\n\\end\{document\}\n$/, 'se instala la hoja en blanco');
      assert.equal((await snap()).pending, true, 'con el primer párrafo ya abierto');
      await act('typeMore', { text: 'Hola' });
      assert.match(text(), /\\begin\{document\}\n\nHola\n\n\\end\{document\}\n$/);
      await act('blur');
      // con algo ya escrito el archivo no se toca, pero se puede empezar a escribir igual
      await open('comentario.tex');
      assert.equal((await snap()).blocks.length, 0);
      await cmd('start');
      assert.equal((await snap()).pending, true);
      await act('typeMore', { text: 'Hola' });
      assert.match(text(), /^% notas sueltas\n[\s\S]*Hola/);
      assert.doesNotMatch(text(), /documentclass/, 'no se le pone un preámbulo que no ha pedido');
      await act('blur');
    },
  ],
  [
    'un archivo vacío ofrece crear el documento base',
    async () => {
      await open('vacio.tex');
      assert.equal((await snap()).blocks.length, 0);
      assert.equal(((await preview.test('ui')) as Ui).templates, 5, 'galería de plantillas');
      await cmd('newdoc');
      assert.match(text(), /\\begin\{document\}/);
      const s = await snap();
      find(s, 'Título del documento');
      find(s, 'Escribe aquí tu texto.');
    },
  ],
];

export async function run(): Promise<void> {
  // (el identificador es «publicador.nombre», tal como esté en package.json)
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', '..', 'package.json'), 'utf8')) as { name: string; publisher: string };
  const ext = vscode.extensions.getExtension<MarsApi>(`${pkg.publisher}.${pkg.name}`);
  assert.ok(ext, 'la extensión no está instalada en el VS Code de pruebas');
  api = await ext.activate();
  const failed: string[] = [];
  // MARS_E2E_ONLY="texto,otro": solo las pruebas cuyo nombre contenga alguno (más la primera, que abre el documento)
  const only = (process.env.MARS_E2E_ONLY ?? '').split(',').map((x) => x.trim()).filter(Boolean);
  const selected = only.length ? tests.filter(([name], i) => i === 0 || only.some((o) => name.includes(o))) : tests;
  for (const [name, fn] of selected) {
    try {
      await fn();
      assert.equal(preview.rejected, 0, 'el host descartó una edición por desfase');
      console.log(`  ✔ ${name}`);
    } catch (err) {
      failed.push(name);
      // lo que la prueba dejase a medias (un párrafo en edición, un diálogo) no debe estropear la siguiente
      try {
        await preview.test('dialog', { cancel: true });
        await preview.test('blur');
        await preview.settle();
      } catch {
        // sin editor al que avisar: la siguiente abre el suyo
      }
      console.log(`  ✖ ${name}\n${String((err as Error)?.stack ?? err).replace(/^/gm, '      ')}`);
    }
  }
  console.log(`\n${selected.length - failed.length} de ${selected.length} pruebas correctas`);
  if (failed.length) throw new Error(`Fallaron ${failed.length} pruebas: ${failed.join('; ')}`);
}
