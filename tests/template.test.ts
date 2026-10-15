import { describe, expect, it } from "vitest";
import { previewTemplate, templateForMeta, validateTemplate } from "../src/template.js";
import type { Form } from "../src/types.js";

/**
 * If a form declares two variables and the approved template has three, Meta
 * rejects the send at invitation time, in production: the case is created and
 * the recipient is never contacted. The observable symptom weeks later is an
 * unattended case, which does not look like an error.
 *
 * Declaring the body moves that mismatch into these assertions.
 */

const base: Form = {
  key: "f",
  button: "Invite",
  fields: [
    { key: "name", label: "Name", type: "text" },
    { key: "phone", label: "Mobile", type: "phone" },
    { key: "site", label: "Site", type: "text" },
  ],
  chat: {},
  template: {
    name: "followup_site",
    body: "Hello {{1}}. We are contacting you about {{2}}.\n\nYou can reply here.",
    variables: [{ field: "name" }, { field: "site", fallback: "a site" }],
  },
};

const withTemplate = (t: Partial<Form["template"]>): Form => ({
  ...base,
  template: { ...base.template, ...t },
});

describe("a consistent template", () => {
  it("1 · reports no issues", () => {
    expect(validateTemplate(base)).toEqual([]);
  });

  it("2 · renders with real values", () => {
    const text = previewTemplate(base, { name: "Armando", site: "block B" });
    expect(text).toContain("Hello Armando.");
    expect(text).toContain("about block B");
  });

  it("3 · an empty field uses its fallback: Meta rejects empty variables", () => {
    expect(previewTemplate(base, { name: "Armando" })).toContain("about a site");
  });
});

describe("mismatches Meta only reports at send time", () => {
  it("4 · placeholder count differs from variable count", () => {
    const fewer = validateTemplate(withTemplate({ body: "Hello {{1}}, good morning." }));
    expect(fewer.map((i) => i.rule)).toContain("count");
    expect(fewer[0]!.detail).toMatch(/1 placeholder\(s\) and 2 variable\(s\)/);

    const more = validateTemplate(withTemplate({ body: "Hello {{1}} about {{2}} in {{3}}, thanks." }));
    expect(more.map((i) => i.rule)).toContain("count");
  });

  it("5 · placeholders out of order or repeated", () => {
    expect(validateTemplate(withTemplate({ body: "Hello {{2}} about {{1}}, thanks." })).map((i) => i.rule)).toContain("order");
    expect(validateTemplate(withTemplate({ body: "Hello {{1}} about {{1}}, thanks." })).map((i) => i.rule)).toContain("order");
  });

  it("6 · a variable reading a field that does not exist", () => {
    // It would resolve to empty, and Meta rejects empty variables.
    const r = validateTemplate(withTemplate({ variables: [{ field: "name" }, { field: "nope" }] }));
    expect(r.map((i) => i.rule)).toContain("unknown_field");
    expect(r.find((i) => i.rule === "unknown_field")!.detail).toContain("nope");
  });
});

describe("Meta formatting rules", () => {
  it("7 · may not start or end with a variable", () => {
    expect(validateTemplate(withTemplate({ body: "{{1}} we are contacting you about {{2}} today." })).map((i) => i.rule)).toContain("leading_placeholder");
    expect(validateTemplate(withTemplate({ body: "Hello {{1}}, this is about {{2}}" })).map((i) => i.rule)).toContain("trailing_placeholder");
  });

  it("8 · two adjacent variables", () => {
    expect(validateTemplate(withTemplate({ body: "Hello {{1}} {{2}}, thanks." })).map((i) => i.rule)).toContain("adjacent_placeholders");
  });

  it("9 · the name allows lowercase, digits and underscores only", () => {
    expect(validateTemplate(withTemplate({ name: "Followup Site" })).map((i) => i.rule)).toContain("name");
  });
});

describe("no declared body", () => {
  it("10 · not an error, but reported as unchecked", () => {
    // The template may have been approved elsewhere. What must not happen is
    // mistaking "unchecked" for "valid".
    const r = validateTemplate(withTemplate({ body: undefined }));
    expect(r.map((i) => i.rule)).toEqual(["no_body"]);
    expect(r[0]!.detail).toContain("in production");
  });
});

describe("submission payload", () => {
  it("11 · body and per-placeholder mapping", () => {
    const m = templateForMeta(base);
    expect(m.name).toBe("followup_site");
    expect(m.language).toBe("es");
    // Utility rather than Marketing: the message continues an existing
    // interaction. Marketing is priced higher and subject to opt-out.
    expect(m.category).toBe("utility");
    expect(m.variables).toEqual([
      { placeholder: "{{1}}", field: "name", fallback: undefined },
      { placeholder: "{{2}}", field: "site", fallback: "a site" },
    ]);
  });
});
