/**
 * Formulario conversacional por WhatsApp.
 *
 * El núcleo no importa React ni Next ni ninguna base: sabe de WhatsApp y de la
 * conversación, y todo lo demás entra por `Repositorio` y `Almacen`. La parte
 * de interfaz vive aparte, en `enlace-dinamico-whatsapp/react`, para que quien
 * solo necesite el webhook no se traiga React detrás.
 */
export type {
  Almacen,
  CampoDialogo,
  Caso,
  Formulario,
  LoQueRecogeElChat,
  Repositorio,
} from "./tipos.js";

export {
  descargarMedio,
  enviarPlantilla,
  enviarTexto,
  extraerMensajes,
  firmaValida,
  respuestaDeVerificacion,
  type ConfigWhatsapp,
  type MensajeEntrante,
  type Resultado,
} from "./whatsapp.js";

export {
  esCierre,
  invitar,
  normalizarTelefono,
  procesarEntrante,
  type Dependencias,
  type ResultadoEntrante,
} from "./conversacion.js";
