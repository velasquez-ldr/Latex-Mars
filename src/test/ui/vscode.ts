import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { _electron as electron, type ElectronApplication, type Frame, type Locator, type Page } from 'playwright-core';

/*
 * Abre un VS Code de verdad con Mars cargado y lo maneja con Playwright: ratón y teclado reales
 * sobre la ventana, no llamadas internas. Lo usan las pruebas de interfaz y las capturas.
 */

export const root = path.resolve(__dirname, '..', '..', '..');

/** Ejecutable del VS Code que descargan las pruebas de integración. */
export function codeExe(): string {
  const base = path.join(root, '.vscode-test');
  const dir = fs.existsSync(base) ? fs.readdirSync(base).find((d) => d.startsWith('vscode-')) : undefined;
  if (!dir) throw new Error('No hay un VS Code de pruebas: ejecuta antes "npm run test:e2e" para descargarlo.');
  return path.join(base, dir, process.platform === 'win32' ? 'Code.exe' : 'code');
}

export interface LaunchOptions {
  /** archivos de la carpeta de trabajo: nombre -> contenido */
  files?: Record<string, string | Buffer>;
  /** archivo que se abre al arrancar */
  open?: string;
  width?: number;
  height?: number;
  theme?: string;
  /** carpeta de extensiones con Mars instalado desde su .vsix; sin ella se carga la carpeta del proyecto */
  extensionsDir?: string;
  /** carpeta de trabajo ya preparada (en vez de crear una temporal con `files`) */
  workDir?: string;
  /** argumentos y variables de entorno adicionales para VS Code */
  extraArgs?: string[];
  env?: Record<string, string>;
}

/**
 * Las ventanas de prueba se llevan fuera de la pantalla y no toman el foco: así no interrumpen a
 * quien esté usando el equipo ni reciben sus clics y teclas. Con MARS_TEST_SHOW=1 quedan a la vista.
 */
const HIDE = process.env.MARS_TEST_SHOW !== '1';

async function sendAway(app: ElectronApplication, size: { w: number; h: number }): Promise<void> {
  await app.evaluate(
    ({ BrowserWindow }, o) => {
      for (const w of BrowserWindow.getAllWindows()) {
        if (w.isMaximized()) w.unmaximize();
        w.setSize(o.w, o.h);
        if (o.hide) {
          w.setSkipTaskbar(true);
          w.setPosition(-20000, 0);
          w.blur();
        }
      }
    },
    { ...size, hide: HIDE },
  );
}

export interface Session {
  app: ElectronApplication;
  win: Page;
  /** carpeta de trabajo temporal */
  work: string;
  close(): Promise<void>;
}

export async function launch(o: LaunchOptions = {}): Promise<Session> {
  const work = o.workDir ?? fs.mkdtempSync(path.join(os.tmpdir(), 'mars-ui-'));
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mars-ui-data-'));
  for (const [name, content] of Object.entries(o.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(work, name)), { recursive: true });
    fs.writeFileSync(path.join(work, name), content);
  }
  // ajustes para que la ventana sea predecible: sin avisos, sin paneles extra ni sesiones restauradas
  fs.mkdirSync(path.join(userData, 'User'), { recursive: true });
  fs.writeFileSync(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify({
      'workbench.colorTheme': o.theme ?? 'Default Dark Modern',
      'workbench.startupEditor': 'none',
      'workbench.secondarySideBar.defaultVisibility': 'hidden',
      'window.restoreWindows': 'none',
      'security.workspace.trust.enabled': false,
      'telemetry.telemetryLevel': 'off',
      'update.mode': 'none',
      'extensions.autoUpdate': false,
      'window.zoomLevel': 0,
      'editor.minimap.enabled': false,
      'chat.commandCenter.enabled': false,
    }),
  );
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
  Object.assign(env, o.env ?? {});
  delete env.ELECTRON_RUN_AS_NODE; // desde un terminal de VS Code haría que Code.exe arrancase como Node
  const args = [
    `--user-data-dir=${userData}`, '--disable-workspace-trust', '--skip-welcome', '--skip-release-notes', '--disable-updates', '--disable-telemetry',
    // una ventana tapada o fuera de la pantalla debe seguir dibujándose con normalidad
    '--disable-features=CalculateNativeWinOcclusion', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows',
    ...(o.extraArgs ?? []),
  ];
  // una carpeta de extensiones vacía: no se cargan las del usuario ni aparece el aviso de «extensiones desactivadas»
  const noExtensions = fs.mkdtempSync(path.join(os.tmpdir(), 'mars-ui-ext-'));
  if (o.extensionsDir) args.push(`--extensions-dir=${o.extensionsDir}`);
  else args.push(`--extensionDevelopmentPath=${root}`, `--extensions-dir=${noExtensions}`);
  args.push(work);
  if (o.open) args.push(path.join(work, o.open));
  const app = await electron.launch({ executablePath: codeExe(), env, args });
  const size = { w: o.width ?? 1500, h: o.height ?? 950 };
  const win = await app.firstWindow();
  await sendAway(app, size);
  await win.waitForSelector('.monaco-workbench', { timeout: 90000 });
  await sendAway(app, size);
  const close = async (): Promise<void> => {
    await app.close().catch(() => undefined);
    for (const d of [...(o.workDir ? [] : [work]), userData, noExtensions]) {
      try {
        fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
      } catch {
        // la carpeta temporal puede seguir en uso unos instantes: no es un fallo de la prueba
      }
    }
  };
  return { app, win, work, close };
}

/** Pulsa el botón ▶ del editor (el que usa el usuario) y devuelve el marco donde vive Mars. */
export async function openMars(win: Page): Promise<Frame> {
  const run = win.locator('.editor-actions [aria-label^="Mars"]').first();
  await run.waitFor({ timeout: 90000 });
  await run.click();
  return marsFrame(win);
}

export async function marsFrame(win: Page, timeout = 60000): Promise<Frame> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    for (const f of win.frames()) {
      try {
        if ((await f.locator('#toolbar .tab').count()) > 0 && (await f.locator('#root .block, #empty:not([hidden])').count()) > 0) return f;
      } catch {
        // marco todavía cargando
      }
    }
    await win.waitForTimeout(200);
  }
  throw new Error('No aparece el editor visual de Mars');
}

/**
 * Punto de la ventana (píxeles reales) que corresponde a un elemento del webview. Playwright no
 * lo calcula bien cuando la hoja lleva zoom, así que se pregunta al propio documento.
 * `fx`, `fy` son fracciones dentro de la caja (0,5 = centro).
 */
export async function point(frame: Frame, target: string | Locator, fx = 0.5, fy = 0.5, scroll = true): Promise<{ x: number; y: number }> {
  const loc = typeof target === 'string' ? frame.locator(target).first() : target;
  if (scroll) {
    await loc.evaluate((el) => el.scrollIntoView({ block: 'center', inline: 'nearest' }));
    await frame.page().waitForTimeout(150);
  }
  const outer = await (await frame.frameElement()).boundingBox();
  if (!outer) throw new Error('El webview no es visible');
  const p = await loc.evaluate(
    (el, f) => {
      const b = el.getBoundingClientRect();
      // dentro de la hoja con zoom, VS Code devuelve medidas sin ampliar: se pasan a píxeles reales
      const page = document.getElementById('page') as HTMLElement;
      const applied = parseFloat(page.style.getPropertyValue('zoom')) || 1;
      const measured = page.offsetWidth ? page.getBoundingClientRect().width / page.offsetWidth : 1;
      const k = el.closest('#page') ? applied / measured : 1;
      return { x: (b.left + b.width * f.fx) * k, y: (b.top + b.height * f.fy) * k };
    },
    { fx, fy },
  );
  return { x: outer.x + p.x, y: outer.y + p.y };
}

export interface ClickOptions {
  fx?: number;
  fy?: number;
  button?: 'left' | 'right';
  count?: number;
  wait?: number;
  scroll?: boolean;
}

/** Clic real del ratón sobre un elemento del webview. */
export async function click(frame: Frame, target: string | Locator, o: ClickOptions = {}): Promise<{ x: number; y: number }> {
  const p = await point(frame, target, o.fx, o.fy, o.scroll);
  await frame.page().mouse.click(p.x, p.y, { button: o.button ?? 'left', clickCount: o.count ?? 1 });
  await frame.page().waitForTimeout(o.wait ?? 250);
  return p;
}

/** Arrastre real del ratón entre dos puntos de la ventana. */
export async function drag(win: Page, from: { x: number; y: number }, to: { x: number; y: number }): Promise<void> {
  await win.mouse.move(from.x, from.y);
  await win.mouse.down();
  const steps = 8;
  for (let i = 1; i <= steps; i++) {
    await win.mouse.move(from.x + ((to.x - from.x) * i) / steps, from.y + ((to.y - from.y) * i) / steps);
    await win.waitForTimeout(25);
  }
  await win.mouse.up();
  await win.waitForTimeout(300);
}
