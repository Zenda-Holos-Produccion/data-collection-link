import { createHash, randomBytes } from "node:crypto";
import type { Channel, InboundMessage } from "./channel.js";
import { invitationVariables, previewInvitation } from "./form.js";
import type { Case, ChannelName, Form, Repository, Storage } from "./types.js";

/**
 * Turns an operator's invitation and a recipient's chat messages into
 * persisted submissions, on any channel.
 *
 * ## Ordering is the guarantee
 *
 * 1. The message is recorded **first**, keyed by its channel id. If it
 *    already existed, the delivery is a retry and processing stops.
 * 2. Media is downloaded **in-band**: both platforms hand out file locations
 *    that are only good for a while, so deferring it risks losing the photo.
 * 3. The acknowledgement is sent **last** and never propagates its failure:
 *    the submission is already persisted, and losing it because the reply
 *    could not be sent would be worse than losing the reply.
 */

export type Deps = {
  /** The channels this host has configured. A form can only be sent over these. */
  channels: Partial<Record<ChannelName, Channel>>;
  repository: Repository;
  storage: Storage;
  /** Replies sent to the recipient. Omit any to send none. */
  replies?: {
    received?: (ctx: { withPhoto: boolean }) => string;
    missingToClose?: (missing: { reports: number; photos: number }) => string;
    closed?: () => string;
    /** Telegram: the link was already opened by another chat, its case closed, or it is unknown. */
    linkInvalid?: () => string;
  };
};

const DEFAULT_CLOSING_WORDS = ["listo", "terminado", "termine", "fin", "finalizar", "done"];

const normalize = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z]/g, "");

/**
 * Whether a message declares the case finished.
 *
 * Matches the **whole** normalized message, not a substring. "Listo, mañana
 * sigo con el segundo piso" contains a closing word and does not express
 * closure; a false positive leaves the recipient without a channel to continue
 * reporting, and reopening the case is not under their control.
 */
export function isClosingMessage(text: string | null | undefined, words?: string[]): boolean {
  if (!text) return false;
  const list = (words?.length ? words : DEFAULT_CLOSING_WORDS).map(normalize);
  return list.includes(normalize(text));
}

/** SHA-256 of a link token, as `Repository` stores it. */
export function hashLinkToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Creates the case and opens the conversation on the chosen channel.
 *
 * - WhatsApp: sends the approved template. `delivered` says whether Meta
 *   accepted it.
 * - Telegram: sends nothing and returns `link`, which carries a one-time
 *   token. **It is returned once and never stored** — only its digest is.
 *   Show it to the operator to hand over.
 *
 * Respond with success even when `delivered` is false: the case exists, and
 * reporting a failure leads operators to create it twice.
 */
export async function invite(
  deps: Deps,
  form: Form,
  values: Record<string, string>,
  channelName: ChannelName = form.channels[0]!,
): Promise<{ case: Case; delivered: boolean; link?: string; error?: string }> {
  if (!form.channels.includes(channelName)) {
    throw new Error(`Form "${form.key}" is not sent over ${channelName}.`);
  }
  const channel = deps.channels[channelName];
  if (!channel) throw new Error(`Channel "${channelName}" is not configured in this application.`);

  for (const field of form.fields) {
    if (field.required && !(values[field.key] ?? "").trim()) throw new Error(`Missing ${field.label}.`);
  }

  let address: string | null = null;
  if (channelName === "whatsapp") {
    const phoneField = form.fields.find((f) => f.type === "phone");
    if (!phoneField) throw new Error(`Form "${form.key}" declares no "phone" field, so there is no delivery address.`);
    address = (values[phoneField.key] ?? "").replace(/\D+/g, "") || null;
    if (!address) throw new Error(`Missing ${phoneField.label}.`);
  }

  // 24 random bytes: 32 characters of base64url, inside Telegram's 64-character
  // limit for a `start` parameter, and the same strength as the links of the
  // host's other forms.
  const linkToken = channelName === "telegram" ? randomBytes(24).toString("base64url") : null;

  const created = await deps.repository.createCase({
    form: form.key,
    channel: channelName,
    address,
    values: Object.fromEntries(form.fields.map((f) => [f.key, (values[f.key] ?? "").trim() || null])),
    linkTokenHash: linkToken ? hashLinkToken(linkToken) : null,
  });

  const result = await channel.invite({
    form,
    address,
    variables: invitationVariables(form, values),
    linkToken,
  });
  await deps.repository.recordDelivery(created.id, {
    ok: result.ok,
    delivered: result.delivered,
    messageId: result.messageId,
    error: result.error,
  });

  if (result.ok && result.messageId) {
    await deps.repository.recordMessage({
      caseId: created.id,
      channel: channelName,
      messageId: result.messageId,
      direction: "outbound",
      type: "invitation",
      text: null,
      occurredAt: null,
    });
  }

  return { case: created, delivered: result.delivered, link: result.link, error: result.error };
}

export type InboundResult =
  | { status: "duplicate" }
  | { status: "no_case" }
  | { status: "bound"; caseId: string }
  | { status: "stored"; withPhoto: boolean }
  | { status: "closed" }
  | { status: "ignored"; reason: string };

export async function processInbound(deps: Deps, form: Form, m: InboundMessage): Promise<InboundResult> {
  const channel = deps.channels[m.channel];
  if (!channel) return { status: "ignored", reason: `channel ${m.channel} is not configured` };

  const record = (caseId: string | null) =>
    deps.repository.recordMessage({
      caseId,
      channel: m.channel,
      messageId: m.id,
      direction: "inbound",
      // A shared location and a button tap are not reports in a free-form
      // conversation. They are recorded as `other` — a location already was,
      // before the channel read it — so `Repository` keeps the types it knows.
      type: m.type === "location" || m.type === "choice" ? "other" : m.type,
      text: m.text ?? null,
      occurredAt: m.occurredAt ?? null,
    });

  // ── Telegram: the recipient opened the link ──────────────────────────
  if (m.start !== undefined && m.start !== null) {
    if (!(await record(null))) return { status: "duplicate" };
    const bound = await deps.repository.bindCase(m.channel, hashLinkToken(m.start), m.from);
    if (!bound) {
      await reply(channel, m.from, deps.replies?.linkInvalid?.());
      return { status: "ignored", reason: "link already used, closed or unknown" };
    }
    // What WhatsApp sends as a template, Telegram sends now: the recipient
    // learns what this is about the moment they open the link.
    const welcome = await channel.sendText(m.from, previewInvitation(form, bound.values));
    if (welcome.ok && welcome.messageId) {
      await deps.repository.recordMessage({
        caseId: bound.id,
        channel: m.channel,
        messageId: welcome.messageId,
        direction: "outbound",
        type: "invitation",
        text: null,
        occurredAt: null,
      });
    }
    return { status: "bound", caseId: bound.id };
  }

  const openCase = await deps.repository.openCaseFor(m.channel, m.from);

  // 1 · Record first. A known message id means this is a retry.
  if (!(await record(openCase?.id ?? null))) return { status: "duplicate" };
  // Senders without an open case are not replied to: a public number or bot
  // receives unsolicited messages, and on WhatsApp each reply costs money.
  if (!openCase) return { status: "no_case" };

  // 2 · Closing request.
  if (m.type === "text" && isClosingMessage(m.text, form.chat.closingWords)) {
    const have = await deps.repository.count(openCase.id);
    const missingReports = form.chat.report?.requiredToClose && have.reports === 0 ? 1 : 0;
    const missingPhotos = Math.max(0, (form.chat.photos?.minToClose ?? 0) - have.photos);
    if (missingReports || missingPhotos) {
      await reply(channel, m.from, deps.replies?.missingToClose?.({ reports: missingReports, photos: missingPhotos }));
      return { status: "ignored", reason: "close requested before requirements met" };
    }
    await deps.repository.closeCase(openCase.id);
    await reply(channel, m.from, deps.replies?.closed?.());
    return { status: "closed" };
  }

  // 3 · Text. For an image this is its caption, which the recipient wrote to
  //     describe the picture.
  const text = m.text?.trim();
  if (text && form.chat.report?.enabled !== false) {
    await deps.repository.saveReport(openCase.id, text);
  }

  // 4 · Media.
  let withPhoto = false;
  if (m.type === "image" && m.mediaId && form.chat.photos?.enabled !== false) {
    const media = await channel.downloadMedia(m.mediaId);
    if (!media.ok) {
      await reply(channel, m.from, "Your message was received, but the photo could not be stored. Please send it again.");
    } else {
      const stored = await deps.storage.save({ bytes: media.bytes, contentType: media.contentType, prefix: form.key });
      await deps.repository.savePhoto(openCase.id, {
        path: stored.path,
        contentType: media.contentType,
        bytes: stored.bytes,
        sha256: stored.sha256,
      });
      withPhoto = true;
    }
  }

  await reply(channel, m.from, deps.replies?.received?.({ withPhoto }));
  return { status: "stored", withPhoto };
}

/** Acknowledgement failures are logged, not propagated. */
async function reply(channel: Channel, address: string, text?: string): Promise<void> {
  if (!text) return;
  const r = await channel.sendText(address, text);
  if (!r.ok) console.warn("[data-collection-link] acknowledgement not sent:", r.error);
}
