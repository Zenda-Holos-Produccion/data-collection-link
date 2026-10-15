import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * El cliente de la Cloud API de WhatsApp (Meta). Sin SDK: `fetch` directo.
 *
 * NO REVIENTA CUANDO FALTA LA CONFIGURACIÓN
 * -----------------------------------------
 * Devuelve `ok:false` con el motivo y quien llama decide qué hacer —anotar el
 * caso como «no enviado» para que alguien escriba a mano, en vez de perder la
 * invitación entera—. Un canal saliente que tumba la operación porque se le
 * venció un token es peor que uno que avisa.
 *
 * LA VENTANA DE 24 HORAS NO ES UN DETALLE
 * ---------------------------------------
 * Fuera de las 24 horas desde el último mensaje de la persona, Meta **solo**
 * admite plantillas aprobadas; un texto libre se rechaza. Por eso la
 * invitación es plantilla y los acuses son texto: van dentro de la ventana que
 * la propia persona abrió al escribir.
 */

export type ConfigWhatsapp = {
  /** Token PERMANENTE de usuario de sistema. El del panel dura 24 horas. */
  token: string;
  /** El id del número emisor, no el número. */
  telefonoId: string;
  /** Para verificar la firma de los webhooks. Sin esto, cualquiera escribe. */
  secretoDeAplicacion?: string;
  /** El que se inventa al registrar el webhook y Meta devuelve. */
  tokenDeVerificacion?: string;
  /** Meta retira versiones cada par de años. */
  version?: string;
  /**
   * Indicativo del país, sin `+`. Se antepone al número guardado.
   * `57` Colombia, `52` México, `34` España…
   */
  indicativo: string;
};

const BASE = "https://graph.facebook.com";

export type Resultado = { ok: boolean; wamid?: string; error?: string };

async function llamar(cfg: ConfigWhatsapp, cuerpo: unknown): Promise<Resultado> {
  if (!cfg?.token || !cfg?.telefonoId) {
    return { ok: false, error: "WhatsApp no configurado (faltan token o telefonoId)." };
  }
  try {
    const res = await fetch(`${BASE}/${cfg.version ?? "v21.0"}/${cfg.telefonoId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(cuerpo),
    });
    const datos = await res.json().catch(() => ({}));
    if (!res.ok) {
      // El mensaje de Meta tal cual: dice por qué —plantilla sin aprobar,
      // número fuera de la lista de pruebas, ventana cerrada— y sin él un «no
      // se pudo enviar» no se puede arreglar.
      return { ok: false, error: datos?.error?.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, wamid: datos?.messages?.[0]?.id };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : "Fallo de red con WhatsApp." };
  }
}

const aE164 = (cfg: ConfigWhatsapp, telefono: string) => `${cfg.indicativo}${telefono}`;

/** La invitación: plantilla, porque la conversación la empieza quien invita. */
export function enviarPlantilla(
  cfg: ConfigWhatsapp,
  e: { telefono: string; plantilla: string; idioma?: string; variables: string[] },
): Promise<Resultado> {
  return llamar(cfg, {
    messaging_product: "whatsapp",
    to: aE164(cfg, e.telefono),
    type: "template",
    template: {
      name: e.plantilla,
      language: { code: e.idioma ?? "es" },
      components: e.variables.length
        ? [{ type: "body", parameters: e.variables.map((v) => ({ type: "text", text: v })) }]
        : [],
    },
  });
}

/** Texto libre. Solo dentro de la ventana de 24 horas que abre la persona. */
export function enviarTexto(
  cfg: ConfigWhatsapp,
  e: { telefono: string; texto: string },
): Promise<Resultado> {
  return llamar(cfg, {
    messaging_product: "whatsapp",
    to: aE164(cfg, e.telefono),
    type: "text",
    text: { preview_url: false, body: e.texto },
  });
}

/**
 * Bajar una foto del chat. Son DOS llamadas y las dos llevan el token: Meta no
 * da una URL pública. La segunda está firmada y caduca en minutos, así que
 * esto se hace al recibir el webhook y no después.
 */
export async function descargarMedio(
  cfg: ConfigWhatsapp,
  medioId: string,
): Promise<{ ok: true; bytes: Uint8Array; contentType: string } | { ok: false; error: string }> {
  if (!cfg?.token) return { ok: false, error: "WhatsApp no configurado." };
  const version = cfg.version ?? "v21.0";
  try {
    const meta = await fetch(`${BASE}/${version}/${medioId}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    const info = await meta.json().catch(() => ({}));
    if (!meta.ok || !info?.url) {
      return { ok: false, error: info?.error?.message ?? `No se pudo ubicar el medio ${medioId}.` };
    }
    const archivo = await fetch(info.url as string, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    if (!archivo.ok) return { ok: false, error: `No se pudo descargar el medio (${archivo.status}).` };
    return {
      ok: true,
      bytes: new Uint8Array(await archivo.arrayBuffer()),
      // El tipo que DECLARA Meta. Declarar no es ser: quien lo guarde debería
      // comprobar también los primeros bytes del archivo.
      contentType: (info.mime_type as string) || archivo.headers.get("content-type") || "",
    };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : "Fallo de red bajando el medio." };
  }
}

/**
 * La firma del webhook. **Sin esto, cualquiera puede inventar respuestas.**
 *
 * El webhook es una URL pública que escribe en la base y no tiene sesión que
 * la proteja: quien llama es Meta, no una persona. La firma es la única
 * puerta.
 *
 * Se calcula sobre el cuerpo CRUDO. Si se parsea el JSON y se vuelve a
 * serializar para firmarlo, un espacio de diferencia tumba la comprobación.
 *
 * La comparación es de tiempo constante a propósito: una normal se corta en el
 * primer byte distinto, y de ahí se puede ir adivinando la firma midiendo
 * cuánto tarda.
 */
export function firmaValida(
  cfg: ConfigWhatsapp,
  crudo: string,
  cabecera: string | null | undefined,
): boolean {
  const secreto = cfg?.secretoDeAplicacion;
  // Falla CERRADO: sin secreto configurado se rechaza, que es exactamente
  // cuando resulta tentador dejarlo pasar «por ahora».
  if (!secreto || !cabecera) return false;
  const esperado = cabecera.startsWith("sha256=") ? cabecera.slice(7) : cabecera;
  if (!/^[0-9a-f]{64}$/i.test(esperado)) return false;
  const calculado = createHmac("sha256", secreto).update(crudo, "utf8").digest("hex");
  const a = Buffer.from(calculado, "hex");
  const b = Buffer.from(esperado.toLowerCase(), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** La respuesta al `GET` con que Meta registra el webhook. */
export function respuestaDeVerificacion(
  cfg: ConfigWhatsapp,
  parametros: URLSearchParams,
): { ok: true; reto: string } | { ok: false } {
  const reto = parametros.get("hub.challenge");
  const esperado = cfg?.tokenDeVerificacion;
  if (
    parametros.get("hub.mode") === "subscribe" &&
    esperado &&
    parametros.get("hub.verify_token") === esperado &&
    reto
  ) {
    return { ok: true, reto };
  }
  return { ok: false };
}

export type MensajeEntrante = {
  wamid: string;
  /** En E.164 sin `+`, como lo manda Meta. */
  de: string;
  tipo: "text" | "image" | string;
  texto?: string | null;
  medioId?: string | null;
  ocurridoEn?: string | null;
};

/**
 * Saca los mensajes de la forma que usa Meta, anidada en tres niveles:
 * `entry[] → changes[] → value.messages[]`.
 *
 * Los avisos de entrega y de lectura vienen por el MISMO webhook, en
 * `value.statuses`, y se ignoran: tratarlos como mensajes crearía una
 * respuesta vacía cada vez que alguien abre el chat.
 */
export function extraerMensajes(cuerpo: unknown): MensajeEntrante[] {
  const salida: MensajeEntrante[] = [];
  const raiz = cuerpo as { entry?: unknown[] };
  for (const entrada of raiz?.entry ?? []) {
    for (const cambio of (entrada as { changes?: unknown[] })?.changes ?? []) {
      const valor = (cambio as { value?: { messages?: unknown[] } })?.value;
      for (const bruto of valor?.messages ?? []) {
        const m = bruto as {
          id?: string;
          from?: string;
          type?: string;
          timestamp?: string;
          text?: { body?: string };
          image?: { id?: string; caption?: string };
        };
        if (!m?.id || !m?.from) continue;
        salida.push({
          wamid: m.id,
          de: m.from,
          tipo: m.type ?? "otro",
          // El pie de una foto es texto que la persona escribió para explicar
          // lo que se ve: se conserva.
          texto: m.type === "image" ? (m.image?.caption ?? null) : (m.text?.body ?? null),
          medioId: m.image?.id ?? null,
          // Meta lo manda en segundos.
          ocurridoEn: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : null,
        });
      }
    }
  }
  return salida;
}
