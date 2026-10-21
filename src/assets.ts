import { execFile } from 'child_process';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import type { TikzPreamble } from './latex/renderer';

/*
 * Recursos que no se pueden dibujar de forma inmediata: figuras TikZ (TeX en WebAssembly) e
 * imágenes EPS (Ghostscript, si está instalado). Se calculan en segundo plano y se guardan en
 * caché; cuando uno termina se avisa para volver a pintar el documento.
 */

type TikzResult = { svg?: string; error?: string };
type Tex2Svg = (source: string, options?: Record<string, unknown>) => Promise<string>;

const hash = (s: string): string => crypto.createHash('sha1').update(s).digest('hex');

export class Assets {
  private tikz = new Map<string, TikzResult>();
  private queued = new Set<string>();
  /** node-tikzjax no admite dos renders a la vez: se encadenan */
  private chain: Promise<void> = Promise.resolve();
  private engine: Tex2Svg | undefined;
  private gs: Promise<string | undefined> | undefined;
  private eps = new Map<string, string | null>();
  /** trabajos en curso (las pruebas esperan a que llegue a cero) */
  pending = 0;

  constructor(private readonly cacheDir: string, private readonly changed: () => void) {}

  /** SVG de una figura TikZ, o `undefined` si todavía se está dibujando. */
  renderTikz(source: string, pre: TikzPreamble): TikzResult | undefined {
    const packages = [...pre.packages];
    if (/\\begin\{tikzcd\}/.test(source) && !packages.includes('tikz-cd')) packages.push('tikz-cd');
    if (/\\begin\{circuitikz\}|\\ctikzset/.test(source) && !packages.includes('circuitikz')) packages.push('circuitikz');
    if (/\\begin\{axis\}|\\addplot/.test(source) && !packages.includes('pgfplots')) packages.push('pgfplots');
    const key = hash(JSON.stringify([source, pre.libraries, packages, pre.extra]));
    const done = this.tikz.get(key) ?? this.stored(key);
    if (done) return done;
    if (!this.queued.has(key)) {
      this.queued.add(key);
      this.pending++;
      this.chain = this.chain.then(async () => {
        try {
          const result = await this.runTikz(source, pre, packages);
          this.tikz.set(key, result);
          this.store(key, result);
          if (this.tikz.size > 300) this.tikz.delete(this.tikz.keys().next().value as string);
        } finally {
          this.queued.delete(key);
          this.pending--;
        }
        // (un fallo al repintar no debe cortar la cola: las figuras que quedan se siguen dibujando)
        try {
          this.changed();
        } catch (err) {
          console.error('[mars]', err);
        }
      });
    }
    return undefined;
  }

  /** Figura ya dibujada en otra sesión: se guarda en disco para no esperar al motor TeX cada vez que se abre el documento. */
  private stored(key: string): TikzResult | undefined {
    try {
      const svg = fs.readFileSync(path.join(this.cacheDir, 'tikz', `${key}.svg`), 'utf8');
      const result = { svg };
      this.tikz.set(key, result);
      return result;
    } catch {
      return undefined;
    }
  }

  private store(key: string, result: TikzResult): void {
    if (!result.svg) return;
    try {
      fs.mkdirSync(path.join(this.cacheDir, 'tikz'), { recursive: true });
      fs.writeFileSync(path.join(this.cacheDir, 'tikz', `${key}.svg`), result.svg);
    } catch {
      // sin caché en disco: se vuelve a dibujar la próxima vez
    }
  }

  private async runTikz(source: string, pre: TikzPreamble, packages: string[]): Promise<TikzResult> {
    try {
      // se carga al primer uso: el motor TeX pesa varios megas. La ruta se calcula para que el
      // empaquetador no lo meta dentro de la extensión: es un archivo aparte (tikz.js)
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      this.engine ??= (require(path.join(__dirname, 'tikz.js')) as { default: Tex2Svg }).default;
      const texPackages: Record<string, string> = {};
      for (const p of packages) texPackages[p] = '';
      // el pgfplots del motor incorporado llega hasta la 1.16: una versión más nueva en `compat` lo hace fallar
      const compat = (s: string): string => s.replace(/\bcompat\s*=\s*(?:newest|1\.(?:1[7-9]|[2-9]\d))/g, 'compat=1.16');
      const svg = await this.engine(`\\begin{document}\n${compat(source)}\n\\end{document}`, {
        texPackages,
        tikzLibraries: pre.libraries,
        addToPreamble: compat(pre.extra),
      });
      // el SVG se incrusta en la página: fuera scripts y manejadores por si acaso
      return { svg: svg.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/\son\w+="[^"]*"/gi, '') };
    } catch (err) {
      return { error: String((err as Error)?.message ?? err).replace(/ Set `options.*$/, '') };
    }
  }

  /** Ruta del ejecutable de Ghostscript, si está instalado. */
  private ghostscript(): Promise<string | undefined> {
    this.gs ??= (async () => {
      for (const exe of process.platform === 'win32' ? ['gswin64c', 'gswin32c', 'gs'] : ['gs']) {
        const ok = await new Promise<boolean>((resolve) => execFile(exe, ['--version'], { timeout: 5000 }, (err) => resolve(!err)));
        if (ok) return exe;
      }
      return undefined;
    })();
    return this.gs;
  }

  /** PNG equivalente a un archivo EPS; `undefined` si aún no existe o no hay Ghostscript. */
  epsToPng(file: string): string | undefined {
    let stamp: string;
    try {
      const st = fs.statSync(file);
      stamp = `${file}:${st.mtimeMs}:${st.size}`;
    } catch {
      return undefined;
    }
    const known = this.eps.get(stamp);
    if (known !== undefined) return known ?? undefined;
    const out = path.join(this.cacheDir, `${hash(stamp)}.png`);
    if (fs.existsSync(out)) {
      this.eps.set(stamp, out);
      return out;
    }
    this.eps.set(stamp, null);
    this.pending++;
    void (async () => {
      try {
        const gs = await this.ghostscript();
        if (gs) {
          fs.mkdirSync(this.cacheDir, { recursive: true });
          const args = ['-dSAFER', '-dBATCH', '-dNOPAUSE', '-dEPSCrop', '-r200', '-sDEVICE=pngalpha', `-sOutputFile=${out}`, file];
          const ok = await new Promise<boolean>((resolve) => execFile(gs, args, { timeout: 30000 }, (err) => resolve(!err)));
          if (ok && fs.existsSync(out)) this.eps.set(stamp, out);
        }
      } catch (err) {
        console.error('[mars]', err);
      } finally {
        this.pending--;
      }
      if (this.eps.get(stamp)) this.changed();
    })();
    return undefined;
  }
}
