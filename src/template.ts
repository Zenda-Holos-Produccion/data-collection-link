import type { Form } from "./types.js";

/**
 * Template validation.
 *
 * A WhatsApp template is a body that Meta approves verbatim, with `{{1}}`,
 * `{{2}}` placeholders. If a form declares two variables and the approved
 * template has three, Meta rejects the send — at invitation time, in
 * production: the case is created and the recipient is never contacted. The
 * observable symptom, weeks later, is an unattended case, which does not look
 * like an error.
 *
 * Declaring the body alongside the variables moves that mismatch into a test.
 *
 * **Out of scope:** this does not submit the template, nor verify that the one
 * approved in Meta matches. Editing it from the console is not detected here;
 * that requires the management API, a different token and scope.
 */

export type TemplateIssue = { rule: string; detail: string };

/** Placeholder indices, in order of appearance. */
function placeholders(body: string): number[] {
  return [...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
}

/** Returns the list of problems. Empty means the template is consistent. */
export function validateTemplate(form: Form): TemplateIssue[] {
  const t = form.template;
  const issues: TemplateIssue[] = [];

  if (!/^[a-z0-9_]{1,512}$/.test(t.name)) {
    issues.push({
      rule: "name",
      detail: `"${t.name}" is not valid: Meta allows lowercase letters, digits and underscores only.`,
    });
  }

  // A variable reading a non-existent field resolves to empty, and Meta
  // rejects empty variables.
  for (const v of t.variables) {
    if (!form.fields.some((f) => f.key === v.field)) {
      issues.push({
        rule: "unknown_field",
        detail: `Variable reads field "${v.field}", which the form does not declare.`,
      });
    }
  }

  if (!t.body) {
    // Not an error: the template may have been approved elsewhere. But
    // "unchecked" has to be distinguishable from "valid".
    issues.push({
      rule: "no_body",
      detail:
        "No body declared, so placeholders cannot be checked against variables. A mismatch would surface at invitation time, in production.",
    });
    return issues;
  }

  const body = t.body.trim();
  const found = placeholders(body);

  if (body.length > 1024) {
    issues.push({ rule: "length", detail: `Body is ${body.length} characters; the limit is 1024.` });
  }

  if (found.length !== t.variables.length) {
    issues.push({
      rule: "count",
      detail: `Body has ${found.length} placeholder(s) and ${t.variables.length} variable(s) are declared. Meta rejects the send when they differ.`,
    });
  }

  // Must be sequential from 1, with no gaps or repeats.
  const expected = found.map((_, i) => i + 1);
  if (found.join(",") !== expected.join(",")) {
    issues.push({
      rule: "order",
      detail: `Placeholders must read {{1}}, {{2}}… in order and without repeats. Found: ${found.map((n) => `{{${n}}}`).join(" ")}.`,
    });
  }

  if (/^\s*\{\{/.test(body)) {
    issues.push({ rule: "leading_placeholder", detail: "Body may not start with a variable." });
  }
  if (/\}\}\s*$/.test(body)) {
    issues.push({ rule: "trailing_placeholder", detail: "Body may not end with a variable." });
  }
  if (/\}\}[\s]*\{\{/.test(body)) {
    issues.push({
      rule: "adjacent_placeholders",
      detail: "Two variables may not be adjacent without text between them.",
    });
  }

  return issues;
}

/** The payload to submit through Meta's template form. */
export function templateForMeta(form: Form): {
  name: string;
  language: string;
  category: string;
  body: string;
  variables: { placeholder: string; field: string; fallback?: string }[];
} {
  const t = form.template;
  return {
    name: t.name,
    language: t.language ?? "es",
    // Utility rather than Marketing: the message continues an interaction the
    // business already has with the recipient. Marketing is priced higher and
    // is subject to the recipient's opt-out preferences.
    category: t.category ?? "utility",
    body: (t.body ?? "").trim(),
    variables: t.variables.map((v, i) => ({
      placeholder: `{{${i + 1}}}`,
      field: v.field,
      fallback: v.fallback,
    })),
  };
}

/** Renders the message as the recipient will receive it. */
export function previewTemplate(form: Form, values: Record<string, string>): string {
  const t = form.template;
  let text = (t.body ?? "").trim();
  t.variables.forEach((v, i) => {
    const value = (values[v.field] ?? "").trim() || v.fallback || "—";
    text = text.replace(new RegExp(`\\{\\{\\s*${i + 1}\\s*\\}\\}`, "g"), value);
  });
  return text;
}
