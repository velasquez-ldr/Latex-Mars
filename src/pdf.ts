/** Exportar a PDF: compila el documento con el LaTeX que haya instalado en el equipo. */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export interface PdfResult {
  ok: boolean;
  /** el PDF generado */
  pdf?: string;
  /** qué se ejecutó */
  tool?: string;
  /** primer error que da LaTeX, con su línea si la dice */
  error?: string;
  /** registro completo de la compilación (.log), si existe */
  log?: string;
  /** no hay ningún compilador de LaTeX en el equipo */
  missing?: boolean;
  /** el PDF se ha vuelto a componer (si no, ya estaba al día) */
  fresh?: boolean;
  /** causa conocida del error, en palabras, y la línea del preámbulo que lo arregla */
  hint?: string;
  fix?: string;
}

function run(cmd: string, args: string[], cwd: string, shell = false, env?: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, env, windowsHide: true, shell, maxBuffer: 64 * 1024 * 1024, timeout: 10 * 60 * 1000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, out: `${stdout}\n${stderr}` });
    });
  });
}

/** El programa está en el PATH. */
async function has(cmd: string): Promise<boolean> {
  const r = await run(process.platform === 'win32' ? 'where' : 'which', [cmd], process.cwd());
  return r.code === 0 && r.out.trim() !== '';
}

/** Motor que pide el documento: XeLaTeX o LuaLaTeX si usa fontspec, polyglossia o código Lua. */
export function engineFor(text: string): 'pdflatex' | 'xelatex' | 'lualatex' {
  const head = text.split('\\begin{document}')[0];
  if (/\\directlua|\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\b(luacode|luatexja)\b/.test(text)) return 'lualatex';
  if (/\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\b(fontspec|polyglossia|xeCJK|unicode-math)\b/.test(head)) return 'xelatex';
  return 'pdflatex';
}

/** Primer error del registro de LaTeX («! Undefined control sequence.» y la línea «l.42 ...»). */
export function firstError(log: string): string | undefined {
  const lines = log.split(/\r?\n/);
  // con -file-line-error el error viene como «./archivo.tex:53: mensaje», sin el signo de admiración
  const fle = lines.findIndex((l) => /^(?:[A-Za-z]:)?[^:\n]*\.[A-Za-z]{2,5}:\d+: /.test(l));
  const bang = lines.findIndex((l) => l.startsWith('!'));
  if (fle >= 0 && (bang < 0 || fle < bang)) {
    const m = /^((?:[A-Za-z]:)?[^:\n]*):(\d+): (.*)$/.exec(lines[fle]) as RegExpExecArray;
    // TeX parte las líneas del registro a los 79 caracteres: el mensaje puede seguir en la siguiente
    const more = lines[fle].length >= 79 && lines[fle + 1] && !/^l\.\d+/.test(lines[fle + 1]) ? lines[fle + 1] : '';
    const where = lines.slice(fle + 1, fle + 12).find((l) => /^l\.\d+/.test(l));
    const what = where ? /^l\.\d+\s*(.*)$/.exec(where)?.[1].trim().slice(-60) : '';
    const file = m[1].replace(/^\.[\\/]/, '');
    return `${(m[3] + more).trim()} (${file}, línea ${m[2]}${what ? `: ${what}` : ''})`;
  }
  const at = bang;
  if (at < 0) return undefined;
  const where = lines.slice(at + 1, at + 12).find((l) => /^l\.\d+/.test(l));
  const line = where ? / ?^l\.(\d+)\s*(.*)$/.exec(where) : null;
  return `${lines[at].replace(/^!\s*/, '')}${line ? ` (línea ${line[1]}: ${line[2].trim().slice(0, 60)})` : ''}`;
}

/**
 * La orden propia del usuario, con %DOC% cambiado por la variable de entorno MARS_DOC. La ruta del
 * documento no se pega en la orden: un nombre de archivo con comillas, `$` o `;` no puede romperla
 * ni hacer que el shell ejecute otra cosa.
 */
export function customCommand(command: string, platform: NodeJS.Platform = process.platform): string {
  return command.replace(/%DOC%/g, platform === 'win32' ? '"%MARS_DOC%"' : '"$MARS_DOC"');
}

/**
 * Compila `file`. `custom` es la orden que haya puesto el usuario en los ajustes (con %DOC% donde va
 * el archivo); si está vacía se usa latexmk, tectonic o el motor que pida el documento, lo que haya.
 */
export async function compilePdf(file: string, text: string, custom = ''): Promise<PdfResult> {
  const dir = path.dirname(file);
  const base = path.basename(file, path.extname(file));
  const pdf = path.join(dir, `${base}.pdf`);
  const logFile = path.join(dir, `${base}.log`);
  const before = fs.existsSync(pdf) ? fs.statSync(pdf).mtimeMs : 0;
  let tool: string;
  let result: { code: number; out: string };
  if (custom.trim()) {
    tool = custom.trim();
    result = await run(customCommand(tool), [], dir, true, { ...process.env, MARS_DOC: file });
  } else {
    const engine = engineFor(text);
    const name = path.basename(file);
    if (await has('latexmk')) {
      tool = 'latexmk';
      result = await run('latexmk', [engine === 'pdflatex' ? '-pdf' : engine === 'xelatex' ? '-xelatex' : '-lualatex', '-interaction=nonstopmode', '-file-line-error', '-synctex=1', name], dir);
    } else if (await has('tectonic')) {
      tool = 'tectonic';
      // (con --synctex el PDF queda enlazado con el documento, como con los demás motores)
      result = await run('tectonic', ['--synctex', name], dir);
    } else if (await has(engine)) {
      tool = engine;
      const args = ['-interaction=nonstopmode', '-file-line-error', '-synctex=1', name];
      result = await run(engine, args, dir);
      // segunda pasada (y bibliografía si la hay) para índices, referencias y citas
      if (result.code === 0) {
        if (/\\bibliography\s*\{/.test(text) && (await has('bibtex'))) await run('bibtex', [base], dir);
        else if (/\\addbibresource\s*\{/.test(text) && (await has('biber'))) await run('biber', [base], dir);
        await run(engine, args, dir);
        result = await run(engine, args, dir);
      }
    } else return { ok: false, missing: true };
  }
  const log = fs.existsSync(logFile) ? logFile : undefined;
  const fresh = fs.existsSync(pdf) && fs.statSync(pdf).mtimeMs > before;
  // (sin cambios desde la última vez, latexmk no rehace nada: el PDF que hay es el bueno)
  if (result.code === 0 && fs.existsSync(pdf)) return { ok: true, pdf, tool, log, fresh };
  let error: string | undefined;
  try {
    error = log ? firstError(fs.readFileSync(log, 'latin1')) : undefined;
  } catch {
    // sin registro legible: se enseña la salida del programa
  }
  error ??= firstError(result.out) ?? result.out.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' · ').slice(0, 300);
  const hint = hintFor(text, error);
  // (con errores leves LaTeX deja igualmente un PDF: se ofrece, avisando)
  return { ok: false, pdf: fresh ? pdf : undefined, tool, error, log, ...hint };
}

/** Causas conocidas de un error, con la línea del preámbulo que lo arregla. */
export function hintFor(text: string, error: string): { hint?: string; fix?: string } {
  const head = text.split('\\begin{document}')[0];
  // babel en español convierte < y > en órdenes: las flechas de TikZ (->, <-) dejan de entenderse
  const spanish = /\\usepackage\s*\[[^\]]*\b(spanish|es-[a-z]+)\b[^\]]*\]\s*\{babel\}/.test(head) && !/es-noshorthands|es-noquoting|\\usetikzlibrary\s*\{[^}]*\bbabel\b/.test(head);
  const tikz = /\\usepackage\s*(?:\[[^\]]*\])?\s*\{[^}]*\b(tikz|pgfplots|tikz-cd|circuitikz|forest|tcolorbox)\b/.test(head);
  if (spanish && tikz && /(->|<-|>|<)/.test(text.split('\\begin{document}')[1] ?? '') && /Missing|Argument of|Paragraph ended|Giving up|I do not know|Runaway|Extra|Undefined|Package (pgf|tikz)/i.test(error)) {
    return { hint: 'El documento usa babel en español junto con TikZ: babel cambia el significado de < y >, y las flechas (->) dejan de funcionar.', fix: '\\usetikzlibrary{babel}' };
  }
  return {};
}
