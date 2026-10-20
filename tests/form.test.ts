import { describe, expect, it } from "vitest";
import { parseForm, previewInvitation, templateForMeta, validateForm } from "../src/form.js";
import type { Form } from "../src/types.js";

/**
 * A broken definition fails at invitation time, in production: the case is
 * created and the recipient is never contacted. These assertions move each
 * known way of breaking one into a test — for a definition in code — and into
 * `parseForm` — for one loaded at runtime.
 */

const base: Form = {
  key: "site-followup",
  button: "Invite",
  channels: ["whatsapp", "telegram"],
  fields: [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "phone", label: "Mobile", type: "phone", required: true },
    { key: "site", label: "Site", type: "text" },
  ],
  chat: { report: { enabled: true }, photos: { enabled: true, minToClose: 1 } },
  invitation: {
    body: "Hello {{1}}. We are contacting you about {{2}}.\n\nYou can reply here.",
    variables: [{ field: "name" }, { field: "site", fallback: "a site" }],
  },
  whatsapp: { name: "followup_site" },
};

const rules = (f: Form) => validateForm(f).map((i) => i.rule);
const withInvitation = (i: Partial<Form["invitation"]>): Form => ({ ...base, invitation: { ...base.invitation, ...i } });

describe("a consistent form", () => {
  it("1 · reports no issues", () => {
    expect(validateForm(base)).toEqual([]);
  });

  it("2 · renders with real values, and an empty field uses its fallback", () => {
    expect(previewInvitation(base, { name: "Armando", site: "block B" })).toContain("Hello Armando. We are contacting you about block B.");
    expect(previewInvitation(base, { name: "Armando" })).toContain("about a site");
  });
});

describe("mismatches that only show at invitation time", () => {
  it("3 · placeholder count differs from variable count", () => {
    expect(rules(withInvitation({ body: "Hello {{1}}, good morning." }))).toContain("count");
    expect(rules(withInvitation({ body: "Hello {{1}} about {{2}} in {{3}}, thanks." }))).toContain("count");
  });

  it("4 · placeholders out of order or repeated", () => {
    expect(rules(withInvitation({ body: "Hello {{2}} about {{1}}, thanks." }))).toContain("order");
    expect(rules(withInvitation({ body: "Hello {{1}} about {{1}}, thanks." }))).toContain("order");
  });

  it("5 · a variable reading a field that does not exist, or an optional one without fallback", () => {
    expect(rules(withInvitation({ variables: [{ field: "name" }, { field: "nope" }] }))).toContain("unknown_field");
    expect(rules(withInvitation({ variables: [{ field: "name" }, { field: "site" }] }))).toContain("fallback");
  });

  it("6 · an empty body", () => {
    expect(rules(withInvitation({ body: "  " }))).toEqual(["body"]);
  });
});

describe("channel rules", () => {
  it("7 · WhatsApp needs exactly one phone field and its template", () => {
    expect(rules({ ...base, fields: base.fields.filter((f) => f.type !== "phone") })).toContain("phone");
    expect(rules({ ...base, whatsapp: undefined })).toContain("whatsapp_template");
  });

  it("8 · a Telegram-only form needs neither", () => {
    const telegramOnly: Form = { ...base, channels: ["telegram"], whatsapp: undefined, fields: base.fields.filter((f) => f.type !== "phone") };
    expect(validateForm(telegramOnly)).toEqual([]);
  });

  it("9 · Meta formatting rules apply on WhatsApp only", () => {
    const edge = withInvitation({ body: "{{1}} we are contacting you about {{2}}" });
    expect(rules(edge)).toEqual(expect.arrayContaining(["leading_placeholder", "trailing_placeholder"]));
    expect(rules({ ...edge, channels: ["telegram"] })).not.toContain("leading_placeholder");
    expect(rules(withInvitation({ body: "Hello {{1}} {{2}}, thanks." }))).toContain("adjacent_placeholders");
    expect(rules({ ...base, whatsapp: { name: "Followup Site" } })).toContain("whatsapp_name");
  });

  it("10 · unknown or repeated channels", () => {
    expect(rules({ ...base, channels: [] })).toContain("channels");
    expect(rules({ ...base, channels: ["whatsapp", "whatsapp"] })).toContain("channels");
    expect(rules({ ...base, channels: ["sms" as "whatsapp"] })).toContain("channels");
  });
});

describe("definitions loaded at runtime", () => {
  it("11 · a JSON round trip of a valid form parses back to the same form", () => {
    expect(parseForm(JSON.parse(JSON.stringify(base)))).toEqual({ ok: true, form: base });
  });

  it("12 · wrong shapes are refused with a reason, never thrown", () => {
    for (const junk of [null, 42, "form", [], { fields: "x" }]) {
      const r = parseForm(junk);
      expect(r.ok).toBe(false);
    }
    const r = parseForm({ ...base, invitation: undefined });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.rule)).toContain("shape");
  });

  it("13 · properties outside the model are dropped, not carried along", () => {
    const r = parseForm({ ...base, sql: "drop table x", fields: [{ ...base.fields[0], onSave: "x" }, base.fields[1], base.fields[2]] });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.form).not.toHaveProperty("sql");
      expect(r.form.fields[0]).not.toHaveProperty("onSave");
    }
  });

  it("14 · a row that breaks a rule is refused like code that breaks it", () => {
    const r = parseForm({ ...base, invitation: { body: "Hello {{1}}.", variables: [] } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues.map((i) => i.rule)).toContain("count");
  });
});

describe("Meta submission payload", () => {
  it("15 · body and per-placeholder mapping, utility by default", () => {
    const m = templateForMeta(base);
    expect(m).toMatchObject({ name: "followup_site", language: "es", category: "utility" });
    expect(m.variables).toEqual([
      { placeholder: "{{1}}", field: "name", fallback: undefined },
      { placeholder: "{{2}}", field: "site", fallback: "a site" },
    ]);
  });

  it("16 · a form without a WhatsApp template has nothing to submit", () => {
    expect(() => templateForMeta({ ...base, whatsapp: undefined })).toThrow(/no WhatsApp template/);
  });
});
