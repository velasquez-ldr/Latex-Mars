# Cambios

## 0.30.5

- **«Ver en el PDF» más preciso**: además del párrafo, el visor señala la palabra exacta donde está el cursor y marca su posición.
  - El párrafo se resalta entero, línea a línea y con su ancho real, en lugar de una franja de una sola línea a todo el ancho de la página.
  - Se busca la línea del código en que está el cursor, no la primera del párrafo.
  - La palabra se encuentra aunque el PDF parta palabras con guion, pierda tildes o ligaduras como «fi» (con las fuentes por defecto de pdflatex).

## 0.30.4

- Con MiKTeX, la compilación ya no se queda colgada: latexmk y el motor se lanzan con `--enable-installer`, así los paquetes que falten se instalan solos en lugar de abrir una ventana «Package Installation» oculta que esperaba un clic.

## 0.30.3

- Si también falla el motor LaTeX alternativo, Mars muestra ese error junto con el del compilador preferido.

## 0.30.2

- Si `latexmk` o `tectonic` no pueden compilar, Mars intenta el motor LaTeX que requiere el documento, con pasadas adicionales para las referencias y la bibliografía.
- La notificación del PDF indica cuándo se usó ese motor como alternativa.

## 0.30.1

- **Presentación automática 16:9**: el panel lateral tiene una tercera cara, **Presentación**,
  para elegir qué apartados presentar y qué llevan (idea clave de cada párrafo o el párrafo
  entero, listas, figuras, tablas, ecuaciones, portada, índice y cierre) con estilo claro,
  oscuro o azul. Vista → **Presentar** la proyecta **a pantalla completa**, como PowerPoint (modo
  zen sin barras, pestañas ni barra de título; al salir, la ventana vuelve a como estaba):
  viñetas, figura al lado, tablas en su diapositiva, autoajuste del texto, vista general (G),
  pantalla en negro (B). No cambia el documento. La **portada** (título, subtítulo, autor,
  institución y fecha) y el **cierre** (título, subtítulo y contacto) se personalizan con el
  lápiz ✎ de cada uno, con vista previa.
- **Panel de referencias**: tras ir a una cita, **quitar esa cita** del texto (y solo esa) sin
  tocar la bibliografía; el «2 de 3» ya no se pierde al redibujar; **orden** de la lista (como en
  la bibliografía, por clave, más citadas, sin citar primero); las citas comentadas con `%` ya
  no cuentan.
- **Esquema**: los títulos con otros debajo se pliegan; **Plegar todo** / **Desplegar todo**.
- El panel lateral ya no salta al principio de la lista cada vez que se redibuja.
- Pruebas: la de la cinta esperaba la pestaña Insertar sin el grupo «Encabezado y pie».

## 0.30.0

Primera versión publicada en el Marketplace.

- Nuevo nombre: **LaTeX Mars**, con icono propio.
- Licencia MIT.
- La orden propia de PDF (`mars.pdf.command`) recibe el documento por la variable de entorno
  `MARS_DOC`: una ruta con comillas, `$` o `;` ya no puede romperla.

## 0.29.0

- **Viñetas por niveles**: el menú de viñetas dice en qué nivel está el cursor y marca su
  símbolo. **Lista multinivel**: viñetas de LaTeX, formas, flechas, esquema (1. a) i) A.),
  numeración por niveles (1. / 1.1. / 1.1.1.) y romanos, aplicados a todos los niveles a la vez.
- Los botones de sangría ⇤ ⇥ suben y bajan de nivel dentro de una lista.
- La numeración por niveles (`\arabic{enumi}.\arabic*.`) se dibuja como en el PDF.
- Corregido: la viñeta ■ no añadía el paquete `amssymb`.

## 0.28.1

- Al editar una hoja horizontal, la hoja apaisada queda centrada sobre la vertical y en el centro
  de la vista.

## 0.28.0

- **Encabezado y pie de página**: se escriben desde Mars (Insertar → Encabezado / Pie, o doble
  clic en el margen de una hoja), con tres casillas arriba y abajo, rayas y vista previa.
  Insertar → Número coloca el número de página o lo quita. Se escribe con `fancyhdr`.
- Un `\pagestyle` dentro de un entorno solo vale en él, como en LaTeX (antes podía dejar todo el
  documento sin números de página).
- Al editar una hoja horizontal se ve la hoja apaisada entera, a tamaño real.
- Listas: `Enter` al final de un elemento con sublista deja el cursor en el elemento nuevo; en un
  elemento vacío de una sublista sube un nivel; ya no quedan `\\` sueltos en el código.
- En español, la letra del segundo nivel numerado va en cursiva, como con babel.

## 0.27.0

- Las preferencias de la vista (papel, zoom, vista de página o continua, cinta minimizada,
  colores recientes) valen para todos los documentos y se recuerdan.
- Con un editor visual abierto, los demás `.tex` que se abren se muestran también en él
  (ajuste `mars.openInVisualEditor`).

## 0.26.1

- Hojas horizontales: por defecto se ven giradas como en el PDF y se ponen derechas al editarlas.

## 0.26.0

- **Hojas horizontales** (`\begin{landscape}`): en hoja propia, como en LaTeX, y con la opción de
  verlas giradas o derechas (ajuste `mars.landscapePages`). Insertar una hoja horizontal y pasar
  de `lscape` a `pdflscape` desde Disposición → Orientación.
- Las órdenes de `eso-pic` no se dibujan como código.
