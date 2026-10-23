import { describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import { hashLinkToken, invite, isClosingMessage, processInbound, type Deps } from "../src/conversation.js";
import { extractMessages, isValidSignature, normalizePhone, whatsappChannel } from "../src/whatsapp.js";
import type { Channel, InboundMessage } from "../src/channel.js";
import type { Case, Form, Repository, Storage } from "../src/types.js";

/**
 * The conversation engine, on both channels.
 *
 * Covers the failure modes that are silent: closing detection, phone
 * normalization, deduplication of platform retries, signature verification,
 * and — on Telegram — the single-use binding of a link to a chat.
 */

const FORM: Form = {
  key: "followup",
  button: "New follow-up",
  channels: ["whatsapp", "telegram"],
  fields: [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "phone", label: "Mobile", type: "phone" },
    { key: "note", label: "Site", type: "textarea" },
  ],
  chat: { report: { enabled: true, requiredToClose: true }, photos: { enabled: true, minToClose: 1 } },
  invitation: {
    body: "Hello {{1}}. This is about {{2}}. Reply here.",
    variables: [{ field: "name" }, { field: "note", fallback: "a site" }],
  },
  whatsapp: { name: "followup_site" },
};

const whatsapp = { token: "t", phoneNumberId: "1", countryCode: "57", appSecret: "s" };

/** A channel that records what it was asked to do. */
function fakeChannel(name: "whatsapp" | "telegram") {
  const sent: { address: string; text: string }[] = [];
  const channel: Channel = {
    name,
    invite: vi.fn(async ({ linkToken }) =>
      name === "telegram"
        ? { ok: true, delivered: false, link: `https://t.me/bot?start=${linkToken}` }
        : { ok: true, delivered: true, messageId: "w-out" },
    ),
    sendText: async (address, text) => (sent.push({ address, text }), { ok: true, messageId: `${address}:${sent.length + 100}` }),
    downloadMedia: async () => ({ ok: true, bytes: new Uint8Array([0xff, 0xd8, 0xff]), contentType: "image/jpeg" }),
    verifyRequest: () => true,
    parse: () => [],
  };
  return { channel, sent };
}

/** A repository in memory, with the binding rule of the contract: first chat wins. */
function fakeRepository(initial: Case | null = null) {
  const seen = new Set<string>();
  const state = { reports: 0, photos: 0, closed: false, deliveries: [] as unknown[], tokenHash: null as string | null };
  let current: Case | null = initial;
  const repository: Repository = {
    createCase: async (i) => {
      state.tokenHash = i.linkTokenHash;
      current = { id: "c1", form: i.form, channel: i.channel, address: i.address, values: i.values, status: "invited" };
      return current;
    },
    openCaseFor: async (channel, address) =>
      current && current.channel === channel && current.address === address && current.status !== "closed" ? current : null,
    bindCase: async (channel, hash, address) => {
      if (!current || current.channel !== channel || state.tokenHash !== hash || current.address !== null) return null;
      current = { ...current, address };
      return current;
    },
    recordMessage: async (m) => {
      const k = `${m.channel}|${m.messageId}`;
      return seen.has(k) ? false : (seen.add(k), true);
    },
    saveReport: async () => void (state.reports += 1),
    savePhoto: async () => void (state.photos += 1),
    count: async () => ({ reports: state.reports, photos: state.photos }),
    closeCase: async () => {
      state.closed = true;
      if (current) current = { ...current, status: "closed" };
    },
    recordDelivery: async (_id, r) => void state.deliveries.push(r),
  };
  return { repository, state };
}

const storage: Storage = { save: async () => ({ path: "x/1.jpg", sha256: "a".repeat(64), bytes: 10 }) };

const OPEN_CASE: Case = {
  id: "c1",
  form: "followup",
  channel: "whatsapp",
  address: "3001234567",
  values: { name: "Ana" },
  status: "in_progress",
};

const text = (id: string, from: string, body: string, channel: "whatsapp" | "telegram" = "whatsapp"): InboundMessage => ({
  channel,
  id,
  from,
  type: "text",
  text: body,
});

function deps(repository: Repository, channels: Deps["channels"]): Deps {
  return {
    channels,
    repository,
    storage,
    replies: { received: () => "ok", closed: () => "closed", missingToClose: () => "missing", linkInvalid: () => "invalid" },
  };
}

describe("closing detection", () => {
  it("1 · accepts the usual wordings", () => {
    for (const t of ["listo", "LISTO", " Listo ", "terminé", "Terminado", "fin", "done", "listo."]) {
      expect(isClosingMessage(t), `rejected "${t}"`).toBe(true);
    }
  });

  it("2 · does NOT close on a sentence that merely contains the word", () => {
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
  it("5 · the same message id is processed once", async () => {
    const { repository, state } = fakeRepository(OPEN_CASE);
    const d = deps(repository, { whatsapp: fakeChannel("whatsapp").channel });
    const m = text("w1", "3001234567", "Slab poured");
    expect((await processInbound(d, FORM, m)).status).toBe("stored");
    expect((await processInbound(d, FORM, m)).status).toBe("duplicate");
    expect(state.reports, "the report was stored once").toBe(1);
  });

  it("6 · senders without an open case are not replied to", async () => {
    const { repository } = fakeRepository(null);
    const wa = fakeChannel("whatsapp");
    const r = await processInbound(deps(repository, { whatsapp: wa.channel }), FORM, text("w9", "3009999999", "hello"));
    expect(r.status).toBe("no_case");
    expect(wa.sent).toEqual([]);
  });
});

describe("closing requirements", () => {
  it("7 · refuses to close before the minimum is met", async () => {
    const { repository, state } = fakeRepository(OPEN_CASE);
    const r = await processInbound(deps(repository, { whatsapp: fakeChannel("whatsapp").channel }), FORM, text("w2", "3001234567", "listo"));
    expect(r.status).toBe("ignored");
    // An empty closed case reads as attended when it is not.
    expect(state.closed).toBe(false);
  });

  it("8 · closes once there is a report and a photo", async () => {
    const { repository, state } = fakeRepository(OPEN_CASE);
    const d = deps(repository, { whatsapp: fakeChannel("whatsapp").channel });
    await processInbound(d, FORM, { channel: "whatsapp", id: "w3", from: "3001234567", type: "image", text: "North wall", mediaId: "m1" });
    expect(state).toMatchObject({ reports: 1, photos: 1 });
    expect((await processInbound(d, FORM, text("w4", "3001234567", "LISTO"))).status).toBe("closed");
  });

  it("8b · a location or a button tap is recorded as `other`, and is not a report", async () => {
    const { repository, state } = fakeRepository({ ...OPEN_CASE, channel: "telegram", address: "77" });
    const types: string[] = [];
    const record = repository.recordMessage;
    repository.recordMessage = async (m) => (types.push(m.type), record(m));
    const d = deps(repository, { telegram: fakeChannel("telegram").channel });
    const where: InboundMessage = { channel: "telegram", id: "77:3", from: "77", type: "location", text: null, location: { latitude: 3.45, longitude: -76.53 } };
    const tap: InboundMessage = { channel: "telegram", id: "77:callback:q1", from: "77", type: "choice", text: null, choice: "x:y", callbackId: "q1" };
    expect((await processInbound(d, FORM, where)).status).toBe("stored");
    expect((await processInbound(d, FORM, tap)).status).toBe("stored");
    expect(types).toEqual(["other", "other"]);
    expect(state).toMatchObject({ reports: 0, photos: 0 });
  });
});

describe("invite over WhatsApp", () => {
  it("9 · rejects a missing phone, and says which field", async () => {
    const { repository } = fakeRepository();
    await expect(
      invite(deps(repository, { whatsapp: fakeChannel("whatsapp").channel }), FORM, { name: "A" }, "whatsapp"),
    ).rejects.toThrow(/Missing Mobile/);
  });

  it("10 · sends the template with fallbacks, records the delivery and the outbound message", async () => {
    const { repository, state } = fakeRepository();
    const spy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ messages: [{ id: "w-out" }] }), { status: 200 }));
    try {
      const r = await invite(deps(repository, { whatsapp: whatsappChannel(whatsapp) }), FORM, { name: "A", phone: "300 123 4567" });
      expect(r).toMatchObject({ delivered: true, case: { channel: "whatsapp", address: "3001234567" } });
      const body = JSON.parse((spy.mock.calls[0]?.[1] as RequestInit).body as string);
      expect(body.to).toBe("573001234567");
      expect(body.template.name).toBe("followup_site");
      // Meta rejects empty variables: the optional field uses its fallback.
      expect(body.template.components[0].parameters.map((p: { text: string }) => p.text)).toEqual(["A", "a site"]);
      expect(state.deliveries).toEqual([{ ok: true, delivered: true, messageId: "w-out", error: undefined }]);
      expect(state.tokenHash, "WhatsApp needs no link token").toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it("11 · a channel the host did not configure is an error before any case exists", async () => {
    const { repository, state } = fakeRepository();
    await expect(invite(deps(repository, {}), FORM, { name: "A", phone: "3001234567" })).rejects.toThrow(/not configured/);
    expect(state.deliveries).toEqual([]);
  });
});

describe("invite over Telegram", () => {
  it("12 · sends nothing, returns the link once, and stores only the token digest", async () => {
    const { repository, state } = fakeRepository();
    const tg = fakeChannel("telegram");
    const r = await invite(deps(repository, { telegram: tg.channel }), FORM, { name: "Ana" }, "telegram");
    const token = r.link!.split("start=")[1]!;
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(r).toMatchObject({ delivered: false, case: { channel: "telegram", address: null } });
    expect(state.tokenHash).toBe(hashLinkToken(token));
    expect(JSON.stringify(state.deliveries), "the link never reaches the repository").not.toContain(token);
    expect(tg.sent).toEqual([]);
  });

  it("13 · opening the link binds the chat and sends the invitation as written", async () => {
    const { repository } = fakeRepository();
    const tg = fakeChannel("telegram");
    const d = deps(repository, { telegram: tg.channel });
    const { link } = await invite(d, FORM, { name: "Ana" }, "telegram");
    const start: InboundMessage = { channel: "telegram", id: "77:1", from: "77", type: "text", start: link!.split("start=")[1] };

    expect(await processInbound(d, FORM, start)).toEqual({ status: "bound", caseId: "c1" });
    expect(tg.sent).toEqual([{ address: "77", text: "Hello Ana. This is about a site. Reply here." }]);
    expect((await processInbound(d, FORM, text("77:2", "77", "Slab poured", "telegram"))).status).toBe("stored");
  });

  it("14 · the same link opened from another account is refused: it is single-use", async () => {
    const { repository } = fakeRepository();
    const tg = fakeChannel("telegram");
    const d = deps(repository, { telegram: tg.channel });
    const { link } = await invite(d, FORM, { name: "Ana" }, "telegram");
    const token = link!.split("start=")[1];
    await processInbound(d, FORM, { channel: "telegram", id: "77:1", from: "77", type: "text", start: token });

    const r = await processInbound(d, FORM, { channel: "telegram", id: "88:1", from: "88", type: "text", start: token });
    expect(r.status).toBe("ignored");
    expect(tg.sent.at(-1)).toEqual({ address: "88", text: "invalid" });
    // And the forwarded account cannot report either.
    expect((await processInbound(d, FORM, text("88:2", "88", "hello", "telegram"))).status).toBe("no_case");
  });

  it("15 · a retried /start is a duplicate, not a second binding", async () => {
    const { repository } = fakeRepository();
    const tg = fakeChannel("telegram");
    const d = deps(repository, { telegram: tg.channel });
    const { link } = await invite(d, FORM, { name: "Ana" }, "telegram");
    const start: InboundMessage = { channel: "telegram", id: "77:1", from: "77", type: "text", start: link!.split("start=")[1] };
    await processInbound(d, FORM, start);
    expect((await processInbound(d, FORM, start)).status).toBe("duplicate");
    expect(tg.sent).toHaveLength(1);
  });
});

describe("WhatsApp webhook signature", () => {
  const body = '{ "object": "whatsapp_business_account" }';
  const sign = (b: string, s = "s") => "sha256=" + createHmac("sha256", s).update(b, "utf8").digest("hex");

  it("16 · accepts a valid digest and rejects a foreign one", () => {
    expect(isValidSignature(whatsapp, body, sign(body))).toBe(true);
    expect(isValidSignature(whatsapp, body, sign(body, "other"))).toBe(false);
  });

  it("17 · rejects when no appSecret is configured — fail closed", () => {
    expect(isValidSignature({ ...whatsapp, appSecret: undefined }, body, sign(body))).toBe(false);
  });

  it("18 · a malformed digest does not throw", () => {
    expect(() => isValidSignature(whatsapp, body, "sha256=abcd")).not.toThrow();
    expect(isValidSignature(whatsapp, body, "sha256=abcd")).toBe(false);
  });

  it("19 · the channel reads the signature header", () => {
    const channel = whatsappChannel(whatsapp);
    expect(channel.verifyRequest({ rawBody: body, headers: new Headers({ "x-hub-signature-256": sign(body) }) })).toBe(true);
    expect(channel.verifyRequest({ rawBody: body, headers: new Headers() })).toBe(false);
  });
});

describe("WhatsApp payload extraction", () => {
  it("20 · delivery and read receipts are NOT messages", () => {
    expect(extractMessages({ entry: [{ changes: [{ value: { statuses: [{ id: "x" }] } }] }] }, "57")).toEqual([]);
  });

  it("21 · an image keeps its caption, and the sender is stored without the country code", () => {
    const [m] = extractMessages(
      { entry: [{ changes: [{ value: { messages: [{ id: "w", from: "573001234567", type: "image", image: { id: "m1", caption: "North wall" } }] } }] }] },
      "57",
    );
    expect(m).toMatchObject({ channel: "whatsapp", id: "w", from: "3001234567", type: "image", mediaId: "m1", text: "North wall" });
  });

  it("22 · malformed payloads yield an empty list rather than throwing", () => {
    for (const junk of [null, {}, { entry: null }, { entry: [{}] }]) {
      expect(() => extractMessages(junk, "57")).not.toThrow();
      expect(extractMessages(junk, "57")).toEqual([]);
    }
  });
});
