import type { ChannelName, DialogField, Form } from "./types.js";

/**
 * Checking a form definition, whether it lives in code or in a database.
 *
 * ## Why this exists
 *
 * A definition has rules that no type system expresses: the invitation's
 * placeholders must match its variables, a WhatsApp form needs exactly one
 * phone field, Meta rejects a body that starts with a variable. Broken, none
 * of them fails at build time — they fail at invitation time, in production:
 * the case is created and the recipient is never contacted. The observable
 * symptom, weeks later, is an unattended case, which does not look like an
 * error.
 *
 * - `validateForm` checks a typed `Form`. For a definition in code, call it
 *   in a test.
 * - `parseForm` checks **untrusted data** — JSON from a database row or an
 *   editor — shape first, then the same rules. It is what makes runtime
 *   definitions possible: a host stores forms as data and refuses to save or
 *   use one that does not pass.
 *
 * **Out of scope:** this does not submit the WhatsApp template, nor verify
 * that the one approved in Meta matches. Editing it from the Meta console is
 * not detected here; that requires the management API.
 */

export const CHANNELS: readonly ChannelName[] = ["whatsapp", "telegram"];

export type FormIssue = { rule: string; detail: string };

/** Placeholder indices, in order of appearance. */
function placeholders(body: string): number[] {
  return [...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
}

/** Returns the list of problems. Empty means the form can be used. */
export function validateForm(form: Form): FormIssue[] {
  const issues: FormIssue[] = [];
  const add = (rule: string, detail: string) => issues.push({ rule, detail });

  if (!/^[a-z0-9_-]{1,64}$/.test(form.key)) {
    add("key", `"${form.key}" is not valid: lowercase letters, digits, "_" and "-", up to 64.`);
  }
  if (!form.button?.trim()) add("button", "The button needs a label.");

  // ── Channels ──────────────────────────────────────────────────────────
  if (!form.channels?.length) add("channels", "Declare at least one channel.");
  for (const c of form.channels ?? []) {
    if (!CHANNELS.includes(c)) add("channels", `Unknown channel "${c}".`);
  }
  if (new Set(form.channels).size !== (form.channels ?? []).length) add("channels", "A channel is listed twice.");
  const onWhatsApp = form.channels?.includes("whatsapp") ?? false;

  // ── Fields ────────────────────────────────────────────────────────────
  const keys = new Set<string>();
  for (const f of form.fields ?? []) {
    if (!/^[a-z][a-z0-9_]{0,63}$/i.test(f.key)) add("field_key", `Field key "${f.key}" is not valid.`);
    if (keys.has(f.key)) add("field_key", `Field key "${f.key}" is declared twice.`);
    keys.add(f.key);
    if (!f.label?.trim()) add("field_label", `Field "${f.key}" needs a label.`);
    if (!["phone", "text", "textarea"].includes(f.type)) add("field_type", `Field "${f.key}" has unknown type "${f.type}".`);
  }
  const phones = (form.fields ?? []).filter((f) => f.type === "phone");
  if (onWhatsApp && phones.length !== 1) {
    add("phone", `A WhatsApp form needs exactly one "phone" field — its delivery address. Found ${phones.length}.`);
  }
  if (!onWhatsApp && phones.length > 1) add("phone", "At most one \"phone\" field.");

  // ── Chat ──────────────────────────────────────────────────────────────
  const chat = form.chat ?? {};
  if (chat.report?.enabled === false && chat.photos?.enabled === false) {
    add("chat", "The conversation collects nothing: enable the report, the photos, or both.");
  }
  const min = chat.photos?.minToClose;
  if (min !== undefined && (!Number.isInteger(min) || min < 0)) add("chat", "`photos.minToClose` must be a whole number, 0 or more.");
  if (chat.closingWords && chat.closingWords.some((w) => !w.trim())) add("chat", "A closing word is empty.");

  // ── Invitation ────────────────────────────────────────────────────────
  const inv = form.invitation;
  const body = (inv?.body ?? "").trim();
  if (!body) {
    add("body", "The invitation needs a body: it is the first message the recipient reads.");
    return issues;
  }
  for (const v of inv.variables ?? []) {
    const field = (form.fields ?? []).find((f) => f.key === v.field);
    if (!field) {
      // It would resolve to empty, and Meta rejects empty variables.
      add("unknown_field", `Variable reads field "${v.field}", which the form does not declare.`);
    } else if (!field.required && !v.fallback?.trim()) {
      add("fallback", `Variable reading optional field "${v.field}" needs a fallback: an empty variable is rejected by Meta and reads as a gap anywhere.`);
    }
  }
  const found = placeholders(body);
  if (found.length !== (inv.variables ?? []).length) {
    add(
      "count",
      `Body has ${found.length} placeholder(s) and ${(inv.variables ?? []).length} variable(s) are declared. They must match.`,
    );
  }
  if (found.join(",") !== found.map((_, i) => i + 1).join(",")) {
    add("order", `Placeholders must read {{1}}, {{2}}… in order and without repeats. Found: ${found.map((n) => `{{${n}}}`).join(" ")}.`);
  }
  if (body.length > 4096) add("length", `Body is ${body.length} characters; Telegram's limit is 4096.`);

  // ── WhatsApp: the template Meta approves ─────────────────────────────
  if (onWhatsApp) {
    if (!form.whatsapp) {
      add("whatsapp_template", "A WhatsApp form needs `whatsapp`: the name of the template Meta approved.");
    } else if (!/^[a-z0-9_]{1,512}$/.test(form.whatsapp.name)) {
      add("whatsapp_name", `"${form.whatsapp.name}" is not valid: Meta allows lowercase letters, digits and underscores only.`);
    }
    if (body.length > 1024) add("whatsapp_length", `Body is ${body.length} characters; Meta's limit is 1024.`);
    if (/^\s*\{\{/.test(body)) add("leading_placeholder", "On WhatsApp the body may not start with a variable.");
    if (/\}\}\s*$/.test(body)) add("trailing_placeholder", "On WhatsApp the body may not end with a variable.");
    if (/\}\}[\s]*\{\{/.test(body)) add("adjacent_placeholders", "On WhatsApp two variables may not be adjacent without text between them.");
  }

  return issues;
}

// ── Untrusted data ─────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : undefined);

/**
 * Reads a definition from untrusted data — a database row, an editor's JSON —
 * and returns it only if it passes `validateForm`.
 *
 * Unknown properties are dropped rather than carried along: what is not in
 * the model is not used, and keeping it would let a row smuggle data into
 * places that trust a `Form`.
 */
export function parseForm(input: unknown): { ok: true; form: Form } | { ok: false; issues: FormIssue[] } {
  const issues: FormIssue[] = [];
  if (!isObject(input)) return { ok: false, issues: [{ rule: "shape", detail: "A form is an object." }] };

  const fieldsIn = Array.isArray(input.fields) ? input.fields : null;
  if (!fieldsIn) issues.push({ rule: "shape", detail: "`fields` must be a list." });
  const fields: DialogField[] = (fieldsIn ?? []).map((f, i) => {
    if (!isObject(f)) {
      issues.push({ rule: "shape", detail: `Field ${i + 1} is not an object.` });
      return { key: "", label: "", type: "text" };
    }
    return {
      key: str(f.key) ?? "",
      label: str(f.label) ?? "",
      type: (str(f.type) ?? "") as DialogField["type"],
      ...(typeof f.required === "boolean" ? { required: f.required } : {}),
      ...(str(f.help) ? { help: str(f.help) } : {}),
      ...(str(f.placeholder) ? { placeholder: str(f.placeholder) } : {}),
      ...(typeof f.maxLength === "number" ? { maxLength: f.maxLength } : {}),
    };
  });

  const chatIn = isObject(input.chat) ? input.chat : {};
  const report = isObject(chatIn.report) ? chatIn.report : null;
  const photos = isObject(chatIn.photos) ? chatIn.photos : null;
  const words = Array.isArray(chatIn.closingWords) ? chatIn.closingWords.filter((w): w is string => typeof w === "string") : null;

  const invIn = isObject(input.invitation) ? input.invitation : null;
  if (!invIn) issues.push({ rule: "shape", detail: "`invitation` must be an object with `body` and `variables`." });
  const variablesIn = invIn && Array.isArray(invIn.variables) ? invIn.variables : [];

  const waIn = isObject(input.whatsapp) ? input.whatsapp : null;
  const category = str(waIn?.category);

  const form: Form = {
    key: str(input.key) ?? "",
    button: str(input.button) ?? "",
    ...(str(input.title) ? { title: str(input.title) } : {}),
    ...(str(input.description) ? { description: str(input.description) } : {}),
    channels: (Array.isArray(input.channels) ? input.channels : []).map((c) => String(c)) as ChannelName[],
    fields,
    chat: {
      ...(report
        ? {
            report: {
              enabled: report.enabled !== false,
              ...(typeof report.requiredToClose === "boolean" ? { requiredToClose: report.requiredToClose } : {}),
            },
          }
        : {}),
      ...(photos
        ? {
            photos: {
              enabled: photos.enabled !== false,
              ...(typeof photos.minToClose === "number" ? { minToClose: photos.minToClose } : {}),
            },
          }
        : {}),
      ...(words ? { closingWords: words } : {}),
    },
    invitation: {
      body: str(invIn?.body) ?? "",
      variables: variablesIn.filter(isObject).map((v) => ({
        field: str(v.field) ?? "",
        ...(str(v.fallback) ? { fallback: str(v.fallback) } : {}),
      })),
    },
    ...(waIn
      ? {
          whatsapp: {
            name: str(waIn.name) ?? "",
            ...(str(waIn.language) ? { language: str(waIn.language) } : {}),
            ...(category === "utility" || category === "marketing" || category === "authentication" ? { category } : {}),
          },
        }
      : {}),
  };

  issues.push(...validateForm(form));
  return issues.length ? { ok: false, issues } : { ok: true, form };
}

// ── Rendering ──────────────────────────────────────────────────────────────

/** The variables in order, each with its fallback — what both channels send. */
export function invitationVariables(form: Form, values: Record<string, string | null | undefined>): string[] {
  return form.invitation.variables.map((v) => (values[v.field] ?? "").trim() || v.fallback || "—");
}

/** The invitation as the recipient reads it. */
export function previewInvitation(form: Form, values: Record<string, string | null | undefined>): string {
  let text = form.invitation.body.trim();
  invitationVariables(form, values).forEach((value, i) => {
    text = text.replace(new RegExp(`\\{\\{\\s*${i + 1}\\s*\\}\\}`, "g"), value);
  });
  return text;
}

/** The payload to submit through Meta's template form. Throws without `whatsapp`. */
export function templateForMeta(form: Form): {
  name: string;
  language: string;
  category: string;
  body: string;
  variables: { placeholder: string; field: string; fallback?: string }[];
} {
  if (!form.whatsapp) throw new Error(`Form "${form.key}" declares no WhatsApp template.`);
  return {
    name: form.whatsapp.name,
    language: form.whatsapp.language ?? "es",
    // Utility rather than Marketing: the message continues an interaction the
    // business already has with the recipient. Marketing is priced higher and
    // is subject to the recipient's opt-out preferences.
    category: form.whatsapp.category ?? "utility",
    body: form.invitation.body.trim(),
    variables: form.invitation.variables.map((v, i) => ({
      placeholder: `{{${i + 1}}}`,
      field: v.field,
      fallback: v.fallback,
    })),
  };
}
