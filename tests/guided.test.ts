import { afterEach, describe, expect, it, vi } from "vitest";
import type { InboundMessage } from "../src/channel.js";
import {
  advance,
  guidedAnswers,
  guidedRemembered,
  parseGuidedNumber,
  startGuided,
  validateGuided,
  type GuidedContext,
  type GuidedOutput,
  type GuidedState,
  type GuidedTemplate,
} from "../src/guided.js";
import { renderTelegram } from "../src/telegram.js";

/**
 * The guided conversation engine, on a dispatch template like the one the PMU
 * uses for humanitarian aid (doc 26 of pmu-sismo-prod): location, origin,
 * destination, items, weight, photos, and a handoff for the personal data.
 *
 * Every turn goes through `talk`, which stores the state as JSON between
 * messages — as a host does in a database row — and checks that nothing is
 * lost on the way and that `advance` does not touch the state it is given.
 */

afterEach(() => vi.restoreAllMocks());

const DESPACHO: GuidedTemplate = {
  key: "despacho",
  locale: "es-CO",
  texts: {
    invalid: "No entendí esa respuesta.",
    cancelled: "Cancelé el borrador. No se registró nada.",
    useRemembered: "Usar: {value}",
    skip: "Omitir",
    summary: "Lo que llevas:",
    nothingBack: "Esta es la primera pregunta.",
    stale: "Ese botón es de una pregunta anterior.",
  },
  steps: [
    {
      id: "ubicacion",
      type: "location",
      label: "Ubicación",
      question: "Comparte tu ubicación para ubicar el destino.",
      button: "📍 Compartir ubicación",
      alternatives: ["No puedo compartirla"],
      resolver: "territorio",
      confirm: {
        question: "Estás en {latitude} {longitude}: barrio {barrio}, {division}. ¿Es el lugar de la entrega?",
        yes: "Sí",
        no: "No, es otro lugar",
      },
      unresolved: "No encontré ese punto en Cali.",
      summary: "barrio {barrio}, {division}",
      invalid: "Necesito la ubicación: toca el botón, o «No puedo compartirla».",
    },
    {
      id: "division",
      type: "choice",
      label: "Comuna o corregimiento",
      question: "¿Comuna o corregimiento?",
      catalog: "divisiones",
      columns: 3,
      skipIf: { answer: "ubicacion.status", equals: "confirmed" },
      invalid: "Escoge una de la lista.",
    },
    { id: "punto", type: "choice", label: "Punto", question: "¿Desde qué punto sale?", catalog: "puntos", remember: true },
    {
      id: "tipo_destino",
      type: "choice",
      label: "Tipo de destino",
      question: "¿Qué clase de lugar es el destino?",
      columns: 2,
      options: [
        { value: "albergue", label: "Albergue" },
        { value: "barrio", label: "Punto de barrio" },
        { value: "hospital", label: "Hospital" },
      ],
    },
    {
      id: "destino",
      type: "text",
      label: "Destino",
      question: "¿Cómo se llama el lugar?",
      minLength: 3,
      maxLength: 120,
      invalid: "Escribe el nombre del lugar, de 3 letras o más.",
    },
    { id: "quien_entrega", type: "text", label: "Entrega", question: "¿Cuál es tu nombre?", remember: true, minLength: 3, maxLength: 80 },
    {
      id: "items",
      type: "list",
      label: "Artículos",
      question: "Ahora los artículos, uno por uno.",
      minItems: 1,
      maxItems: 20,
      more: { question: "Llevas {count}. ¿Otro artículo?", add: "Agregar otro", done: "Listo" },
      steps: [
        { id: "categoria", type: "choice", label: "Categoría", question: "Artículo {n}: ¿de qué categoría?", catalog: "categorias", columns: 2 },
        {
          id: "cantidad",
          type: "number",
          label: "Cantidad",
          question: "¿Cuántos?",
          positive: true,
          invalid: "Escribe una cantidad mayor que cero, como 20 o 2,5.",
        },
        { id: "unidad", type: "choice", label: "Unidad", question: "¿En qué unidad?", catalog: "unidades", columns: 3 },
      ],
    },
    {
      id: "unidad_peso",
      type: "choice",
      label: "Peso en",
      question: "¿Cuánto pesa en total?",
      options: [
        { value: "kg", label: "En kilos" },
        { value: "t", label: "En toneladas" },
        { value: "no_se", label: "No puedo calcularlo" },
      ],
    },
    {
      id: "peso_kg",
      type: "number",
      label: "Peso (kg)",
      question: "¿Cuántos kilos?",
      positive: true,
      max: 40_000,
      skipIf: { not: { answer: "unidad_peso", equals: "kg" } },
      invalid: "Escribe un peso entre 0 y 40.000 kg.",
    },
    {
      id: "peso_t",
      type: "number",
      label: "Peso (t)",
      question: "¿Cuántas toneladas?",
      positive: true,
      max: 40,
      thousandsDot: false,
      skipIf: { not: { answer: "unidad_peso", equals: "t" } },
      invalid: "Escribe un peso entre 0 y 40 toneladas.",
    },
    {
      id: "fotos",
      type: "photos",
      label: "Fotos de la carga",
      question: "Manda las fotos de lo que se entrega, hasta {max}. Cuando termines, toca Listo.",
      min: 1,
      max: 12,
      done: "Listo",
      received: "Van {count} de {max}.",
      invalid: "Manda al menos una foto de la carga.",
    },
    { id: "resumen", type: "summary", question: "Lo que llevas:" },
    {
      id: "receptor",
      type: "handoff",
      question: "Falta quien recibe y el acta. Se llenan en una pantalla protegida: no quedan en este chat.",
      button: "Completar datos de quien recibe",
      link: "pantalla",
    },
  ],
};

const URL_WITH_TOKEN = "https://pmu.example/f/tok_abc123?paso=receptor";

const ctx: GuidedContext = {
  catalogs: {
    divisiones: [
      { value: "c18", label: "Comuna 18" },
      { value: "c19", label: "Comuna 19" },
      { value: "c20", label: "Comuna 20" },
      { value: "pance", label: "Pance" },
    ],
    puntos: [
      { value: "petronio", label: "Petronio Álvarez" },
      { value: "coliseo", label: "Coliseo del Pueblo" },
    ],
    categorias: [
      { value: "alimentos", label: "Alimentos" },
      { value: "agua", label: "Agua" },
      { value: "aseo", label: "Aseo" },
    ],
    unidades: [
      { value: "caja", label: "Cajas" },
      { value: "litro", label: "Litros" },
      { value: "kit", label: "Kits" },
    ],
  },
  // What a host's query to its own polygons would answer: inside Cali, a
  // barrio and its comuna; outside, nothing.
  resolvers: {
    territorio: async ({ latitude }) =>
      latitude > 3.3 && latitude < 3.6 ? { barrio: "Meléndez", division: "comuna 18", division_codigo: "c18" } : null,
  },
  links: { pantalla: URL_WITH_TOKEN },
};

// ── Inbound messages, as extractUpdate builds them ──────────────────────

const CHAT = "770077";
let seq = 0;
const base = () => ({ channel: "telegram" as const, id: `${CHAT}:${++seq}`, from: CHAT });
const text = (t: string): InboundMessage => ({ ...base(), type: "text", text: t });
const tap = (data: string): InboundMessage => {
  const b = base();
  return { ...b, type: "choice", text: null, choice: data, callbackId: `cbq-${seq}` };
};
const place = (latitude: number, longitude: number, accuracyMeters?: number): InboundMessage => ({
  ...base(),
  type: "location",
  text: null,
  location: { latitude, longitude, ...(accuracyMeters !== undefined ? { accuracyMeters } : {}) },
});
const photo = (fileId: string, caption?: string): InboundMessage => ({ ...base(), type: "image", text: caption ?? null, mediaId: fileId });
const reopen = (): InboundMessage => ({ ...base(), type: "text", text: null, start: "tok_abc123" });

/** The outputs a recipient sees: the acknowledgement of a tap is not a message. */
const shown = (outputs: GuidedOutput[]) => outputs.filter((o) => o.kind !== "ack");
const textOf = (outputs: GuidedOutput[]) => shown(outputs).map((o) => ("text" in o ? o.text : ""));

/** A conversation as a host runs it, the state going through JSON between messages. */
async function talk(template: GuidedTemplate = DESPACHO, c: GuidedContext = ctx) {
  const started = await startGuided(template, c);
  let state: GuidedState = started.state;
  return {
    first: started.outputs,
    get state() {
      return state;
    },
    async say(input: InboundMessage): Promise<GuidedOutput[]> {
      const stored = JSON.stringify(state);
      const loaded = JSON.parse(stored) as GuidedState;
      expect(loaded, "the state survives JSON unchanged").toStrictEqual(state);
      const r = await advance(loaded, template, input, c);
      expect(JSON.stringify(loaded), "advance does not modify the state it is given").toBe(stored);
      state = r.state;
      return r.outputs;
    },
  };
}

type Talk = Awaited<ReturnType<typeof talk>>;

/** Confirmed location, origin, destination and name: the conversation waits on the first item. */
async function upToItems(c: Talk) {
  await c.say(place(3.4516, -76.532, 25));
  await c.say(tap("ubicacion!yes"));
  await c.say(tap("punto:petronio"));
  await c.say(tap("tipo_destino:albergue"));
  await c.say(text("Coliseo El Pueblo"));
  await c.say(text("Jorge Castaño"));
}

describe("the template", () => {
  it("1 · the dispatch template is valid, with the real catalogs, resolver and link", () => {
    expect(validateGuided(DESPACHO)).toEqual([]);
    expect(validateGuided(DESPACHO, ctx)).toEqual([]);
  });

  it("2 · validateGuided names what is wrong", () => {
    const broken: GuidedTemplate = {
      key: "roto",
      texts: { invalid: "?", cancelled: "x" },
      steps: [
        { id: "a", type: "text", question: "A", optional: true, skipIf: { answer: "b", equals: "x" } },
        { id: "b", type: "choice", question: "B", options: [{ value: "1", label: "Uno" }], catalog: "otro", remember: true },
        { id: "a", type: "number", question: "C", min: 10, max: 1 },
        { id: "fin", type: "handoff", question: "D", button: "Abrir", link: "pantalla" },
        { id: "lugar", type: "location", question: "E", button: "Compartir", confirm: { question: "?", yes: "Sí", no: "No" } },
        {
          id: "cosas",
          type: "list",
          question: "F",
          steps: [{ id: "x", type: "text", question: "G", remember: true }],
          more: { question: "¿Otro?", add: "Listo", done: "listo" },
        },
        { id: "fotos", type: "photos", question: "H", min: 3, max: 2, done: "Listo" },
      ],
    };
    const rules = validateGuided(broken).map((i) => i.rule);
    expect(rules).toEqual(
      expect.arrayContaining(["texts", "skipIf", "choice", "id", "number", "handoff", "location", "remember", "list", "photos"]),
    );
    const details = validateGuided(broken).map((i) => i.detail).join("\n");
    expect(details).toContain("texts.skip");
    expect(details).toContain("texts.useRemembered");
    expect(details).toContain('skipIf reads "b", which is not an earlier step');
    expect(details).toContain("the last step");
  });

  it("3 · an option whose button data exceeds 64 bytes is caught, in bytes, for fixed options and for catalogs", () => {
    // 30 characters, 60 bytes: "ñ" takes two. With "tipo:" it is 65.
    const long = "ñ".repeat(30);
    const t: GuidedTemplate = {
      key: "largo",
      texts: { invalid: "?", cancelled: "x" },
      steps: [
        { id: "tipo", type: "choice", question: "¿Cuál?", options: [{ value: long, label: "Largo" }] },
        { id: "cat", type: "choice", question: "¿Cuál?", catalog: "c" },
      ],
    };
    expect(validateGuided(t)).toEqual([expect.objectContaining({ rule: "callback-data", detail: expect.stringContaining("65 bytes") })]);
    const issues = validateGuided({ ...t, steps: [t.steps[1]!] }, { catalogs: { c: [{ value: "x".repeat(62), label: "Otro" }] } });
    expect(issues).toEqual([expect.objectContaining({ rule: "callback-data", detail: expect.stringContaining("66 bytes") })]);
  });
});

describe("a whole dispatch", () => {
  it("4 · location confirmed → origin → destination → name → 2 items → weight → 2 photos → handoff", async () => {
    const c = await talk(DESPACHO, { ...ctx, remembered: { punto: "petronio", quien_entrega: "Ana María Ruiz" } });
    expect(c.first).toEqual([
      {
        kind: "location",
        text: "Comparte tu ubicación para ubicar el destino.",
        button: "📍 Compartir ubicación",
        alternatives: ["No puedo compartirla"],
      },
    ]);

    // The host's resolver names the place; the recipient confirms it.
    expect(await c.say(place(3.4516, -76.532, 25))).toEqual([
      {
        kind: "choices",
        text: "Estás en 3,4516 -76,5320: barrio Meléndez, comuna 18. ¿Es el lugar de la entrega?",
        rows: [[{ text: "Sí", data: "ubicacion!yes" }, { text: "No, es otro lugar", data: "ubicacion!no" }]],
      },
    ]);

    // Confirmed: the comuna is known, so it is not asked. The tap is
    // acknowledged first, and the origin this chat used last time is offered.
    const origin = await c.say(tap("ubicacion!yes"));
    expect(origin[0]).toEqual({ kind: "ack", callbackId: expect.stringMatching(/^cbq-/) });
    expect(shown(origin)).toEqual([
      {
        kind: "choices",
        text: "¿Desde qué punto sale?",
        rows: [
          [{ text: "Usar: Petronio Álvarez", data: "punto!remembered" }],
          [{ text: "Petronio Álvarez", data: "punto:petronio" }],
          [{ text: "Coliseo del Pueblo", data: "punto:coliseo" }],
        ],
      },
    ]);

    expect(shown(await c.say(tap("punto!remembered")))).toEqual([
      {
        kind: "choices",
        text: "¿Qué clase de lugar es el destino?",
        rows: [
          [{ text: "Albergue", data: "tipo_destino:albergue" }, { text: "Punto de barrio", data: "tipo_destino:barrio" }],
          [{ text: "Hospital", data: "tipo_destino:hospital" }],
        ],
      },
    ]);
    expect(shown(await c.say(tap("tipo_destino:albergue")))).toEqual([
      { kind: "text", text: "¿Cómo se llama el lugar?", removeKeyboard: true },
    ]);
    expect(await c.say(text("Coliseo El Pueblo"))).toEqual([
      { kind: "choices", text: "¿Cuál es tu nombre?", rows: [[{ text: "Usar: Ana María Ruiz", data: "quien_entrega!remembered" }]] },
    ]);

    // A name typed instead of the remembered one: it is the one kept.
    expect(await c.say(text("Jorge Castaño"))).toEqual([
      {
        kind: "choices",
        text: "Ahora los artículos, uno por uno.\n\nArtículo 1: ¿de qué categoría?",
        rows: [
          [{ text: "Alimentos", data: "items.categoria:alimentos" }, { text: "Agua", data: "items.categoria:agua" }],
          [{ text: "Aseo", data: "items.categoria:aseo" }],
        ],
      },
    ]);
    expect(shown(await c.say(tap("items.categoria:alimentos")))).toEqual([{ kind: "text", text: "¿Cuántos?", removeKeyboard: true }]);
    expect(await c.say(text("20"))).toEqual([
      {
        kind: "choices",
        text: "¿En qué unidad?",
        rows: [
          [
            { text: "Cajas", data: "items.unidad:caja" },
            { text: "Litros", data: "items.unidad:litro" },
            { text: "Kits", data: "items.unidad:kit" },
          ],
        ],
      },
    ]);
    expect(shown(await c.say(tap("items.unidad:caja")))).toEqual([
      {
        kind: "choices",
        text: "Llevas 1. ¿Otro artículo?",
        rows: [[{ text: "Agregar otro", data: "items!add" }, { text: "Listo", data: "items!done" }]],
      },
    ]);
    expect(textOf(await c.say(tap("items!add")))).toEqual(["Artículo 2: ¿de qué categoría?"]);
    await c.say(tap("items.categoria:agua"));
    await c.say(text("50"));
    expect(textOf(await c.say(tap("items.unidad:litro")))).toEqual(["Llevas 2. ¿Otro artículo?"]);

    expect(shown(await c.say(tap("items!done")))).toEqual([
      {
        kind: "choices",
        text: "¿Cuánto pesa en total?",
        rows: [
          [{ text: "En kilos", data: "unidad_peso:kg" }],
          [{ text: "En toneladas", data: "unidad_peso:t" }],
          [{ text: "No puedo calcularlo", data: "unidad_peso:no_se" }],
        ],
      },
    ]);
    // In kilos, so the weight in tons is skipped.
    expect(textOf(await c.say(tap("unidad_peso:kg")))).toEqual(["¿Cuántos kilos?"]);
    // «1.200,5»: a thousands dot and a decimal comma.
    expect(await c.say(text("1.200,5"))).toEqual([
      {
        kind: "choices",
        text: "Manda las fotos de lo que se entrega, hasta 12. Cuando termines, toca Listo.",
        rows: [[{ text: "Listo", data: "fotos!done" }]],
      },
    ]);
    // A caption may say anything — here, personal data nobody asked for.
    expect(await c.say(photo("file-1", "Recibe Juan Pérez, cédula 123"))).toEqual([
      { kind: "choices", text: "Van 1 de 12.", rows: [[{ text: "Listo", data: "fotos!done" }]] },
    ]);
    expect(textOf(await c.say(photo("file-2")))).toEqual(["Van 2 de 12."]);

    // Done: the summary, then the page for what does not go through the chat.
    const end = await c.say(tap("fotos!done"));
    expect(shown(end)).toEqual([
      {
        kind: "text",
        removeKeyboard: true,
        text: [
          "Lo que llevas:",
          "",
          "Ubicación: barrio Meléndez, comuna 18",
          "Punto: Petronio Álvarez",
          "Tipo de destino: Albergue",
          "Destino: Coliseo El Pueblo",
          "Entrega: Jorge Castaño",
          "Artículos:",
          "1. Alimentos, 20, Cajas",
          "2. Agua, 50, Litros",
          "Peso en: En kilos",
          "Peso (kg): 1.200,5",
          "Fotos de la carga: 2",
        ].join("\n"),
      },
      {
        kind: "webapp",
        text: "Falta quien recibe y el acta. Se llenan en una pantalla protegida: no quedan en este chat.",
        button: { text: "Completar datos de quien recibe", url: URL_WITH_TOKEN },
      },
    ]);
    expect(c.state.status).toBe("handed_off");

    expect(guidedAnswers(c.state)).toStrictEqual({
      ubicacion: {
        status: "confirmed",
        latitude: 3.4516,
        longitude: -76.532,
        accuracyMeters: 25,
        place: { barrio: "Meléndez", division: "comuna 18", division_codigo: "c18" },
      },
      punto: "petronio",
      tipo_destino: "albergue",
      destino: "Coliseo El Pueblo",
      quien_entrega: "Jorge Castaño",
      items: [
        { categoria: "alimentos", cantidad: 20, unidad: "caja" },
        { categoria: "agua", cantidad: 50, unidad: "litro" },
      ],
      unidad_peso: "kg",
      peso_kg: 1200.5,
      fotos: ["file-1", "file-2"],
    });
    expect(guidedRemembered(DESPACHO, c.state)).toEqual({ punto: "petronio", quien_entrega: "Jorge Castaño" });

    // The state holds the answers and nothing else: not the chat, not the
    // taps, not the link and its token, not the caption.
    const json = JSON.stringify(c.state);
    for (const absent of [CHAT, "cbq-", "pmu.example", "tok_abc123", "Juan Pérez", "cédula"]) expect(json).not.toContain(absent);

    // After the handoff, anything but a command shows the button again.
    expect(shown(await c.say(text("¿Y ahora?")))).toEqual([shown(end)[1]]);
    expect(c.state.status).toBe("handed_off");
  });

  it("5 · the outputs reach Telegram in order, one call each", async () => {
    const c = await talk();
    await upToItems(c);
    await c.say(tap("items.categoria:aseo"));
    await c.say(text("3"));
    await c.say(tap("items.unidad:kit"));
    await c.say(tap("items!done"));
    await c.say(tap("unidad_peso:no_se"));
    await c.say(photo("file-1"));
    const end = await c.say(tap("fotos!done"));

    const spy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () => Response.json({ ok: true, result: { message_id: spy.mock.calls.length } }));
    const r = await renderTelegram({ token: "123:SECRET", username: "pmu_bot" }, CHAT, end);
    expect(r).toEqual({ ok: true, messageIds: [`${CHAT}:2`, `${CHAT}:3`] });
    const calls = spy.mock.calls.map(([url, init]) => ({
      method: String(url).split("/").pop(),
      body: JSON.parse((init as RequestInit).body as string),
    }));
    expect(calls.map((x) => x.method)).toEqual(["answerCallbackQuery", "sendMessage", "sendMessage"]);
    expect(calls[1]?.body.text).toContain("No puedo calcularlo");
    expect(calls[2]?.body.reply_markup).toEqual({
      inline_keyboard: [[{ text: "Completar datos de quien recibe", web_app: { url: URL_WITH_TOKEN } }]],
    });
  });
});

describe("the location", () => {
  it("6 · without a location: the alternative, then the comuna by buttons", async () => {
    const c = await talk();
    expect(await c.say(text("No puedo compartirla"))).toEqual([
      {
        kind: "choices",
        text: "¿Comuna o corregimiento?",
        rows: [
          [
            { text: "Comuna 18", data: "division:c18" },
            { text: "Comuna 19", data: "division:c19" },
            { text: "Comuna 20", data: "division:c20" },
          ],
          [{ text: "Pance", data: "division:pance" }],
        ],
      },
    ]);
    // The label typed works as the button does, whatever its case and accents.
    expect(textOf(await c.say(text("  comuna 19 ")))).toEqual(["¿Desde qué punto sale?"]);
    expect(guidedAnswers(c.state)).toStrictEqual({
      ubicacion: { status: "declined", alternative: "No puedo compartirla" },
      division: "c19",
    });
  });

  it("7 · «no, es otro lugar» drops the point and asks the comuna", async () => {
    const c = await talk();
    await c.say(place(3.4516, -76.532));
    expect(textOf(await c.say(tap("ubicacion!no")))).toEqual(["¿Comuna o corregimiento?"]);
    expect(guidedAnswers(c.state).ubicacion).toStrictEqual({ status: "rejected" });
    // Not in the answers, nor in the history kept for going back.
    expect(JSON.stringify(c.state)).not.toContain("3.4516");
    expect(JSON.stringify(c.state)).not.toContain("Meléndez");
    // So back from the comuna asks for the location again, not the confirmation.
    expect(textOf(await c.say(text("/atras")))).toEqual(["Comparte tu ubicación para ubicar el destino."]);
  });

  it("8 · a point the resolver does not know is kept, said, and the comuna is asked", async () => {
    const c = await talk();
    expect(textOf(await c.say(place(4.711, -74.072, 12)))).toEqual(["No encontré ese punto en Cali.", "¿Comuna o corregimiento?"]);
    expect(guidedAnswers(c.state).ubicacion).toStrictEqual({ status: "unresolved", latitude: 4.711, longitude: -74.072, accuracyMeters: 12 });
  });

  it("9 · a resolver that fails does not strand the recipient", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const failing: GuidedContext = {
      ...ctx,
      resolvers: {
        territorio: async () => {
          throw new Error("connection refused");
        },
      },
    };
    const c = await talk(DESPACHO, failing);
    expect(textOf(await c.say(place(3.4516, -76.532)))).toEqual(["No encontré ese punto en Cali.", "¿Comuna o corregimiento?"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("resolver"), "connection refused");
  });

  it("10 · a new location replaces the one waiting; «sí» typed confirms as the button does", async () => {
    const c = await talk();
    await c.say(place(3.4, -76.5));
    expect(textOf(await c.say(place(3.4516, -76.532, 8)))).toEqual([
      "Estás en 3,4516 -76,5320: barrio Meléndez, comuna 18. ¿Es el lugar de la entrega?",
    ]);
    expect(textOf(await c.say(text("SÍ")))).toEqual(["¿Desde qué punto sale?"]);
    expect(guidedAnswers(c.state).ubicacion).toMatchObject({ status: "confirmed", latitude: 3.4516, accuracyMeters: 8 });
  });

  it("11 · without a resolver the point is simply kept", async () => {
    const t: GuidedTemplate = {
      key: "simple",
      texts: { invalid: "?", cancelled: "x" },
      steps: [
        { id: "donde", type: "location", question: "¿Dónde?", button: "Compartir" },
        { id: "nota", type: "text", question: "¿Algo más?" },
      ],
    };
    const c = await talk(t, {});
    await c.say(place(3.45, -76.53));
    expect(guidedAnswers(c.state)).toStrictEqual({ donde: { status: "shared", latitude: 3.45, longitude: -76.53 } });
  });
});

describe("going back", () => {
  it("12 · /atras in the middle of the list walks back item step by item step", async () => {
    const c = await talk();
    await upToItems(c);
    await c.say(tap("items.categoria:alimentos"));
    await c.say(text("20"));
    await c.say(tap("items.unidad:caja"));
    await c.say(tap("items!add"));
    expect(textOf(await c.say(tap("items.categoria:agua")))).toEqual(["¿Cuántos?"]);

    expect(textOf(await c.say(text("/atras")))).toEqual(["Artículo 2: ¿de qué categoría?"]);
    expect(textOf(await c.say(text("/atras")))).toEqual(["Llevas 1. ¿Otro artículo?"]);
    // Back into the first item: it leaves the answers and is the draft again.
    expect(textOf(await c.say(text("/atras")))).toEqual(["¿En qué unidad?"]);
    expect(c.state.answers.items).toBeUndefined();
    expect(c.state.item).toEqual({ categoria: "alimentos", cantidad: 20 });

    await c.say(tap("items.unidad:kit"));
    expect(textOf(await c.say(tap("items!done")))).toEqual(["¿Cuánto pesa en total?"]);
    expect(guidedAnswers(c.state).items).toEqual([{ categoria: "alimentos", cantidad: 20, unidad: "kit" }]);
  });

  it("13 · /atras returns to the previous question asked, not to a skipped one", async () => {
    const c = await talk();
    await c.say(place(3.4516, -76.532));
    await c.say(tap("ubicacion!yes"));
    // The comuna was skipped: back goes to the confirmation.
    expect(textOf(await c.say(text("/atras")))).toEqual([
      "Estás en 3,4516 -76,5320: barrio Meléndez, comuna 18. ¿Es el lugar de la entrega?",
    ]);
    expect(guidedAnswers(c.state)).toEqual({});
    expect(textOf(await c.say(text("/Atrás")))).toEqual(["Comparte tu ubicación para ubicar el destino."]);
    expect(textOf(await c.say(text("/atras@pmu_bot")))).toEqual([
      "Esta es la primera pregunta.\n\nComparte tu ubicación para ubicar el destino.",
    ]);
    // This time the point is not the place: the comuna is asked, and back
    // from the origin now goes to it.
    await c.say(place(3.4516, -76.532));
    await c.say(tap("ubicacion!no"));
    await c.say(tap("division:c20"));
    expect(textOf(await c.say(text("/atras")))).toEqual(["¿Comuna o corregimiento?"]);
  });

  it("14 · /atras after the handoff reopens the photos, which start over", async () => {
    const c = await talk();
    await upToItems(c);
    await c.say(tap("items.categoria:aseo"));
    await c.say(text("3"));
    await c.say(tap("items.unidad:kit"));
    await c.say(tap("items!done"));
    await c.say(tap("unidad_peso:t"));
    await c.say(text("1.200"));
    await c.say(photo("file-1"));
    await c.say(tap("fotos!done"));
    expect(c.state.status).toBe("handed_off");
    // In tons a dot is a decimal point: «1.200» is 1.2.
    expect(guidedAnswers(c.state).peso_t).toBe(1.2);

    expect(textOf(await c.say(text("/atras")))).toEqual([
      "Manda las fotos de lo que se entrega, hasta 12. Cuando termines, toca Listo.",
    ]);
    expect(c.state.status).toBe("active");
    expect(c.state.answers.fotos).toBeUndefined();
  });
});

describe("cancelling and resuming", () => {
  it("15 · /cancelar ends the conversation; nothing else moves it", async () => {
    const c = await talk();
    await upToItems(c);
    expect(await c.say(text("/CANCELAR"))).toEqual([{ kind: "text", text: "Cancelé el borrador. No se registró nada.", removeKeyboard: true }]);
    expect(c.state).toMatchObject({ status: "cancelled", at: null, history: [] });
    expect(await c.say(text("Hola"))).toEqual([]);
    // A tap is still answered, so the button stops spinning.
    expect(await c.say(tap("items.categoria:agua"))).toEqual([{ kind: "ack", callbackId: expect.any(String) }]);
    expect(await c.say(text("/atras"))).toEqual([]);
  });

  it("16 · a template can rename the commands", async () => {
    const t: GuidedTemplate = { ...DESPACHO, commands: { back: "/volver", cancel: "/salir" } };
    const c = await talk(t);
    expect(textOf(await c.say(text("/cancelar")))).toEqual([
      "Necesito la ubicación: toca el botón, o «No puedo compartirla».\n\nComparte tu ubicación para ubicar el destino.",
    ]);
    await c.say(text("/salir"));
    expect(c.state.status).toBe("cancelled");
  });

  it("17 · /resumen shows what is filled and asks the question again", async () => {
    const c = await talk();
    await upToItems(c);
    await c.say(tap("items.categoria:agua"));
    expect(textOf(await c.say(text("/resumen")))).toEqual([
      [
        "Lo que llevas:",
        "",
        "Ubicación: barrio Meléndez, comuna 18",
        "Punto: Petronio Álvarez",
        "Tipo de destino: Albergue",
        "Destino: Coliseo El Pueblo",
        "Entrega: Jorge Castaño",
      ].join("\n"),
      "¿Cuántos?",
    ]);
  });

  it("18 · opening the link again resumes where the conversation was", async () => {
    const c = await talk();
    await upToItems(c);
    expect(textOf(await c.say(reopen()))).toEqual(["Artículo 1: ¿de qué categoría?"]);
    expect(guidedAnswers(c.state)).toMatchObject({ destino: "Coliseo El Pueblo", quien_entrega: "Jorge Castaño" });
  });
});

describe("inputs that do not fit", () => {
  it("19 · each repeats the question after a short explanation", async () => {
    const c = await talk();
    // A photo, or a text that is not an alternative, when the location is asked.
    for (const wrong of [photo("file-x"), text("Barrio El Retiro")]) {
      expect(await c.say(wrong)).toEqual([
        {
          kind: "location",
          text: "Necesito la ubicación: toca el botón, o «No puedo compartirla».\n\nComparte tu ubicación para ubicar el destino.",
          button: "📍 Compartir ubicación",
          alternatives: ["No puedo compartirla"],
        },
      ]);
    }
    await c.say(text("No puedo compartirla"));
    // A text that is not an option; a location when a choice is asked.
    expect(textOf(await c.say(text("Comuna 99")))).toEqual(["Escoge una de la lista.\n\n¿Comuna o corregimiento?"]);
    expect(textOf(await c.say(place(3.45, -76.53)))).toEqual(["Escoge una de la lista.\n\n¿Comuna o corregimiento?"]);
    await c.say(tap("division:c18"));
    await c.say(tap("punto:coliseo"));
    // A photo when a choice is asked: the step has no `invalid`, so the template's.
    expect(textOf(await c.say(photo("file-y")))).toEqual(["No entendí esa respuesta.\n\n¿Qué clase de lugar es el destino?"]);
    await c.say(tap("tipo_destino:hospital"));
    // Too short a name; a location when a text is asked.
    expect(textOf(await c.say(text("ab")))).toEqual(["Escribe el nombre del lugar, de 3 letras o más.\n\n¿Cómo se llama el lugar?"]);
    expect(textOf(await c.say(place(3.45, -76.53)))).toEqual(["Escribe el nombre del lugar, de 3 letras o más.\n\n¿Cómo se llama el lugar?"]);
    await c.say(text("Hospital Departamental"));
    await c.say(text("Jorge Castaño"));
    await c.say(tap("items.categoria:agua"));
    // Not a number, zero, and a photo, when a quantity is asked.
    for (const wrong of [text("veinte"), text("0"), photo("file-z")]) {
      expect(textOf(await c.say(wrong))).toEqual(["Escribe una cantidad mayor que cero, como 20 o 2,5.\n\n¿Cuántos?"]);
    }
    expect(textOf(await c.say(text("2,5")))).toEqual(["¿En qué unidad?"]);
    await c.say(tap("items.unidad:litro"));
    await c.say(tap("items!done"));
    await c.say(tap("unidad_peso:kg"));
    // Over the maximum: «50.000» kg is 50000.
    expect(textOf(await c.say(text("50.000")))).toEqual(["Escribe un peso entre 0 y 40.000 kg.\n\n¿Cuántos kilos?"]);
    await c.say(text("800"));
    // Done before any photo; a text when photos are asked.
    expect(textOf(await c.say(tap("fotos!done")))).toEqual([
      "Manda al menos una foto de la carga.\n\nManda las fotos de lo que se entrega, hasta 12. Cuando termines, toca Listo.",
    ]);
    expect(textOf(await c.say(text("ya van")))).toEqual([
      "Manda al menos una foto de la carga.\n\nManda las fotos de lo que se entrega, hasta 12. Cuando termines, toca Listo.",
    ]);
    await c.say(photo("file-1"));
    // «listo» typed is the button.
    expect(shown(await c.say(text("listo"))).map((o) => o.kind)).toEqual(["text", "webapp"]);
    expect(guidedAnswers(c.state)).toMatchObject({ items: [{ categoria: "agua", cantidad: 2.5, unidad: "litro" }], peso_kg: 800, fotos: ["file-1"] });
  });

  it("20 · a button from an earlier question is not taken as an answer", async () => {
    const c = await talk();
    await upToItems(c);
    // The origin's button, tapped while the first item is asked.
    const r = await c.say(tap("punto:coliseo"));
    expect(r[0]?.kind).toBe("ack");
    expect(textOf(r)).toEqual(["Ese botón es de una pregunta anterior.\n\nArtículo 1: ¿de qué categoría?"]);
    expect(guidedAnswers(c.state).punto).toBe("petronio");
    // Nor is a button whose data the engine did not write.
    expect(textOf(await c.say(tap("modo:guiado")))).toEqual(["Ese botón es de una pregunta anterior.\n\nArtículo 1: ¿de qué categoría?"]);
    // An option of this question that is not in the catalog is refused, not stale.
    expect(textOf(await c.say(tap("items.categoria:armas")))).toEqual(["No entendí esa respuesta.\n\nArtículo 1: ¿de qué categoría?"]);
  });

  it("21 · a remembered value that no longer fits is not offered, nor accepted", async () => {
    const c = await talk(DESPACHO, { ...ctx, remembered: { punto: "cerrado" } });
    await c.say(place(3.4516, -76.532));
    const origin = await c.say(tap("ubicacion!yes"));
    expect(shown(origin)[0]).toMatchObject({ rows: [[{ data: "punto:petronio" }], [{ data: "punto:coliseo" }]] });
    expect(textOf(await c.say(tap("punto!remembered")))).toEqual(["No entendí esa respuesta.\n\n¿Desde qué punto sale?"]);
  });
});

describe("numbers", () => {
  it("22 · comma decimals and dot thousands, as written in Colombia", () => {
    const cases: [string, number | null][] = [
      ["1.200,5", 1200.5],
      ["1.200", 1200],
      ["12.500.000", 12_500_000],
      ["2,5", 2.5],
      ["2.5", 2.5],
      ["0.250", 0.25],
      [" 1 200 ", 1200],
      ["-3", -3],
      ["20", 20],
      ["1,200,000", null],
      ["1.2.3", null],
      ["1.20,5", null],
      ["veinte", null],
      ["", null],
      [",5", null],
    ];
    for (const [typed, expected] of cases) expect(parseGuidedNumber(typed), `«${typed}»`).toBe(expected);
  });

  it("23 · where a dot is a decimal point, «1.200» is 1.2", () => {
    expect(parseGuidedNumber("1.200", false)).toBe(1.2);
    expect(parseGuidedNumber("1,25", false)).toBe(1.25);
    expect(parseGuidedNumber("1.200,5", false)).toBeNull();
  });

  it("24 · whole numbers and ranges are enforced", async () => {
    const t: GuidedTemplate = {
      key: "n",
      texts: { invalid: "No.", cancelled: "x" },
      steps: [
        { id: "personas", type: "number", question: "¿Cuántas personas?", integer: true, min: 1, max: 500 },
        { id: "nota", type: "text", question: "¿Algo más?" },
      ],
    };
    const c = await talk(t, {});
    for (const wrong of ["2,5", "0", "501"]) expect(textOf(await c.say(text(wrong)))).toEqual(["No.\n\n¿Cuántas personas?"]);
    await c.say(text("120"));
    expect(guidedAnswers(c.state)).toEqual({ personas: 120 });
  });
});

describe("button data", () => {
  it("25 · a catalog value too long for a button is refused before reaching Telegram", async () => {
    const t: GuidedTemplate = {
      key: "largo",
      texts: { invalid: "?", cancelled: "x" },
      steps: [{ id: "cat", type: "choice", question: "¿Cuál?", catalog: "c" }],
    };
    const c = await talk(t, { catalogs: { c: [{ value: "ñ".repeat(40), label: "Muy largo" }] } });
    const spy = vi.spyOn(globalThis, "fetch");
    const r = await renderTelegram({ token: "123:SECRET", username: "pmu_bot" }, CHAT, c.first);
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/"Muy largo".*84 bytes/);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("other shapes", () => {
  const TEXTS = { invalid: "No entendí.", cancelled: "Cancelado.", skip: "Omitir" };

  it("26 · an optional step can be skipped; its answer is null and the summary leaves it out", async () => {
    const t: GuidedTemplate = {
      key: "opcional",
      texts: TEXTS,
      steps: [
        { id: "nota", type: "text", label: "Nota", question: "¿Alguna nota?", optional: true },
        { id: "cuantos", type: "number", label: "Cuántos", question: "¿Cuántos?" },
        { id: "fin", type: "summary", question: "Resumen:" },
      ],
    };
    const c = await talk(t, {});
    expect(c.first).toEqual([{ kind: "choices", text: "¿Alguna nota?", rows: [[{ text: "Omitir", data: "nota!skip" }]] }]);
    await c.say(tap("nota!skip"));
    // The template ends without a handoff: the conversation is complete.
    expect(await c.say(text("3"))).toEqual([{ kind: "text", text: "Resumen:\n\nCuántos: 3", removeKeyboard: true }]);
    expect(c.state).toMatchObject({ status: "completed", at: null });
    expect(guidedAnswers(c.state)).toStrictEqual({ nota: null, cuantos: 3 });
    expect(await c.say(text("hola"))).toEqual([]);
  });

  it("27 · a list stops asking at maxItems, and photos at max", async () => {
    const t: GuidedTemplate = {
      key: "topes",
      texts: TEXTS,
      steps: [
        {
          id: "cosas",
          type: "list",
          question: "Las cosas.",
          maxItems: 2,
          more: { question: "¿Otra?", add: "Sí", done: "No" },
          steps: [{ id: "nombre", type: "text", question: "Cosa {n}:" }],
        },
        { id: "fotos", type: "photos", question: "Fotos, hasta {max}.", max: 2, done: "Listo" },
        { id: "nota", type: "text", question: "¿Nota?" },
      ],
    };
    const c = await talk(t, {});
    expect(textOf(c.first)).toEqual(["Las cosas.\n\nCosa 1:"]);
    await c.say(text("Pala"));
    await c.say(tap("cosas!add"));
    expect(textOf(await c.say(text("Pico")))).toEqual(["Fotos, hasta 2."]);
    // Without `received`, a photo is not acknowledged; the second one is the last.
    expect(await c.say(photo("f1"))).toEqual([]);
    expect(textOf(await c.say(photo("f2")))).toEqual(["¿Nota?"]);
    expect(guidedAnswers(c.state)).toStrictEqual({ cosas: [{ nombre: "Pala" }, { nombre: "Pico" }], fotos: ["f1", "f2"] });
  });

  it("28 · a list with minItems 0 asks before the first item", async () => {
    const t: GuidedTemplate = {
      key: "cero",
      texts: TEXTS,
      steps: [
        {
          id: "cosas",
          type: "list",
          question: "Cosas adicionales.",
          minItems: 0,
          more: { question: "¿Agregar una? Van {count}.", add: "Agregar", done: "Ninguna más" },
          steps: [{ id: "nombre", type: "text", question: "¿Cuál?" }],
        },
        { id: "nota", type: "text", question: "¿Nota?" },
      ],
    };
    const c = await talk(t, {});
    expect(textOf(c.first)).toEqual(["Cosas adicionales.\n\n¿Agregar una? Van 0."]);
    expect(textOf(await c.say(text("ninguna más")))).toEqual(["¿Nota?"]);
    expect(guidedAnswers(c.state)).toStrictEqual({ cosas: [] });
  });

  it("29 · a state from another template, or a missing catalog, is a host error", async () => {
    const { state } = await startGuided(DESPACHO, ctx);
    await expect(advance(state, { ...DESPACHO, key: "otro" }, text("x"), ctx)).rejects.toThrow(/template "despacho"/);
    const c = await talk();
    await c.say(text("No puedo compartirla"));
    await expect(advance(c.state, DESPACHO, text("Comuna 18"), {})).rejects.toThrow(/catalog "divisiones"/);
  });
});
