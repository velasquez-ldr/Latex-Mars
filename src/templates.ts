/** Plantillas para documentos nuevos (galería que se ofrece cuando el archivo está vacío). */

const HEAD = `\\usepackage[utf8]{inputenc}
\\usepackage[spanish]{babel}
\\usepackage{amsmath, amssymb}
\\usepackage{graphicx}
\\usepackage{hyperref}`;

export const TEMPLATES: Record<string, string> = {
  blank: `\\documentclass[11pt, a4paper]{article}
${HEAD}
\\usepackage[margin=2.5cm]{geometry}

\\begin{document}

\\end{document}
`,
  article: `\\documentclass{article}
${HEAD}

\\title{Título del documento}
\\author{Autor}
\\date{\\today}

\\begin{document}

\\maketitle

\\section{Introducción}

Escribe aquí tu texto.

\\end{document}
`,
  report: `\\documentclass[12pt, a4paper]{report}
${HEAD}
\\usepackage[margin=2.5cm]{geometry}

\\title{Título del informe}
\\author{Autor}
\\date{\\today}

\\begin{document}

\\maketitle

\\begin{abstract}
Resumen del informe en unas pocas líneas.
\\end{abstract}

\\tableofcontents

\\chapter{Introducción}

Escribe aquí tu texto.

\\chapter{Desarrollo}

\\section{Primer apartado}

Contenido del apartado.

\\chapter{Conclusiones}

Conclusiones del trabajo.

\\end{document}
`,
  homework: `\\documentclass[11pt, a4paper]{article}
${HEAD}
\\usepackage[margin=2.5cm]{geometry}

\\title{Tarea 1}
\\author{Nombre del estudiante}
\\date{\\today}

\\begin{document}

\\maketitle

\\section*{Ejercicio 1}

Enunciado del ejercicio.

\\textbf{Solución.} Desarrollo de la solución:
\\[
  a^2 + b^2 = c^2
\\]

\\section*{Ejercicio 2}

Enunciado del ejercicio.

\\begin{enumerate}
  \\item Primer apartado.
  \\item Segundo apartado.
\\end{enumerate}

\\end{document}
`,
  letter: `\\documentclass[11pt, a4paper]{article}
${HEAD}
\\usepackage[margin=3cm]{geometry}
\\pagestyle{empty}

\\begin{document}

\\begin{flushright}
Ciudad, \\today
\\end{flushright}

\\noindent Nombre del destinatario \\\\
Cargo o institución \\\\
Dirección

\\bigskip

\\noindent Estimado/a señor/a:

Escribe aquí el cuerpo de la carta.

\\bigskip

\\noindent Atentamente,

\\bigskip

\\noindent Tu nombre

\\end{document}
`,
  thesis: `\\documentclass[12pt, a4paper]{report}
${HEAD}
\\usepackage[left=3cm, right=2.5cm, top=2.5cm, bottom=2.5cm]{geometry}

\\title{Título de la tesis}
\\author{Nombre del autor}
\\date{\\today}

\\begin{document}

\\maketitle

\\begin{abstract}
Resumen del trabajo: el problema, el método y los resultados principales, en un párrafo.
\\end{abstract}

\\tableofcontents

\\include{capitulos/introduccion}

\\include{capitulos/marco-teorico}

\\include{capitulos/metodologia}

\\include{capitulos/resultados}

\\include{capitulos/conclusiones}

\\bibliographystyle{plain}
\\bibliography{referencias}

\\end{document}
`,
};

/** Archivos que acompañan a una plantilla (los capítulos de una tesis), con su ruta junto al principal. */
export const TEMPLATE_FILES: Record<string, Record<string, string>> = {
  thesis: {
    'capitulos/introduccion.tex': `\\chapter{Introducción}

Presenta aquí el tema y por qué importa.

\\section{Planteamiento del problema}

Describe el problema que aborda el trabajo.

\\section{Objetivos}

\\begin{itemize}
  \\item Objetivo general.
  \\item Primer objetivo específico.
\\end{itemize}
`,
    'capitulos/marco-teorico.tex': `\\chapter{Marco teórico}

Resume lo que ya se sabe sobre el tema, citando las fuentes \\cite{knuth1984}.

\\section{Antecedentes}

Trabajos anteriores relacionados con este.
`,
    'capitulos/metodologia.tex': `\\chapter{Metodología}

Explica cómo se hizo el trabajo: datos, instrumentos y procedimiento.

\\section{Diseño}

Tipo de estudio y sus etapas.
`,
    'capitulos/resultados.tex': `\\chapter{Resultados}

Presenta lo que se obtuvo, con sus tablas y figuras.

\\section{Análisis}

Interpreta los resultados.
`,
    'capitulos/conclusiones.tex': `\\chapter{Conclusiones}

Lo que se concluye del trabajo y lo que queda por hacer.
`,
    'referencias.bib': `@book{knuth1984,
  author = {Knuth, Donald E.},
  title = {The {\\TeX}book},
  publisher = {Addison-Wesley},
  year = {1984}
}
`,
  },
};

/** Las plantillas, en el orden y con el texto con que se ofrecen al crear un documento. */
export const TEMPLATE_LIST: { id: string; label: string; detail: string }[] = [
  { id: 'blank', label: 'En blanco', detail: 'Solo el preámbulo básico en español' },
  { id: 'article', label: 'Artículo', detail: 'Título, secciones y texto' },
  { id: 'report', label: 'Informe', detail: 'Capítulos, resumen e índice' },
  { id: 'thesis', label: 'Tesis', detail: 'Un archivo por capítulo (carpeta capitulos/) y bibliografía en referencias.bib' },
  { id: 'homework', label: 'Tarea', detail: 'Ejercicios con solución' },
  { id: 'letter', label: 'Carta', detail: 'Fecha, destinatario y firma' },
];
