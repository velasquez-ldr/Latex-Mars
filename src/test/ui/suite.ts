import * as assert from 'assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import type { Frame, Locator, Page } from 'playwright-core';
import { click, drag, launch, openMars, point, root, type Session } from './vscode';

/*
 * Pruebas de interfaz: un VS Code real manejado con ratón y teclado. Cubren lo que las pruebas
 * de integración no pueden ver: que los clics caen donde deben, que las teclas llegan al editor,
 * que los atajos no chocan con los de VS Code y que lo guardado en disco es lo esperado.
 */

let s: Session;
let win: Page;
let frame: Frame;
let file: string;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const disk = (): string => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const block = (text: string): Locator => frame.locator('.block .content', { hasText: text }).first();

async function until(ok: () => boolean | Promise<boolean>, what: string, ms = 8000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok()) return;
    await sleep(150);
  }
  throw new Error(`No ocurrió a tiempo: ${what}`);
}

/** Guarda con Ctrl+S (tecla real) y espera a que el archivo en disco cumpla la condición. */
async function saved(expect: RegExp | ((t: string) => boolean), what: string): Promise<void> {
  const ok = (): boolean => (expect instanceof RegExp ? expect.test(disk()) : expect(disk()));
  await sleep(500);
  for (let i = 0; i < 4 && !ok(); i++) {
    await win.keyboard.press('Control+S');
    await sleep(900);
  }
  assert.ok(ok(), `${what}\n--- archivo en disco ---\n${disk()}`);
}

/**
 * Punto de la ventana donde está una palabra concreta de un bloque. `fx` es la fracción horizontal
 * dentro de la palabra (0,5 = su centro; casi 0 = justo delante de su primera letra).
 */
async function wordPoint(blockText: string, word: string, fx = 0.5, scroll = true): Promise<{ x: number; y: number }> {
  const loc = block(blockText);
  if (scroll) {
    await loc.evaluate((el) => el.scrollIntoView({ block: 'center' }));
    await sleep(200);
  }
  const outer = await (await frame.frameElement()).boundingBox();
  assert.ok(outer);
  const p = await loc.evaluate(
    (el, a) => {
      // el texto corrido del bloque: una palabra puede ocupar varios nodos (formato a medias, puntos de división)
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      const nodes: { node: Text; at: number }[] = [];
      let all = '';
      for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
        nodes.push({ node: n, at: all.length });
        all += n.data;
      }
      const i = all.indexOf(a.word);
      if (i < 0) return null;
      const at = (pos: number, end: boolean): [Text, number] => {
        const hit = [...nodes].reverse().find((x) => (end ? x.at < pos : x.at <= pos)) ?? nodes[0];
        return [hit.node, pos - hit.at];
      };
      const r = document.createRange();
      r.setStart(...at(i, false));
      r.setEnd(...at(i + a.word.length, true));
      // la primera línea de la palabra (si el renglón la parte, su primer trozo)
      const b = r.getClientRects()[0] ?? r.getBoundingClientRect();
      const page = document.getElementById('page') as HTMLElement;
      const applied = parseFloat(page.style.getPropertyValue('zoom')) || 1;
      const k = applied / (page.getBoundingClientRect().width / page.offsetWidth);
      return { x: (b.left + b.width * a.fx) * k, y: (b.top + b.height / 2) * k };
    },
    { word, fx },
  );
  assert.ok(p, `no encuentro «${word}» en el bloque «${blockText}»`);
  return { x: outer.x + p.x, y: outer.y + p.y };
}

/** Tramos pintados por la selección de varios bloques. */
const marks = (): Promise<number> => frame.evaluate(() => CSS.highlights.get('mars-select')?.size ?? 0);

/** Clic al final del texto de un bloque: lo deja en edición con el cursor al final. */
async function caretAtEnd(target: string | Locator): Promise<void> {
  await click(frame, typeof target === 'string' ? block(target) : target);
  await win.keyboard.press('Control+End');
  await sleep(150);
}

const tests: [string, () => Promise<void>][] = [
  [
    'el botón ▶ abre el editor visual con la cinta y el documento',
    async () => {
      assert.deepEqual(await frame.locator('#toolbar .tab:visible').allTextContents(), ['Inicio', 'Insertar', 'Disposición', 'Referencias', 'Revisar', 'Vista']);
      assert.ok((await frame.locator('#root .block').count()) > 15);
      // nada se sale por los lados: sin barra de desplazamiento horizontal
      const overflow = await frame.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.ok(overflow <= 1, `desbordamiento horizontal de ${overflow}px`);
    },
  ],
  [
    'la regla coincide con la caja de texto de la hoja',
    async () => {
      const m = await frame.evaluate(() => {
        const page = document.getElementById('page') as HTMLElement;
        const k = (parseFloat(page.style.getPropertyValue('zoom')) || 1) / (page.getBoundingClientRect().width / page.offsetWidth);
        const para = Array.from(document.querySelectorAll('.block.k-rich .content')).find((c) => c.textContent?.includes('Un párrafo con')) as HTMLElement;
        const r = para.getBoundingClientRect();
        const h = (side: string): number => {
          const b = (document.querySelector(`#ruler .rl-h[data-side="${side}"]`) as HTMLElement).getBoundingClientRect();
          return b.left + b.width / 2;
        };
        return { textLeft: r.left * k, textRight: r.right * k, handleLeft: h('left'), handleRight: h('right') };
      });
      assert.ok(Math.abs(m.handleLeft - m.textLeft) < 3, `tirador izquierdo en ${m.handleLeft}, texto en ${m.textLeft}`);
      assert.ok(Math.abs(m.handleRight - m.textRight) < 3, `tirador derecho en ${m.handleRight}, texto en ${m.textRight}`);
    },
  ],
  [
    'clic en un párrafo y tecleo real; Ctrl+S guarda en disco',
    async () => {
      await caretAtEnd('Un párrafo con');
      assert.match((await frame.locator('.block.active .content').textContent()) ?? '', /^Un párrafo con/, 'el clic activa ese párrafo');
      await win.keyboard.type(' hola', { delay: 20 });
      await saved(/y \\\$10\. hola\n/, 'lo tecleado llega al archivo');
    },
  ],
  [
    'Ctrl+Z deshace desde el editor visual',
    async () => {
      for (let i = 0; i < 6 && (await frame.locator('.block .content', { hasText: '$10. hola' }).count()) > 0; i++) {
        await win.keyboard.press('Control+Z');
        await sleep(700);
      }
      await saved((t) => !t.includes('$10. hola') && /y \\\$10\.\n/.test(t), 'el texto tecleado desaparece al deshacer');
    },
  ],
  [
    'doble clic selecciona una palabra: aparece la barra flotante y Ctrl+B la pone en negrita',
    async () => {
      const p = await wordPoint('Un párrafo con', 'canción');
      await win.mouse.dblclick(p.x, p.y);
      await until(async () => !(await frame.locator('#bubble').isHidden()), 'barra flotante visible');
      assert.equal(await frame.evaluate(() => document.getSelection()?.toString().trim()), 'canción');
      // la barra queda pegada a la selección (no desplazada por el zoom)
      const gap = await frame.evaluate(() => {
        const page = document.getElementById('page') as HTMLElement;
        const k = (parseFloat(page.style.getPropertyValue('zoom')) || 1) / (page.getBoundingClientRect().width / page.offsetWidth);
        const sel = (document.getSelection() as Selection).getRangeAt(0).getBoundingClientRect();
        const b = (document.getElementById('bubble') as HTMLElement).getBoundingClientRect();
        return { dy: Math.min(Math.abs(sel.top * k - b.bottom), Math.abs(b.top - sel.bottom * k)), dx: Math.abs((sel.left + sel.width / 2) * k - (b.left + b.width / 2)) };
      });
      assert.ok(gap.dy < 16 && gap.dx < b_half(), `barra a ${gap.dy}px en vertical y ${gap.dx}px en horizontal de la selección`);
      await win.keyboard.press('Control+B');
      await saved(/\\textbf\{canción\}/, 'Ctrl+B pone la palabra en negrita');
      // el atajo es del editor visual: no dispara el de VS Code (mostrar u ocultar la barra lateral)
      assert.ok(await win.locator('.part.sidebar').first().isVisible(), 'Ctrl+B no oculta la barra lateral de VS Code');
    },
  ],
  [
    'un botón de la barra flotante, con el ratón',
    async () => {
      const p = await wordPoint('Un párrafo con', 'niño');
      await win.mouse.dblclick(p.x, p.y);
      await until(async () => !(await frame.locator('#bubble').isHidden()), 'barra flotante visible');
      await click(frame, '#bubble button[data-cmd="italic"]', { scroll: false });
      await saved(/\\textit\{niño\}/, 'el botón de cursiva de la barra flotante');
    },
  ],
  [
    'control de la fuente con el ratón: tamaño, color y tipo de letra del texto seleccionado',
    async () => {
      const pickWord = async (word: string): Promise<void> => {
        const p = await wordPoint('Un párrafo con', word);
        await win.mouse.dblclick(p.x, p.y);
        await until(async () => (await frame.evaluate(() => document.getSelection()?.toString().trim())) === word, `«${word}» seleccionada`);
      };
      const choose = async (menu: string, item: string): Promise<void> => {
        await click(frame, `#${menu} .dd-btn`, { scroll: false });
        assert.ok(await frame.locator(`#${menu} .menu`).isVisible(), `el menú ${menu} se despliega`);
        await click(frame, `#${menu} ${item}`, { scroll: false });
      };
      const box = (id: string): Promise<string> => frame.evaluate((i) => document.querySelector(`#${i} .combo-val`)?.textContent ?? '', id);
      // los cuadros de fuente y tamaño están en Inicio y muestran lo que hay bajo el cursor
      assert.deepEqual([await box('dd-font'), await box('dd-fsize')], ['Computer Modern', '10']);
      await pickWord('comillas');
      await choose('dd-fsize', 'button[data-arg="14"]');
      await saved((t) => /\{\\fontsize\{14\}\{16\.8\}\\selectfont comillas\}/.test(t) && /\\usepackage\{anyfontsize\}\n/.test(t), '14 puntos sobre la palabra seleccionada, y el paquete que lo permite');
      // el párrafo sigue en edición con la palabra seleccionada, y el cuadro muestra su tamaño
      await until(async () => (await frame.evaluate(() => document.getSelection()?.toString())) === 'comillas' && (await box('dd-fsize')) === '14', 'selección conservada y tamaño a la vista');
      // otro tamaño sobre lo mismo sustituye al anterior en vez de anidarse
      await choose('dd-fsize', 'button[data-arg="18"]');
      await saved((t) => /\{\\fontsize\{18\}\{21\.6\}\\selectfont comillas\}/.test(t) && !t.includes('fontsize{14}'), '18 puntos en lugar de 14');
      await pickWord('guiones');
      await choose('dd-color', 'button[data-arg="FF0000"]');
      await saved((t) => /\\textcolor\{red\}\{guiones\}/.test(t) && /\\usepackage\{xcolor\}\n/.test(t), 'color rojo, y el paquete que necesita');
      await pickWord('símbolos');
      await choose('dd-font', 'button[data-cmd="wrap"][data-arg="sf"]');
      await saved(/\\textsf\{símbolos\}/, 'letra sin remates');
      await pickWord('acentos');
      await choose('dd-font', 'button[data-cmd="font"][data-arg="times"]');
      await saved((t) => /\{\\fontfamily\{ptm\}\\selectfont acentos\}/.test(t) && !t.includes('mathptmx'), 'Times solo en la palabra, sin cambiar la letra del documento');
      assert.equal(await box('dd-font'), 'Times');
      // y en pantalla se ven con ese aspecto
      const look = await frame.evaluate(() => {
        // el elemento más interior que contiene justo esa palabra
        const find = (text: string): CSSStyleDeclaration | undefined => {
          const el = Array.from(document.querySelectorAll('.block .content span')).filter((s) => s.textContent === text).pop();
          return el ? getComputedStyle(el) : undefined;
        };
        const base = parseFloat(getComputedStyle(document.querySelector('.block.k-para .content') as Element).fontSize);
        return {
          large: parseFloat(find('comillas')?.fontSize ?? '0') / base, color: find('guiones')?.color, family: find('símbolos')?.fontFamily, times: find('acentos')?.fontFamily,
        };
      });
      assert.ok(look.large > 1.75 && look.large < 1.85, `«comillas» se ve a 18 puntos sobre un texto de 10 (×${look.large})`);
      assert.equal(look.color, 'rgb(255, 0, 0)');
      assert.match(look.family ?? '', /SansSerif/);
      assert.match(look.times ?? '', /Times New Roman/);
    },
  ],
  [
    'un clic sobre una fórmula deja el cursor a su lado: se puede seguir escribiendo',
    async () => {
      const formula = frame.locator('.block .content', { hasText: 'Una fórmula en línea como' }).first().locator('.atom.math, .atom').first();
      // en la mitad derecha de la fórmula: el cursor queda justo detrás
      await click(frame, formula, { fx: 0.8 });
      const inside = await frame.evaluate(() => {
        const n = document.getSelection()?.anchorNode;
        return (n?.nodeType === 1 ? (n as Element) : n?.parentElement)?.closest('[data-tex]') !== null;
      });
      assert.equal(inside, false, 'el cursor no queda dentro de la fórmula');
      await win.keyboard.type('X', { delay: 20 });
      await saved(/= 0\$X se edita con doble clic/, 'lo tecleado va justo detrás de la fórmula');
      for (let i = 0; i < 4 && disk().includes('$X se edita'); i++) {
        await win.keyboard.press('Control+Z');
        await sleep(700);
        await win.keyboard.press('Control+S');
        await sleep(500);
      }
      assert.ok(!disk().includes('$X se edita'), 'deshecho');
    },
  ],
  [
    'Enter crea un párrafo y «# » lo convierte en título mientras se teclea',
    async () => {
      await caretAtEnd('Una fórmula en línea como');
      await win.keyboard.press('Enter');
      await until(async () => (await frame.locator('.block.pending').count()) === 1, 'párrafo nuevo abierto');
      // tecleado seguido, sin esperar a que el párrafo se convierta en título: no se pierde ninguna letra
      await win.keyboard.type('# Sección tecleada', { delay: 25 });
      // y el párrafo nuevo queda separado por una sola línea en blanco a cada lado
      await saved(/al final\.\}\.\n\n\\section\{Sección tecleada\}\n\n\\subsection\{Listas\}/, 'el atajo «# » crea una sección');
    },
  ],
  [
    'menú «/»: se abre al teclear, filtra y Enter inserta',
    async () => {
      // el título, no su entrada en el índice
      await caretAtEnd(frame.locator('.block .content h2', { hasText: 'Sección tecleada' }));
      await win.keyboard.press('Enter');
      await until(async () => (await frame.locator('.block.pending').count()) === 1, 'párrafo nuevo abierto');
      await win.keyboard.type('/', { delay: 30 });
      await until(async () => !(await frame.locator('#slash').isHidden()), 'menú / visible');
      await win.keyboard.type('tab', { delay: 30 });
      assert.deepEqual(await frame.locator('#slash button b').allTextContents(), ['Tabla']);
      await win.keyboard.press('Enter');
      await until(async () => (await frame.locator('.overlay .dialog').count()) === 1, 'diálogo de tabla');
      await click(frame, '.overlay button.primary', { scroll: false });
      await saved((t) => /\\begin\{tabular\}\{\|c\|c\|c\|\}/.test(t) && !t.includes('/tab'), 'la tabla se inserta y no queda rastro de «/tab»');
    },
  ],
  [
    'Ctrl+Enter inserta un salto de página y deja el cursor en la hoja siguiente',
    async () => {
      await caretAtEnd('Un párrafo con');
      await win.keyboard.press('Control+Enter');
      await until(async () => (await frame.locator('.block.pending').count()) === 1, 'párrafo nuevo tras el salto');
      await win.keyboard.type('Tras el salto', { delay: 20 });
      await saved(/\\\$10\.\n\n\\newpage\n\nTras el salto\n\nUna fórmula/, 'salto de página seguido del texto nuevo, sin líneas en blanco de más');
      assert.ok((await frame.locator('.block.page-start', { hasText: 'Tras el salto' }).count()) === 1, 'lo escrito abre hoja nueva');
    },
  ],
  [
    'la cinta con el ratón: Disposición → Tamaño → A4',
    async () => {
      await click(frame, '#toolbar .tab[data-tab="layout"]', { scroll: false });
      await click(frame, '#dd-paper .dd-btn', { scroll: false });
      const menu = frame.locator('#dd-paper .menu');
      assert.ok(await menu.isVisible(), 'el menú se despliega');
      // el menú entero queda dentro de la ventana
      const fits = await menu.evaluate((m) => {
        const r = m.getBoundingClientRect();
        return r.left >= 0 && r.right <= document.documentElement.clientWidth + 1 && r.top >= 0;
      });
      assert.ok(fits, 'el menú no se sale de la ventana');
      // ni lo tapa otra cosa: lo que hay bajo el puntero es la opción del menú
      const hit = await frame.evaluate(() => {
        const r = (document.querySelector('#dd-paper button[data-arg="paper=a4paper"]') as HTMLElement).getBoundingClientRect();
        return document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest('button')?.getAttribute('data-arg');
      });
      assert.equal(hit, 'paper=a4paper', 'la opción A4 está a la vista y recibe el clic');
      await click(frame, '#dd-paper button[data-arg="paper=a4paper"]', { scroll: false });
      await saved(/^\\documentclass\[a4paper\]\{article\}\n/, 'el tamaño A4 se escribe en el preámbulo');
      assert.equal(await frame.evaluate(() => (document.getElementById('page') as HTMLElement).style.getPropertyValue('--pw')), '966px');
    },
  ],
  [
    'sin nada seleccionado, la fuente y el tamaño de Inicio cambian todo el documento',
    async () => {
      await click(frame, '#toolbar .tab[data-tab="home"]', { scroll: false });
      // el cursor en un párrafo, sin selección
      await caretAtEnd('Una fórmula en línea como');
      await click(frame, '#dd-font .dd-btn', { scroll: false });
      assert.ok(await frame.locator('#dd-font .menu').isVisible(), 'el menú de fuentes se despliega');
      assert.match((await frame.locator('#dd-font .menu-hint').textContent()) ?? '', /todo el documento/);
      await click(frame, '#dd-font button[data-cmd="font"][data-arg="palatino"]', { scroll: false });
      await saved(/\\usepackage\{mathpazo\}\n/, 'Palatino se escribe en el preámbulo');
      const font = await frame.evaluate(() => getComputedStyle(document.getElementById('page') as HTMLElement).fontFamily);
      assert.match(font, /Palatino/, 'y la hoja se dibuja con esa letra');
      const size = (): Promise<string> => frame.evaluate(() => document.querySelector('#dd-fsize .combo-val')?.textContent ?? '');
      // un tamaño de los que trae la clase va en \documentclass
      await click(frame, '#dd-fsize .dd-btn', { scroll: false });
      await click(frame, '#dd-fsize button[data-arg="12"]', { scroll: false });
      await saved(/^\\documentclass\[12pt, a4paper\]\{article\}\n/, '12 puntos como opción de la clase');
      // los demás, con el paquete scrextend: el botón de agrandar pasa de 12 a 14
      await click(frame, '#toolbar button[data-cmd="fsize-step"][data-arg="1"]', { scroll: false });
      await saved((t) => /^\\documentclass\[a4paper\]\{article\}\n/.test(t) && /\\usepackage\[fontsize=14pt\]\{scrextend\}\n/.test(t), '14 puntos para todo el documento');
      await until(async () => (await size()) === '14', 'el cuadro muestra 14');
      const px = await frame.evaluate(() => parseFloat(getComputedStyle(document.getElementById('page') as HTMLElement).fontSize));
      assert.ok(Math.abs(px - 14 * 0.03515 * 46) < 0.2, `la hoja se dibuja a 14 puntos (${px}px)`);
      // y el de reducir vuelve a 12, sin dejar rastro del paquete
      await click(frame, '#toolbar button[data-cmd="fsize-step"][data-arg="-1"]', { scroll: false });
      await saved((t) => /^\\documentclass\[12pt, a4paper\]\{article\}\n/.test(t) && !t.includes('scrextend'), 'de vuelta a 12 puntos');
    },
  ],
  [
    'cinta estrecha: las flechas de los bordes la desplazan',
    async () => {
      const panel = frame.locator('#toolbar .panel.on');
      const overflows = await panel.evaluate((p) => p.scrollWidth > p.clientWidth + 4);
      if (overflows) {
        const right = frame.locator('#toolbar .rb-more[data-scroll="1"]');
        assert.ok(await right.isVisible(), 'la flecha derecha aparece cuando la cinta no cabe');
        await click(frame, right, { scroll: false, wait: 700 });
        assert.ok((await panel.evaluate((p) => p.scrollLeft)) > 20, 'la cinta se desplaza');
        assert.ok(await frame.locator('#toolbar .rb-more[data-scroll="-1"]').isVisible(), 'y aparece la flecha de vuelta');
      }
      await click(frame, '#toolbar .tab[data-tab="home"]', { scroll: false });
    },
  ],
  [
    'varias páginas: al alejar, las hojas se colocan en mosaico con el mismo reparto, y un clic en su número abre una',
    async () => {
      const pages = (): Promise<string> =>
        frame.evaluate(() => Array.from(document.querySelectorAll('#status span')).map((s) => /^(?:Página )?\d+(?: de |\/)(\d+)$/.exec(s.textContent ?? '')?.[1]).find(Boolean) ?? '');
      const single = await pages();
      await click(frame, '#toolbar .tab[data-tab="view"]', { scroll: false });
      await click(frame, '#toolbar button[data-cmd="zoom"][data-arg="multi"]', { scroll: false });      await until(async () => (await frame.locator('body.grid').count()) === 1, 'mosaico de hojas');
      await sleep(500);
      const grid = await frame.evaluate(() => {
        const box = (e: Element): DOMRect => e.getBoundingClientRect();
        const sheets = Array.from(document.querySelectorAll('.ov-sheet')).map(box);
        const inSheet = (r: DOMRect): boolean => sheets.some((s) => r.left >= s.left - 1 && r.right <= s.right + 1 && r.top >= s.top - 1 && r.top < s.bottom);
        // cada párrafo empieza dentro de alguna hoja
        const paras = Array.from(document.querySelectorAll('#root > .block.k-para > .content'));
        // y por cada párrafo partido entre dos hojas hay una copia con su continuación
        const split = Array.from(document.querySelectorAll<HTMLElement>('#root > .block')).filter((b) => b.style.clipPath !== '').length;
        return {
          rows: sheets.map((s) => Math.round(s.top)), cols: sheets.map((s) => Math.round(s.left)), count: sheets.length,
          stray: paras.filter((p) => !inSheet(box(p))).length, paras: paras.length, split, mirrors: document.querySelectorAll('#mirrors > .block.mirror').length,
          numbers: Array.from(document.querySelectorAll('.ov-num')).map((n) => n.textContent),
        };
      });
      assert.ok(grid.mirrors >= grid.split, `cada bloque partido tiene su continuación (${grid.split} partidos, ${grid.mirrors} copias)`);
      assert.equal(String(grid.count), single, 'tantas hojas como páginas tenía el documento');
      assert.ok(grid.count >= 2 && grid.rows[0] === grid.rows[1] && grid.cols[1] > grid.cols[0], `las dos primeras hojas, una al lado de otra (${JSON.stringify(grid)})`);
      assert.deepEqual(grid.numbers.slice(0, 2), ['1', '2']);
      assert.ok(grid.paras >= 2 && grid.stray === 0, `todos los párrafos quedan dentro de su hoja (${grid.stray} de ${grid.paras} fuera)`);
      assert.equal(await pages(), single, 'el reparto en páginas no cambia');
      // el número de la segunda hoja la abre a tamaño de lectura
      await click(frame, frame.locator('.ov-sheet .ov-num').nth(1), { scroll: false, wait: 900 });
      await until(async () => (await frame.locator('body.grid').count()) === 0, 'de vuelta a una hoja por fila');
      await until(async () => (await frame.evaluate(() => Array.from(document.querySelectorAll('#status span')).some((s) => /^(?:Página )?2(?: de |\/)\d+$/.test(s.textContent ?? '')))), 'y se ve la página 2');
      await click(frame, '#toolbar .tab[data-tab="home"]', { scroll: false });
    },
  ],
  [
    'arrastrar el tirador de la regla cambia el margen izquierdo',
    async () => {
      const from = await point(frame, '#ruler .rl-h[data-side="left"]', 0.5, 0.5, false);
      const before = await frame.evaluate(() => {
        const sheet = document.querySelector('#ruler .rl-sheet') as HTMLElement;
        const cm = parseFloat(getComputedStyle(sheet).getPropertyValue('--cmz'));
        return { cm, left: parseFloat((sheet.querySelector('[data-side="left"]') as HTMLElement).style.left) / cm };
      });
      await drag(win, from, { x: from.x + before.cm, y: from.y });
      await saved((t) => {
        const m = /\\usepackage\[top=[\d.]+cm, bottom=[\d.]+cm, left=([\d.]+)cm, right=[\d.]+cm\]\{geometry\}/.exec(t);
        return m !== null && Math.abs(parseFloat(m[1]) - (before.left + 1)) <= 0.15;
      }, `el margen izquierdo pasa de ${before.left.toFixed(2)} cm a un centímetro más`);
    },
  ],
  [
    'Ctrl+F abre el buscador de VS Code sobre el documento visual',
    async () => {
      await click(frame, block('Un párrafo con'));
      await win.keyboard.press('Control+F');
      await until(async () => (await win.locator('.simple-find-part.visible').count()) > 0, 'buscador visible');
      await win.keyboard.type('Marte');
      await win.keyboard.press('Enter');
      await sleep(400);
      await win.keyboard.press('Escape');
    },
  ],
  [
    'pegar desde el portapapeles conserva negritas y cursivas',
    async () => {
      await s.app.evaluate(({ clipboard }) => clipboard.write({ text: ' pegado con formato', html: ' <b>pegado</b> con <i>formato</i>' }));
      await caretAtEnd('Una fórmula en línea como');
      await win.keyboard.press('Control+V');
      await saved(/\\textbf\{pegado\} con \\textit\{formato\}/, 'el formato del portapapeles pasa a LaTeX');
    },
  ],
  [
    'panel de navegación: se abre desde la barra de estado y un clic lleva a la sección',
    async () => {
      if ((await frame.locator('body.nav-open').count()) === 0) await click(frame, '#status button[data-cmd="nav"]', { scroll: false });
      await until(async () => (await frame.locator('#nav .nav-item').count()) >= 4, 'esquema visible');
      const zoomBefore = await frame.evaluate(() => (document.getElementById('page') as HTMLElement).style.getPropertyValue('zoom'));
      await click(frame, frame.locator('#nav .nav-item', { hasText: 'Matemáticas' }), { scroll: false });
      const where = (): Promise<{ y: number; bar: number; end: boolean; sy: number }> =>
        frame.evaluate(() => {
          const page = document.getElementById('page') as HTMLElement;
          const k = (parseFloat(page.style.getPropertyValue('zoom')) || 1) / (page.getBoundingClientRect().width / page.offsetWidth);
          const h = Array.from(document.querySelectorAll('.block h2')).find((x) => x.textContent?.includes('Matemáticas')) as HTMLElement;
          return {
            y: h.getBoundingClientRect().top * k,
            bar: (document.getElementById('toolbar') as HTMLElement).offsetHeight,
            end: window.scrollY + window.innerHeight >= document.documentElement.scrollHeight - 2,
            sy: window.scrollY,
          };
        });
      // el desplazamiento es animado: se espera a que se detenga
      let top = await where();
      for (let i = 0; i < 20; i++) {
        await sleep(200);
        const now = await where();
        const still = Math.abs(now.sy - top.sy) < 1;
        top = now;
        if (still) break;
      }
      assert.ok(top.end || (top.y > top.bar - 5 && top.y < top.bar + 140), `el título queda bajo la cinta (y=${top.y}, cinta=${top.bar})`);
      const narrow = await frame.evaluate(() => document.documentElement.clientWidth < 900);
      if (narrow) {
        // en un panel estrecho el esquema flota: no encoge la hoja y se cierra al elegir
        assert.equal(await frame.evaluate(() => (document.getElementById('page') as HTMLElement).style.getPropertyValue('zoom')), zoomBefore, 'el zoom no cambia');
        assert.equal(await frame.locator('body.nav-open').count(), 0, 'el esquema se cierra tras elegir una sección');
      } else await click(frame, '#nav [data-cmd="nav"]', { scroll: false });
    },
  ],
  [
    'Enter en mitad de un párrafo y tecleo inmediato: no se pierde ninguna letra',
    async () => {
      const p = await wordPoint('Una fórmula en línea como', 'Mira');
      await win.mouse.click(p.x, p.y);
      await win.keyboard.press('Control+ArrowLeft');
      await win.keyboard.press('Enter');
      // sin esperar a que el documento vuelva redibujado
      await win.keyboard.type('Zeta ', { delay: 0 });
      await saved(/doble clic\.\n\nZeta Mira la\n/, 'el párrafo se parte y lo tecleado va al principio del segundo');
    },
  ],
  [
    'corrector: una palabra mal escrita se subraya y el clic derecho ofrece corregirla',
    async () => {
      const underlined = (): Promise<number> => frame.evaluate(() => CSS.highlights.get('mars-spell')?.size ?? 0);
      // el diccionario tarda un momento en cargarse la primera vez
      await sleep(2500);
      const base = await underlined();
      await caretAtEnd('Tras el salto');
      await win.keyboard.type(' con una palabrra más', { delay: 20 });
      await until(async () => (await underlined()) === base + 1, 'la palabra mal escrita queda subrayada', 15000);
      const p = await wordPoint('Tras el salto', 'palabrra');
      await win.mouse.click(p.x, p.y, { button: 'right' });
      await until(async () => (await frame.locator('#spellmenu button[data-fix]').count()) > 0, 'menú con sugerencias', 15000);
      await click(frame, frame.locator('#spellmenu button[data-fix="palabra"]'), { scroll: false });
      await saved(/\nTras el salto con una palabra más\n/, 'la palabra queda corregida en el archivo');
      await until(async () => (await underlined()) === base, 'y deja de estar subrayada', 8000);
    },
  ],
  [
    'arrastrar de un párrafo a otro selecciona a través de los bloques: Ctrl+C copia el LaTeX y Supr los une',
    async () => {
      const b = await wordPoint('Zeta Mira la', 'Mira', 0.02);
      const a = await wordPoint('Una fórmula en línea como', 'edita', 0.02, false);
      await drag(win, a, b);
      await until(async () => (await marks()) === 2, 'selección pintada en los dos párrafos');
      await win.keyboard.press('Control+C');
      await sleep(300);
      const copied = await s.app.evaluate(({ clipboard }) => clipboard.readText());
      assert.equal(copied.replace(/\r\n/g, '\n'), 'edita con doble clic.\n\nZeta', 'se copia el código LaTeX de lo seleccionado');
      await win.keyboard.press('Delete');
      await saved(/= 0\$ se Mira la\n/, 'los dos párrafos quedan unidos por donde se cortó');
      assert.equal(await marks(), 0);
    },
  ],
  [
    'Mayús+clic extiende la selección hasta otro párrafo y Ctrl+B la pone entera en negrita',
    async () => {
      const b = await wordPoint('Una fórmula en línea como', 'línea', 0.02);
      const a = await wordPoint('Tras el salto', 'salto', 0.02, false);
      await win.mouse.click(a.x, a.y);
      await win.keyboard.down('Shift');
      await win.mouse.click(b.x, b.y);
      await win.keyboard.up('Shift');
      await until(async () => (await marks()) === 2, 'selección de un párrafo a otro');
      await win.keyboard.press('Control+B');
      await saved(/\nTras el \\textbf\{salto con una palabra más\}\n\n\\textbf\{Una fórmula en \}línea como/, 'la negrita abarca los dos párrafos');
      assert.equal(await marks(), 2, 'y la selección sigue en su sitio');
      await win.keyboard.press('Escape');
      await until(async () => (await marks()) === 0, 'Escape suelta la selección');
    },
  ],
  [
    'Ctrl+A selecciona el párrafo y, pulsado otra vez, todo el documento',
    async () => {
      await click(frame, block('Tras el'));
      await win.keyboard.press('Control+A');
      await sleep(250);
      assert.match(await frame.evaluate(() => document.getSelection()?.toString() ?? ''), /^Tras el salto con una palabra más$/, 'primero, el párrafo');
      assert.equal(await marks(), 0);
      await win.keyboard.press('Control+A');
      await until(async () => (await marks()) > 5, 'después, todo el documento');
      await win.keyboard.press('Control+C');
      await sleep(300);
      const copied = (await s.app.evaluate(({ clipboard }) => clipboard.readText())).replace(/\r\n/g, '\n');
      assert.match(copied, /^\\maketitle\n\n\\begin\{abstract\}[\s\S]*\\end\{verbatim\}$/, 'se copia el cuerpo entero del documento');
      await win.keyboard.press('Escape');
      await until(async () => (await marks()) === 0, 'Escape suelta la selección');
      assert.ok(await win.locator('.part.sidebar').first().isVisible());
    },
  ],
  [
    'después de todo lo anterior la hoja sigue sin desplazamiento lateral',
    async () => {
      const overflow = await frame.evaluate(() => ({ w: document.documentElement.scrollWidth - document.documentElement.clientWidth, x: window.scrollX }));
      assert.ok(overflow.w <= 1 && overflow.x === 0, `desbordamiento horizontal de ${overflow.w}px, desplazado ${overflow.x}px`);
    },
  ],
];

/** Mitad del ancho de la barra flotante: margen admisible para el centrado horizontal. */
function b_half(): number {
  return 190;
}

async function main(): Promise<void> {
  s = await launch({ files: { 'ejemplo.tex': fs.readFileSync(path.join(root, 'ejemplo.tex')) }, open: 'ejemplo.tex', width: 1500, height: 950 });
  win = s.win;
  file = path.join(s.work, 'ejemplo.tex');
  const failed: string[] = [];
  try {
    frame = await openMars(win);
    await sleep(1500);
    for (const [name, fn] of tests) {
      try {
        await fn();
        console.log(`  ✔ ${name}`);
      } catch (err) {
        failed.push(name);
        console.log(`  ✖ ${name}\n${String((err as Error)?.stack ?? err).replace(/^/gm, '      ')}`);
        await win.screenshot({ path: path.join(root, 'tools', 'capturas', `fallo-${failed.length}.png`) }).catch(() => undefined);
        // deja la interfaz en un estado neutro para la prueba siguiente
        await win.keyboard.press('Escape').catch(() => undefined);
      }
    }
  } finally {
    await s.close();
  }
  console.log(`\n${tests.length - failed.length} de ${tests.length} pruebas de interfaz correctas`);
  if (failed.length) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
