import { afterEach, describe, expect, it, vi } from "vitest";
import {
  answerCallback,
  downloadFile,
  extractUpdate,
  isValidSecret,
  requestLocation,
  sendChoices,
  sendMessage,
  sendWebApp,
  setWebhook,
  telegramChannel,
} from "../src/telegram.js";
import type { Form } from "../src/types.js";

/**
 * The Telegram channel: reading updates, authenticating the webhook, and the
 * calls to the Bot API — with `fetch` replaced, so nothing leaves the machine.
 */

const cfg = { token: "123:SECRET-BOT-TOKEN", username: "pmu_bot", secretToken: "s3cret" };

afterEach(() => vi.restoreAllMocks());

const update = (message: Record<string, unknown>) => ({
  update_id: 1,
  message: { message_id: 5, date: 1_760_000_000, chat: { id: 77, type: "private" }, ...message },
});

describe("reading updates", () => {
  it("1 · a text message, with an id unique across chats", () => {
    expect(extractUpdate(update({ text: "Slab poured" }))).toEqual([
      {
        channel: "telegram",
        id: "77:5",
        from: "77",
        type: "text",
        text: "Slab poured",
        occurredAt: new Date(1_760_000_000_000).toISOString(),
      },
    ]);
  });

  it("2 · /start carries the link token; a bare /start carries none", () => {
    expect(extractUpdate(update({ text: "/start AbC_12-x" }))[0]).toMatchObject({ start: "AbC_12-x", text: null });
    expect(extractUpdate(update({ text: "/start" }))[0]).toMatchObject({ start: null });
  });

  it("3 · a photo keeps the largest size and its caption", () => {
    const [m] = extractUpdate(update({ photo: [{ file_id: "small" }, { file_id: "large" }], caption: "North wall" }));
    expect(m).toMatchObject({ type: "image", mediaId: "large", text: "North wall" });
  });

  it("4 · a photo sent as a file counts; another file does not", () => {
    expect(extractUpdate(update({ document: { file_id: "d1", mime_type: "image/jpeg" } }))[0]).toMatchObject({ type: "image", mediaId: "d1" });
    expect(extractUpdate(update({ document: { file_id: "d2", mime_type: "application/pdf" } }))[0]).toMatchObject({ type: "other" });
  });

  it("5 · group chats and non-message updates are ignored", () => {
    expect(extractUpdate(update({ chat: { id: -100, type: "group" }, text: "hi" }))).toEqual([]);
    for (const junk of [null, {}, { edited_message: {} }, { message: {} }]) expect(extractUpdate(junk)).toEqual([]);
  });

  it("5b · a shared location, with the accuracy the device reported", () => {
    expect(extractUpdate(update({ location: { latitude: 3.4516, longitude: -76.532, horizontal_accuracy: 18.5 } }))).toEqual([
      {
        channel: "telegram",
        id: "77:5",
        from: "77",
        type: "location",
        text: null,
        location: { latitude: 3.4516, longitude: -76.532, accuracyMeters: 18.5 },
        occurredAt: new Date(1_760_000_000_000).toISOString(),
      },
    ]);
    // Without an accuracy, the key is absent rather than undefined: the
    // message stays equal to itself through JSON.
    const [m] = extractUpdate(update({ location: { latitude: 3.45, longitude: -76.53 } }));
    expect(m?.location).toStrictEqual({ latitude: 3.45, longitude: -76.53 });
  });

  it("5c · a button tap is a choice from the chat it was sent to, with the id to answer", () => {
    const tap = (over: Record<string, unknown>) => ({
      update_id: 2,
      callback_query: {
        id: "4382bfdwdsb323b2d9",
        from: { id: 77 },
        message: { message_id: 10, date: 1_760_000_000, chat: { id: 77, type: "private" } },
        data: "punto:petronio",
        ...over,
      },
    });
    expect(extractUpdate(tap({}))).toEqual([
      {
        channel: "telegram",
        id: "77:callback:4382bfdwdsb323b2d9",
        from: "77",
        type: "choice",
        text: null,
        choice: "punto:petronio",
        callbackId: "4382bfdwdsb323b2d9",
        occurredAt: null,
      },
    ]);
    // Only private chats, as with messages; a tap without data, or on a
    // message Telegram no longer shows, carries nothing to act on.
    expect(extractUpdate(tap({ message: { message_id: 10, chat: { id: -100, type: "group" } } }))).toEqual([]);
    expect(extractUpdate(tap({ data: undefined }))).toEqual([]);
    expect(extractUpdate(tap({ message: undefined }))).toEqual([]);
  });
});

describe("webhook authentication", () => {
  it("6 · the secret header must match, in constant time", () => {
    expect(isValidSecret(cfg, "s3cret")).toBe(true);
    expect(isValidSecret(cfg, "s3cre")).toBe(false);
    expect(isValidSecret(cfg, null)).toBe(false);
  });

  it("7 · without a secret configured, nothing is accepted — fail closed", () => {
    expect(isValidSecret({ ...cfg, secretToken: undefined }, "anything")).toBe(false);
    const channel = telegramChannel({ ...cfg, secretToken: undefined });
    expect(channel.verifyRequest({ rawBody: "{}", headers: new Headers({ "x-telegram-bot-api-secret-token": "" }) })).toBe(false);
  });

  it("8 · setWebhook refuses to register without a secret", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await setWebhook({ ...cfg, secretToken: undefined }, "https://x/api")).toMatchObject({ ok: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it("8b · setWebhook asks for messages and button taps, nothing else", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true, result: true }));
    expect(await setWebhook(cfg, "https://pmu.example/api/telegram/webhook")).toEqual({ ok: true });
    expect(JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      url: "https://pmu.example/api/telegram/webhook",
      secret_token: "s3cret",
      allowed_updates: ["message", "callback_query"],
    });
  });
});

describe("Bot API calls", () => {
  it("9b · sendWebApp sends the button that opens the page inside Telegram", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true, result: { message_id: 4 } }));
    const r = await sendWebApp(cfg, { chatId: "77", text: "Tu formulario", button: { text: "Abrir", url: "https://pmu.example/f/abc" } });
    expect(r).toEqual({ ok: true, messageId: "77:4" });
    expect(JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      chat_id: "77",
      text: "Tu formulario",
      reply_markup: { inline_keyboard: [[{ text: "Abrir", web_app: { url: "https://pmu.example/f/abc" } }]] },
    });
  });

  it("9c · sendWebApp refuses a page that is not https, without calling Telegram", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    expect(await sendWebApp(cfg, { chatId: "77", text: "x", button: { text: "Abrir", url: "http://pmu.example/f/abc" } })).toMatchObject({ ok: false });
    expect(await sendWebApp(cfg, { chatId: "77", text: "x", button: { text: "Abrir", url: "no es una url" } })).toMatchObject({ ok: false });
    expect(spy).not.toHaveBeenCalled();
  });

  it("9 · sendMessage posts to the chat and returns <chat>:<message>", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true, result: { message_id: 9 } }));
    expect(await sendMessage(cfg, { chatId: "77", text: "hola" })).toEqual({ ok: true, messageId: "77:9" });
    expect(spy.mock.calls[0]?.[0]).toBe("https://api.telegram.org/bot123:SECRET-BOT-TOKEN/sendMessage");
    expect(JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({ chat_id: "77", text: "hola" });
  });

  it("10 · errors never carry the bot token", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("connect ECONNREFUSED https://api.telegram.org/bot123:SECRET-BOT-TOKEN/sendMessage"));
    const r = await sendMessage(cfg, { chatId: "77", text: "hola" });
    expect(r.ok).toBe(false);
    expect(r.error).not.toContain("SECRET-BOT-TOKEN");
  });

  it("11 · a file is fetched from the path getFile returns, typed by its extension", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ ok: true, result: { file_path: "photos/file_1.jpg" } }))
      .mockResolvedValueOnce(new Response(new Uint8Array([0xff, 0xd8, 0xff]), { headers: { "content-type": "application/octet-stream" } }));
    const r = await downloadFile(cfg, "large");
    expect(r).toMatchObject({ ok: true, contentType: "image/jpeg" });
  });

  it("12 · without a token, calls report instead of throwing", async () => {
    expect(await sendMessage({ ...cfg, token: "" }, { chatId: "77", text: "x" })).toMatchObject({ ok: false });
  });

  it("12b · sendMessage can take away a reply keyboard", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true, result: { message_id: 3 } }));
    await sendMessage(cfg, { chatId: "77", text: "Gracias", removeKeyboard: true });
    expect(JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({
      chat_id: "77",
      text: "Gracias",
      reply_markup: { remove_keyboard: true },
    });
  });
});

const body = (spy: { mock: { calls: unknown[][] } }, call = 0) =>
  JSON.parse((spy.mock.calls[call]?.[1] as RequestInit).body as string);

describe("buttons and locations", () => {
  it("15 · sendChoices sends an inline keyboard, row by row", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true, result: { message_id: 6 } }));
    const r = await sendChoices(cfg, {
      chatId: "77",
      text: "¿Desde qué punto sale?",
      rows: [[{ text: "Petronio Álvarez", data: "punto:petronio" }, { text: "Coliseo", data: "punto:coliseo" }], [], [{ text: "Omitir", data: "punto!skip" }]],
    });
    expect(r).toEqual({ ok: true, messageId: "77:6" });
    expect(spy.mock.calls[0]?.[0]).toBe("https://api.telegram.org/bot123:SECRET-BOT-TOKEN/sendMessage");
    expect(body(spy)).toEqual({
      chat_id: "77",
      text: "¿Desde qué punto sale?",
      reply_markup: {
        inline_keyboard: [
          [{ text: "Petronio Álvarez", callback_data: "punto:petronio" }, { text: "Coliseo", callback_data: "punto:coliseo" }],
          [{ text: "Omitir", callback_data: "punto!skip" }],
        ],
      },
    });
  });

  it("16 · sendChoices refuses data over 64 bytes — counted in bytes — without calling Telegram", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    // 40 characters, 80 bytes: "ñ" takes two.
    const long = "ñ".repeat(40);
    const r = await sendChoices(cfg, { chatId: "77", text: "x", rows: [[{ text: "Ok", data: "a" }, { text: "Largo", data: long }]] });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/"Largo".*80 bytes/);
    expect(await sendChoices(cfg, { chatId: "77", text: "x", rows: [[{ text: "Vacío", data: "" }]] })).toMatchObject({ ok: false });
    expect(await sendChoices(cfg, { chatId: "77", text: "x", rows: [[]] })).toMatchObject({ ok: false });
    expect(await sendChoices(cfg, { chatId: "77", text: "x", rows: [[{ text: " ", data: "a" }]] })).toMatchObject({ ok: false });
    expect(spy).not.toHaveBeenCalled();
    // Exactly 64 bytes is accepted.
    spy.mockResolvedValue(Response.json({ ok: true, result: { message_id: 1 } }));
    expect(await sendChoices(cfg, { chatId: "77", text: "x", rows: [[{ text: "Ok", data: "ñ".repeat(32) }]] })).toMatchObject({ ok: true });
  });

  it("17 · requestLocation asks with Telegram's keyboard, plus the alternatives", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true, result: { message_id: 7 } }));
    const r = await requestLocation(cfg, {
      chatId: "77",
      text: "Comparte tu ubicación",
      button: "📍 Compartir ubicación",
      alternatives: ["No puedo compartirla"],
    });
    expect(r).toEqual({ ok: true, messageId: "77:7" });
    expect(body(spy)).toEqual({
      chat_id: "77",
      text: "Comparte tu ubicación",
      reply_markup: {
        keyboard: [[{ text: "📍 Compartir ubicación", request_location: true }], [{ text: "No puedo compartirla" }]],
        one_time_keyboard: true,
        resize_keyboard: true,
      },
    });
  });

  it("18 · answerCallback stops the spinner, with or without a notice", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true, result: true }));
    expect(await answerCallback(cfg, "q1")).toEqual({ ok: true });
    expect(spy.mock.calls[0]?.[0]).toBe("https://api.telegram.org/bot123:SECRET-BOT-TOKEN/answerCallbackQuery");
    expect(body(spy, 0)).toEqual({ callback_query_id: "q1" });
    await answerCallback(cfg, "q2", "Guardado");
    expect(body(spy, 1)).toEqual({ callback_query_id: "q2", text: "Guardado" });
  });

  it("19 · an expired tap reports Telegram's reason, without the token", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ ok: false, description: "Bad Request: query is too old and response timeout expired" }, { status: 400 }),
    );
    const r = await answerCallback(cfg, "q1");
    expect(r).toEqual({ ok: false, error: "Bad Request: query is too old and response timeout expired" });
  });
});

describe("the channel's invitation", () => {
  const form = { key: "f", channels: ["telegram"] } as Form;

  it("13 · is a t.me link with the token, and sends nothing", async () => {
    const spy = vi.spyOn(globalThis, "fetch");
    const r = await telegramChannel(cfg).invite({ form, address: null, variables: [], linkToken: "tok_123" });
    expect(r).toEqual({ ok: true, delivered: false, link: "https://t.me/pmu_bot?start=tok_123" });
    expect(spy).not.toHaveBeenCalled();
  });

  it("14 · without the bot's username there is no link to give", async () => {
    const r = await telegramChannel({ ...cfg, username: "" }).invite({ form, address: null, variables: [], linkToken: "t" });
    expect(r).toMatchObject({ ok: false });
  });
});
