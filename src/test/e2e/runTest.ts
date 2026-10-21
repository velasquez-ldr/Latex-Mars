import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { downloadAndUnzipVSCode } from '@vscode/test-electron';
import { launch } from '../ui/vscode';

// Descarga un VS Code aparte, carga la extensión y ejecuta la suite dentro de él.
async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..', '..', '..');
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'mars-e2e-'));
  fs.copyFileSync(path.join(root, 'ejemplo.tex'), path.join(work, 'ejemplo.tex'));
  fs.writeFileSync(path.join(work, 'min.tex'), '\\documentclass{article}\n\\begin{document}\n\nHola\n\n\\end{document}\n');
  fs.writeFileSync(path.join(work, 'vacio.tex'), '');
  // «Empezar a escribir»: en un archivo vacío y en uno que tiene algo escrito pero no dibuja nada
  fs.writeFileSync(path.join(work, 'vacio2.tex'), '');
  fs.writeFileSync(path.join(work, 'comentario.tex'), '% notas sueltas\n');
  // lo que babel cambia en español y lo que solo se sabe al repartir en hojas (la página de \pageref)
  fs.writeFileSync(
    path.join(work, 'fiel.tex'),
    ['\\documentclass[a4paper]{article}', '\\usepackage[spanish]{babel}', '\\usepackage{hyperref}', '\\begin{document}', '',
      '\\section{Uno}\\label{sec:uno}', '',
      'Dijo <<hola>> y vale $3.14$; \\autoref{sec:dos} está en la página \\pageref{sec:dos} y \\autoref{sec:uno} en la \\pageref{sec:uno}.', '',
      '\\begin{itemize}', '  \\item Primero', '  \\begin{enumerate}', '    \\item Dentro', '  \\end{enumerate}', '\\end{itemize}', '',
      '\\newpage', '', '\\section{Dos}\\label{sec:dos}', '', 'Texto de la segunda hoja.', '', '\\end{document}', ''].join('\n'),
  );
  // documento de varias hojas, con párrafos y una lista que no caben en una sola
  const para = 'Este es un párrafo largo de prueba para comprobar cómo se reparte el texto entre dos hojas cuando no cabe entero en la primera. '.repeat(9).trim();
  const items = Array.from({ length: 14 }, (_, i) => `  \\item Elemento número ${i + 1} de una lista que también puede partirse entre hojas.`).join('\n');
  // un párrafo corto delante del último de la primera hoja: así este queda a medias, partido entre dos
  const short = para.split('. ').slice(0, 4).join('. ') + '.';
  fs.writeFileSync(
    path.join(work, 'largo.tex'),
    ['\\documentclass[a4paper]{article}', '\\usepackage[spanish]{babel}', '\\usepackage[margin=2.54cm]{geometry}', '\\begin{document}', '',
      '\\section{Primera sección}', '', para, '', para, '', '\\begin{itemize}', items, '\\end{itemize}', '', short, '', para, '',
      '\\section{Segunda sección}', '', para, '', '\\end{document}', ''].join('\n'),
  );
  // encabezado y pie con fancyhdr, notas al pie y una figura que no cabe donde está
  const sentence = para.split('. ')[0] + '. ';
  fs.writeFileSync(
    path.join(work, 'muebles.tex'),
    ['\\documentclass[a4paper]{article}', '\\usepackage[spanish]{babel}', '\\usepackage[margin=2.54cm]{geometry}', '\\usepackage{fancyhdr}',
      '\\pagestyle{fancy}', '\\fancyhf{}', '\\fancyhead[L]{Mi tesis}', '\\fancyhead[R]{\\leftmark}', '\\fancyfoot[C]{Página \\thepage\\ de \\pageref{LastPage}}',
      '\\begin{document}', '', '\\section{Primera sección}', '',
      sentence.repeat(4).trim() + '\\footnote{Primera nota al pie, corta.} ' + sentence.repeat(4).trim(), '', para, '',
      para + '\\footnote{Segunda nota, bastante más larga para que ocupe dos líneas al fondo de la hoja y se vea cómo le quita sitio al texto de su página.}', '',
      '\\begin{figure}[ht]', '\\centering', '\\vspace{7cm}', 'FIGURA', '\\caption{Una figura alta que no cabe al pie de la primera hoja}', '\\end{figure}', '',
      para, '', '\\subsection{Un apartado}', '', para + '\\footnote{Tercera nota.}', '',
      '\\section{Segunda sección}', '', para, '', para, '', para, '', '\\end{document}', ''].join('\n'),
  );
  // numeración romana para el índice, arábiga después, y una hoja sin encabezado ni pie
  fs.writeFileSync(
    path.join(work, 'romanos.tex'),
    ['\\documentclass{article}', '\\begin{document}', '', '\\pagenumbering{roman}', '\\tableofcontents', '\\newpage', '', 'Prólogo.', '\\newpage', '',
      '\\pagenumbering{arabic}', '\\section{Uno}', '', 'Texto.', '\\newpage', '', '\\thispagestyle{empty}', 'Hoja sin número.', '\\newpage', '', 'Última.', '', '\\end{document}', ''].join('\n'),
  );
  // una figura con su imagen, entre dos párrafos
  fs.writeFileSync(
    path.join(work, 'imagen.tex'),
    ['\\documentclass{article}', '\\usepackage{graphicx}', '\\begin{document}', '', para, '',
      '\\begin{figure}[h]', '  \\centering', '  \\includegraphics[width=0.5\\textwidth]{img/pixel.png}', '  \\caption{Un píxel}', '\\end{figure}', '', para, '', '\\end{document}', ''].join('\n'),
  );
  // portada con espacio elástico, índice y texto
  fs.writeFileSync(
    path.join(work, 'portada.tex'),
    ['\\documentclass[12pt]{article}', '\\usepackage[spanish]{babel}', '\\usepackage[margin=2.54cm]{geometry}', '\\begin{document}', '',
      '\\begin{titlepage}', '\\centering', '{\\LARGE\\bfseries TÍTULO DEL TRABAJO}', '', '\\vfill', '', '{\\large Ciudad, 2026}', '', '\\vspace{0.03\\textheight}', '\\end{titlepage}', '',
      '\\tableofcontents', '\\newpage', '', '\\section{Introducción}', '', 'Texto de la introducción.', '', '\\end{document}', ''].join('\n'),
  );
  // documento que cita por autor y año (natbib) las fuentes de un archivo .bib
  fs.writeFileSync(
    path.join(work, 'autores.tex'),
    ['\\documentclass[12pt]{article}', '\\usepackage[spanish]{babel}', '\\usepackage{natbib}', '\\bibliographystyle{apalike}', '\\begin{document}', '',
      'El modelo relacional \\citep{codd1970} y su optimización, según \\citet{selinger1979}.', '', '\\bibliography{autores}', '', '\\end{document}', ''].join('\n'),
  );
  fs.writeFileSync(
    path.join(work, 'autores.bib'),
    '@article{codd1970,\n  author = {Codd, E. F.},\n  title = {A relational model of data for large shared data banks},\n  journal = {Communications of the ACM},\n  year = {1970}\n}\n' +
      '@inproceedings{selinger1979,\n  author = {Selinger, P. Griffiths and Astrahan, M. M. and Chamberlin, D. D.},\n  title = {Access path selection},\n  booktitle = {SIGMOD},\n  year = {1979}\n}\n' +
      '@book{elmasri2016,\n  author = {Elmasri, Ramez and Navathe, Shamkant B.},\n  title = {Fundamentals of Database Systems},\n  publisher = {Pearson},\n  year = {2016}\n}\n',
  );
  // un título empujado hacia el final de la hoja, seguido de un párrafo
  fs.writeFileSync(
    path.join(work, 'pie.tex'),
    ['\\documentclass[a4paper]{article}', '\\usepackage[margin=2.54cm]{geometry}', '\\begin{document}', '', '\\vspace{20cm}', '',
      '\\section{Título al pie}', '', para, '', '\\end{document}', ''].join('\n'),
  );
  fs.mkdirSync(path.join(work, 'img'));
  // PNG de 1x1 y PDF mínimo de una página (200x100 pt) para las pruebas de imágenes
  fs.writeFileSync(
    path.join(work, 'img', 'pixel.png'),
    Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'),
  );
  fs.writeFileSync(
    path.join(work, 'img', 'grafico.pdf'),
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R>>endobj\n' +
      '4 0 obj<</Length 27>>stream\n1 0 0 rg 20 20 160 60 re f\nendstream endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n',
  );
  fs.writeFileSync(
    path.join(work, 'figuras.tex'),
    [
      '\\documentclass{article}',
      '\\usepackage{tikz}',
      '\\usepackage{pgfplots}',
      '\\usepackage{graphicx}',
      '\\usetikzlibrary{arrows.meta}',
      '\\tikzset{caja/.style={draw, thick}}',
      '\\begin{document}',
      '',
      '\\begin{tikzpicture}',
      '  \\node[caja] (a) at (0,0) {Tierra};',
      '  \\node[caja] (b) at (3,0) {Marte};',
      '  \\draw[-Stealth] (a) -- (b);',
      '\\end{tikzpicture}',
      '',
      '\\begin{tikzpicture}',
      '  \\begin{axis}[xlabel=$x$]',
      '    \\addplot[domain=-2:2]{x^2};',
      '  \\end{axis}',
      '\\end{tikzpicture}',
      '',
      '\\includegraphics[width=0.5\\textwidth]{img/grafico}',
      '',
      '\\end{document}',
      '',
    ].join('\n'),
  );
  // documento con la bibliografía en un archivo .bib aparte
  fs.writeFileSync(
    path.join(work, 'biblio.tex'),
    ['\\documentclass{article}', '\\begin{document}', '', 'Un texto con citas.', '', '\\bibliographystyle{plain}', '\\bibliography{refs}', '', '\\end{document}', ''].join('\n'),
  );
  fs.writeFileSync(path.join(work, 'refs.bib'), '@book{knuth1984,\n  author = {Knuth, Donald E.},\n  title = {The {\\TeX}book},\n  year = {1984}\n}\n');
  // Al lanzarlo desde un terminal de VS Code esta variable haría que Code.exe arrancase como Node.
  delete process.env.ELECTRON_RUN_AS_NODE;
  await downloadAndUnzipVSCode();
  let code: number | null = 1;
  try {
    // la misma lanzadera que las pruebas de interfaz: ventana fuera de la pantalla y perfil limpio
    const v = await launch({
      workDir: work,
      extraArgs: [`--extensionTestsPath=${path.join(__dirname, 'suite')}`],
      env: { MARS_E2E_DIR: work, MARS_E2E_ONLY: process.env.MARS_E2E_ONLY ?? '' },
    });
    const child = v.app.process();
    child.stdout?.on('data', (d) => process.stdout.write(d));
    child.stderr?.on('data', (d) => process.stderr.write(d));
    // VS Code se cierra solo al terminar la suite, con el resultado como código de salida
    code = await new Promise<number | null>((resolve) => child.once('exit', (c) => resolve(c)));
    await v.close();
  } finally {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
  }
  if (code !== 0) throw new Error(`La suite de integración terminó con código ${code}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
