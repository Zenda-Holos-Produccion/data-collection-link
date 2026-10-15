import { describe, expect, it, vi } from "vitest";
import { isClosingMessage, normalizePhone, processInbound, invite } from "../src/conversation.js";
import { extractMessages, isValidSignature } from "../src/whatsapp.js";
import { createHmac } from "node:crypto";
import type { Case, Form, Repository, Storage } from "../src/types.js";

/**
 * Covers the failure modes that are silent: closing detection, phone
 * normalization, deduplication of Meta retries, and signature verification.
 */

const FORM: Form = {
  key: "followup",
  button: "New follow-up",
  fields: [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "phone", label: "Mobile", type: "phone", required: true },
  ],
  chat: { report: { enabled: true, requiredToClose: true }, photos: { enabled: true, minToClose: 1 } },
  template: { name: "t", variables: [{ field: "name" }] },
};

const whatsapp = { token: "t", phoneNumberId: "1", countryCode: "57", appSecret: "s" };

function fakeRepository(openCase: Case | null) {
  const seen = new Set<string>();
  const state = { reports: 0, photos: 0, closed: false };
  const repository: Repository = {
    createCase: async (i) => ({ id: "c1", form: i.form, phone: i.phone, values: i.values, status: "invited" }),
    openCaseFor: async () => openCase,
    recordMessage: async (m) => (seen.has(m.wamid) ? false : (seen.add(m.wamid), true)),
    saveReport: async () => { state.reports += 1; },
    savePhoto: async () => { state.photos += 1; },
    count: async () => ({ reports: state.reports, photos: state.photos }),
    closeCase: async () => { state.closed = true; },
    recordDelivery: async () => {},
  };
  return { repository, state };
}

const storage: Storage = {
  save: async () => ({ path: "x/1.jpg", sha256: "a".repeat(64), bytes: 10 }),
};

const OPEN_CASE: Case = { id: "c1", form: "followup", phone: "3001234567", values: {}, status: "in_progress" };

describe("closing detection", () => {
  it("1 · accepts the usual wordings", () => {
    for (const t of ["listo", "LISTO", " Listo ", "terminé", "Terminado", "fin", "done", "listo."]) {
      expect(isClosingMessage(t), `rejected "${t}"`).toBe(true);
    }
  });

  it("2 · does NOT close on a sentence that merely contains the word", () => {
    // A false positive leaves the recipient without a channel to continue
    // reporting, and reopening the case is not under their control.
    for (const t of ["Listo, mañana sigo con el segundo piso", "ya quedó listo el muro pero falta el techo"]) {
      expect(isClosingMessage(t), `closed on "${t}"`).toBe(false);
    }
  });

  it("3 · closing words are configurable per form", () => {
    expect(isClosingMessage("acabé", ["acabé", "ya"])).toBe(true);
    expect(isClosingMessage("listo", ["acabé", "ya"]), "defaults no longer apply").toBe(false);
  });
});

describe("phone normalization", () => {
  it("4 · strips the country code regardless of input form", () => {
    expect(normalizePhone("573001234567", "57")).toBe("3001234567");
    expect(normalizePhone("3001234567", "57")).toBe("3001234567");
    expect(normalizePhone("5215512345678", "52")).toBe("15512345678");
  });
});

describe("retry deduplication", () => {
  it("5 · the same wamid is processed once", async () => {
    const { repository, state } = fakeRepository(OPEN_CASE);
    const deps = { whatsapp, repository, storage };
    const m = { wamid: "w1", from: "573001234567", type: "text" as const, text: "Slab poured" };

    expect((await processInbound(deps, FORM, m)).status).toBe("stored");
    expect((await processInbound(deps, FORM, m)).status).toBe("duplicate");
    expect(state.reports, "the report was stored once").toBe(1);
  });

  it("6 · numbers without an open case are not replied to", async () => {
    const { repository } = fakeRepository(null);
    const r = await processInbound({ whatsapp, repository, storage }, FORM, {
      wamid: "w9", from: "573009999999", type: "text", text: "hello",
    });
    expect(r.status).toBe("no_case");
  });
});

describe("closing requirements", () => {
  it("7 · refuses to close before the minimum is met", async () => {
    const { repository, state } = fakeRepository(OPEN_CASE);
    const r = await processInbound({ whatsapp, repository, storage }, FORM, {
      wamid: "w2", from: "573001234567", type: "text", text: "listo",
    });
    expect(r.status).toBe("ignored");
    // An empty closed case reads as attended when it is not.
    expect(state.closed).toBe(false);
  });
});

describe("invite", () => {
  it("8 · rejects a form without a phone field, and says why", async () => {
    const { repository } = fakeRepository(null);
    const noPhone = { ...FORM, fields: [FORM.fields[0]!] };
    await expect(
      invite({ whatsapp, repository, storage }, noPhone, { name: "A" }),
    ).rejects.toThrow(/no field of type "phone"/);
  });

  it("9 · empty variables use their fallback: Meta rejects empty ones", async () => {
    const { repository } = fakeRepository(null);
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ messages: [{ id: "w-out" }] }), { status: 200 }),
    );
    try {
      const f = { ...FORM, template: { name: "t", variables: [{ field: "note", fallback: "a site" }] } };
      await invite({ whatsapp, repository, storage }, f, { name: "A", phone: "3001234567" });
      const body = JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string);
      expect(body.template.components[0].parameters[0].text).toBe("a site");
    } finally {
      spy.mockRestore();
    }
  });
});

describe("webhook signature", () => {
  const body = '{ "object": "whatsapp_business_account" }';
  const sign = (b: string, s = "s") => "sha256=" + createHmac("sha256", s).update(b, "utf8").digest("hex");

  it("10 · accepts a valid digest and rejects a foreign one", () => {
    expect(isValidSignature(whatsapp, body, sign(body))).toBe(true);
    expect(isValidSignature(whatsapp, body, sign(body, "other"))).toBe(false);
  });

  it("11 · rejects when no appSecret is configured — fail closed", () => {
    expect(isValidSignature({ ...whatsapp, appSecret: undefined }, body, sign(body))).toBe(false);
  });

  it("12 · a malformed digest does not throw", () => {
    expect(() => isValidSignature(whatsapp, body, "sha256=abcd")).not.toThrow();
    expect(isValidSignature(whatsapp, body, "sha256=abcd")).toBe(false);
  });
});

describe("payload extraction", () => {
  it("13 · delivery and read receipts are NOT messages", () => {
    // They arrive through the same webhook; treating them as messages would
    // create an empty submission whenever the recipient opens the thread.
    expect(extractMessages({ entry: [{ changes: [{ value: { statuses: [{ id: "x" }] } }] }] })).toEqual([]);
  });

  it("14 · an image keeps its caption", () => {
    const [m] = extractMessages({
      entry: [{ changes: [{ value: { messages: [{ id: "w", from: "57300", type: "image", image: { id: "m1", caption: "North wall" } }] } }] }],
    });
    expect(m!.mediaId).toBe("m1");
    expect(m!.text).toBe("North wall");
  });

  it("15 · malformed payloads yield an empty list rather than throwing", () => {
    for (const junk of [null, {}, { entry: null }, { entry: [{}] }]) {
      expect(() => extractMessages(junk)).not.toThrow();
      expect(extractMessages(junk)).toEqual([]);
    }
  });
});
