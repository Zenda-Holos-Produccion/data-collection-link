# data-collection-link

A **data collection link** turns a chat thread — on **WhatsApp** or **Telegram** — into a form for
someone who has no account in your application.

An **operator** — an authenticated user of the host application — opens a case through a dialog of N
fields. The **recipient** — an external person — is reached on a chat channel, and from then on that
thread *is* the form: the text and photos they send are persisted to whatever storage the host
application defines, until they reply with a closing word.

What the dialog asks, what the chat collects, the closing words and the invitation text all come from
one **template**: a `Form` definition, which is plain data.

Built for the [PMU of the Cali earthquake emergency](https://github.com/Zenda-Holos-Produccion/pmu-sismo-prod),
where recipients are contractors and field staff reporting from a site, without installing an
application or creating credentials. Formerly `whatsapp-conversational-form`.

---

## Model

The template keeps two datasets apart, by author and by timing:

| config | actor | when | shape |
|---|---|---|---|
| `fields` | operator | before the conversation | N typed fields |
| `chat` | recipient | during the conversation | text (`report`) and images (`photos`) |

There is no `photo` field type in `fields`: images are sent by the recipient over the channel, not by
the operator through the dialog.

## Channels

The conversation engine is the same for both; what differs is how a conversation starts and who the
recipient is.

| | WhatsApp (Cloud API) | Telegram (Bot API) |
|---|---|---|
| **Who writes first** | The business, with a template | The recipient: a bot cannot write first |
| **The invitation** | `invite` sends the approved template to a phone number | `invite` returns a `t.me/<bot>?start=<token>` link for the operator to hand over |
| **Recipient identity** | The phone number in the dialog | The chat that opens the link — single-use: the first account binds |
| **Invitation text** | Must match a template Meta approved, word for word; each change is reviewed again | Sent as written when the link is opened |
| **Free-form replies** | Only inside the 24-hour window the recipient opens | Always |
| **Setup** | Meta Business, a verified number, a system-user token, an approved template | A bot token from @BotFather and a webhook secret |
| **Price** | Per template message sent, by category and country | None |
| **Webhook auth** | HMAC of the raw body (`X-Hub-Signature-256`) | Shared secret header (`X-Telegram-Bot-Api-Secret-Token`) |

A form lists the channels it may be sent over (`channels`), and the host decides per invitation.

## Persistence

The scope of this package is the channels and the conversation state machine. It contains no data
access. The host application implements two interfaces:

- **`Repository`** — case creation, binding a Telegram chat, message recording, report and image
  persistence, closing.
- **`Storage`** — binary writes.

## Installation

```bash
npm install github:Zenda-Holos-Produccion/data-collection-link
```

Not published to npm; installed from git. The repository is **public**, so no credentials are
required — on a workstation, in CI, or inside a Docker image. That was deliberate: a private
dependency requires a token in every build and introduces a new deployment failure mode.

Requires Node 20+. React is an optional peer dependency, needed only for the `/react` entry point.

## Configuration

Three blocks with different lifecycles: the **channels** (credentials, change on token rotation), the
**template** (changes with the business process) and the **persistence adapters** (stable). Keep them
in separate modules. The library reads no environment variables; resolving configuration is the host
application's responsibility.

### Channel: `WhatsAppConfig`

```ts
import { whatsappChannel, type WhatsAppConfig } from "data-collection-link";

export function whatsappConfig(): WhatsAppConfig {
  return {
    token: process.env.WHATSAPP_TOKEN ?? "",
    phoneNumberId: process.env.WHATSAPP_PHONE_ID ?? "",
    appSecret: process.env.WHATSAPP_APP_SECRET,
    verifyToken: process.env.WHATSAPP_VERIFY_TOKEN,
    version: process.env.WHATSAPP_API_VERSION,  // optional, defaults to v21.0
    countryCode: "57",
  };
}
export const whatsapp = () => whatsappChannel(whatsappConfig());
```

| field | description | source |
|---|---|---|
| `token` | Permanent system-user token | Business Settings → System users → Generate token, with `whatsapp_business_messaging`, `whatsapp_business_management`, `business_management` |
| `phoneNumberId` | Phone number **id**, not the number | App dashboard → WhatsApp → API Setup |
| `appSecret` | Verifies webhook signatures | App dashboard → Settings → Basic → App Secret |
| `verifyToken` | Chosen when registering the webhook | Must match on both sides |
| `version` | Graph API version | Meta retires versions every couple of years |
| `countryCode` | Calling code without `+` | Stripped from inbound numbers, prepended on send |

### Channel: `TelegramConfig`

```ts
import { telegramChannel, setWebhook, type TelegramConfig } from "data-collection-link";

export function telegramConfig(): TelegramConfig {
  return {
    token: process.env.TELEGRAM_BOT_TOKEN ?? "",
    username: process.env.TELEGRAM_BOT_USERNAME ?? "",   // without @
    secretToken: process.env.TELEGRAM_WEBHOOK_SECRET,    // 1–256 chars, A-Z a-z 0-9 _ -
  };
}
export const telegram = () => telegramChannel(telegramConfig());

// Once, after deploying the webhook route — and again after upgrading to 0.6,
// which also asks for button taps (`callback_query`):
await setWebhook(telegramConfig(), "https://your.app/api/telegram/webhook");
```

| field | description | source |
|---|---|---|
| `token` | Bot token. Never logged: errors are scrubbed of it | @BotFather → `/newbot` |
| `username` | The bot's username, builds the `t.me` link | @BotFather |
| `secretToken` | Echoed by Telegram on every webhook call | Chosen by you, passed to `setWebhook` |

On either channel, missing credentials do not throw: calls return `ok:false` with the reason, so the
caller can record the case as undelivered. A missing `appSecret` or `secretToken` makes webhook
verification return `false` — fail-closed.

### Template: the `Form` definition

A single definition per form. Dialog fields, what the conversation collects, closing words and the
invitation all come from here.

```ts
import type { Form } from "data-collection-link";

export const siteFollowUp: Form = {
  key: "site-followup",
  button: "New follow-up",
  title: "New follow-up",
  description: "The recipient reports in a chat thread.",
  channels: ["whatsapp", "telegram"],

  fields: [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "phone", label: "Mobile number", type: "phone",
      help: "With or without country code. Needed on WhatsApp only." },
    { key: "note", label: "Description", type: "textarea",
      placeholder: "Which site this is about" },
  ],

  chat: {
    report: { enabled: true, requiredToClose: true },
    photos: { enabled: true, minToClose: 1 },
    closingWords: ["listo", "done"],   // optional
  },

  invitation: {
    body:
      "Hello {{1}}. We are contacting you about {{2}}.\n\n" +
      "You can send photos and describe the work in this thread.\n\n" +
      "When there is nothing left to report, reply DONE.",
    variables: [{ field: "name" }, { field: "note", fallback: "a site" }],
  },

  // Only when `channels` includes "whatsapp": the template Meta approved with that body.
  whatsapp: { name: "site_followup", language: "es", category: "utility" },
};
```

Rules enforced by `validateForm` (and by `parseForm` for data):

- **Placeholders match variables**: `{{1}}`, `{{2}}`… in order, as many as there are variables, each
  reading a declared field.
- **A `fallback` on every variable sourced from an optional field.** Meta rejects empty variables, and
  an empty one reads as a gap on Telegram too.
- **WhatsApp**: exactly one `phone` field — the delivery address —, a `whatsapp.name`, a body under
  1024 characters that does not start or end with a variable nor put two side by side.
- **Telegram**: no phone needed; body under 4096 characters.
- **No `photo` field type.** Images are configured under `chat`, not `fields`.

### Persistence adapters

```ts
import type { Repository, Storage } from "data-collection-link";

export function repository(db: YourDatabase): Repository {
  return {
    createCase: async ({ form, channel, address, values, linkTokenHash }) => { /* … */ },
    openCaseFor: async (channel, address) => { /* … or null */ },

    // Telegram: attach the chat to the case whose link token digest matches.
    // Single-use: a conditional update `where address is null` — the first
    // chat wins; the link forwarded to someone else gets null.
    bindCase: async (channel, linkTokenHash, address) => { /* … or null */ },

    // `false` when (channel, messageId) already exists. The uniqueness
    // constraint must live in the database — a unique index — not in process
    // memory: retries may reach a different instance.
    recordMessage: async (m) => { /* true when new */ },

    saveReport: async (caseId, text) => { /* … */ },
    savePhoto: async (caseId, photo) => { /* … */ },
    count: async (caseId) => ({ reports: 0, photos: 0 }),
    closeCase: async (caseId) => { /* … */ },
    recordDelivery: async (caseId, r) => { /* ok, delivered, messageId or error */ },
  };
}

export const storage: Storage = {
  async save({ bytes, contentType, prefix }) {
    // Write… then read the object back and compare size and digest before
    // confirming. See "File integrity".
    return { path, sha256, bytes: bytes.length };
  },
};
```

## Usage

### Button

```tsx
import { DataCollectionButton } from "data-collection-link/react";
import { siteFollowUp } from "@/lib/forms/site-followup";

<DataCollectionButton
  form={siteFollowUp}
  channel="telegram"            // defaults to the form's first channel
  classNames={{ button: "my-button", dialog: "my-dialog", field: "my-field", link: "my-link" }}
  onSubmit={async (values) => {
    const r = await fetch("/api/follow-up", { method: "POST", body: JSON.stringify(values) });
    return r.json();            // { delivered, link?, error? }
  }}
/>
```

Unstyled by design: every element carries a `data-dcl` attribute and accepts an external class. It
issues no server calls — `onSubmit` targets your route, where your authorization lives. On Telegram it
shows the returned link once, for the operator to copy.

### Case creation

```ts
import { invite } from "data-collection-link";

const deps = { channels: { whatsapp: whatsapp(), telegram: telegram() }, repository: repository(db), storage };

const { case: created, delivered, link, error } = await invite(deps, siteFollowUp, values, "telegram");
// WhatsApp: `delivered` says whether Meta accepted the template.
// Telegram: nothing is sent; `link` carries a one-time token. It is returned
// once and never stored — only its SHA-256 is. Show it to the operator.
// Respond 201 even when `delivered` is false: the case exists, and reporting
// otherwise leads operators to create it twice.
```

### Webhook

One route per channel, the same body for both:

```ts
import { processInbound, verifyChallenge, type Channel } from "data-collection-link";

async function handle(channel: Channel, request: Request) {
  const raw = await request.text();                         // RAW, unparsed
  if (!channel.verifyRequest({ rawBody: raw, headers: request.headers })) {
    return new Response("invalid", { status: 403 });
  }
  let payload: unknown;
  try { payload = JSON.parse(raw); } catch { return Response.json({ ok: true }); }
  for (const m of channel.parse(payload)) {
    try {
      await processInbound(deps, siteFollowUp, m);
    } catch (e) {
      console.error(e);   // one bad message must not block the rest
    }
  }
  return Response.json({ ok: true });                       // ALWAYS 200
}

// app/api/whatsapp/webhook/route.ts
export const POST = (r: Request) => handle(whatsapp(), r);
export async function GET(request: Request) {               // Meta's registration challenge
  const r = verifyChallenge(whatsappConfig(), new URL(request.url).searchParams);
  return r.ok ? new Response(r.challenge) : new Response("no", { status: 403 });
}

// app/api/telegram/webhook/route.ts
export const POST = (r: Request) => handle(telegram(), r);
```

`replies` in `deps` are optional: `received`, `missingToClose`, `closed` and, for Telegram,
`linkInvalid` (the link was already opened by another account, its case is closed, or it is unknown).
When a Telegram link is opened, the engine binds the chat and sends the rendered invitation as the
first message.

### Validation and preview

```ts
import { validateForm, parseForm, previewInvitation, templateForMeta } from "data-collection-link";

expect(validateForm(siteFollowUp)).toEqual([]);         // in a test: empty means usable
parseForm(rowFromDatabase);                             // { ok, form } or { ok: false, issues }
previewInvitation(siteFollowUp, { name: "Armando", note: "block B" });
templateForMeta(siteFollowUp);                          // payload for Meta's template form
```

---

## Guided conversations

On Telegram, a conversation can also be a questionnaire: the bot asks one thing at a time, with
buttons, and checks each answer before the next question. A `GuidedTemplate` lists the steps; it is a
separate engine from the free-form one above, and does no I/O of its own.

| step | asks for | answer |
|---|---|---|
| `location` | the device's location, or a text alternative; a host `resolver` can name the place for the recipient to `confirm` | `{ status, latitude, longitude, accuracyMeters, place }` |
| `choice` | one of fixed `options`, or of a `catalog` the host passes by name, in `columns` | the option's `value` |
| `text` | free text, `minLength` to `maxLength` | string |
| `number` | a number as people type it — «1.200,5» is 1200.5 — from `min` to `max` | number |
| `list` | item steps repeated per item, then «another?», from `minItems` | the items |
| `photos` | 1 to `max` photos, ended by a done button | file ids |
| `summary` | nothing: shows the answers so far and goes on | — |
| `handoff` | nothing: a button that opens a page of the host's own; the conversation ends there | — |

Every step has an `id` and its `question`, and can be skipped with `skipIf`, a condition over earlier
answers. Choice, text and number steps can be `optional` (a skip button) or `remember`ed: the host
keeps the answer for the chat (`guidedRemembered`) and the next conversation offers it as a button.
Every text the recipient reads — including the explanation for an answer that does not fit — comes
from the template; only the default commands are Spanish: `/atras`, `/cancelar`, `/resumen`.

```ts
import type { GuidedTemplate } from "data-collection-link";

export const dispatch: GuidedTemplate = {
  key: "dispatch",
  locale: "es-CO",                       // how numbers and coordinates are written back
  texts: { invalid: "No entendí esa respuesta.", cancelled: "Cancelé el borrador.", useRemembered: "Usar: {value}" },
  steps: [
    { id: "where", type: "location", question: "Comparte tu ubicación.", button: "📍 Compartir ubicación",
      alternatives: ["No puedo compartirla"], resolver: "territory",
      confirm: { question: "Estás en {latitude} {longitude}: barrio {barrio}. ¿Es el lugar?", yes: "Sí", no: "No" } },
    { id: "district", type: "choice", question: "¿Comuna o corregimiento?", catalog: "districts", columns: 3,
      skipIf: { answer: "where.status", equals: "confirmed" } },
    { id: "origin", type: "choice", question: "¿Desde qué punto sale?", catalog: "origins", remember: true },
    { id: "items", type: "list", question: "Ahora los artículos.",
      more: { question: "Llevas {count}. ¿Otro?", add: "Agregar otro", done: "Listo" },
      steps: [
        { id: "category", type: "choice", question: "Artículo {n}: ¿categoría?", catalog: "categories", columns: 2 },
        { id: "quantity", type: "number", question: "¿Cuántos?", positive: true },
      ] },
    { id: "photos", type: "photos", question: "Manda las fotos, hasta {max}.", max: 12, done: "Listo" },
    { id: "recipient", type: "handoff", question: "Quien recibe se llena en una pantalla protegida.",
      button: "Completar", link: "recipient" },
  ],
};
```

In the Telegram webhook, after `recordMessage` said the message is new:

```ts
import { advance, startGuided, renderTelegram, type GuidedContext } from "data-collection-link";

const ctx: GuidedContext = {
  catalogs: await catalogs(),                          // { districts: [{ value, label }], … }
  remembered: await rememberedFor(m.from),             // what guidedRemembered returned last time
  resolvers: { territory: ({ latitude, longitude }) => db.placeAt(latitude, longitude) },
  links: { recipient: recipientPageUrl(draft) },       // https, carrying your own credential
};
const saved = await db.conversationFor(m.from);        // GuidedState | null: plain JSON
const { state, outputs } = saved ? await advance(saved, dispatch, m, ctx) : await startGuided(dispatch, ctx);
await db.saveConversation(m.from, state);              // save first: a lost reply is resent on /start
await renderTelegram(telegramConfig(), m.from, outputs);
// state.status: "active", "handed_off" (close it when the page confirms), "completed" or "cancelled".
// guidedAnswers(state) gives the answers by step id for your submission.
```

- **One message at a time per chat.** An album arrives as several updates at once; handled in
  parallel on the same saved state, one photo is lost. Serialize per chat, or save with a version
  check and retry.
- **The state is only the answers**, and where the conversation stands: no chat id, no token, no
  URL. Photos are file ids, their captions dropped. A location the recipient says is not the place
  is dropped, from the history kept for `/atras` too.
- **`/atras` returns to the previous question actually asked**, skipping what `skipIf` skipped, and
  drops the answers given since. `/start` — the link opened again — repeats the current question.
- **A button from an earlier question is not an answer.** Its data names its step, so a tap on an
  old keyboard repeats the current question instead.
- **Button data is 64 bytes**, not characters. `validateGuided(template, { catalogs })` in a test,
  with the real catalogs, checks every option; `sendChoices` refuses an oversize button before
  calling Telegram.

### Personal data in a guided conversation

Every answer typed or tapped in the chat is a message to a bot, kept on Telegram's servers and not
end-to-end encrypted (see [Personal data](#personal-data)). **Ask in the chat only what is not
personal** — places, categories, quantities, photos of goods. What is personal — the name, ID number
or phone of the person receiving, a signed record — goes through a **`handoff`** step: a page of your
own, opened inside Telegram, that sends what is typed in it straight to your server. The library
cannot tell a personal question from another; that is the template author's call, reviewed like code.
A photo can show a face: say what to photograph.

---

**How an answer reads in the summary.** A step's `summaryAs` sets its value's side of the line, with `{value}`: `"{value} kg"`. An option's `summary` replaces its label there. An empty string leaves the line out, which suits a «kilos or tonnes» choice whose number already says it all.

## Static or dynamic definitions

A `Form` is data, so it can live in two places. The library supports both; the cost is in the host.

**Static — a constant in code** (how the originating project does it). A change is a commit: the
template is reviewed like code, `validateForm` runs in a test, and a broken definition never reaches
production. The cost of each change is a deploy.

**Dynamic — a row in a database**, edited at runtime by an operator. The library side is
`parseForm`: it refuses malformed or rule-breaking data with the reasons, and drops properties outside
the model. Everything else falls on the host:

| | What it takes |
|---|---|
| **Versions** | Each edit creates a new, immutable version, and each case records the version it was opened with. Otherwise editing a form changes the meaning of past cases: a removed field disappears from old answers. The webhook loads the case's version instead of a constant. |
| **Answers as data** | Dialog values stored as JSON keyed by field, not as typed columns. Lists, filters and exports become generic, and anything computed from a field must know its key across versions. |
| **An editor** | Fields, chat requirements and invitation text, with a live `previewInvitation` and `parseForm` before saving; permissions over who edits; an audit of who changed what. |
| **WhatsApp approval** | The invitation body *is* the approved template. Changing it at runtime means submitting a new template through Meta's management API (a different token scope and the WhatsApp Business Account id), waiting for review — minutes to a day or more —, handling a rejection or a recategorization to Marketing (priced higher), and refusing to invite with that version until it is approved. Telegram has none of this. |
| **Personal data** | An editor can add a field asking for an ID number. In code that goes through review; at runtime it needs an approval step or a closed list of what may be asked. |

Two middle grounds cover most needs at a fraction of the cost: **dynamic fields with fixed
invitations** (a few approved WhatsApp bodies whose variables are filled from the case, so nothing
goes back to Meta), or **dynamic definitions on Telegram only**.

---

## Platform constraints

These design decisions follow from platform limits and from failure modes observed in production.
They are documented here because they are not evident from the API surface.

### Webhook authentication

The webhook endpoint is public and writes to the database. No session protects it: the caller is the
platform, not a user. On WhatsApp the HMAC-SHA256 of `X-Hub-Signature-256` is the only access control,
computed over the **raw body** — deserializing and re-serializing the JSON yields a different string
and verification fails. On Telegram it is the `X-Telegram-Bot-Api-Secret-Token` header, compared in
constant time. Both return `false` when their secret is not configured: fail-closed.

### Idempotency

Both platforms retry deliveries that do not receive `200` in time. The same message may arrive several
times. `Repository.recordMessage` must return `false` when `(channel, messageId)` already exists, with
the uniqueness constraint in the database. The handler must respond `200` even when processing fails:
retrying an already-persisted message corrects nothing and multiplies side effects.

Telegram message ids are unique per chat, so the library uses `<chat id>:<message id>`.

### Media download

WhatsApp returns a signed URL that expires within minutes; Telegram a file path that is valid for at
least an hour, for files up to 20 MB. In both cases the download happens while handling the webhook:
deferring it to a queue introduces a failure mode where the media is no longer retrievable. Telegram
serves files as `application/octet-stream`, so the type comes from the extension — verify magic bytes
before trusting either.

### File integrity

`Storage` cannot enforce verification because it does not know the backend. Implementations should
read the object back and compare size and digest before confirming the write.

Rationale: in the originating project, 88 files across 23 submissions were lost because the binary
body was transmitted as text, the runtime decoded it as UTF-8, and every byte ≥ 0x80 was replaced.
The API returned `200`, the record was written with the original size, and the corruption surfaced
only weeks later when the images were first read.

### WhatsApp: 24-hour service window and tokens

Outside the 24 hours following the recipient's last message, Meta accepts approved templates only;
free-form text is rejected. `invite` opens the conversation with the template; `replies` are valid
only inside the window the recipient opens by replying — which is exactly when they are used.

The token in the API Setup panel is valid for 24 hours. Production requires a system-user token with
the `whatsapp_business_messaging`, `whatsapp_business_management` and `business_management` scopes.
With an expired token, the invitation is never delivered; persist it through `recordDelivery` or the
failure is silent.

### Telegram: the link is a single-use credential

The token travels inside the link — through whatever the operator uses to hand it over, and through
Telegram. Three things limit what a leaked link can do: only its SHA-256 is stored, binding is
single-use (the first account to open it owns the case; a second account is told the link is no
longer valid), and once bound, only that chat can report. A link that reached the wrong person first
is resolved by closing the case and inviting again.

Only private chats are read: a bot added to a group would otherwise turn every group message into a
report.

### Telegram: a rich form as a Mini App

Some forms do not fit a chat: a list of items, photos per section, an offline queue. For those the
chat is only the door. `sendWebApp(cfg, { chatId, text, button: { text, url } })` answers the
`/start <token>` with a button that opens the host application's own web form inside Telegram,
carrying the same token. The form validates the token; the bot only delivers it. Telegram opens only
`https` pages this way, and `sendWebApp` refuses anything else before calling the API. A guided
conversation ends in the same kind of page with its `handoff` step.

### Closing detection

`isClosingMessage` compares the whole normalized message — diacritics and non-alphabetic characters
removed — against the closing words. It does not match substrings: "Listo, mañana sigo con el segundo
piso" contains a closing word and does not express closure. A false positive leaves the recipient
without a channel to continue reporting, and reopening the case is not under their control. The
defaults are Spanish plus `done`; declare `chat.closingWords` to replace them.

## Personal data

Phone numbers, message contents and attachments are processed by the platform — Meta or Telegram —
and stay in its infrastructure: on WhatsApp until downloaded; on Telegram, messages to a bot are cloud
chats, not end-to-end encrypted, kept on Telegram's servers.

Where the use case involves personal data, this requires a lawful basis for processing and an
international data transfer agreement with the provider. The library does not address that
requirement. Ask only what the case needs: what is not collected cannot leak.

## Migrating from `whatsapp-conversational-form` 0.3

- Package and import path: `data-collection-link`; React: `DataCollectionButton` (was
  `WhatsAppFormButton`), attributes `data-dcl` (were `data-edw`); `SubmitResult` is
  `{ delivered, link?, error? }` (was `{ sent, error? }`).
- `Form.template` splits in two: `invitation: { body, variables }` (now required, for every channel)
  and `whatsapp: { name, language, category }`. Add `channels: ["whatsapp"]`.
- `validateTemplate` → `validateForm`; `previewTemplate` → `previewInvitation`.
- `Deps.whatsapp: WhatsAppConfig` → `Deps.channels: { whatsapp: whatsappChannel(cfg) }`. `invite`
  returns `delivered` (was `sent`) and, on Telegram, `link`.
- `Case.phone` → `Case.channel` and `Case.address`.
- `Repository`: `createCase` receives `channel`, `address` and `linkTokenHash`; `openCaseFor(channel,
  address)`; new `bindCase` (return `null` if you only use WhatsApp); `recordMessage` receives
  `channel` and `messageId` (was `wamid`), and its type `invitation` (was `template`);
  `recordDelivery` receives `{ ok, delivered, messageId?, error? }`.
- `extractMessages(payload, countryCode)` returns messages with `channel`, `id` and `from` already
  normalized. Prefer `channel.parse` and `channel.verifyRequest`.

## Contributing

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).
See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Status

`0.6.x`. One consumer in integration on WhatsApp, no production traffic; the Telegram channel and
the guided conversation are covered by tests and have not met a real bot yet. The API surface may
change: it is validated by the second use case, not the first.
