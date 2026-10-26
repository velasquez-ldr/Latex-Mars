# LaTeX Mars

Editor visual (WYSIWYM) de LaTeX para VS Code. Abre un `.tex`, escribe sobre el documento ya
maquetado como en un procesador de textos y Mars mantiene el código LaTeX al día. No compila
nada ni necesita una instalación de LaTeX: el archivo `.tex` es siempre la única fuente de verdad.

## Uso

1. Abre un archivo `.tex`.
2. Pulsa el botón ▶ de arriba a la derecha, `Ctrl+K V`, o el comando
   **Mars: Abrir editor visual al lado**.
3. Haz clic en cualquier texto y escribe.

Para empezar de cero, el comando **Mars: Nuevo documento (plantillas)** (también en
*Archivo → Nuevo archivo…* y en el menú contextual de una carpeta del explorador) pregunta la
plantilla —en blanco, artículo, informe, tesis, tarea o carta— y dónde guardarlo, crea el `.tex` y
lo abre ya en el editor visual. La **tesis** se crea como un proyecto de varios archivos: el
principal, un `.tex` por capítulo en la carpeta `capitulos/` y `referencias.bib`.

Si quieres que los `.tex` se abran siempre así, sin pasar por el código, usa **Mars: Abrir siempre
los .tex con el editor visual** (la misma orden lo deshace).

Con un editor visual abierto, los demás `.tex` que abras (desde el explorador, la búsqueda o
`Ctrl+P`) se muestran también en el editor visual: en su columna si tienes el código y Mars lado a
lado (el código del nuevo queda a su izquierda, como con ▶), o en lugar del código si Mars está
solo. Las pestañas de código que ya tenías abiertas, «Volver a abrir con → Editor de texto» y el
código que abre Mars (ir a una línea) no se tocan. Se desactiva con `mars.openInVisualEditor`.

### Cambios e historial (git)

Si el documento está en un repositorio de git, el botón <kbd>⇄</kbd> de la barra de estado abre a
la derecha el panel **Cambios**:

- **Barras al margen**: cada párrafo, título, tabla o figura que ha cambiado lleva una barra a su
  izquierda —verde si es nuevo, azul si está modificado— y un triángulo rojo donde se borró algo.
- **Qué cambió**: un clic en la barra (o en la lista del panel) muestra el detalle, con lo quitado
  tachado y lo añadido resaltado, y un botón para **restaurar** ese tramo como estaba. Restaurar
  es una edición normal: se deshace con `Ctrl+Z`.
- **Historial**: la lista de commits que tocaron el documento. Por defecto se compara con el
  último; al elegir otro se marca todo lo que ha cambiado desde entonces.
- **Ver una versión**: el ojo de cada commit abre el documento maquetado tal como estaba, en solo
  lectura, con las marcas de lo que cambió en ese commit.

- **Commit desde el panel**: con cambios sin confirmar aparece un cuadro para el mensaje y el
  botón «Hacer commit», que guarda el documento (y, si se marca, los demás `.tex` y `.bib` del
  proyecto que hayan cambiado). Esos otros archivos se listan y se abren con un clic.

El detalle compara el texto que se lee (sin las órdenes de LaTeX); si solo cambió el formato,
enseña el código. Una versión antigua se dibuja con los capítulos, la bibliografía y las imágenes
que tenía entonces. Hace falta tener git instalado; cambiar de rama o resolver conflictos sigue
siendo cosa del panel de control de código fuente de VS Code.

### Exportar a PDF

El botón de PDF de la cinta (o **Mars: Exportar a PDF**) guarda el documento, lo compila con el
LaTeX que haya instalado —`latexmk`, `tectonic` o, si no, el motor que pida el documento
(pdfLaTeX, XeLaTeX con `fontspec`, LuaLaTeX con código Lua), con sus pasadas y la bibliografía— y
abre el PDF al lado, en un visor propio. Desde un capítulo compila el documento principal.

El visor está enlazado con el documento (SyncTeX): el botón de la diana, junto al de PDF, lleva el
visor al párrafo donde está el cursor y lo resalta; y un **doble clic en el PDF** abre en Mars el
párrafo correspondiente (en su archivo, si es de otro capítulo). Si todavía no hay PDF, o has
escrito después de crearlo, la diana lo vuelve a componer antes de ir al párrafo; si no ha
cambiado nada, se usa el que hay sin esperar. El visor solo pinta las páginas que tienes a la
vista, así que un documento largo abre igual de rápido.

Si LaTeX da un error se muestra el primero, con su archivo y su línea, y se puede abrir el
registro; si aun así dejó un PDF, se enseña avisando de que puede faltar algo. Para el choque
más habitual en documentos en español —`babel` con las flechas de TikZ (`->`)— Mars lo dice en
palabras y ofrece el arreglo con un botón (añade `\usetikzlibrary{babel}` y vuelve a
compilar). Mars sigue sin necesitar LaTeX para editar; solo hace falta para este paso. El ajuste
`mars.pdf.command` permite fijar la orden.

### Avisos del documento

En la barra de estado aparece «N avisos» cuando hay algo que LaTeX señalaría al compilar:
referencias a etiquetas que no existen, citas sin fuente, etiquetas repetidas e imágenes que no
se encuentran. Un clic abre la lista y cada aviso lleva a su sitio.

### Proyectos de varios archivos

Con el documento repartido en capítulos (`\input`, `\include`):

- En el **documento principal**, cada capítulo se ve en su sitio, numerado, con una etiqueta con
  el nombre de su archivo: un clic en ella lo abre para editarlo. Ahí se muestra entero pero no
  se edita (ni se reparte bien entre hojas): para trabajar en él, ábrelo.
- Un **capítulo abierto por separado** no tiene preámbulo propio, así que Mars busca su documento
  principal (el `.tex` de su carpeta, o de las dos de encima, que lo incluye; o el que diga un
  comentario `% !TEX root = ../tesis.tex`) y lo dibuja con él: mismos márgenes, letra e idioma,
  sus macros, y la numeración que le toca («Capítulo 3», sección 3.2, figuras y ecuaciones que
  siguen la cuenta). Las referencias a etiquetas de otros capítulos y las citas de la bibliografía
  común se resuelven. La barra de estado indica «Parte de tesis.tex» y lleva a él. Las hojas se
  numeran desde 1: el número de página real depende de los capítulos anteriores.
- Las rutas de imágenes y de la bibliografía se toman desde la carpeta del principal, como hace
  LaTeX. Si un formato necesita un paquete (un color, un subrayado), el `\usepackage` se añade al
  preámbulo del principal; los cambios de la pestaña Disposición también se escriben allí.

### La cinta de opciones

| Pestaña | Qué contiene |
| --- | --- |
| **Inicio** | Fuente (cuadros de **tipo de letra** y de **tamaño en puntos**, agrandar y reducir, negrita, cursiva, subrayado, tachado, super/subíndice, versalitas, color), párrafo (listas, alineación), galería de estilos (Normal, Título 1–3, Capítulo) y ecuación |
| **Insertar** | Portada y salto de página, tabla (cuadrícula para elegir el tamaño), imagen, dibujos TikZ de plantilla, enlace, referencia, cita textual, código, nota al pie, ecuaciones (galería de fórmulas habituales) y símbolos |
| **Disposición** | Márgenes, orientación, tamaño de papel, columnas, saltos, interlineado, tipo de documento, idioma y título. Se escribe en el preámbulo (`\documentclass`, `geometry`, `setspace`, `babel`) y la hoja del editor toma esas medidas |
| **Referencias** | Índice, índices de figuras y tablas, notas al pie, **fuentes y citas** (agrega una fuente a mano, a partir de su **DOI** o eligiéndola en **Zotero**; el menú «Insertar cita» lista las fuentes del documento o de su `.bib`), referencias cruzadas y etiquetas |
| **Revisar** | Buscar y reemplazar, control de cambios (aceptar o rechazar), comentarios al margen y corrector ortográfico |
| **Vista** | Vista de página o continua, zoom, ajustar al ancho, **varias páginas** e ir al código |
| **Tabla** | Aparece al situarse en una tabla: añadir y eliminar filas y columnas, alinear, bordes y combinar o dividir celdas |
| **Imagen** | Aparece al hacer clic en una imagen: alinearla, rodearla de texto, ancho y alto, medidas exactas, girarla y recortarla |

Si el panel es estrecho, la cinta se compacta y aparecen flechas en sus bordes para desplazarla
(también vale la rueda del ratón).

**Minimizar la cinta**, como en Word: la flecha **˄** del extremo derecho de las pestañas, un
**doble clic en cualquier pestaña** o `Ctrl+F1` dejan solo la fila de pestañas, y el documento
gana ese espacio. Con la cinta minimizada, pulsar una pestaña despliega sus botones sobre el
documento un momento: al usar uno, o al hacer clic fuera, se recogen. Lo mismo la vuelve a
mostrar entera. Mars recuerda cómo la dejaste.

**Color del texto** (Inicio): la paleta trae los diez colores del tema con cinco tonos de cada
uno, los diez colores estándar, los últimos que hayas usado y «Más colores…», para elegir
cualquiera o escribir su código. En el `.tex` queda `\textcolor{red}{…}` cuando el color tiene
nombre en `xcolor` y `\textcolor[HTML]{1F4E79}{…}` cuando no.

### Edición como en un procesador de textos

- **Párrafo** (Inicio): interlineado propio de un párrafo (`spacing`, de `setspace`), aumentar y
  reducir su sangría (`adjustwidth`, de `changepage`), y el símbolo de las viñetas o el formato
  de la numeración de una lista (`enumitem`: ○, –, ✓, a), (a), I. …).
- **Copiar formato** (el bote de pintura de Inicio): recoge el formato del texto donde está el
  cursor y se lo da a lo siguiente que selecciones. `Esc` lo suelta.
- **Estilos propios** (menú Estilos): «Crear un estilo con el formato del cursor» guarda ese
  formato como una orden nueva en el preámbulo (`\newcommand{\destacado}[1]{…}`) y la añade al
  menú. El texto con un estilo propio se ve con su formato y se sigue editando en sitio.
- **Buscar y reemplazar** (`Ctrl+H` o Revisar → Buscar): cuenta y resalta las coincidencias en
  el texto del documento (no en fórmulas ni código) y reemplaza una o todas; reemplazar todas es
  un solo paso de deshacer. `Ctrl+F` sigue abriendo el buscador de VS Code.
- **Control de cambios** (Revisar → Control): mientras está activado, lo que escribes queda como
  `\added{…}` y lo que borras como `\deleted{…}` (paquete `changes`), a la vista en verde y en
  rojo tachado. «Aceptar» y «Rechazar» resuelven todos los cambios del documento de una vez.
- **Comentarios** (Revisar → Comentario): una nota al margen (`\todo{…}`, de `todonotes`) a la
  altura de su línea. En un panel estrecho, sin margen a la vista, se muestra entre el texto.
- **Estilos de tabla** (Tabla → Estilos): cambian de una vez las líneas, los bordes y el
  sombreado de toda la tabla. Cuadrícula, sin bordes, profesional (tres líneas, con `booktabs`),
  líneas horizontales, encabezado sombreado y filas alternas (`\rowcolor`, con `colortbl`).
- **Tablas**: combinar una celda con la de su derecha (`\multicolumn`) o con la de debajo
  (`\multirow`), dividirla, arrastrar el borde derecho de una celda para fijar el ancho de su
  columna (`p{3cm}`), y pegar celdas copiadas de una hoja de cálculo: dentro de una tabla
  rellenan sus celdas desde la del cursor; fuera, crean una tabla.
- **Imágenes**: izquierda, centro o derecha; con el texto rodeándola (`wrapfigure`), y recorte
  por cada lado en porcentaje (`trim` y `clip`).

### Imágenes

- **Insertar**: Insertar → Imagen (o `/imagen`, o el botón derecho) abre el selector de archivos
  y pregunta el ancho y el pie. Una imagen que está en otra carpeta se copia a `img/`, junto al
  documento, para que este no dependa de una ruta de tu equipo.
- **Pegar con `Ctrl+V`**: una captura de pantalla, una imagen copiada de la web o de otro programa
  se guarda en `img/` y se inserta como figura, haya o no un párrafo en edición.
- **Arrastrar** un archivo de imagen sobre el documento (en VS Code, con `Mayús` al soltar).
- **Botón derecho sobre una imagen**: copiar, cortar, pegar, alinear, rodear de texto, recortar,
  cambiar el archivo (conserva tamaño y pie), editar su código y eliminar. Sobre el texto, el
  menú ofrece cortar, copiar, pegar, insertar imagen y buscar.
- **Copiar imagen** deja en el portapapeles la imagen (para pegarla en cualquier programa) y su
  código LaTeX (pegada de vuelta en Mars sale la misma figura, sin duplicar el archivo).
- **Tamaño con el ratón**: arrastra su borde derecho para cambiar el ancho, o el de abajo para
  cambiar el alto (`height=3.2cm`; el ancho queda proporcional). Mientras arrastras, una
  etiqueta enseña las medidas.
- **Tamaño desde la pestaña Imagen**:
  - **Ancho ▾**: 25, 33, 50, 66, 75 o 100 % del ancho del texto (`width=0.5\textwidth`).
  - **Alto ▾**: 10 a 75 % del alto del texto (`height=0.25\textheight`).
  - **Medidas**: ancho y alto exactos en %, cm, mm, pulgadas o puntos; con los dos a la vez,
    «encajar sin deformar» añade `keepaspectratio`. También la escala (`scale=0.5`) y el giro.
  - **Original**: quita ancho, alto y escala; **Girar**: 90° más cada vez (`angle=90`).

  Al cambiar el ancho, el alto pasa a ser el proporcional (y al revés), así que la imagen no se
  deforma; lo demás que tuviera `\includegraphics` (recorte, página de un PDF…) se conserva. En
  un bloque con varias imágenes (subfiguras) se cambia la que hayas pulsado, y dentro de una
  subfigura o una minipágina el porcentaje se refiere a su ancho (`\linewidth`).

### Panel de referencias

El panel lateral tiene tres caras: **Esquema** (los títulos, que se pueden plegar),
**Referencias** y **Presentación** (ver más abajo). La de referencias se abre
también con Referencias → **Gestionar**, y lista todas las fuentes del documento: las de su
archivo `.bib` o, si no usa uno, los `\bibitem` de su lista.

- Cada fuente muestra su clave, autor, título y año, y **cuántas veces se cita**; las que no se
  citan salen atenuadas y el resumen dice cuántas son.
- **Buscador** por autor, título o clave (sin distinguir tildes ni mayúsculas).
- Un clic en una fuente lleva a su cita en el documento y la resalta. Si se cita varias veces,
  **cada clic lleva a la siguiente** (el panel dice «2 de 3») y tras la última vuelve a la primera.
- **Quitar esta cita**: tras ir a una cita, el botón ⊘ de la fuente la quita del texto, solo esa
  (en `\cite{a, b}` se queda `\cite{b}`), sin tocar la bibliografía. Se deshace con `Ctrl+Z`.
- **Orden** de la lista: como en la bibliografía, por clave, más citadas o sin citar primero.
- Al pasar el ratón aparecen sus acciones: **citarla** donde está el cursor, **editarla** (la
  entrada tal cual está escrita) y **quitarla**, que pide confirmación en el propio panel y
  avisa si se está citando.
- Arriba, **Añadir** (escribiendo sus datos), **DOI** y **Zotero**.
- Al final, las **citas sin referencia**: claves que se citan pero no están en la bibliografía.

Los cambios se escriben en el `.bib` (y se guarda) o en la lista del documento.

### Presentación

Convierte el documento en una presentación 16:9, como las de PowerPoint, sin escribir nada más:
Vista → **Presentar**, o la cara **Presentación** del panel lateral (Vista → **Elegir**).

- **Qué apartados**: una casilla por título; al quitar uno se van con él los que cuelgan de él.
  **Todos** / **Ninguno**, y ▶ junto a cada apartado para empezar desde ahí.
- **Texto de cada párrafo**: la **idea clave** (su primera frase, como viñeta), el párrafo
  **completo** o **nada** (solo títulos, listas, figuras, tablas y ecuaciones).
- **Incluir**: listas, figuras, tablas y ecuaciones.
- **Inicio y final**: portada, índice y cierre. El lápiz ✎ junto a cada uno los personaliza, con
  vista previa: la **portada** (título, subtítulo, autor, institución o curso y fecha; lo que no se
  cambia sigue al `\title`, `\author` y `\date` del documento, y se guarda para cada documento) y
  el **cierre** (título, subtítulo y contacto; vale para todas las presentaciones).
- **Estilo**: claro, oscuro o azul (títulos sobre una banda de color, como Beamer).

Cada capítulo (o sección, en un artículo) con apartados debajo abre con su portadilla; las
viñetas se reparten de cinco en cinco; una figura con pocas viñetas va al lado, y las tablas
van en su propia diapositiva. Si algo no cabe, el texto se encoge.

Proyectando: `→`, espacio o clic para avanzar; `←` para volver; `Inicio`/`Fin`; **G** para la
vista general; **B** pantalla en negro; **Esc** para salir. Ocupa **toda la pantalla**, como en
PowerPoint: mientras dura, VS Code pasa al modo zen, sin barras, pestañas ni barra de título, y al
salir todo vuelve a como estaba (también el reparto de los editores). La presentación no cambia
el documento.

### Variables del documento

Muchos documentos guardan sus datos en órdenes propias sin argumentos, a modo de variables:
`\newcommand{\tituloPerfil}{Sistema de evaluación…}`, `\estudiante`, `\anio`… Mars las dibuja
con su texto, como el PDF, y además:

- Al editar el bloque (o al pasar el ratón) cada variable lleva encima una etiqueta con su
  **nombre**, y su texto queda subrayado: se ve a la vez qué pone y de dónde sale.
- **Doble clic** sobre una variable abre un cuadro con las dos cosas: el texto que vale y la
  orden que hay escrita en ese punto. Cambiar el texto cambia su definición en el preámbulo (en
  el documento principal, si estás en un capítulo), y con ella todos los sitios donde se usa.
- «Solo aquí» deja de usar la variable en ese punto y escribe el texto en su lugar.

### Mover, duplicar y arrastrar bloques

Un bloque es un párrafo, un título, una ecuación, una figura, una tabla, una lista… Al pasar el
ratón sobre uno aparecen sus botones:

- **↑ y ↓** (o `Alt+↑` / `Alt+↓`): lo suben o lo bajan un puesto. El cursor sigue en él, así que
  puedes repetir la tecla hasta dejarlo en su sitio.
- **Duplicar** (o `Ctrl+D`, o `Alt+Mayús+↓`): deja una copia justo debajo.
- **El asa ⠿**: arrástrala para llevar el bloque a cualquier parte del documento; una línea
  marca dónde va a caer. Con `Ctrl` pulsado al soltar, se copia en vez de moverse.
- Con **varios párrafos seleccionados**, `Alt+↑` / `Alt+↓` y `Ctrl+D` actúan sobre todos a la
  vez, y siguen seleccionados después.
- El **botón derecho** ofrece lo mismo, además de copiar o cortar el bloque entero (su código).

En el `.tex` se mueven sus líneas tal cual están escritas, sin reformatearlas, y cada operación
es un solo paso de deshacer.

### Ortografía

Las palabras que no están en el diccionario se subrayan en rojo mientras escribes. Con el botón
derecho sobre una de ellas aparecen las sugerencias, **Añadir al diccionario** (se recuerda para
todos tus documentos) y **Omitir en esta sesión**. La barra de estado muestra cuántas quedan y
lleva a la siguiente.

- El idioma es el que el documento declara con `babel` (español o inglés, también sus variantes:
  `british`, `american`, `mexico`…), aunque lleve opciones como `es-tabla` o esté dentro de un
  `\IfFileExists`; desde **Revisar → Idioma** se puede fijar otro o corregir con los dos a la vez.
- En español se dan por buenas las palabras que la lengua forma con reglas regulares a partir de
  otras del diccionario: adverbios en *-mente*, prefijos (*subconsulta*, *reescritura*) y derivados
  como *optimizador* o *cardinalidad*.
- No se revisan las fórmulas, el código, las referencias, la bibliografía, las siglas ni las
  direcciones web.
- Los diccionarios (Hunspell) van incluidos: no hace falta conexión ni instalar nada.

### Citas: DOI y Zotero

- **Referencias → DOI**: pega el DOI de un artículo (o su dirección `https://doi.org/…`) y Mars
  pide sus datos a doi.org, añade la referencia a la bibliografía y la cita donde está el cursor.
  La clave es «apellido + año» (`lecun2015`); si la referencia ya estaba, no se duplica.
- **Referencias → Zotero**: abre el selector de citas de Zotero, inserta `\cite{…}` con lo
  elegido y trae sus datos a la bibliografía. Necesita Zotero abierto con el complemento
  [Better BibTeX](https://retorque.re/zotero-better-bibtex/).

En ambos casos, si el documento usa un archivo `.bib` (`\bibliography{…}` o
`\addbibresource{…}`) la entrada se guarda en él; si no, se escribe como `\bibitem` dentro de
`thebibliography`, que se crea si no existe.

### Seleccionar varios párrafos

Arrastra de un párrafo a otro, usa `Mayús+clic` o pulsa `Ctrl+A` dos veces (la primera
selecciona el párrafo; la segunda, todo el documento). Sobre esa selección funcionan:

- `Supr` o `Retroceso` (lo que queda de los párrafos de los extremos se une), y escribir o pegar
  encima, que la sustituye.
- `Ctrl+C` y `Ctrl+X`: se copia el código LaTeX de lo seleccionado.
- Negrita, cursiva, subrayado y el resto de formatos de carácter, que se aplican a todo el texto.
- Lista y alineación: varios párrafos pasan a ser una lista (uno por elemento) o quedan dentro
  de un entorno `center`, `flushleft` o `flushright`.

Cada una de estas operaciones es un solo paso de deshacer.

### La página: márgenes, tamaño de hoja y saltos

- **Márgenes**: el menú ofrece ajustes predefinidos (Normal, Estrecho, Moderado, Ancho,
  Encuadernación) con su miniatura y sus medidas, y un diálogo para fijar cada lado (superior,
  inferior, izquierdo, derecho). En la **regla** que hay sobre la hoja los márgenes laterales
  aparecen sombreados y se cambian arrastrando sus tiradores. Se escriben con el paquete
  `geometry`; «Predeterminados de LaTeX» lo quita.
- **Tamaño de hoja**: A4, carta, oficio, A3, A5, B5, ejecutivo o un tamaño personalizado, en
  vertical u horizontal. La hoja del editor cambia de tamaño y proporción al instante.
- **Hojas horizontales** (`\begin{landscape}` de `lscape` o `pdflscape`): van en una hoja
  propia, como en LaTeX, con el contenido compuesto a lo ancho de la hoja apaisada. En
  **Disposición → Orientación** se elige cómo verlas. Por defecto, *Girada; derecha al editarla*:
  se ve como en el PDF hasta que haces clic en ella; mientras la editas aparece la hoja apaisada
  entera, a tamaño real y con sus márgenes (reducida solo si no cabe en el panel), y al salir
  vuelve a girarse. Las otras opciones son *Como en el PDF* (con `lscape` la hoja
  sigue vertical y el contenido va girado 90°, tal como sale impresa; con `pdflscape` se ve
  apaisada, como en el visor), *Siempre girada* o *Siempre derecha* (más cómoda para leer y
  editar). El mismo menú inserta una hoja horizontal y cambia `lscape` por `pdflscape` (o al
  revés) con *Apaisadas también en el visor de PDF*: al imprimir sale igual, pero el visor de
  PDF muestra la hoja girada. Se recuerda en el ajuste `mars.landscapePages`.
- **Saltos de página**: el documento se reparte en hojas como en un procesador de textos. Los
  párrafos y las listas se parten por líneas entre una hoja y la siguiente; las ecuaciones,
  tablas, figuras y bloques de código pasan enteros; un título no se queda solo al pie de una
  hoja. `Ctrl+Enter` (o **Disposición → Saltos**) inserta un salto manual: con el cursor en
  mitad de un párrafo lo parte ahí, y al final deja el cursor en un párrafo nuevo de la hoja
  siguiente. También se puede insertar un espacio vertical (`\vspace`).
- **Varias páginas**: al alejar el zoom (70 % o menos, con `Ctrl` + rueda, el botón «−» de la
  barra de estado o **Vista → Varias**) las hojas se colocan en mosaico, dos o más por fila, con
  el mismo reparto que en la vista normal. Un clic en el número de una hoja, o doble clic sobre
  ella, la abre a tamaño de lectura. Se puede seguir escribiendo; de un párrafo partido entre dos
  hojas, la parte que continúa en la siguiente es de solo lectura.

Para que las hojas corten como en el PDF, Mars imita cómo compone LaTeX la página:

- En cada hoja caben las mismas líneas: se mide de línea base a línea base, con la primera a
  `\topskip` del borde, y se respetan el interlineado (`setspace`, también en `singlespace` y
  compañía), la sangría y la separación de párrafos (`\parindent`, `\parskip`, el paquete
  `parskip`) y los espacios de los títulos (los de la clase o los de `titlesec`).
- El interlineado puede cambiar por tramos: `\singlespacing`, `\onehalfspacing`, `\doublespacing`
  y `\setstretch` escritos en el cuerpo valen desde ahí hasta la siguiente orden.
- Los títulos siguen el formato de `titlesec` (`\titleformat` de capítulos y secciones: tamaño,
  centrado, rótulo «Capítulo 1» y separador), y los nombres que el documento redefine
  (`\contentsname`, `\chaptername`, `\listfigurename`, `\bibname`...) valen desde donde se escriben.
- El índice y los índices de figuras y tablas llevan **puntos guía y número de página** (el de
  la hoja donde cae cada título, también los de `\addcontentsline`), y `\dotfill`, `\hrulefill`
  y `\hfill` llenan lo que queda de su línea.
- Las palabras **se parten con guion** al final de línea: en español por sílabas, y en inglés,
  francés, alemán, portugués, italiano y catalán con los patrones de TeX. El texto del documento no cambia: es solo cómo se dibuja. Se desactiva con el
  ajuste `mars.hyphenation`.
- `\vfill` reparte el espacio que queda libre en su hoja, y el espacio en blanco que no cabe al
  pie de una hoja se descarta en vez de pasar a la siguiente.
- **Flotantes**: una figura o tabla que no cabe donde está no deja un hueco; el texto sigue y ella
  abre la hoja siguiente (con `[H]` se queda en su sitio).
- **Notas al pie** al fondo de la hoja donde está su llamada, bajo su raya, quitándole sitio al
  texto. En la vista continua van en una lista al final.
- **Encabezado y pie**: el número de página donde lo pone LaTeX, y lo que configure `fancyhdr`
  (`\fancyhead`, `\fancyfoot`, `\lhead`…, con `\thepage`, `\leftmark`, `\rightmark` y
  `\pageref{LastPage}`). También `\pagestyle`, `\thispagestyle` y `\pagenumbering` (romanos…):
  un `\pagestyle` del cuerpo vale desde su hoja y, dentro de un entorno (una hoja horizontal, por
  ejemplo), solo en él, como en LaTeX.
- **Escribir el encabezado y el pie**: con **Insertar → Encabezado / Pie**, o con doble clic en el
  margen de arriba o de abajo de cualquier hoja, como en un procesador de textos. El diálogo tiene
  tres casillas arriba y tres abajo (izquierda, centro, derecha), las rayas y una vista previa;
  se escribe `{página}`, `{total}`, `{sección}` o `{subsección}` donde va cada cosa, y texto
  corriente o LaTeX. **Insertar → Número** lo coloca abajo centrado, abajo a la derecha, arriba a
  la derecha o como «Página 3 de 12», o lo quita. Mars lo escribe con `fancyhdr` (y `lastpage`
  si hace falta el total) al final del preámbulo, sustituyendo la configuración anterior.
- **Viudas y huérfanas** (Disposición → Viudas): escribe `\widowpenalty` y `\clubpenalty` y el
  reparto deja al menos dos líneas de un párrafo a cada lado de un corte de hoja.

Aun así es una aproximación: Mars no compila el documento y LaTeX elige los cortes de línea de
cada párrafo de otra manera, así que una hoja puede empezar una línea antes o después que en el
PDF final.

### Listas

- `Enter` crea el elemento siguiente; en un elemento vacío sale de la lista o, en una sublista,
  sube un nivel. `Tab` y `Mayús+Tab` bajan y suben de nivel.
- Al pulsar `Enter` al final de un elemento con sublista, el nuevo queda en su sitio con el
  cursor dentro, y la sublista pasa a colgar de él (el código conserva su sangría).
- Las marcas y la numeración de cada nivel son las de LaTeX y, en español, las de babel
  (▪ • ∘ ⋄ y 1. *a*) 1) a′).
- **Viñetas por niveles** (menú ▾ junto a los botones de lista): dice en qué nivel está el cursor
  y marca su símbolo; elegir una viñeta o una numeración cambia solo la lista de ese nivel. La
  **lista multinivel** aplica un esquema a todos los niveles a la vez: viñetas de LaTeX
  (• – ∗ ·), formas (• ○ ■ ▹), flechas, esquema (1. a) i) A.), numeración por niveles
  (1. / 1.1. / 1.1.1.), romanos (I. A. 1. a)) o las del documento (sin etiquetas propias). Se
  escriben con `enumitem` (y `amssymb` si el símbolo lo pide), conservando las demás opciones de
  cada lista (`noitemsep`, `start=`...).
- Dentro de una lista, los botones de sangría ⇤ ⇥ suben y bajan de nivel el elemento, como
  `Mayús+Tab` y `Tab`.

### Escribir más rápido

- **Barra flotante**: al seleccionar texto aparece una barra con negrita, cursiva, subrayado,
  código, super/subíndice, enlace y «convertir en fórmula».
- **Comandos con `/`**: teclea `/` al empezar un párrafo o tras un espacio y elige qué insertar
  (título, lista, ecuación, tabla, imagen, gráfica, nota, cita…). Lo que escribas detrás filtra
  la lista; `Enter` inserta y `Esc` cierra.
- **Atajos tipo Markdown** al principio de un párrafo: `# `, `## `, `### ` crean títulos; `- ` una
  lista; `1. ` una lista numerada; `> ` una cita.
- **Pegar con formato**: lo copiado de Word, Google Docs o una web conserva negritas, cursivas,
  enlaces, títulos, listas y tablas, convertidos a LaTeX. Una imagen del portapapeles se guarda
  en `img/` junto al documento y se inserta como figura.
- **Imágenes**: arrastra el borde derecho de una imagen para cambiar su ancho.
- **Tablas**: en la pestaña Tabla, además de filas y columnas, alineación de la columna y
  poner o quitar todos los bordes.
- **Panel de navegación** (Vista, o el botón de la barra de estado): esquema del documento con
  sus títulos; un clic lleva a la sección. Los títulos con otros debajo se pliegan (▾), y
  **Plegar todo** deja solo el primer nivel.
- **Buscar**: `Ctrl+F` abre el buscador de VS Code sobre el documento visual.
- **Vista de página** con hojas, márgenes y numeración, o vista continua; zoom y página actual
  en la barra de estado. Los párrafos se ven como los compone LaTeX: seguidos y con sangría en la
  primera línea (sin ella tras un título, salvo en español, y tras `\noindent`).
- **Documento nuevo**: en un archivo vacío se ofrece una galería de plantillas (artículo,
  informe, tesis, tarea, carta).
- **Mayúsculas y minúsculas**: el botón «Aa ▾» de Inicio cambia el texto seleccionado (o la
  palabra donde está el cursor) a MAYÚSCULAS, minúsculas, Tipo oración, Cada Palabra En Mayúscula
  o lo alterna. Cambia las letras del documento, sin tocar el formato ni las fórmulas.
- **Regla**: marca centímetros, medios y milímetros según el zoom, con los márgenes sombreados.
  Al arrastrar un tirador aparece una guía sobre la hoja y la medida del margen y del ancho de
  texto; va de milímetro en milímetro (con Mayús de 5 en 5 mm, con Alt en décimas de milímetro y
  con Ctrl mueve los dos márgenes a la vez). Con el tirador enfocado, las flechas lo mueven desde
  el teclado, y un doble clic permite escribir la medida exacta.
- **Papel**: en la pestaña Vista se elige hoja blanca, sepia u oscura (para escribir de noche).
  Solo cambia cómo se ve al editar; el documento y el PDF no cambian.
- **Preferencias de la vista para todos los documentos**: el papel, el zoom, la vista de página o
  continua, la cinta minimizada y los colores recientes valen para todos los `.tex`. Lo que
  cambies en uno se aplica al momento en los demás editores abiertos, en los que abras después
  y en la siguiente sesión.
- **Informes y libros** (`report`, `book`, `scrreprt`, `scrbook`): como en LaTeX, el título, el
  resumen, el índice, cada capítulo y la bibliografía empiezan en hoja propia; el título y el
  resumen no llevan número. Ecuaciones, figuras y tablas se numeran dentro del capítulo (2.1,
  2.2…), y `\numberwithin` vale en cualquier clase. `\listoffigures` y `\listoftables` dibujan
  sus índices.
- **Gráficas desde datos**: *Insertar → Gráfica* pide el tipo (líneas, barras, puntos o una
  función), los rótulos y los datos, y escribe la figura pgfplots.
- **Ordenar tablas**: en la pestaña Tabla, A → Z y Z → A ordenan las filas por la columna del
  cursor (números como números), sin mover los filetes.
- **Palabras por apartado**: el panel de navegación muestra cuántas palabras lleva cada sección.
- **Capítulos incluidos**: en el documento principal, doble clic en un párrafo de un capítulo
  traído con `\input` lo abre en su archivo, en ese mismo párrafo.
- **Documentos largos**: al escribir solo se vuelven a repartir en hojas las páginas afectadas
  por el cambio (desde la anterior hasta que el reparto coincide otra vez con el que había), así
  que una tesis de 150 páginas responde como un documento corto. Al abrirlo, se dibuja por
  tandas: las primeras hojas salen enseguida y el resto se añade detrás sin bloquear el editor
  (la barra de estado indica el avance).
- **Sin saltos**: las imágenes reservan su hueco desde el principio (Mars lee sus medidas del
  archivo) y las figuras TikZ ya dibujadas se guardan en disco, así que al reabrir el documento
  aparecen al instante.

### El editor de ecuaciones

**Inicio → Ecuación** (o teclear `$` para una fórmula en línea, o doble clic sobre una existente)
abre el editor de ecuaciones:

- **Campo visual**: se escribe sobre la propia fórmula, como en una calculadora. `/` crea una
  fracción, `^` un exponente, `_` un subíndice; `sqrt`, `pi`, `alpha`, `sen`… se convierten solos,
  y `Tab` salta al siguiente hueco.
- **Paleta gráfica** por categorías (estructuras, griegas, operadores, relaciones, flechas,
  conjuntos, funciones, matrices, acentos). Las estructuras se dibujan con sus huecos punteados,
  como en Word: se insertan y se rellenan en su sitio.
- **Buscador**: escribe «fracción», «alfa», «flecha», «integral»… (en español, con o sin acentos,
  o el nombre LaTeX) y pulsa `Enter` para insertar el primer resultado.
- **Recientes**: lo último que has insertado queda a un clic.
- **Matrices**: elige el tamaño en una cuadrícula y el delimitador (paréntesis, corchetes,
  barras, llaves o ninguno).
- **Deshacer, rehacer y vaciar** en la cabecera, y el botón `</>` para ver y editar el **código
  LaTeX**, siempre sincronizado con el campo visual.

**Insertar → Ecuación** ofrece además una galería de fórmulas habituales, e **Insertar → Símbolo**
los símbolos sueltos para el texto.

### La fuente

Los cuadros de **fuente** y de **tamaño** están en Inicio, como en un procesador de textos, y
muestran lo que hay donde está el cursor. Lo que elijas en ellos se aplica:

- **Al texto seleccionado**, si hay una selección: `{\fontfamily{ptm}\selectfont …}` para el tipo
  de letra y `{\fontsize{14}{16.8}\selectfont …}` para el tamaño (se añade el paquete
  `anyfontsize`). Elegir otro valor sobre el mismo texto sustituye al anterior, y elegir el del
  documento lo quita.
- **A todo el documento**, si no hay nada seleccionado (o está seleccionado entero): se escribe en
  el preámbulo. La fuente, con su paquete (`\usepackage{mathptmx}`, `\usepackage{mathpazo}`…; para
  las de palo seco, además, `\renewcommand{\familydefault}{\sfdefault}`); el tamaño, como opción
  de la clase si es 10, 11 o 12 pt y con `\usepackage[fontsize=…]{scrextend}` en los demás casos.

El menú indica en su primera línea a qué se va a aplicar.

- **Fuentes**: Computer Modern (la de LaTeX), Latin Modern, Times, Palatino, Charter, Bookman,
  Century Schoolbook, Helvetica y Computer Modern sin remates; todas funcionan con pdfLaTeX sin
  instalar nada, y la hoja se dibuja con una fuente equivalente del sistema. Para la selección
  están además las familias genéricas: con remates, sin remates y monoespaciada.
- **Tamaños**: 8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48 y 72 puntos, y los botones
  de agrandar y reducir, que pasan al siguiente de la lista.
- **Lo demás** (Inicio → Fuente): negrita, cursiva, subrayado, tachado, superíndice, subíndice,
  versalitas, énfasis y **color**. El formato no se lleva los espacios de los extremos de la
  selección.

### Teclado

| Acción | Cómo |
| --- | --- |
| Párrafo nuevo | `Enter` (dentro de una lista crea un elemento; en una tabla pasa de celda) |
| Unir con el párrafo anterior | `Retroceso` al inicio del párrafo |
| Negrita, cursiva, subrayado | `Ctrl+B`, `Ctrl+I`, `Ctrl+U` |
| Fórmula en línea | Teclea `$` |
| Sangrar un elemento de lista | `Tab` / `Mayús+Tab` |
| Editar una fórmula, tabla compleja o bloque en LaTeX puro | Doble clic, o el botón `</>` del bloque |
| Título, autor y fecha | Doble clic en el bloque de título |
| Seleccionar el párrafo / todo el documento | `Ctrl+A` / `Ctrl+A` otra vez |
| Extender la selección a otro párrafo | Arrastrar o `Mayús+clic` |
| Subir o bajar el bloque (o los seleccionados) | `Alt+↑` / `Alt+↓` |
| Duplicar el bloque | `Ctrl+D` o `Alt+Mayús+↓` |
| Minimizar o mostrar la cinta | `Ctrl+F1`, o doble clic en una pestaña |
| Sugerencias de ortografía | Botón derecho sobre la palabra subrayada |
| Deshacer, rehacer, guardar | `Ctrl+Z`, `Ctrl+Y`, `Ctrl+S` |

El editor de código y el visual están sincronizados en ambos sentidos: lo que escribas en uno
aparece en el otro, y comparten un único historial de deshacer (`Ctrl+Z` deshace lo último,
se haya hecho donde se haya hecho).

Mars es un editor personalizado de VS Code: además del botón ▶, puedes usar **Reabrir editor
con… → Mars** o fijarlo como editor predeterminado de los `.tex`.

Al pegar, el texto corriente se escapa (`50%` pasa a `50\%`) y el código LaTeX se interpreta.

## Qué entiende

**Lógica sencilla del preámbulo.** Mars no ejecuta LaTeX, pero resuelve lo que las plantillas
reales suelen usar para configurarse:

- Condicionales: `\IfFileExists`, `\newif` con `\ifalgo … \else … \fi`, `\ifthenelse` con
  `\boolean`, `\equal`, `\not`, `\and`, `\or`; `\iftoggle` y `\ifbool` de etoolbox; `\ifdefined`
  y los de motor (`\ifXeTeX`…; Mars cuenta como pdfLaTeX). También en el cuerpo: se dibuja la
  rama que LaTeX usaría. Lo que no sabe evaluar lo deja a la vista, sin inventar.
- **Clases propias**: si la clase del documento es un `.cls` que está junto a él, se lee la clase
  estándar que carga (`\LoadClass`) y lo que configura: márgenes, fuente, interlineado, títulos.
- Paquetes `.sty` locales y `\input` en el preámbulo cuentan como parte de él.
- Contadores (`\newcounter`, `\setcounter`, `\stepcounter`, `\thealgo`, `\arabic`, `\Roman`,
  `\alph`…) y longitudes propias (`\newlength`, `\setlength`, usables en `\vspace`, anchos…).
- **Contenido generado con código.** Un intérprete reducido de macros ejecuta lo que el documento
  programa y dibuja el resultado: bucles `\foreach` de pgffor (series `1,...,10`, varias
  variables `\a/\b`, `count=`, anidados), `\ifnum`, `\ifcase`, `\ifodd`, `\ifx`, `\ifcsname`,
  `\loop…\repeat`, `\numexpr`, `\pgfmathparse` / `\pgfmathresult` / `\pgfmathtruncatemacro`,
  registros `\newcount` con `\advance`, `\newif`, definiciones dinámicas (`\def`, `\let`,
  `\csname…\endcsname`, argumentos delimitados), `\newenvironment` con argumentos, xparse
  (`\NewDocumentCommand` con `o`, `O{}`, `s`; `\IfNoValueTF`) y keyval (`\setkeys`). Así, una
  tabla o unas secciones hechas con un bucle se ven con sus filas y sus títulos. Ese contenido es
  resultado del código, así que no se edita en sitio: se cambia en el código del bloque (doble
  clic). Lo que solo puede calcular un compilador de verdad —Lua (`\directlua`) y expl3— no se
  inventa: en su lugar aparece una marca ⚙ con el nombre de la orden.
- Nombres cambiados por el documento (`\contentsname`, `\figurename`, `\refname`…), con las
  reglas de `babel` (solo valen dentro de `\addto\captions…`; en español, «Cuadro» salvo con
  `es-tabla`).

Secciones, formato de texto, listas (anidadas), tablas `tabular`, matemáticas con KaTeX
(`$…$`, `\[…\]`, `equation`, `align`, `gather`…), numeración y referencias cruzadas (`\label`,
`\ref`, `\eqref`), notas al pie, `\cite` con `thebibliography`, teoremas (`\newtheorem`), macros
(`\newcommand`), `\input`, `verbatim`, índice, portadas (`titlepage`), `minipage`, espacios
(`\vspace`, `\vfill`, `\\[10pt]`, `\hspace`; con medidas en cm, pt, em o fracciones de
`\textwidth` y `\textheight`).

**Como lo compondría LaTeX.** Además de dibujar cada orden, Mars sigue las reglas que deciden qué
se ve en el PDF:

- **Lo que babel cambia en español**, además de los nombres: las marcas de las listas (▪ y •; `1.`
  y `a)`), las comillas latinas al escribir `<<` y `>>`, la coma decimal de las fórmulas (`$3.14$`
  se ve 3,14) y los operadores `\sen`, `\tg`, `\arcsen`, lím, máx y mín. Se respetan `es-nolists`,
  `es-noquoting`, `es-nodecimaldot`, `mexico` y `\unaccentedoperators`. Los números de `siunitx`
  llevan la marca decimal que diga `\sisetup{output-decimal-marker=…}`, como en LaTeX.
- **Títulos**: en informes y libros las subsubsecciones van sin número y no entran en el índice
  (`secnumdepth` y `tocdepth`, que el documento puede cambiar); un título con asterisco solo
  aparece en el índice con `\addcontentsline`; tras `\appendix` se cuentan con letras («Apéndice
  A», figura A.1); `\frontmatter`, `\mainmatter` y `\backmatter` de los libros; las partes, en
  romanos; y la lista de referencias se titula «Bibliografía» en informes y libros.
- **Listas**: la marca y la numeración de cada nivel (•, –, ∗; `1.`, `(a)`, `i.`), las etiquetas
  cortas del paquete `enumerate` (`[a)]`, `[(i)]`), `start=` y `resume`.
- **Referencias con nombre**: `\autoref` («Figura 3»), `\cref` y `\Cref` de cleveref («figuras 1 y
  2», «eq. (4)»; con sus opciones `capitalise` y `noabbrev` y con `\crefname`), `\nameref`,
  `\subref` y `\pageref`, que en la vista de página muestra la hoja donde cae la etiqueta.
- **Notas al pie** con la llamada y el texto por separado (`\footnotemark`, `\footnotetext`), como
  se escriben dentro de una tabla.

- **Clases de documento**: además de `article`, `report` y `book` (y las de KOMA-Script, con el
  color que den a sus títulos), se dibujan las cartas (`letter`: remitente, destinatario,
  `\opening`, `\closing` con la firma, `\ps`), los exámenes (`exam`: `questions`, `parts`,
  `choices`, puntos y `solution`), las presentaciones (`beamer`: cada `frame` como una diapositiva
  con su título, `\frame{\titlepage}`, `block`), los pósteres (`tikzposter`: `\block{título}{…}`,
  a escala de folio) e `IEEEtran` (`\IEEEauthorblockN`, `IEEEkeywords`).
- **Paquetes**: `tcolorbox` (cajas con título y colores, `\newtcolorbox`), `mdframed`, `framed`;
  `algorithm` + `algpseudocode` (pseudocódigo con sus líneas numeradas y sangradas) y
  `algorithm2e` (con sus palabras en español si se carga con `spanish`); `glossaries`
  (`\gls`, `\newacronym`, `\printglossary`), `acronym` y `acro` (`\ac`, `\acs`, `\acl`, `\acf`:
  entera la primera vez y después solo la sigla) y `makeidx` (`\index`, `\printindex`, sin números
  de página); `xcolor` completo (mezclas `blue!20`, `green!60!black`, colores de `\definecolor` y
  `\colorlet` en cualquier modelo); `diagbox`, `makecell`, `\resizebox`, `\scalebox`, `\parbox`,
  `\fbox`, `\hyperref[etiqueta]{texto}`, `\lstinline`, `\captionof`, `import`; `csquotes`
  (`\enquote`, `\textquote`, `\blockquote`, con las comillas del idioma); `soul` y `ulem` (`\hl`,
  `\ul`, `\st`, `\uuline`, `\uwave`…); `subfig` (`\subfloat`); `listings` con título y etiqueta en
  sus opciones, `\lstinputlisting` e `\inputminted`; `tabularray` (`tblr`), `supertabular`, `tabu`
  y los tipos de columna de `\newcolumntype`; `pdfpages` (`\includepdf`: se enseña la primera
  página); las capas de `beamer` (`\only<2>`, `\item<1->`); y los símbolos de `textcomp`,
  `gensymb` y `textgreek` (`\textordmasculine`, `\celsius`, `\textmu`…).
- **Matemáticas de otros paquetes**, que KaTeX no trae: `siunitx` (`\SI`, `\qty`, `\num`, `\si`,
  `\unit`, `\ang`, intervalos y listas, con lo que fijen `\sisetup` y `\DeclareSIUnit`), también
  en el texto; `physics` (`\dv`, `\pdv`, `\abs`, `\norm`, `\qty(…)`, `\comm`, `\ev`, `\mel`,
  `\mqty`…); `mhchem` (`\ce{H2O}`); `\DeclarePairedDelimiter` de `mathtools`; `\intertext`;
  `\mathbbm` y `\mathds`; `\cancelto`; y las letras griegas de `upgreek`.
- **Citas por autor y año**: con `natbib` o `biblatex`, `\citep`, `\citet`, `\citeauthor`,
  `\citeyear`… se muestran como «(Codd, 1970)» o «Codd (1970)» y `\bibliography{…}` dibuja la
  lista de referencias, a partir del archivo `.bib` del documento (solo las citadas, ordenadas por
  autor). Las citas nuevas se insertan con `\citep`.
- **Imágenes** (`\includegraphics`): PNG, JPG, SVG, GIF, WebP y PDF (primera página, con pdf.js).
  Los EPS se muestran si Ghostscript está instalado en el sistema. Se respetan `width`, `height`,
  `scale` y `keepaspectratio`; sin medidas, la imagen sale a su tamaño natural (sus píxeles a la
  resolución que declare el archivo), como en LaTeX.
- **TikZ** (`tikzpicture`, `circuitikz`, `tikzcd`, gráficas `pgfplots`, y `\tikz …;` dentro de una
  línea): se dibujan con un motor TeX en WebAssembly, sin LaTeX instalado. La primera figura tarda
  un par de segundos; después quedan en caché. Admite `\usetikzlibrary`, `\tikzset`,
  `\pgfplotsset` y colores del preámbulo.

Lo que no sabe dibujar se muestra como un bloque con su código, que se conserva intacto. Los
comentarios y los comandos desconocidos nunca se pierden al editar, y las listas y tablas
mantienen su sangría y alineación: solo se reescribe la línea que cambias.

Un documento a medio escribir no puede colgar el editor: una orden que se llama a sí misma
(`\newcommand{\a}{\a\a}`, que a LaTeX lo dejaría sin memoria) se deja sin expandir, y el dibujado
tiene un tope de expansiones.

## Ajustes

| Ajuste | Qué hace |
| --- | --- |
| `mars.scrollSync` | Sincroniza el desplazamiento del editor visual con el de código |
| `mars.hyphenation` | Parte las palabras con guion al final de línea, como LaTeX (activado) |
| `mars.spellCheck.enabled` | Activa el corrector ortográfico |
| `mars.spellCheck.language` | `auto` (el idioma del documento), `es`, `en` o `es+en` |
| `mars.zotero.url` | Dirección local de Zotero (por defecto `http://127.0.0.1:23119`) |
| `mars.pdf.command` | Orden con la que compilar el PDF, con `%DOC%` donde va el archivo (vacío: `latexmk`, `tectonic` o el motor que pida el documento) |
| `mars.openInVisualEditor` | Con un editor visual abierto, los demás `.tex` que abras se muestran también en él (activado) |
| `mars.landscapePages` | Cómo se ven las hojas horizontales: `edit` (como en el PDF y derechas mientras se editan, por defecto), `pdf` (como en el PDF), `rotated` (siempre giradas) o `upright` (siempre derechas) |

En `mars.pdf.command`, `%DOC%` se cambia por la variable de entorno `MARS_DOC` (entre comillas),
no por el nombre del archivo: una ruta con comillas, `$` o `;` no puede romper la orden.

Mars ejecuta programas sobre los archivos de la carpeta (git, LaTeX y la orden de
`mars.pdf.command`), así que solo se activa en carpetas de confianza: en el modo restringido de
VS Code queda desactivada.

## Desarrollo

```
npm install
npm run compile      # TypeScript + empaquetado (esbuild) de la extensión y del webview
npm run test:unit    # renderizador, serializador, corrector y citas (Node + jsdom)
npm run test:e2e     # el editor manejado desde dentro de un VS Code real
npm run test:ui      # ratón y teclado reales sobre un VS Code real (Playwright)
npm run package      # genera el .vsix
npm run test:vsix    # instala el .vsix en un VS Code limpio y comprueba que funciona
```

Hace falta Node 22.12 o posterior (jsdom se carga con `require()` de módulos ES); con un Node
22 anterior, las pruebas unitarias se lanzan con `node --experimental-require-module --test …`.
`npm run package` deja el `.vsix` en `releases/`.

`F5` abre una ventana de VS Code con la extensión cargada y `ejemplo.tex` abierto.

Los atajos `mars.noop` de `package.json` (`Ctrl+B`, `Ctrl+I`, `Ctrl+Z`, `Ctrl+A`…) no hacen nada
a propósito: le quitan esas teclas a VS Code mientras el editor visual tiene el foco, para que
lleguen al webview, que es quien pone la negrita, deshace o selecciona.

Las pruebas que abren VS Code lo hacen **fuera de la pantalla** y sin tomar el foco, para no
molestar ni recibir clics ajenos. `MARS_TEST_SHOW=1` deja las ventanas a la vista;
`MARS_E2E_ONLY="texto,otro"` ejecuta solo las pruebas de integración cuyo nombre contenga alguno
de esos textos.

El paquete no lleva `node_modules`: `esbuild.mjs` deja en `dist/` la extensión, el corrector y el
motor TikZ ya empaquetados, y copia las fuentes, las bibliotecas del webview, los diccionarios y
los archivos de TeX a `media/vendor`, `dict` y `tex` (unos 10 MB y 200 archivos en total).

## Cómo funciona

- `src/latex/renderer.ts` convierte LaTeX en HTML dividido en bloques (uno por párrafo, título,
  entorno…), cada uno con su rango de líneas. El HTML va anotado con el código de origen.
- `src/webview/serialize.ts` hace el camino inverso: del HTML editado vuelve a LaTeX.
- `src/webview/main.ts` es el editor: al escribir en un bloque, lo serializa y envía al host solo
  las líneas de ese bloque. La selección de varios bloques y el subrayado del corrector se pintan
  con la API de resaltados de CSS, sin tocar el DOM del documento.
- `src/extension.ts` aplica el cambio al documento. Cada edición incluye las líneas que cree
  estar sustituyendo (y, al insertar, las vecinas); si el documento no coincide, se descarta y la
  vista se resincroniza. Varias ediciones pueden ir juntas como un solo paso de deshacer.
- `src/webview/hyphen.ts` marca dónde puede partirse cada palabra. Las marcas son elementos vacíos
  cuyo guion opcional pone la hoja de estilos, así que el texto del documento no cambia.
- `src/latex/preamble.ts` calcula el preámbulo «efectivo»: condicionales resueltos y la clase o
  los paquetes propios incorporados. Solo se usa para leer; nunca se escribe en el documento.
- `src/latex/layout.ts` lee y escribe la configuración de página del preámbulo y la traduce a las
  medidas de la hoja.
- `src/latex/mathext.ts` pasa a LaTeX corriente lo que KaTeX no trae (siunitx, physics, la coma
  decimal y los operadores del español) antes de dibujar cada fórmula. Lo usan el renderizador y
  los diálogos del editor, que reciben del documento qué paquetes e idioma están en vigor.
- `src/spell.ts` y `src/spellWorker.ts`: corrector Hunspell (nspell) en un hilo aparte.
- `src/citations.ts`: BibTeX, DOI (doi.org) y Zotero (Better BibTeX).

Los componentes de terceros y sus licencias están en `THIRD-PARTY-NOTICES.md`.
