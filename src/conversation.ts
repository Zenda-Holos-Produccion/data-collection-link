import type { Case, Form, Repository, Storage } from "./types.js";
import {
  downloadMedia,
  sendTemplate,
  sendText,
  type InboundMessage,
  type WhatsAppConfig,
} from "./whatsapp.js";

/**
 * Turns inbound WhatsApp messages into persisted submissions.
 *
 * ## Ordering is the guarantee
 *
 * 1. The message is recorded **first**, keyed by `wamid`. If it already
 *    existed, the delivery is a Meta retry and processing stops.
 * 2. Media is downloaded **in-band**: the signed URL Meta returns expires
 *    within minutes, so deferring it risks an unrecoverable object.
 * 3. The acknowledgement is sent **last** and never propagates its failure:
 *    the submission is already persisted, and losing it because the reply
 *    could not be sent would be worse than losing the reply.
 */

export type Deps = {
  whatsapp: WhatsAppConfig;
  repository: Repository;
  storage: Storage;
  /** Replies sent to the recipient. Omit to send none. */
  replies?: {
    received?: (ctx: { withPhoto: boolean }) => string;
    missingToClose?: (missing: { reports: number; photos: number }) => string;
    closed?: () => string;
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

/**
 * Converts Meta's E.164 form to the number as stored.
 *
 * The country code is stripped so numbers are stored in a single
 * representation; mixing both forms makes `openCaseFor` miss about half the
 * lookups.
 */
export function normalizePhone(from: string, countryCode: string): string | null {
  const digits = (from ?? "").replace(/\D+/g, "");
  if (!digits) return null;
  return digits.startsWith(countryCode) ? digits.slice(countryCode.length) : digits;
}

/** Creates the case and sends the opening template. */
export async function invite(
  deps: Deps,
  form: Form,
  values: Record<string, string>,
): Promise<{ case: Case; sent: boolean; error?: string }> {
  const phoneField = form.fields.find((f) => f.type === "phone");
  if (!phoneField) {
    throw new Error(
      `Form "${form.key}" declares no field of type "phone", so there is no delivery address.`,
    );
  }
  const phone = (values[phoneField.key] ?? "").replace(/\D+/g, "");
  if (!phone) throw new Error(`Missing ${phoneField.label}.`);

  for (const field of form.fields) {
    if (field.required && !(values[field.key] ?? "").trim()) {
      throw new Error(`Missing ${field.label}.`);
    }
  }

  const created = await deps.repository.createCase({
    form: form.key,
    phone,
    values: Object.fromEntries(
      form.fields.map((f) => [f.key, (values[f.key] ?? "").trim() || null]),
    ),
  });

  // Meta rejects templates with empty variables, so optional fields need a
  // fallback. The failure surfaces only at send time, with the template
  // already approved.
  const variables = form.template.variables.map((v) => {
    const value = (values[v.field] ?? "").trim();
    return value || v.fallback || "—";
  });

  const result = await sendTemplate(deps.whatsapp, {
    phone,
    template: form.template.name,
    language: form.template.language,
    variables,
  });
  await deps.repository.recordDelivery(created.id, result);

  if (result.ok && result.wamid) {
    await deps.repository.recordMessage({
      caseId: created.id,
      wamid: result.wamid,
      direction: "outbound",
      type: "template",
      text: null,
      occurredAt: null,
    });
  }

  return { case: created, sent: result.ok, error: result.error };
}

export type InboundResult =
  | { status: "duplicate" }
  | { status: "no_case" }
  | { status: "stored"; withPhoto: boolean }
  | { status: "closed" }
  | { status: "ignored"; reason: string };

export async function processInbound(
  deps: Deps,
  form: Form,
  m: InboundMessage,
): Promise<InboundResult> {
  const phone = normalizePhone(m.from, deps.whatsapp.countryCode);
  const openCase = phone ? await deps.repository.openCaseFor(phone) : null;

  // 1 · Record first. A known `wamid` means this is a retry.
  const isNew = await deps.repository.recordMessage({
    caseId: openCase?.id ?? null,
    wamid: m.wamid,
    direction: "inbound",
    type: m.type === "text" ? "text" : m.type === "image" ? "image" : "other",
    text: m.text ?? null,
    occurredAt: m.occurredAt ?? null,
  });
  if (!isNew) return { status: "duplicate" };
  // Numbers without an open case are not replied to: a business number
  // receives unsolicited messages, and each reply costs a conversation.
  if (!openCase || !phone) return { status: "no_case" };

  // 2 · Closing request.
  if (m.type === "text" && isClosingMessage(m.text, form.chat.closingWords)) {
    const have = await deps.repository.count(openCase.id);
    const missingReports = form.chat.report?.requiredToClose && have.reports === 0 ? 1 : 0;
    const missingPhotos = Math.max(0, (form.chat.photos?.minToClose ?? 0) - have.photos);
    if (missingReports || missingPhotos) {
      await reply(deps, phone, deps.replies?.missingToClose?.({ reports: missingReports, photos: missingPhotos }));
      return { status: "ignored", reason: "close requested before requirements met" };
    }
    await deps.repository.closeCase(openCase.id);
    await reply(deps, phone, deps.replies?.closed?.());
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
    const media = await downloadMedia(deps.whatsapp, m.mediaId);
    if (!media.ok) {
      await reply(deps, phone, "Your message was received, but the photo could not be stored. Please send it again.");
    } else {
      const stored = await deps.storage.save({
        bytes: media.bytes,
        contentType: media.contentType,
        prefix: form.key,
      });
      await deps.repository.savePhoto(openCase.id, {
        path: stored.path,
        contentType: media.contentType,
        bytes: stored.bytes,
        sha256: stored.sha256,
      });
      withPhoto = true;
    }
  }

  await reply(deps, phone, deps.replies?.received?.({ withPhoto }));
  return { status: "stored", withPhoto };
}

/** Acknowledgement failures are logged, not propagated. */
async function reply(deps: Deps, phone: string, text?: string): Promise<void> {
  if (!text) return;
  const r = await sendText(deps.whatsapp, { phone, text });
  if (!r.ok) console.warn("[whatsapp-conversational-form] acknowledgement not sent:", r.error);
}
