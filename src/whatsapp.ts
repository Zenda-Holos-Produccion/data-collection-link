import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * WhatsApp Cloud API client. No SDK — plain `fetch`.
 *
 * Missing configuration does not throw: calls return `ok:false` with the
 * reason so the caller can record the case as undelivered and have someone
 * follow up manually, rather than losing the invitation. An outbound channel
 * that takes down the operation when a token expires is worse than one that
 * reports.
 */

export type WhatsAppConfig = {
  /** Permanent system-user token. The API Setup panel token expires in 24h. */
  token: string;
  /** Phone number **id**, not the number itself. */
  phoneNumberId: string;
  /** Verifies webhook signatures. Without it, the endpoint is unauthenticated. */
  appSecret?: string;
  /** The value chosen when registering the webhook. */
  verifyToken?: string;
  /** Graph API version. Meta retires versions every couple of years. */
  version?: string;
  /** Country calling code without `+`, prepended to stored numbers. */
  countryCode: string;
};

const BASE = "https://graph.facebook.com";

export type SendResult = { ok: boolean; wamid?: string; error?: string };

async function call(cfg: WhatsAppConfig, body: unknown): Promise<SendResult> {
  if (!cfg?.token || !cfg?.phoneNumberId) {
    return { ok: false, error: "WhatsApp is not configured (missing token or phoneNumberId)." };
  }
  try {
    const res = await fetch(`${BASE}/${cfg.version ?? "v21.0"}/${cfg.phoneNumberId}/messages`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      // Meta's message is returned verbatim: it states the cause — template
      // not approved, number outside the test list, session window closed —
      // and a generic failure cannot be acted upon.
      return { ok: false, error: data?.error?.message ?? `HTTP ${res.status}` };
    }
    return { ok: true, wamid: data?.messages?.[0]?.id };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : "Network failure calling WhatsApp." };
  }
}

const toE164 = (cfg: WhatsAppConfig, phone: string) => `${cfg.countryCode}${phone}`;

/** Opens the conversation. Business-initiated messages must use a template. */
export function sendTemplate(
  cfg: WhatsAppConfig,
  m: { phone: string; template: string; language?: string; variables: string[] },
): Promise<SendResult> {
  return call(cfg, {
    messaging_product: "whatsapp",
    to: toE164(cfg, m.phone),
    type: "template",
    template: {
      name: m.template,
      language: { code: m.language ?? "es" },
      components: m.variables.length
        ? [{ type: "body", parameters: m.variables.map((v) => ({ type: "text", text: v })) }]
        : [],
    },
  });
}

/** Free-form text. Only valid inside the 24-hour customer service window. */
export function sendText(
  cfg: WhatsAppConfig,
  m: { phone: string; text: string },
): Promise<SendResult> {
  return call(cfg, {
    messaging_product: "whatsapp",
    to: toE164(cfg, m.phone),
    type: "text",
    text: { preview_url: false, body: m.text },
  });
}

/**
 * Downloads an inbound media object.
 *
 * Two authenticated requests: `GET /{media-id}` returns a signed URL that
 * expires within minutes, so the download must happen while handling the
 * webhook rather than being deferred to a queue.
 */
export async function downloadMedia(
  cfg: WhatsAppConfig,
  mediaId: string,
): Promise<{ ok: true; bytes: Uint8Array; contentType: string } | { ok: false; error: string }> {
  if (!cfg?.token) return { ok: false, error: "WhatsApp is not configured." };
  const version = cfg.version ?? "v21.0";
  try {
    const meta = await fetch(`${BASE}/${version}/${mediaId}`, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    const info = await meta.json().catch(() => ({}));
    if (!meta.ok || !info?.url) {
      return { ok: false, error: info?.error?.message ?? `Media ${mediaId} could not be located.` };
    }
    const file = await fetch(info.url as string, {
      headers: { Authorization: `Bearer ${cfg.token}` },
    });
    if (!file.ok) return { ok: false, error: `Media download failed (${file.status}).` };
    return {
      ok: true,
      bytes: new Uint8Array(await file.arrayBuffer()),
      // The type Meta *declares*. Callers should also verify magic bytes.
      contentType: (info.mime_type as string) || file.headers.get("content-type") || "",
    };
  } catch (e: unknown) {
    return { ok: false, error: e instanceof Error ? e.message : "Network failure downloading media." };
  }
}

/**
 * Verifies the `X-Hub-Signature-256` HMAC.
 *
 * The webhook endpoint is public and writes to the database; there is no
 * session protecting it, since the caller is Meta. This check is the only
 * access control.
 *
 * The digest is computed over the **raw body**. Deserializing and
 * re-serializing the JSON yields a different string and the check fails.
 *
 * Returns `false` when `appSecret` is undefined — fail-closed, so an
 * incompletely configured deployment does not accept unverified payloads.
 *
 * Comparison is constant-time: a short-circuiting comparison leaks the digest
 * byte by byte through timing.
 */
export function isValidSignature(
  cfg: WhatsAppConfig,
  rawBody: string,
  header: string | null | undefined,
): boolean {
  const secret = cfg?.appSecret;
  if (!secret || !header) return false;
  const expected = header.startsWith("sha256=") ? header.slice(7) : header;
  if (!/^[0-9a-f]{64}$/i.test(expected)) return false;
  const computed = createHmac("sha256", secret).update(rawBody, "utf8").digest("hex");
  const a = Buffer.from(computed, "hex");
  const b = Buffer.from(expected.toLowerCase(), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Handles the `GET` challenge Meta issues when registering the webhook. */
export function verifyChallenge(
  cfg: WhatsAppConfig,
  params: URLSearchParams,
): { ok: true; challenge: string } | { ok: false } {
  const challenge = params.get("hub.challenge");
  const expected = cfg?.verifyToken;
  if (
    params.get("hub.mode") === "subscribe" &&
    expected &&
    params.get("hub.verify_token") === expected &&
    challenge
  ) {
    return { ok: true, challenge };
  }
  return { ok: false };
}

export type InboundMessage = {
  wamid: string;
  /** E.164 without `+`, as Meta sends it. */
  from: string;
  type: "text" | "image" | string;
  text?: string | null;
  mediaId?: string | null;
  occurredAt?: string | null;
};

/**
 * Extracts messages from Meta's payload shape: `entry[] → changes[] →
 * value.messages[]`.
 *
 * Delivery and read receipts arrive through the same webhook under
 * `value.statuses` and are ignored: treating them as messages would create an
 * empty submission every time the recipient opens the thread.
 */
export function extractMessages(payload: unknown): InboundMessage[] {
  const out: InboundMessage[] = [];
  const root = payload as { entry?: unknown[] };
  for (const entry of root?.entry ?? []) {
    for (const change of (entry as { changes?: unknown[] })?.changes ?? []) {
      const value = (change as { value?: { messages?: unknown[] } })?.value;
      for (const raw of value?.messages ?? []) {
        const m = raw as {
          id?: string;
          from?: string;
          type?: string;
          timestamp?: string;
          text?: { body?: string };
          image?: { id?: string; caption?: string };
        };
        if (!m?.id || !m?.from) continue;
        out.push({
          wamid: m.id,
          from: m.from,
          type: m.type ?? "other",
          // An image caption is text the recipient wrote to explain the
          // picture, so it is kept as the report body.
          text: m.type === "image" ? (m.image?.caption ?? null) : (m.text?.body ?? null),
          mediaId: m.image?.id ?? null,
          // Meta sends seconds since epoch.
          occurredAt: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : null,
        });
      }
    }
  }
  return out;
}
