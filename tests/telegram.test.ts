import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadFile, extractUpdate, isValidSecret, sendMessage, setWebhook, telegramChannel } from "../src/telegram.js";
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
});

describe("Bot API calls", () => {
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
