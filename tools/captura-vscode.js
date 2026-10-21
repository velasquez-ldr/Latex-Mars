// Captura de Mars dentro de un VS Code real (requiere haber compilado: npm run compile).
//   node tools/captura-vscode.js <nombre> [--tex ruta.tex] [--w 1500] [--h 950] [--theme "Default Light Modern"] [--steps pasos.json]
// `pasos.json` es una lista de acciones previas a la captura:
//   {"click": "selector"}  {"dbl": "selector"}  {"rclick": "selector"}  {"hover": "selector"}
//   {"key": "Control+B"}   {"type": "texto"}    {"wait": 500}           {"eval": "código JS en el webview"}
//   {"test": {"action": "cmd", "args": {"name": "ins-equation"}}}       (acciones internas del editor)
const fs = require('fs');
const path = require('path');
const { root, launch, openMars, click, point } = require('../out/test/ui/vscode');

const args = process.argv.slice(2);
const name = args[0] || 'vscode';
const opt = (flag, def) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : def);

(async () => {
  const tex = opt('--tex', path.join(root, 'ejemplo.tex'));
  const steps = opt('--steps') ? JSON.parse(fs.readFileSync(opt('--steps'), 'utf8')) : [];
  const out = path.join(root, 'tools', 'capturas');
  fs.mkdirSync(out, { recursive: true });
  // --dir carpeta --open archivo.tex: una copia de la carpeta entera (imágenes, .bib...), sin tocar la original
  const dir = opt('--dir');
  const files = {};
  if (dir) {
    // con sus subcarpetas (capítulos, imágenes), hasta tres niveles
    const take = (rel, depth) => {
      for (const f of fs.readdirSync(path.join(dir, rel))) {
        const sub = rel ? `${rel}/${f}` : f;
        const st = fs.statSync(path.join(dir, sub));
        if (st.isDirectory()) {
          if (depth < 3 && !/^(\.|node_modules$)/.test(f)) take(sub, depth + 1);
        } else if (/\.(tex|bib|png|jpe?g|gif|svg|sty|cls|eps|pdf)$/i.test(f) && (rel === '' ? !/\.pdf$/i.test(f) : true)) files[sub] = fs.readFileSync(path.join(dir, sub));
      }
    };
    take('', 0);
  } else files['documento.tex'] = tex === 'vacio' ? '' : fs.readFileSync(tex);
  // --work carpeta --open archivo.tex: se trabaja en esa misma carpeta, ya preparada (un repositorio git de prueba)
  const work = opt('--work');
  const v = await launch({
    ...(work ? { workDir: work } : { files }),
    open: dir || work ? opt('--open') : 'documento.tex',
    width: Number(opt('--w', 1500)),
    height: Number(opt('--h', 950)),
    theme: opt('--theme', 'Default Dark Modern'),
  });
  try {
    const frame = await openMars(v.win);
    await v.win.waitForTimeout(1200);
    for (const s of steps) {
      if (s.click) await click(frame, s.click);
      else if (s.dbl) await click(frame, s.dbl, { count: 2 });
      else if (s.rclick) await click(frame, s.rclick, { button: 'right' });
      else if (s.hover) {
        const p = await point(frame, s.hover);
        await v.win.mouse.move(p.x, p.y);
      } else if (s.rclickText || s.clickText) {
        // clic (o clic derecho) sobre una palabra del documento
        const word = s.rclickText || s.clickText;
        const outer = await (await frame.frameElement()).boundingBox();
        const p = await frame.evaluate((w) => {
          // sobre el texto corrido: una palabra puede ocupar varios nodos (puntos de división, formato)
          const walker = document.createTreeWalker(document.getElementById('root'), NodeFilter.SHOW_TEXT);
          const nodes = [];
          let all = '';
          for (let n = walker.nextNode(); n; n = walker.nextNode()) {
            nodes.push({ node: n, at: all.length });
            all += n.data;
          }
          const i = all.indexOf(w);
          if (i < 0) return null;
          const at = (pos, end) => {
            const hit = [...nodes].reverse().find((x) => (end ? x.at < pos : x.at <= pos)) || nodes[0];
            return [hit.node, pos - hit.at];
          };
          const r = document.createRange();
          r.setStart(...at(i, false));
          r.setEnd(...at(i + w.length, true));
          const b = r.getClientRects()[0] || r.getBoundingClientRect();
          const page = document.getElementById('page');
          const k = (parseFloat(page.style.getPropertyValue('zoom')) || 1) / (page.getBoundingClientRect().width / page.offsetWidth);
          return { x: (b.left + b.width / 2) * k, y: (b.top + b.height / 2) * k };
        }, word);
        if (!p) throw new Error(`no encuentro «${word}»`);
        await v.win.mouse.click(outer.x + p.x, outer.y + p.y, { button: s.rclickText ? 'right' : 'left' });
      } else if (s.key) await v.win.keyboard.press(s.key);
      else if (s.type) await v.win.keyboard.type(s.type, { delay: 15 });
      else if (s.eval) console.log('eval:', JSON.stringify(await frame.evaluate(s.eval)));
      else if (s.winEval) console.log('winEval:', JSON.stringify(await v.win.evaluate(s.winEval)));
      else if (s.test) await frame.evaluate((m) => window.postMessage({ type: 'test', id: Date.now(), ...m }, '*'), s.test);
      else if (s.shot) await v.win.screenshot({ path: path.join(out, `${s.shot}.png`) });
      await v.win.waitForTimeout(s.wait ?? 350);
    }
    const file = path.join(out, `${name}.png`);
    await v.win.screenshot({ path: file });
    console.log('captura:', file);
  } finally {
    await v.close();
  }
})().catch((e) => {
  console.error('ERROR', e);
  process.exit(1);
});
