import { timingSafeEqual } from "node:crypto";
import type { Channel, InboundMessage, Media, SendResult } from "./channel.js";
import type { GuidedOutput } from "./guided.js";

/**
 * Telegram Bot API channel. No SDK — plain `fetch`.
 *
 * ## How it differs from WhatsApp
 *
 * - **A bot cannot write first.** `invite` sends nothing: it returns a
 *   `https://t.me/<bot>?start=<token>` link for the operator to hand over.
 *   When the recipient opens it, Telegram sends `/start <token>` and the
 *   engine binds that chat to the case (`Repository.bindCase`).
 * - **No templates, no approval, no 24-hour window, no per-message price.**
 *   The invitation body is sent as written once the chat is bound.
 * - **The recipient is a chat, not a phone number.** A `phone` field is not
 *   needed; if the form has one, it is kept as data.
 *
 * ## The link is a credential, but a single-use one
 *
 * The token travels inside the link, through whatever the operator uses to
 * hand it over and through Telegram. Binding is single-use: the first chat
 * that opens it owns the case, and the same link opened from another account
 * is refused. Only the token's SHA-256 is stored.
 *
 * Missing configuration does not throw, as on WhatsApp: calls return
 * `ok:false` with the reason.
 */

export type TelegramConfig = {
  /** From @BotFather. Never logged: errors are scrubbed of it. */
  token: string;
  /** The bot's username, without `@`. Builds the `t.me` link. */
  username: string;
  /**
   * The `secret_token` given to `setWebhook`. Telegram echoes it in
   * `X-Telegram-Bot-Api-Secret-Token`; without it configured, every webhook
   * request is rejected. 1–256 characters, `A-Z a-z 0-9 _ -`.
   */
  secretToken?: string;
  /** Override for tests or a self-hosted Bot API server. */
  apiBase?: string;
};

const BASE = "https://api.telegram.org";
/** Telegram's limit for a single text message. */
export const TELEGRAM_TEXT_LIMIT = 4096;

const scrub = (cfg: TelegramConfig, s: string) => (cfg.token ? s.split(cfg.token).join("<token>") : s);

async function call<T>(
  cfg: TelegramConfig,
  method: string,
  body: unknown,
): Promise<{ ok: true; result: T } | { ok: false; error: string }> {
  if (!cfg?.token) return { ok: false, error: "Telegram is not configured (missing token)." };
  try {
    const res = await fetch(`${cfg.apiBase ?? BASE}/bot${cfg.token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!res.ok || !data.ok) {
      // Telegram's description states the cause — chat not found, bot
      // blocked by the user — and is returned verbatim.
      return { ok: false, error: scrub(cfg, data.description ?? `HTTP ${res.status}`) };
    }
    return { ok: true, result: data.result as T };
  } catch (e: unknown) {
    return { ok: false, error: scrub(cfg, e instanceof Error ? e.message : "Network failure calling Telegram.") };
  }
}

/** The link the operator hands over. The token must be `A-Z a-z 0-9 _ -`, up to 64. */
export function telegramLink(cfg: TelegramConfig, token: string): string {
  return `https://t.me/${cfg.username}?start=${token}`;
}

/**
 * Plain text to a chat. Message ids are unique per chat, so the id is `<chat>:<message>`.
 *
 * `removeKeyboard` takes away a reply keyboard left open by `requestLocation`.
 * Sending it when none is open does nothing.
 */
export async function sendMessage(
  cfg: TelegramConfig,
  m: { chatId: string; text: string; removeKeyboard?: boolean },
): Promise<SendResult> {
  const r = await call<{ message_id: number }>(cfg, "sendMessage", {
    chat_id: m.chatId,
    text: m.text.slice(0, TELEGRAM_TEXT_LIMIT),
    ...(m.removeKeyboard ? { reply_markup: { remove_keyboard: true } } : {}),
  });
  return r.ok ? { ok: true, messageId: `${m.chatId}:${r.result.message_id}` } : { ok: false, error: r.error };
}

/** Telegram's limit for a button's `callback_data`, in bytes — not characters. */
export const CALLBACK_DATA_LIMIT = 64;

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

/**
 * A message with buttons under it (an inline keyboard). A tap arrives as an
 * update of type `choice` carrying the button's `data`, and must be answered
 * with `answerCallback`.
 *
 * `data` is limited to 1–64 **bytes**: an accented letter takes two. Telegram
 * rejects the whole message when one button exceeds it, so this refuses it
 * first, naming the button, without calling the API.
 */
export async function sendChoices(
  cfg: TelegramConfig,
  m: { chatId: string; text: string; rows: { text: string; data: string }[][] },
): Promise<SendResult> {
  const rows = m.rows.filter((row) => row.length > 0);
  if (rows.length === 0) return { ok: false, error: "A choice needs at least one button." };
  for (const button of rows.flat()) {
    if (!button.text.trim()) return { ok: false, error: "Every button needs a text." };
    const bytes = utf8Length(button.data);
    if (bytes < 1 || bytes > CALLBACK_DATA_LIMIT) {
      return {
        ok: false,
        error: `Button "${button.text}": its data is ${bytes} bytes; Telegram accepts 1 to ${CALLBACK_DATA_LIMIT}.`,
      };
    }
  }
  const r = await call<{ message_id: number }>(cfg, "sendMessage", {
    chat_id: m.chatId,
    text: m.text.slice(0, TELEGRAM_TEXT_LIMIT),
    reply_markup: {
      inline_keyboard: rows.map((row) => row.map((b) => ({ text: b.text.slice(0, 64), callback_data: b.data }))),
    },
  });
  return r.ok ? { ok: true, messageId: `${m.chatId}:${r.result.message_id}` } : { ok: false, error: r.error };
}

/**
 * Asks for the recipient's location with Telegram's own keyboard: one button
 * that shares it, and text buttons for those who cannot — Telegram Desktop
 * does not share locations, and a phone may have it turned off. A tapped
 * alternative arrives as a text message with the button's text.
 *
 * The keyboard hides after one use; `sendMessage` with `removeKeyboard`
 * takes it away.
 */
export async function requestLocation(
  cfg: TelegramConfig,
  m: { chatId: string; text: string; button: string; alternatives?: string[] },
): Promise<SendResult> {
  const r = await call<{ message_id: number }>(cfg, "sendMessage", {
    chat_id: m.chatId,
    text: m.text.slice(0, TELEGRAM_TEXT_LIMIT),
    reply_markup: {
      keyboard: [[{ text: m.button, request_location: true }], ...(m.alternatives ?? []).map((text) => [{ text }])],
      one_time_keyboard: true,
      resize_keyboard: true,
    },
  });
  return r.ok ? { ok: true, messageId: `${m.chatId}:${r.result.message_id}` } : { ok: false, error: r.error };
}

/**
 * Answers a button tap. Until it is answered the button shows a spinner;
 * `text`, if given, appears briefly over the chat (up to 200 characters).
 * Telegram refuses an answer after some seconds, so answer before slow work.
 */
export async function answerCallback(
  cfg: TelegramConfig,
  callbackId: string,
  text?: string,
): Promise<{ ok: boolean; error?: string }> {
  const r = await call<boolean>(cfg, "answerCallbackQuery", {
    callback_query_id: callbackId,
    ...(text ? { text: text.slice(0, 200) } : {}),
  });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

/**
 * A message with a button that opens a web page inside Telegram (a Mini App).
 *
 * For forms too rich for a chat — a list of items, photos per section, an
 * offline queue — the chat is only the door: the recipient taps the button and
 * the host application's own web form opens inside Telegram, carrying the same
 * token the link did. The form validates the token; the bot only delivers it.
 *
 * Telegram only opens `https` pages this way; anything else is refused here
 * before calling the API.
 */
export async function sendWebApp(
  cfg: TelegramConfig,
  m: { chatId: string; text: string; button: { text: string; url: string } },
): Promise<SendResult> {
  let url: URL;
  try {
    url = new URL(m.button.url);
  } catch {
    return { ok: false, error: "The button URL is not a valid URL." };
  }
  if (url.protocol !== "https:") return { ok: false, error: "Telegram only opens https pages in a Mini App." };
  const r = await call<{ message_id: number }>(cfg, "sendMessage", {
    chat_id: m.chatId,
    text: m.text.slice(0, TELEGRAM_TEXT_LIMIT),
    reply_markup: { inline_keyboard: [[{ text: m.button.text.slice(0, 64), web_app: { url: url.toString() } }]] },
  });
  return r.ok ? { ok: true, messageId: `${m.chatId}:${r.result.message_id}` } : { ok: false, error: r.error };
}

const TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  heic: "image/heic",
};

/**
 * Downloads a file by id: `getFile` returns a path, then the file is fetched
 * from it. Bots can download up to 20 MB. As on WhatsApp, it is done while
 * handling the webhook.
 *
 * Telegram serves files as `application/octet-stream`, so the type is taken
 * from the extension. Callers should verify magic bytes anyway.
 */
export async function downloadFile(cfg: TelegramConfig, fileId: string): Promise<Media> {
  const info = await call<{ file_path?: string }>(cfg, "getFile", { file_id: fileId });
  if (!info.ok) return { ok: false, error: info.error };
  const path = info.result.file_path;
  if (!path) return { ok: false, error: `File ${fileId} has no path (over 20 MB?).` };
  try {
    const file = await fetch(`${cfg.apiBase ?? BASE}/file/bot${cfg.token}/${path}`);
    if (!file.ok) return { ok: false, error: `File download failed (${file.status}).` };
    const extension = path.split(".").pop()?.toLowerCase() ?? "";
    return {
      ok: true,
      bytes: new Uint8Array(await file.arrayBuffer()),
      contentType: TYPE_BY_EXTENSION[extension] ?? file.headers.get("content-type") ?? "",
    };
  } catch (e: unknown) {
    return { ok: false, error: scrub(cfg, e instanceof Error ? e.message : "Network failure downloading a file.") };
  }
}

/**
 * Verifies `X-Telegram-Bot-Api-Secret-Token`.
 *
 * Like the WhatsApp signature, it is the only access control on a public
 * endpoint that writes to the database. Returns `false` when no secret is
 * configured — fail-closed — and compares in constant time.
 */
export function isValidSecret(cfg: TelegramConfig, header: string | null | undefined): boolean {
  const secret = cfg?.secretToken;
  if (!secret || !header) return false;
  const a = Buffer.from(secret, "utf8");
  const b = Buffer.from(header, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Registers the webhook, with the secret and only the updates this library
 * reads: messages, and taps on the buttons `sendChoices` sends.
 */
export async function setWebhook(cfg: TelegramConfig, url: string): Promise<{ ok: boolean; error?: string }> {
  if (!cfg.secretToken) return { ok: false, error: "Set `secretToken` first: the webhook would accept anyone." };
  const r = await call<boolean>(cfg, "setWebhook", {
    url,
    secret_token: cfg.secretToken,
    allowed_updates: ["message", "callback_query"],
  });
  return r.ok ? { ok: true } : { ok: false, error: r.error };
}

type TelegramChat = { id?: number | string; type?: string };

type TelegramMessage = {
  message_id?: number;
  date?: number;
  chat?: TelegramChat;
  text?: string;
  caption?: string;
  photo?: { file_id?: string; file_size?: number }[];
  document?: { file_id?: string; mime_type?: string };
  location?: { latitude?: number; longitude?: number; horizontal_accuracy?: number };
};

type TelegramCallbackQuery = {
  id?: string;
  data?: string;
  message?: { message_id?: number; chat?: TelegramChat };
};

/**
 * The message inside a webhook `Update`, or the tap on a button.
 *
 * Only private chats count: a bot added to a group would otherwise turn every
 * group message into a report. Edits and channel posts are not read
 * (`setWebhook` does not even ask for them).
 *
 * A photo arrives in several sizes; the largest is kept. A photo sent "as a
 * file" arrives as a document and is kept if its type is an image.
 *
 * A shared location becomes a `location` message. A tap on a button sent with
 * `sendChoices` becomes a `choice` carrying the button's data and the
 * `callbackId` to answer; it comes from the chat the button was sent to. A tap
 * has no time of its own — the message's date is when the button was sent —
 * so `occurredAt` is null. Its id is `<chat>:callback:<query id>`, which
 * cannot collide with a message's `<chat>:<message>`.
 */
export function extractUpdate(payload: unknown): InboundMessage[] {
  const update = payload as { message?: TelegramMessage; callback_query?: TelegramCallbackQuery } | null;
  const query = update?.callback_query;
  if (query) {
    const chat = query.message?.chat;
    if (!query.id || !query.data || chat?.id === undefined || chat.type !== "private") return [];
    return [
      {
        channel: "telegram",
        id: `${chat.id}:callback:${query.id}`,
        from: String(chat.id),
        occurredAt: null,
        type: "choice",
        text: null,
        choice: query.data,
        callbackId: query.id,
      },
    ];
  }

  const m = update?.message;
  if (!m?.message_id || m.chat?.id === undefined || m.chat?.type !== "private") return [];
  const chat = String(m.chat.id);
  const base = {
    channel: "telegram" as const,
    id: `${chat}:${m.message_id}`,
    from: chat,
    occurredAt: m.date ? new Date(m.date * 1000).toISOString() : null,
  };

  const largest = m.photo?.length ? m.photo[m.photo.length - 1] : undefined;
  if (largest?.file_id) {
    return [{ ...base, type: "image", text: m.caption ?? null, mediaId: largest.file_id }];
  }
  if (m.document?.file_id && m.document.mime_type?.startsWith("image/")) {
    return [{ ...base, type: "image", text: m.caption ?? null, mediaId: m.document.file_id }];
  }
  const { latitude, longitude, horizontal_accuracy } = m.location ?? {};
  if (typeof latitude === "number" && typeof longitude === "number") {
    return [
      {
        ...base,
        type: "location",
        text: null,
        location: {
          latitude,
          longitude,
          ...(typeof horizontal_accuracy === "number" ? { accuracyMeters: horizontal_accuracy } : {}),
        },
      },
    ];
  }
  if (typeof m.text === "string") {
    const start = /^\/start(?:@\w+)?(?:\s+(\S+))?\s*$/.exec(m.text);
    if (start) return [{ ...base, type: "text", text: null, start: start[1] ?? null }];
    return [{ ...base, type: "text", text: m.text }];
  }
  return [{ ...base, type: "other", text: null }];
}

/**
 * Sends what a guided conversation step returned (`advance`, `startGuided`),
 * in order, one Bot API call per output.
 *
 * Stops at the first message that fails and reports it: the rest would read
 * out of context. A button tap that cannot be answered — Telegram refuses an
 * answer after some seconds — is logged and does not stop the rest, since the
 * conversation already moved on. `messageIds` are those sent, for the host to
 * record if it records outbound messages.
 */
export async function renderTelegram(
  cfg: TelegramConfig,
  chatId: string,
  outputs: GuidedOutput[],
): Promise<{ ok: boolean; messageIds: string[]; error?: string }> {
  const messageIds: string[] = [];
  for (const o of outputs) {
    if (o.kind === "ack") {
      const r = await answerCallback(cfg, o.callbackId);
      if (!r.ok) console.warn("[data-collection-link] button tap not answered:", r.error);
      continue;
    }
    const r =
      o.kind === "text"
        ? await sendMessage(cfg, { chatId, text: o.text, removeKeyboard: o.removeKeyboard })
        : o.kind === "choices"
          ? await sendChoices(cfg, { chatId, text: o.text, rows: o.rows })
          : o.kind === "location"
            ? await requestLocation(cfg, { chatId, text: o.text, button: o.button, alternatives: o.alternatives })
            : await sendWebApp(cfg, { chatId, text: o.text, button: o.button });
    if (!r.ok) return { ok: false, messageIds, error: r.error };
    if (r.messageId) messageIds.push(r.messageId);
  }
  return { ok: true, messageIds };
}

/** The Telegram channel, for the conversation engine. */
export function telegramChannel(cfg: TelegramConfig): Channel {
  return {
    name: "telegram",
    async invite({ linkToken }) {
      if (!cfg?.username) return { ok: false, delivered: false, error: "Telegram is not configured (missing username)." };
      if (!linkToken) return { ok: false, delivered: false, error: "A Telegram invitation needs a link token." };
      // Nothing is sent: a bot cannot start a conversation. The link is the
      // invitation, and the operator hands it over.
      return { ok: true, delivered: false, link: telegramLink(cfg, linkToken) };
    },
    sendText: (address, text) => sendMessage(cfg, { chatId: address, text }),
    downloadMedia: (mediaId) => downloadFile(cfg, mediaId),
    verifyRequest: ({ headers }) => isValidSecret(cfg, headers.get("x-telegram-bot-api-secret-token")),
    parse: extractUpdate,
  };
}
