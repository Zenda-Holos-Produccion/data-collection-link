import type { InboundLocation, InboundMessage } from "./channel.js";
import type { FormIssue } from "./form.js";

/**
 * Guided conversations: the bot asks one thing at a time, with buttons.
 *
 * ## What it is
 *
 * The free-form conversation (`conversation.ts`) turns a chat into a mailbox:
 * whatever the recipient sends is stored. A guided conversation is a
 * questionnaire instead. A `GuidedTemplate` lists the steps — a location, a
 * choice among buttons, a text, a number, a list of items, photos — and the
 * bot asks them in order. What must not travel through the chat goes through
 * a `handoff` step, which opens a page of the host's own.
 *
 * ## No I/O of its own
 *
 * `advance(state, template, input, ctx)` takes the conversation's state and
 * one inbound message, and returns the next state and the messages to send.
 * It stores nothing, sends nothing and looks nothing up: the host loads and
 * saves the state, sends the outputs (`renderTelegram` on Telegram), and
 * provides catalogs, remembered values, location resolvers and handoff links
 * through `ctx`. Any database query happens in the host.
 *
 * ## The state is data
 *
 * `GuidedState` is plain JSON, for the host to keep in a row between
 * messages. It holds the answers and where the conversation stands, and
 * nothing that did not come from an answer: no chat id, no link token, no
 * URL. A photo is its file id; its caption is dropped. A shared location the
 * recipient says is not the place is dropped too.
 *
 * ## The template speaks the host's language
 *
 * Every text the recipient reads comes from the template, including the
 * explanation for an answer that does not fit and the button that skips a
 * step. The library carries no language of its own; only the default
 * commands are Spanish (`/atras`, `/cancelar`, `/resumen`), and a template can
 * rename them.
 */

// ── Templates ───────────────────────────────────────────────────────────

export type GuidedScalar = string | number | boolean | null;

export type GuidedOption = {
  value: string;
  label: string;
  /**
   * How this option reads in a summary, instead of its label. An empty string
   * leaves the line out: a «kilos or tonnes» choice whose number says it all.
   */
  summary?: string;
};

/**
 * A condition over earlier answers. `answer` is a step id, or a path into an
 * answer: `"ubicacion.status"`. `equals: null` matches a skipped optional
 * step; a step that was never asked matches nothing.
 */
export type GuidedCondition =
  | { answer: string; equals: GuidedScalar | GuidedScalar[] }
  | { not: GuidedCondition }
  | { all: GuidedCondition[] }
  | { any: GuidedCondition[] };

type StepCommon = {
  /**
   * Unique in the template, up to 24 characters of `A-Z a-z 0-9 _ -`. It keys
   * the answer and goes inside the buttons' data, which is limited to 64 bytes.
   */
  id: string;
  /**
   * What the bot says when the step is reached. On a summary, its header; on a
   * handoff, the text above the button.
   */
  question: string;
  /** Skip this step when the condition holds over earlier answers. */
  skipIf?: GuidedCondition;
};

type AskedStep = StepCommon & {
  /** How the answer reads in a summary. Defaults to the id. */
  label?: string;
  /**
   * The value's side of its summary line, with `{value}` for the answer as it
   * displays: `"{value} kg"`. An empty string leaves the line out.
   */
  summaryAs?: string;
  /**
   * Said before the question again when an input does not fit the step — a
   * photo when a text is asked, a number out of range. Defaults to
   * `texts.invalid`.
   */
  invalid?: string;
};

type ValueStep = AskedStep & {
  /** Offers the `texts.skip` button. A skipped answer is `null`. */
  optional?: boolean;
  /**
   * The host keeps this answer for the chat (`guidedRemembered`) and passes it
   * back in `ctx.remembered`; the next conversation offers it as a
   * `texts.useRemembered` button. Not inside a list.
   */
  remember?: boolean;
};

/** Fixed options, or a catalog the host passes by name in `ctx.catalogs`. */
export type GuidedChoiceStep = ValueStep & {
  type: "choice";
  options?: GuidedOption[];
  catalog?: string;
  /** Buttons per row. Defaults to 1. */
  columns?: number;
};

export type GuidedTextStep = ValueStep & {
  type: "text";
  /** In characters. Defaults to 1: an empty answer never fits. */
  minLength?: number;
  maxLength?: number;
};

/**
 * A number as people type it: the comma is the decimal separator and a dot
 * followed by groups of three digits separates thousands — «1.200,5» is
 * 1200.5, «2,5» and «2.5» are 2.5. A dot followed by three digits is read as
 * thousands, so «1.250» is 1250; where a dot means a decimal point — a weight
 * in tons — set `thousandsDot: false` and «1.250» is 1.25. A range catches
 * most misreadings.
 */
export type GuidedNumberStep = ValueStep & {
  type: "number";
  min?: number;
  max?: number;
  /** Greater than zero. */
  positive?: boolean;
  integer?: boolean;
  /** Defaults to true. */
  thousandsDot?: boolean;
};

/**
 * Asks for the device's location, with text alternatives for those who cannot
 * share it (Telegram Desktop cannot). With a `resolver`, the host says what is
 * at that point; with `confirm`, the recipient is asked whether it is right:
 * «Estás en {latitude} {longitude}: barrio {barrio}. ¿Es correcto?». The
 * placeholders are `latitude`, `longitude`, `accuracy` (meters) and whatever
 * the resolver returned.
 */
export type GuidedLocationStep = AskedStep & {
  type: "location";
  /** The button that shares the location. */
  button: string;
  /** Text buttons instead of sharing; the one tapped is the answer's `alternative`. */
  alternatives?: string[];
  /** A name in `ctx.resolvers`. */
  resolver?: string;
  /** Needs a resolver. */
  confirm?: { question: string; yes: string; no: string };
  /** Said when the resolver finds nothing at that point. */
  unresolved?: string;
  /** How a resolved place reads in a summary, with the same placeholders. Defaults to the coordinates. */
  summary?: string;
};

/** The steps a list item repeats. */
export type GuidedItemStep = GuidedChoiceStep | GuidedTextStep | GuidedNumberStep;

/**
 * A group of steps repeated once per item. `{n}` in an item step's question is
 * the item's number. After each item, from `minItems` on, it asks
 * `more.question` (`{count}` is the items so far) with `add` and `done`.
 */
export type GuidedListStep = AskedStep & {
  type: "list";
  steps: GuidedItemStep[];
  /** Defaults to 1. With 0, `more.question` is asked before the first item. */
  minItems?: number;
  maxItems?: number;
  more: { question: string; add: string; done: string };
};

/**
 * Photos, from `min` (default 1) to `max`, ended with the `done` button or by
 * reaching `max`. `{count}` and `{max}` are available in `question` and
 * `received`, which acknowledges each photo when set.
 */
export type GuidedPhotosStep = AskedStep & {
  type: "photos";
  min?: number;
  max: number;
  done: string;
  received?: string;
};

/** Shows the answers so far, with `question` as the header, and goes on without waiting. */
export type GuidedSummaryStep = StepCommon & { type: "summary" };

/**
 * Opens a page of the host's own for what must not go through the chat, and
 * ends the conversation in `handed_off`: the host closes it when the page
 * confirms. `link` names a URL in `ctx.links` — it usually carries a
 * credential, so it is not in the template and never in the state.
 */
export type GuidedHandoffStep = StepCommon & { type: "handoff"; button: string; link: string };

export type GuidedStep =
  | GuidedLocationStep
  | GuidedChoiceStep
  | GuidedTextStep
  | GuidedNumberStep
  | GuidedListStep
  | GuidedPhotosStep
  | GuidedSummaryStep
  | GuidedHandoffStep;

/** What the engine itself says. Only `invalid` and `cancelled` are always needed. */
export type GuidedTexts = {
  /** Said before the question again when an input does not fit and the step has no `invalid`. */
  invalid: string;
  /** The answer to the cancel command. */
  cancelled: string;
  /** The button offering a remembered value: `"Usar: {value}"`. Needed when a step has `remember`. */
  useRemembered?: string;
  /** The button that skips an optional step. Needed when a step is `optional`. */
  skip?: string;
  /** Header of the summary command's answer. */
  summary?: string;
  /** Said before the first question when the back command has nowhere to go. */
  nothingBack?: string;
  /** Said before the question when a button of an earlier question is tapped. */
  stale?: string;
};

export type GuidedTemplate = {
  key: string;
  /** BCP 47 locale for numbers and coordinates the bot writes. Defaults to `en`. */
  locale?: string;
  steps: GuidedStep[];
  /** Defaults: `/atras`, `/cancelar`, `/resumen`. Case and accents are ignored. */
  commands?: { back?: string; cancel?: string; summary?: string };
  texts: GuidedTexts;
};

// ── Context ─────────────────────────────────────────────────────────────

/** Named values a resolver found at a point: `{ barrio: "Meléndez", comuna: "18" }`. */
export type GuidedPlace = Record<string, string>;

/**
 * Says what is at a shared point, or `null` when nothing is. It runs in the
 * host and may query a database. If it throws, the step goes on as if nothing
 * was found, so a failing lookup does not strand the recipient; the error is
 * logged.
 */
export type GuidedResolver = (location: InboundLocation) => Promise<GuidedPlace | null>;

/** What the host passes on every call. */
export type GuidedContext = {
  /** Options of choice steps that name a `catalog`. */
  catalogs?: Record<string, GuidedOption[]>;
  /** Values the host kept for this chat, by step id (`guidedRemembered`). */
  remembered?: Record<string, string>;
  /** Location resolvers, by the name a location step gives. */
  resolvers?: Record<string, GuidedResolver>;
  /** URLs for handoff steps, by the name the step gives. */
  links?: Record<string, string>;
};

// ── State ───────────────────────────────────────────────────────────────

/**
 * Where a location answer came from:
 *
 * - `confirmed`: shared, resolved, and the recipient said it is the place.
 * - `rejected`: shared and resolved, and the recipient said it is not. The
 *   point is dropped: it is where the recipient stands, not the place asked.
 * - `unresolved`: shared, and the resolver found nothing there.
 * - `shared`: shared, with no confirmation asked.
 * - `declined`: the recipient tapped an alternative instead.
 */
export type GuidedLocationAnswer = {
  status: "confirmed" | "rejected" | "unresolved" | "shared" | "declined";
  latitude?: number;
  longitude?: number;
  accuracyMeters?: number;
  place?: GuidedPlace;
  alternative?: string;
};

/** One list item, by item step id. */
export type GuidedItem = Record<string, string | number | null>;

/**
 * A choice or a text is a string, a number a number, photos their file ids, a
 * list its items, a location a `GuidedLocationAnswer`, and a skipped optional
 * step `null`. A step skipped by `skipIf` has no key at all.
 */
export type GuidedAnswer = string | number | null | string[] | GuidedItem[] | GuidedLocationAnswer;

export type GuidedAnswers = Record<string, GuidedAnswer>;

/** The question the conversation waits on: a step, an item step in a list, or a phase of either. */
export type GuidedCursor = { step: string; sub?: string; phase?: "confirm" | "more" };

/** A shared location waiting for the recipient to confirm it. */
export type GuidedPending = { location: InboundLocation; place: GuidedPlace };

/** The state when a question was asked, so the back command can return to it. */
export type GuidedSnapshot = { at: GuidedCursor; answers: GuidedAnswers; item?: GuidedItem; pending?: GuidedPending };

/**
 * Plain JSON: it survives `JSON.parse(JSON.stringify(state))` unchanged.
 *
 * - `active`: waiting on `at`.
 * - `handed_off`: the handoff page was sent; the host closes the conversation
 *   when the page confirms. Back and cancel still work.
 * - `completed`: the template ended without a handoff.
 * - `cancelled`: the recipient sent the cancel command.
 */
export type GuidedState = {
  template: string;
  status: "active" | "handed_off" | "completed" | "cancelled";
  at: GuidedCursor | null;
  answers: GuidedAnswers;
  /** The list item being filled, before it joins `answers`. */
  item?: GuidedItem;
  pending?: GuidedPending;
  /** One snapshot per question asked, the current one last. */
  history: GuidedSnapshot[];
};

// ── Outputs ─────────────────────────────────────────────────────────────

/** `data` is what comes back in `InboundMessage.choice` when the button is tapped. */
export type GuidedButton = { text: string; data: string };

/**
 * What the host sends, in order. The engine does not know the channel; on
 * Telegram, `renderTelegram` maps each kind to one Bot API call.
 *
 * - `text`: a message. `removeKeyboard` takes away a location keyboard.
 * - `choices`: a message with buttons under it.
 * - `location`: a request for the device's location, with text alternatives.
 * - `webapp`: a message with a button that opens a page.
 * - `ack`: the tap that triggered this call must be answered.
 */
export type GuidedOutput =
  | { kind: "text"; text: string; removeKeyboard?: boolean }
  | { kind: "choices"; text: string; rows: GuidedButton[][] }
  | { kind: "location"; text: string; button: string; alternatives: string[] }
  | { kind: "webapp"; text: string; button: { text: string; url: string } }
  | { kind: "ack"; callbackId: string };

export type GuidedIssue = FormIssue;

// ── Helpers ─────────────────────────────────────────────────────────────

const COMMANDS = { back: "/atras", cancel: "/cancelar", summary: "/resumen" } as const;
const ID = /^[A-Za-z0-9_-]{1,24}$/;
/**
 * Telegram's limit for a button's data, in bytes — the only channel with
 * buttons. A step id up to 24 characters leaves room for every action the
 * engine encodes; option values are checked by `validateGuided`.
 */
const DATA_LIMIT = 64;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Case, accents and spacing do not count when matching what was typed. */
const fold = (s: string) =>
  s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

const utf8Length = (s: string) => new TextEncoder().encode(s).length;

/** `{name}` placeholders; an unknown one is left as written. */
function fill(text: string, vars: Record<string, string | number>): string {
  return text.replace(/\{(\w+)\}/g, (whole, name: string) => (Object.hasOwn(vars, name) ? String(vars[name]) : whole));
}

const formatNumber = (t: GuidedTemplate, n: number) =>
  new Intl.NumberFormat(t.locale ?? "en", { maximumFractionDigits: 6 }).format(n);

/** Four decimals: about 11 m, finer than a phone's fix. */
const formatCoordinate = (t: GuidedTemplate, n: number) =>
  new Intl.NumberFormat(t.locale ?? "en", { minimumFractionDigits: 4, maximumFractionDigits: 4, useGrouping: false }).format(n);

/**
 * A number as typed, or null. See `GuidedNumberStep` for the rules. Spaces
 * are ignored; «1,200,000» and «1.2.3» are not numbers.
 */
export function parseGuidedNumber(text: string, thousandsDot = true): number | null {
  let t = text.replace(/[\s  ]/g, "");
  let sign = 1;
  if (/^[-−]/.test(t)) {
    sign = -1;
    t = t.slice(1);
  }
  if (thousandsDot && /^[1-9]\d{0,2}(\.\d{3})+(,\d+)?$/.test(t)) t = t.replace(/\./g, "");
  if (!/^\d+([.,]\d+)?$/.test(t)) return null;
  const n = sign * Number(t.replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

const keyOf = (at: GuidedCursor) => (at.sub ? `${at.step}.${at.sub}` : at.step);
const optionData = (key: string, value: string) => `${key}:${value}`;
const actionData = (key: string, action: string) => `${key}!${action}`;

/** `<key>:<option value>` or `<key>!<action>`. Keys cannot hold `:` or `!`, so the first one splits. */
function readData(data: string | null | undefined): { key: string; value?: string; action?: string } | null {
  const m = /^([A-Za-z0-9_.-]+)([:!])([\s\S]*)$/.exec(data ?? "");
  if (!m) return null;
  return m[2] === ":" ? { key: m[1]!, value: m[3]! } : { key: m[1]!, action: m[3]! };
}

function topStep(t: GuidedTemplate, id: string): { step: GuidedStep; index: number } {
  const index = t.steps.findIndex((s) => s.id === id);
  if (index < 0) throw new Error(`Step "${id}" is not in template "${t.key}".`);
  return { step: t.steps[index]!, index };
}

function itemStep(list: GuidedListStep, id: string): { step: GuidedItemStep; index: number } {
  const index = list.steps.findIndex((s) => s.id === id);
  if (index < 0) throw new Error(`Step "${id}" is not in list "${list.id}".`);
  return { step: list.steps[index]!, index };
}

function optionsOf(step: GuidedChoiceStep, ctx: GuidedContext): GuidedOption[] {
  if (step.options) return step.options;
  const options = step.catalog !== undefined ? ctx.catalogs?.[step.catalog] : undefined;
  if (!options) throw new Error(`Step "${step.id}" reads catalog "${step.catalog}", which ctx.catalogs does not provide.`);
  return options;
}

/** For display only: an option that left the catalog still reads as its value. */
function optionLabel(step: GuidedChoiceStep, value: string, ctx: GuidedContext): string {
  return optionOf(step, value, ctx)?.label ?? value;
}

function optionOf(step: GuidedChoiceStep, value: string, ctx: GuidedContext): GuidedOption | undefined {
  const options = step.options ?? (step.catalog !== undefined ? ctx.catalogs?.[step.catalog] : undefined) ?? [];
  return options.find((o) => o.value === value);
}

const itemsOf = (s: GuidedState, step: GuidedListStep) => (s.answers[step.id] as GuidedItem[] | undefined) ?? [];
const photosOf = (s: GuidedState, step: GuidedPhotosStep) => (s.answers[step.id] as string[] | undefined) ?? [];

function chunk<T>(list: T[], size: number): T[][] {
  const width = Math.max(1, Math.floor(size));
  const rows: T[][] = [];
  for (let i = 0; i < list.length; i += width) rows.push(list.slice(i, i + width));
  return rows;
}

function lookup(answers: GuidedAnswers, path: string): unknown {
  let value: unknown = answers;
  for (const part of path.split(".")) {
    if (value === null || typeof value !== "object" || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function holds(c: GuidedCondition, answers: GuidedAnswers): boolean {
  if ("all" in c) return c.all.every((x) => holds(x, answers));
  if ("any" in c) return c.any.some((x) => holds(x, answers));
  if ("not" in c) return !holds(c.not, answers);
  const value = lookup(answers, c.answer);
  return (Array.isArray(c.equals) ? c.equals : [c.equals]).some((wanted) => wanted === value);
}

function placeVars(t: GuidedTemplate, at: { latitude?: number; longitude?: number; accuracyMeters?: number }, place?: GuidedPlace) {
  const vars: Record<string, string> = { ...place };
  if (typeof at.latitude === "number") vars.latitude = formatCoordinate(t, at.latitude);
  if (typeof at.longitude === "number") vars.longitude = formatCoordinate(t, at.longitude);
  if (typeof at.accuracyMeters === "number") vars.accuracy = formatNumber(t, Math.round(at.accuracyMeters));
  return vars;
}

// ── Reading an answer ───────────────────────────────────────────────────

type Read = { ok: true; value: string | number | null } | { ok: false; stale: boolean };
const accept = (value: string | number | null): Read => ({ ok: true, value });
const REFUSED: Read = { ok: false, stale: false };
const STALE: Read = { ok: false, stale: true };

function numberFits(step: GuidedNumberStep, n: number): boolean {
  return (
    Number.isFinite(n) &&
    (!step.integer || Number.isInteger(n)) &&
    (!step.positive || n > 0) &&
    (step.min === undefined || n >= step.min) &&
    (step.max === undefined || n <= step.max)
  );
}

/** Whether a value fits the step. A number is parsed as typed; a remembered one arrives already a number. */
function check(step: GuidedItemStep, raw: string | number, ctx: GuidedContext): Read {
  switch (step.type) {
    case "choice": {
      const value = String(raw);
      return optionsOf(step, ctx).some((o) => o.value === value) ? accept(value) : REFUSED;
    }
    case "text": {
      const value = String(raw).trim();
      const length = [...value].length;
      if (length < Math.max(1, step.minLength ?? 1) || (step.maxLength !== undefined && length > step.maxLength)) return REFUSED;
      return accept(value);
    }
    case "number": {
      const n = typeof raw === "number" ? raw : parseGuidedNumber(raw, step.thousandsDot ?? true);
      return n !== null && numberFits(step, n) ? accept(n) : REFUSED;
    }
  }
}

const rememberedRaw = (step: GuidedItemStep, remembered: string) => (step.type === "number" ? Number(remembered) : remembered);

/** A choice, text or number step: a tap, a typed option label, a typed value, the remembered value or a skip. */
function readValue(
  t: GuidedTemplate,
  step: GuidedItemStep,
  key: string,
  input: InboundMessage,
  ctx: GuidedContext,
  remembered?: string,
): Read {
  if (input.type === "choice") {
    const data = readData(input.choice);
    if (!data || data.key !== key) return STALE;
    if (data.action === "skip" && step.optional) return accept(null);
    if (data.action === "remembered" && remembered !== undefined) return check(step, rememberedRaw(step, remembered), ctx);
    if (data.value !== undefined && step.type === "choice") return check(step, data.value, ctx);
    return REFUSED;
  }
  if (input.type !== "text" || typeof input.text !== "string") return REFUSED;
  const said = fold(input.text);
  if (step.optional && t.texts.skip && said === fold(t.texts.skip)) return accept(null);
  if (step.type === "choice") {
    const option = optionsOf(step, ctx).find((o) => fold(o.label) === said);
    return option ? accept(option.value) : REFUSED;
  }
  return check(step, input.text, ctx);
}

/** One of the engine's own buttons, tapped or typed. `"stale"` is a tap on another question's button. */
function actionOf(input: InboundMessage, key: string, labels: Record<string, string>): string | null {
  if (input.type === "choice") {
    const data = readData(input.choice);
    if (!data || data.key !== key) return "stale";
    return data.action !== undefined && Object.hasOwn(labels, data.action) ? data.action : null;
  }
  if (input.type === "text" && typeof input.text === "string") {
    const said = fold(input.text);
    for (const [action, label] of Object.entries(labels)) if (fold(label) === said) return action;
  }
  return null;
}

function validLocation(l: InboundLocation | null | undefined): InboundLocation | null {
  if (!l || !Number.isFinite(l.latitude) || !Number.isFinite(l.longitude)) return null;
  if (Math.abs(l.latitude) > 90 || Math.abs(l.longitude) > 180) return null;
  const accuracy = typeof l.accuracyMeters === "number" && Number.isFinite(l.accuracyMeters) ? { accuracyMeters: l.accuracyMeters } : {};
  return { latitude: l.latitude, longitude: l.longitude, ...accuracy };
}

async function resolve(ctx: GuidedContext, name: string, location: InboundLocation): Promise<GuidedPlace | null> {
  const resolver = ctx.resolvers?.[name];
  if (!resolver) throw new Error(`Resolver "${name}" is not provided in ctx.resolvers.`);
  let found: unknown;
  try {
    found = await resolver(location);
  } catch (e: unknown) {
    console.warn("[data-collection-link] location resolver failed:", e instanceof Error ? e.message : String(e));
    return null;
  }
  if (!found || typeof found !== "object") return null;
  // Only strings reach the state, so it stays JSON whatever the resolver returns.
  const place: GuidedPlace = {};
  for (const [k, v] of Object.entries(found)) {
    if (typeof v === "string" || (typeof v === "number" && Number.isFinite(v))) place[k] = String(v);
  }
  return place;
}

// ── Asking ──────────────────────────────────────────────────────────────

function display(t: GuidedTemplate, step: GuidedItemStep, value: string | number, ctx: GuidedContext): string {
  if (step.type === "choice") return optionLabel(step, String(value), ctx);
  if (step.type === "number" && typeof value === "number") return formatNumber(t, value);
  return String(value);
}

function askValue(t: GuidedTemplate, step: GuidedItemStep, key: string, ctx: GuidedContext, text: string, remembered?: string): GuidedOutput[] {
  const rows: GuidedButton[][] = [];
  if (remembered !== undefined) {
    const read = check(step, rememberedRaw(step, remembered), ctx);
    // A remembered value that no longer fits — an option removed from the
    // catalog, a range narrowed — is not offered.
    if (read.ok && read.value !== null) {
      const shown = display(t, step, read.value, ctx);
      rows.push([{ text: fill(t.texts.useRemembered ?? "{value}", { value: shown }), data: actionData(key, "remembered") }]);
    }
  }
  if (step.type === "choice") {
    rows.push(...chunk(optionsOf(step, ctx).map((o) => ({ text: o.label, data: optionData(key, o.value) })), step.columns ?? 1));
  }
  if (step.optional && t.texts.skip) rows.push([{ text: t.texts.skip, data: actionData(key, "skip") }]);
  return rows.length ? [{ kind: "choices", text, rows }] : [{ kind: "text", text, removeKeyboard: true }];
}

function handoff(step: GuidedHandoffStep, ctx: GuidedContext, text: string): GuidedOutput {
  const url = ctx.links?.[step.link];
  if (!url) throw new Error(`Step "${step.id}" opens link "${step.link}", which ctx.links does not provide.`);
  return { kind: "webapp", text, button: { text: step.button, url } };
}

/** The question the state waits on, with `prefix` before it. */
function ask(t: GuidedTemplate, s: GuidedState, ctx: GuidedContext, prefix?: string): GuidedOutput[] {
  const at = s.at;
  if (!at) return [];
  const say = (text: string) => (prefix ? `${prefix}\n\n${text}` : text);
  const { step } = topStep(t, at.step);
  const key = keyOf(at);
  switch (step.type) {
    case "location":
      if (at.phase === "confirm" && s.pending && step.confirm) {
        return [
          {
            kind: "choices",
            text: say(fill(step.confirm.question, placeVars(t, s.pending.location, s.pending.place))),
            rows: [[{ text: step.confirm.yes, data: actionData(key, "yes") }, { text: step.confirm.no, data: actionData(key, "no") }]],
          },
        ];
      }
      return [{ kind: "location", text: say(step.question), button: step.button, alternatives: step.alternatives ?? [] }];
    case "list": {
      const count = itemsOf(s, step).length;
      if (at.phase === "more") {
        return [
          {
            kind: "choices",
            text: say(fill(step.more.question, { count })),
            rows: [[{ text: step.more.add, data: actionData(key, "add") }, { text: step.more.done, data: actionData(key, "done") }]],
          },
        ];
      }
      const { step: sub } = itemStep(step, at.sub ?? "");
      return askValue(t, sub, key, ctx, say(fill(sub.question, { n: count + 1 })));
    }
    case "photos":
      return [
        {
          kind: "choices",
          text: say(fill(step.question, { count: photosOf(s, step).length, max: step.max })),
          rows: [[{ text: step.done, data: actionData(key, "done") }]],
        },
      ];
    case "handoff":
      return [handoff(step, ctx, say(step.question))];
    case "summary":
      return [];
    default:
      return askValue(t, step, key, ctx, say(step.question), step.remember ? ctx.remembered?.[step.id] : undefined);
  }
}

function describeLocation(t: GuidedTemplate, step: GuidedLocationStep, a: GuidedLocationAnswer): string | null {
  if (a.status === "declined") return a.alternative ?? null;
  if (a.place && step.summary) return fill(step.summary, placeVars(t, a, a.place));
  if (typeof a.latitude === "number" && typeof a.longitude === "number") {
    return `${formatCoordinate(t, a.latitude)} ${formatCoordinate(t, a.longitude)}`;
  }
  return null;
}

/** The answers so far, one line each; skipped steps are left out. */
function summarize(t: GuidedTemplate, s: GuidedState, ctx: GuidedContext, header?: string): string {
  const lines: string[] = [];
  for (const step of t.steps) {
    if (step.type === "summary" || step.type === "handoff" || !Object.hasOwn(s.answers, step.id)) continue;
    const value = s.answers[step.id];
    if (value === null || value === undefined) continue;
    const label = step.label ?? step.id;
    switch (step.type) {
      case "location": {
        const shown = describeLocation(t, step, value as GuidedLocationAnswer);
        if (shown) lines.push(`${label}: ${shown}`);
        break;
      }
      case "list": {
        const items = value as GuidedItem[];
        if (!items.length) break;
        lines.push(`${label}:`);
        items.forEach((item, i) => {
          const parts = step.steps
            .filter((sub) => item[sub.id] !== null && item[sub.id] !== undefined)
            .map((sub) => display(t, sub, item[sub.id]!, ctx));
          lines.push(`${i + 1}. ${parts.join(", ")}`);
        });
        break;
      }
      case "photos":
        lines.push(`${label}: ${(value as string[]).length}`);
        break;
      default: {
        const shown = display(t, step, value as string | number, ctx);
        const option = step.type === "choice" ? optionOf(step, String(value), ctx) : undefined;
        const text =
          option?.summary !== undefined
            ? option.summary
            : step.summaryAs !== undefined
              ? fill(step.summaryAs, { value: shown })
              : shown;
        if (text !== "") lines.push(`${label}: ${text}`);
      }
    }
  }
  return [header, lines.join("\n")].filter(Boolean).join("\n\n") || "—";
}

// ── Moving ──────────────────────────────────────────────────────────────

function snapshot(s: GuidedState): GuidedSnapshot {
  return clone({
    at: s.at!,
    answers: s.answers,
    ...(s.item ? { item: s.item } : {}),
    ...(s.pending ? { pending: s.pending } : {}),
  });
}

/** Asks the question `s.at` now points to, and remembers it for the back command. */
function askNew(t: GuidedTemplate, s: GuidedState, ctx: GuidedContext, out: GuidedOutput[], prefix?: string): void {
  s.history.push(snapshot(s));
  out.push(...ask(t, s, ctx, prefix));
}

/** From the step at `from`, to the next one that asks something, through skips and summaries. */
function forward(t: GuidedTemplate, s: GuidedState, ctx: GuidedContext, out: GuidedOutput[], from: number): void {
  delete s.item;
  delete s.pending;
  for (let i = from + 1; i < t.steps.length; i++) {
    const step = t.steps[i]!;
    if (step.skipIf && holds(step.skipIf, s.answers)) continue;
    if (step.type === "summary") {
      out.push({ kind: "text", text: summarize(t, s, ctx, step.question), removeKeyboard: true });
      continue;
    }
    if (step.type === "list") {
      if ((step.minItems ?? 1) > 0) {
        s.item = {};
        s.at = { step: step.id, sub: step.steps[0]!.id };
      } else {
        s.at = { step: step.id, phase: "more" };
      }
      // The list's own question introduces its first one.
      return askNew(t, s, ctx, out, step.question);
    }
    s.at = { step: step.id };
    if (step.type === "handoff") s.status = "handed_off";
    return askNew(t, s, ctx, out);
  }
  s.at = null;
  s.status = "completed";
}

/** Back to the previous question actually asked: the one before the current in `history`. */
function back(t: GuidedTemplate, s: GuidedState, ctx: GuidedContext, out: GuidedOutput[]): void {
  if (s.history.length < 2) {
    out.push(...ask(t, s, ctx, t.texts.nothingBack));
    return;
  }
  s.history.pop();
  const target = clone(s.history[s.history.length - 1]!);
  s.at = target.at;
  s.answers = target.answers;
  if (target.item) s.item = target.item;
  else delete s.item;
  if (target.pending) s.pending = target.pending;
  else delete s.pending;
  s.status = "active";
  out.push(...ask(t, s, ctx));
}

async function answer(t: GuidedTemplate, s: GuidedState, ctx: GuidedContext, input: InboundMessage, out: GuidedOutput[]): Promise<void> {
  const at = s.at!;
  const { step, index } = topStep(t, at.step);
  const key = keyOf(at);
  const refuse = (stale: boolean, invalid?: string) => {
    out.push(...ask(t, s, ctx, stale ? t.texts.stale : (invalid ?? t.texts.invalid)));
  };

  switch (step.type) {
    case "location": {
      const shared = input.type === "location" ? validLocation(input.location) : null;
      if (shared) {
        // A new location replaces one waiting for confirmation.
        if (!step.resolver) {
          s.answers[step.id] = { status: "shared", ...shared };
          return forward(t, s, ctx, out, index);
        }
        const place = await resolve(ctx, step.resolver, shared);
        if (!place) {
          s.answers[step.id] = { status: "unresolved", ...shared };
          if (step.unresolved) out.push({ kind: "text", text: step.unresolved, removeKeyboard: true });
          return forward(t, s, ctx, out, index);
        }
        if (!step.confirm) {
          s.answers[step.id] = { status: "shared", ...shared, place };
          return forward(t, s, ctx, out, index);
        }
        s.pending = { location: shared, place };
        s.at = { step: step.id, phase: "confirm" };
        return askNew(t, s, ctx, out);
      }
      if (at.phase === "confirm" && s.pending && step.confirm) {
        const action = actionOf(input, key, { yes: step.confirm.yes, no: step.confirm.no });
        if (action === "yes") {
          s.answers[step.id] = { status: "confirmed", ...s.pending.location, place: s.pending.place };
          return forward(t, s, ctx, out, index);
        }
        if (action === "no") {
          // The point is where the recipient stands, not the place asked: it
          // goes, from the history too. Back from here asks for the location.
          s.answers[step.id] = { status: "rejected" };
          s.history = s.history.filter((h) => !(h.at.step === step.id && h.pending));
          return forward(t, s, ctx, out, index);
        }
        if (action === "stale") return refuse(true);
      }
      if (input.type === "text" && typeof input.text === "string") {
        const said = fold(input.text);
        const alternative = (step.alternatives ?? []).find((a) => fold(a) === said);
        if (alternative) {
          s.answers[step.id] = { status: "declined", alternative };
          return forward(t, s, ctx, out, index);
        }
      }
      // While the location is asked there are no buttons of this step to tap.
      return refuse(input.type === "choice", step.invalid);
    }

    case "list": {
      if (at.phase === "more") {
        const action = actionOf(input, key, { add: step.more.add, done: step.more.done });
        if (action === "add") {
          s.item = {};
          s.at = { step: step.id, sub: step.steps[0]!.id };
          return askNew(t, s, ctx, out);
        }
        if (action === "done") {
          s.answers[step.id] = itemsOf(s, step);
          return forward(t, s, ctx, out, index);
        }
        return refuse(action === "stale", step.invalid);
      }
      const { step: sub, index: subIndex } = itemStep(step, at.sub ?? "");
      const read = readValue(t, sub, key, input, ctx);
      if (!read.ok) return refuse(read.stale, sub.invalid ?? step.invalid);
      s.item = { ...s.item, [sub.id]: read.value };
      const next = step.steps[subIndex + 1];
      if (next) {
        s.at = { step: step.id, sub: next.id };
        return askNew(t, s, ctx, out);
      }
      const items = [...itemsOf(s, step), s.item];
      s.answers[step.id] = items;
      delete s.item;
      if (step.maxItems !== undefined && items.length >= step.maxItems) return forward(t, s, ctx, out, index);
      if (items.length < (step.minItems ?? 1)) {
        s.item = {};
        s.at = { step: step.id, sub: step.steps[0]!.id };
      } else {
        s.at = { step: step.id, phase: "more" };
      }
      return askNew(t, s, ctx, out);
    }

    case "photos": {
      const photos = photosOf(s, step);
      if (input.type === "image" && input.mediaId) {
        // The file id only: a caption may say anything, and is not asked for.
        const now = [...photos, input.mediaId];
        s.answers[step.id] = now;
        if (now.length >= step.max) return forward(t, s, ctx, out, index);
        if (step.received) {
          out.push({
            kind: "choices",
            text: fill(step.received, { count: now.length, max: step.max }),
            rows: [[{ text: step.done, data: actionData(key, "done") }]],
          });
        }
        return;
      }
      const action = actionOf(input, key, { done: step.done });
      if (action === "done" && photos.length >= (step.min ?? 1)) {
        s.answers[step.id] = photos;
        return forward(t, s, ctx, out, index);
      }
      return refuse(action === "stale", step.invalid);
    }

    case "summary":
    case "handoff":
      out.push(...ask(t, s, ctx));
      return;

    default: {
      const read = readValue(t, step, key, input, ctx, step.remember ? ctx.remembered?.[step.id] : undefined);
      if (!read.ok) return refuse(read.stale, step.invalid);
      s.answers[step.id] = read.value;
      return forward(t, s, ctx, out, index);
    }
  }
}

function commandOf(t: GuidedTemplate, input: InboundMessage): "back" | "cancel" | "summary" | null {
  if (input.type !== "text" || typeof input.text !== "string") return null;
  // `/atras@pmu_bot` is how Telegram writes a command picked from the menu.
  const said = fold(input.text).replace(/@\w+$/, "");
  for (const name of ["back", "cancel", "summary"] as const) {
    if (said === fold(t.commands?.[name] ?? COMMANDS[name])) return name;
  }
  return null;
}

// ── API ─────────────────────────────────────────────────────────────────

/** The initial state and the first question. */
export async function startGuided(
  template: GuidedTemplate,
  ctx: GuidedContext = {},
): Promise<{ state: GuidedState; outputs: GuidedOutput[] }> {
  const state: GuidedState = { template: template.key, status: "active", at: null, answers: {}, history: [] };
  const outputs: GuidedOutput[] = [];
  forward(template, state, ctx, outputs, -1);
  return { state, outputs };
}

/**
 * One inbound message through the conversation: the next state and what to
 * send. `state` is not modified.
 *
 * - An input that does not fit the question — a photo when a text is asked,
 *   a text when a location is — repeats the question after the step's
 *   `invalid` text.
 * - The back command returns to the previous question actually asked; steps
 *   skipped by `skipIf` do not count. Answers given since are dropped.
 * - The cancel command ends in `cancelled`; the summary command shows the
 *   answers and repeats the question.
 * - `/start` — the link opened again — repeats the question: the
 *   conversation resumes where it was.
 * - A tap is always acknowledged first (`ack`), whatever it says.
 *
 * Messages for one chat must be handled one at a time, each on the state the
 * previous one saved: two photos of an album handled at once would each add
 * to the same state, and one would be lost. Deduplicate retries before
 * calling (`Repository.recordMessage`): a retried photo would count twice.
 */
export async function advance(
  state: GuidedState,
  template: GuidedTemplate,
  input: InboundMessage,
  ctx: GuidedContext = {},
): Promise<{ state: GuidedState; outputs: GuidedOutput[] }> {
  if (state.template !== template.key) {
    throw new Error(`This conversation follows template "${state.template}", not "${template.key}".`);
  }
  const s = clone(state);
  const out: GuidedOutput[] = [];
  if (input.type === "choice" && input.callbackId) out.push({ kind: "ack", callbackId: input.callbackId });
  if (s.status === "cancelled" || s.status === "completed" || !s.at) return { state: s, outputs: out };

  switch (commandOf(template, input)) {
    case "cancel":
      s.status = "cancelled";
      s.at = null;
      s.history = [];
      delete s.item;
      delete s.pending;
      out.push({ kind: "text", text: template.texts.cancelled, removeKeyboard: true });
      return { state: s, outputs: out };
    case "summary":
      out.push({ kind: "text", text: summarize(template, s, ctx, template.texts.summary), removeKeyboard: true });
      out.push(...ask(template, s, ctx));
      return { state: s, outputs: out };
    case "back":
      back(template, s, ctx, out);
      return { state: s, outputs: out };
  }

  // After the handoff only the commands act: anything else shows the button again.
  if (s.status === "handed_off" || input.start !== undefined) {
    out.push(...ask(template, s, ctx));
    return { state: s, outputs: out };
  }

  await answer(template, s, ctx, input, out);
  return { state: s, outputs: out };
}

/** The answers, by step id, for the host to build its submission. See `GuidedAnswer`. */
export function guidedAnswers(state: GuidedState): GuidedAnswers {
  return clone(state.answers);
}

/** The answers of steps marked `remember`, for the host to keep for this chat and pass back in `ctx.remembered`. */
export function guidedRemembered(template: GuidedTemplate, state: GuidedState): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const step of template.steps) {
    if (!("remember" in step) || !step.remember) continue;
    const value = state.answers[step.id];
    if (typeof value === "string" || typeof value === "number") kept[step.id] = String(value);
  }
  return kept;
}

// ── Validation ──────────────────────────────────────────────────────────

const VALUE_TYPES = new Set(["choice", "text", "number"]);
const isCount = (n: unknown, min = 0) => typeof n === "number" && Number.isInteger(n) && n >= min;

function checkCondition(c: GuidedCondition, earlier: Set<string>, where: string, add: (rule: string, detail: string) => void) {
  if ("all" in c) return c.all.forEach((x) => checkCondition(x, earlier, where, add));
  if ("any" in c) return c.any.forEach((x) => checkCondition(x, earlier, where, add));
  if ("not" in c) return checkCondition(c.not, earlier, where, add);
  const head = c.answer.split(".")[0] ?? "";
  if (!earlier.has(head)) add("skipIf", `${where}: skipIf reads "${c.answer}", which is not an earlier step.`);
}

function checkStep(
  t: GuidedTemplate,
  step: GuidedStep,
  key: string,
  where: string,
  add: (rule: string, detail: string) => void,
  ctx: GuidedContext | undefined,
  inList: boolean,
) {
  const loose = step as { optional?: boolean; remember?: boolean };
  if (loose.optional) {
    if (!VALUE_TYPES.has(step.type)) add("optional", `${where}: only choice, text and number steps can be optional.`);
    else if (!t.texts?.skip?.trim()) add("texts", `${where} is optional: set \`texts.skip\`, the button that skips it.`);
  }
  if (loose.remember) {
    if (!VALUE_TYPES.has(step.type) || inList) add("remember", `${where}: only choice, text and number steps outside a list can be remembered.`);
    else if (!t.texts?.useRemembered?.trim()) add("texts", `${where} is remembered: set \`texts.useRemembered\`, the button that offers it.`);
  }

  switch (step.type) {
    case "choice": {
      if ((step.options === undefined) === (step.catalog === undefined)) add("choice", `${where}: give either \`options\` or a \`catalog\`.`);
      if (step.catalog !== undefined && ctx?.catalogs && !ctx.catalogs[step.catalog]) {
        add("catalog", `${where}: catalog "${step.catalog}" is not in ctx.catalogs.`);
      }
      const options = step.options ?? (step.catalog !== undefined ? ctx?.catalogs?.[step.catalog] : undefined);
      if (options) {
        if (!options.length) add("choice", `${where}: there are no options to choose from.`);
        const values = new Set<string>();
        for (const o of options) {
          if (values.has(o.value)) add("choice", `${where}: option "${o.value}" is repeated.`);
          values.add(o.value);
          if (!o.label?.trim()) add("choice", `${where}: option "${o.value}" has no label.`);
          const bytes = utf8Length(optionData(key, o.value));
          if (bytes > DATA_LIMIT) {
            add(
              "callback-data",
              `${where}: option "${o.label}" makes ${bytes} bytes of button data, over Telegram's ${DATA_LIMIT}. Shorten its value or the step id.`,
            );
          }
        }
      }
      if (step.columns !== undefined && (!isCount(step.columns, 1) || step.columns > 8)) add("choice", `${where}: \`columns\` is 1 to 8.`);
      break;
    }
    case "text":
      if (step.minLength !== undefined && !isCount(step.minLength)) add("text", `${where}: \`minLength\` is a whole number.`);
      if (step.maxLength !== undefined && !isCount(step.maxLength, 1)) add("text", `${where}: \`maxLength\` is a whole number over 0.`);
      if (step.minLength !== undefined && step.maxLength !== undefined && step.minLength > step.maxLength) {
        add("text", `${where}: \`minLength\` is over \`maxLength\`.`);
      }
      break;
    case "number":
      if (step.min !== undefined && step.max !== undefined && step.min > step.max) add("number", `${where}: \`min\` is over \`max\`.`);
      break;
    case "location": {
      if (inList) add("list", `${where}: a list repeats only choice, text and number steps.`);
      if (!step.button?.trim()) add("location", `${where}: needs the \`button\` that shares the location.`);
      if (step.confirm && !step.resolver) add("location", `${where}: \`confirm\` needs a \`resolver\` to say what is there.`);
      if (step.confirm && fold(step.confirm.yes) === fold(step.confirm.no)) add("location", `${where}: \`confirm.yes\` and \`confirm.no\` read the same.`);
      if (step.resolver !== undefined && ctx?.resolvers && !ctx.resolvers[step.resolver]) {
        add("resolver", `${where}: resolver "${step.resolver}" is not in ctx.resolvers.`);
      }
      const alternatives = (step.alternatives ?? []).map(fold);
      if (alternatives.some((a) => !a)) add("location", `${where}: an alternative is empty.`);
      if (new Set(alternatives).size !== alternatives.length) add("location", `${where}: an alternative is repeated.`);
      break;
    }
    case "list": {
      if (inList) add("list", `${where}: a list cannot hold another list.`);
      if (!step.steps?.length) add("list", `${where}: a list needs the steps of an item.`);
      const ids = new Set<string>();
      (step.steps ?? []).forEach((sub, j) => {
        const inner = `${where}, item step ${j + 1} ("${sub.id}")`;
        if (!VALUE_TYPES.has(sub.type)) add("list", `${inner}: a list repeats only choice, text and number steps.`);
        if (!ID.test(sub.id)) add("id", `${inner}: ids are 1 to 24 characters of A-Z a-z 0-9 _ -.`);
        if (ids.has(sub.id)) add("id", `${inner}: the id is repeated.`);
        ids.add(sub.id);
        if (!sub.question?.trim()) add("question", `${inner}: needs a question.`);
        if (sub.skipIf) add("skipIf", `${inner}: item steps cannot be skipped by a condition.`);
        checkStep(t, sub, `${key}.${sub.id}`, inner, add, ctx, true);
      });
      const min = step.minItems ?? 1;
      if (!isCount(min)) add("list", `${where}: \`minItems\` is a whole number.`);
      if (step.maxItems !== undefined && (!isCount(step.maxItems, 1) || step.maxItems < min)) {
        add("list", `${where}: \`maxItems\` is a whole number, at least 1 and at least \`minItems\`.`);
      }
      if (!step.more?.question?.trim() || !step.more?.add?.trim() || !step.more?.done?.trim()) {
        add("list", `${where}: \`more\` needs a question and the \`add\` and \`done\` buttons.`);
      } else if (fold(step.more.add) === fold(step.more.done)) {
        add("list", `${where}: \`more.add\` and \`more.done\` read the same.`);
      }
      break;
    }
    case "photos":
      if (inList) add("list", `${where}: a list repeats only choice, text and number steps.`);
      if (!isCount(step.max, 1)) add("photos", `${where}: \`max\` is a whole number over 0.`);
      if (step.min !== undefined && (!isCount(step.min) || step.min > step.max)) add("photos", `${where}: \`min\` is a whole number up to \`max\`.`);
      if (!step.done?.trim()) add("photos", `${where}: needs the \`done\` button.`);
      break;
    case "handoff":
      if (!step.button?.trim() || !step.link?.trim()) add("handoff", `${where}: needs a \`button\` and the name of a \`link\`.`);
      if (ctx?.links && !ctx.links[step.link]) add("handoff", `${where}: link "${step.link}" is not in ctx.links.`);
      break;
    case "summary":
      break;
  }
}

/**
 * Returns the list of problems. Empty means the template can be used. Call it
 * in a test, as `validateForm`.
 *
 * Catalogs, resolvers and links arrive at runtime, so they are checked only
 * when `ctx` provides them: pass the real catalogs to know that every option
 * fits in a button's 64 bytes of data.
 */
export function validateGuided(template: GuidedTemplate, ctx?: GuidedContext): GuidedIssue[] {
  const issues: GuidedIssue[] = [];
  const add = (rule: string, detail: string) => issues.push({ rule, detail });
  const t = template;

  if (!t.key?.trim()) add("key", "The template needs a `key`.");
  if (!t.texts?.invalid?.trim()) add("texts", "`texts.invalid` is required: it explains an answer that does not fit.");
  if (!t.texts?.cancelled?.trim()) add("texts", "`texts.cancelled` is required: it answers the cancel command.");
  if (t.locale !== undefined) {
    try {
      new Intl.NumberFormat(t.locale);
    } catch {
      add("locale", `"${t.locale}" is not a locale.`);
    }
  }
  const commands = (["back", "cancel", "summary"] as const).map((c) => fold(t.commands?.[c] ?? COMMANDS[c]));
  for (const c of commands) if (!/^\/\w+$/.test(c)) add("commands", `Command "${c}" must be a slash and one word.`);
  if (new Set(commands).size !== commands.length) add("commands", "The back, cancel and summary commands must differ.");

  if (!t.steps?.length) {
    add("steps", "The template has no steps.");
    return issues;
  }
  const earlier = new Set<string>();
  t.steps.forEach((step, i) => {
    const where = `Step ${i + 1} ("${step.id}")`;
    if (!ID.test(step.id)) add("id", `${where}: ids are 1 to 24 characters of A-Z a-z 0-9 _ -.`);
    if (earlier.has(step.id)) add("id", `${where}: the id is repeated.`);
    if (!step.question?.trim()) add("question", `${where}: needs a question.`);
    if (step.skipIf) checkCondition(step.skipIf, earlier, where, add);
    earlier.add(step.id);
    checkStep(t, step, step.id, where, add, ctx, false);
    if (step.type === "handoff" && i !== t.steps.length - 1) add("handoff", `${where}: a handoff ends the conversation, so it is the last step.`);
  });
  return issues;
}
