import type { ChannelName, Form } from "./types.js";

/**
 * What every chat channel provides to the conversation engine.
 *
 * The engine (`conversation.ts`) knows cases, closing rules and replies; a
 * channel knows its platform — how to open a conversation, send text, fetch a
 * photo, authenticate a webhook and read its payload. WhatsApp and Telegram
 * differ most in the first step:
 *
 * - **WhatsApp** can write first, but only with a template Meta approved
 *   word for word. `invite` sends it.
 * - **Telegram** bots cannot write first. `invite` returns a `t.me` link
 *   carrying a one-time token; the operator hands it over, and the
 *   conversation starts when the recipient opens it.
 */

export type SendResult = { ok: boolean; messageId?: string; error?: string };

/**
 * `delivered` means a message reached the platform. On Telegram it is always
 * false and `link` is set instead: it is shown to the operator once.
 */
export type InvitationResult = {
  ok: boolean;
  delivered: boolean;
  messageId?: string;
  link?: string;
  error?: string;
};

export type InboundMessage = {
  channel: ChannelName;
  /** Unique within the channel: the deduplication key. */
  id: string;
  /** The sender, already in the form `Case.address` stores. */
  from: string;
  type: "text" | "image" | "other";
  /** For an image, its caption. */
  text?: string | null;
  mediaId?: string | null;
  occurredAt?: string | null;
  /** Telegram: the payload of `/start <payload>`, sent when the link is opened. */
  start?: string | null;
};

export type Media = { ok: true; bytes: Uint8Array; contentType: string } | { ok: false; error: string };

/** The part of `Headers` a channel reads. */
export type HeaderReader = { get(name: string): string | null };

export interface Channel {
  readonly name: ChannelName;
  /** Opens the conversation for a case that was just created. */
  invite(input: {
    form: Form;
    /** The phone on WhatsApp; null on Telegram. */
    address: string | null;
    /** `invitation.variables`, already resolved with their fallbacks. */
    variables: string[];
    /** Telegram: the one-time token the link carries. Null on WhatsApp. */
    linkToken: string | null;
  }): Promise<InvitationResult>;
  /** Free text. On WhatsApp, valid only inside the 24-hour service window. */
  sendText(address: string, text: string): Promise<SendResult>;
  /** Fetches inbound media while handling the webhook. */
  downloadMedia(mediaId: string): Promise<Media>;
  /**
   * Whether a webhook request comes from the platform. Fail-closed: without
   * the secret configured, nothing is accepted.
   */
  verifyRequest(request: { rawBody: string; headers: HeaderReader }): boolean;
  /** The messages inside a webhook payload. Receipts and other events are dropped. */
  parse(payload: unknown): InboundMessage[];
}
