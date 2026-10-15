import type { Almacen, Caso, Formulario, Repositorio } from "./tipos.js";
import {
  descargarMedio,
  enviarPlantilla,
  enviarTexto,
  type ConfigWhatsapp,
  type MensajeEntrante,
} from "./whatsapp.js";

/**
 * De un mensaje de WhatsApp a una fila guardada.
 *
 * EL ORDEN DE LOS PASOS **ES** LA GARANTÍA
 * ----------------------------------------
 * 1. El mensaje se registra PRIMERO, con su `wamid`. Si ya estaba, es un
 *    reintento de Meta y no se hace nada más. Sin esto, una foto se guarda
 *    dos o tres veces y el informe miente.
 * 2. La foto se baja EN EL ACTO: la URL que da Meta está firmada y caduca en
 *    minutos, así que diferirla a una cola sería cambiar un problema por otro
 *    peor — una foto que ya no se puede recuperar.
 * 3. El acuse va al final y, si falla, no se propaga: lo guardado ya está
 *    guardado, y perder el acuse es molesto; perder el informe por no poder
 *    acusarlo sería absurdo.
 */

export type Dependencias = {
  whatsapp: ConfigWhatsapp;
  repositorio: Repositorio;
  almacen: Almacen;
  /** Qué se le contesta a la persona. Opcional: sin esto no se acusa nada. */
  acuses?: {
    recibido?: (ctx: { conFoto: boolean }) => string;
    faltaParaCerrar?: (falta: { informes: number; fotos: number }) => string;
    cerrado?: () => string;
  };
};

const CIERRES_POR_OMISION = ["listo", "terminado", "termine", "fin", "finalizar"];

/**
 * Si un mensaje es la orden de cerrar.
 *
 * Exige que el mensaje ENTERO sea la palabra, no que la contenga. «Listo,
 * mañana sigo con el segundo piso» contiene «listo» y es lo contrario de un
 * cierre: cerrar ahí le quita a la persona la forma de seguir reportando, y
 * reabrir no está en su mano.
 */
export function esCierre(texto: string | null | undefined, palabras?: string[]): boolean {
  if (!texto) return false;
  const limpio = texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // sin tildes: «terminé» y «termine»
    .toLowerCase()
    .replace(/[^a-z]/g, "");
  const lista = (palabras?.length ? palabras : CIERRES_POR_OMISION).map((p) =>
    p.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z]/g, ""),
  );
  return lista.includes(limpio);
}

/**
 * Del número que manda Meta al que guarda el repositorio.
 *
 * Meta entrega E.164 sin `+`. Se quita el indicativo para que el número viva
 * guardado de una sola forma: si unos llegan con indicativo y otros sin él,
 * buscar el caso abierto por teléfono falla la mitad de las veces.
 */
export function normalizarTelefono(de: string, indicativo: string): string | null {
  const d = (de ?? "").replace(/\D+/g, "");
  if (!d) return null;
  return d.startsWith(indicativo) ? d.slice(indicativo.length) : d;
}

/** Invitar: crea el caso y manda la plantilla. */
export async function invitar(
  dep: Dependencias,
  formulario: Formulario,
  valores: Record<string, string>,
): Promise<{ caso: Caso; enviado: boolean; error?: string }> {
  const campoTelefono = formulario.campos.find((c) => c.tipo === "telefono");
  if (!campoTelefono) {
    throw new Error(
      `El formulario «${formulario.clave}» no declara un campo de tipo «telefono», y sin él no hay a dónde escribir.`,
    );
  }
  const telefono = (valores[campoTelefono.clave] ?? "").replace(/\D+/g, "");
  if (!telefono) throw new Error(`Falta el teléfono (${campoTelefono.etiqueta}).`);

  for (const campo of formulario.campos) {
    if (campo.requerido && !(valores[campo.clave] ?? "").trim()) {
      throw new Error(`Falta ${campo.etiqueta}.`);
    }
  }

  const caso = await dep.repositorio.crearCaso({
    formulario: formulario.clave,
    telefono,
    valores: Object.fromEntries(
      formulario.campos.map((c) => [c.clave, (valores[c.clave] ?? "").trim() || null]),
    ),
  });

  // Meta **rechaza una variable vacía**, así que un campo opcional necesita su
  // valor por omisión. Se descubre tarde: con la plantilla ya aprobada y el
  // mensaje que no sale.
  const variables = formulario.plantilla.variables.map((v) => {
    const valor = (valores[v.campo] ?? "").trim();
    return valor || v.siVacio || "—";
  });

  const envio = await enviarPlantilla(dep.whatsapp, {
    telefono,
    plantilla: formulario.plantilla.nombre,
    idioma: formulario.plantilla.idioma,
    variables,
  });
  await dep.repositorio.anotarEnvio(caso.id, envio);

  if (envio.ok && envio.wamid) {
    await dep.repositorio.registrarMensaje({
      casoId: caso.id,
      wamid: envio.wamid,
      direccion: "saliente",
      tipo: "plantilla",
      texto: null,
      ocurridoEn: null,
    });
  }

  return { caso, enviado: envio.ok, error: envio.error };
}

export type ResultadoEntrante =
  | { estado: "repetido" }
  | { estado: "sin_caso" }
  | { estado: "guardado"; conFoto: boolean }
  | { estado: "cerrado" }
  | { estado: "ignorado"; motivo: string };

export async function procesarEntrante(
  dep: Dependencias,
  formulario: Formulario,
  m: MensajeEntrante,
): Promise<ResultadoEntrante> {
  const telefono = normalizarTelefono(m.de, dep.whatsapp.indicativo);
  const caso = telefono ? await dep.repositorio.casoAbiertoDe(telefono) : null;

  // 1 · Registrar SIEMPRE y PRIMERO. Si el `wamid` ya estaba, es un reintento.
  const nuevo = await dep.repositorio.registrarMensaje({
    casoId: caso?.id ?? null,
    wamid: m.wamid,
    direccion: "entrante",
    tipo: m.tipo === "text" ? "texto" : m.tipo === "image" ? "imagen" : "otro",
    texto: m.texto ?? null,
    ocurridoEn: m.ocurridoEn ?? null,
  });
  if (!nuevo) return { estado: "repetido" };
  // A un número sin caso abierto no se le contesta: sería gastar un mensaje
  // por cada quien escriba, y a un número de empresa le escribe cualquiera.
  if (!caso || !telefono) return { estado: "sin_caso" };

  // 2 · ¿Cierra?
  if (m.tipo === "text" && esCierre(m.texto, formulario.chat.palabrasDeCierre)) {
    const tiene = await dep.repositorio.contar(caso.id);
    const faltanInformes = formulario.chat.informe?.obligatorioParaCerrar && tiene.informes === 0 ? 1 : 0;
    const faltanFotos = Math.max(0, (formulario.chat.fotos?.minimoParaCerrar ?? 0) - tiene.fotos);
    if (faltanInformes || faltanFotos) {
      await acusar(dep, telefono, dep.acuses?.faltaParaCerrar?.({ informes: faltanInformes, fotos: faltanFotos }));
      return { estado: "ignorado", motivo: "cierre sin lo mínimo" };
    }
    await dep.repositorio.cerrarCaso(caso.id);
    await acusar(dep, telefono, dep.acuses?.cerrado?.());
    return { estado: "cerrado" };
  }

  // 3 · El texto. En una imagen es su pie de foto, que la gente usa para
  //     explicar lo que se ve: por eso no se descarta.
  const texto = m.texto?.trim();
  if (texto && formulario.chat.informe?.pide !== false) {
    await dep.repositorio.guardarInforme(caso.id, texto);
  }

  // 4 · La foto.
  let conFoto = false;
  if (m.tipo === "image" && m.medioId && formulario.chat.fotos?.pide !== false) {
    const medio = await descargarMedio(dep.whatsapp, m.medioId);
    if (!medio.ok) {
      await acusar(dep, telefono, "Recibí su mensaje pero no pude guardar la foto. ¿La puede enviar otra vez?");
    } else {
      const guardada = await dep.almacen.guardar({
        bytes: medio.bytes,
        contentType: medio.contentType,
        prefijo: formulario.clave,
      });
      await dep.repositorio.guardarFoto(caso.id, {
        ruta: guardada.ruta,
        contentType: medio.contentType,
        bytes: guardada.bytes,
        sha256: guardada.sha256,
      });
      conFoto = true;
    }
  }

  await acusar(dep, telefono, dep.acuses?.recibido?.({ conFoto }));
  return { estado: "guardado", conFoto };
}

/** Si el acuse falla no se propaga: lo guardado ya está guardado. */
async function acusar(dep: Dependencias, telefono: string, texto?: string): Promise<void> {
  if (!texto) return;
  const r = await enviarTexto(dep.whatsapp, { telefono, texto });
  if (!r.ok) console.warn("[enlace-dinamico-whatsapp] no se pudo acusar recibo:", r.error);
}
