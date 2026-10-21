/*
 * Motor TeX (WebAssembly) que dibuja las figuras TikZ. Va en un archivo aparte porque pesa varios
 * megas y solo se carga cuando el documento contiene alguna figura.
 */
import tex2svg from 'node-tikzjax';

export default tex2svg;
