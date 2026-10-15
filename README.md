# enlace-dinamico-whatsapp

Forms whose response channel is a WhatsApp conversation.

An **operator** — an authenticated user of the host application — creates a case through a dialog
of N fields. The library sends an approved template to the **recipient** — an external person with
no account — and from then on the WhatsApp thread acts as the form: the text and images they send
are persisted to whatever storage the host application defines.

Built for the [PMU of the Cali earthquake emergency](https://github.com/Zenda-Holos-Produccion/pmu-sismo-prod),
where recipients are contractors reporting construction progress from the field, without
installing an application or creating credentials.

---

## Model

The configuration keeps two datasets apart, by author and by timing:

| config | actor | when | shape |
|---|---|---|---|
| `fields` | operator | before the conversation | N typed fields |
| `chat` | recipient | during the conversation | text (`report`) and images (`photos`) |

There is no `photo` field type in `fields`: images are sent by the recipient over the channel, not
by the operator through the dialog. Merging both datasets into one list would require a per-field
discriminator expressing this same distinction less clearly.

## Persistence

The scope of this package is the WhatsApp protocol and the conversation state machine. It contains
no data access.

The host application implements two interfaces:

- **`Repository`** — case creation, message recording, report and image persistence, closing.
- **`Storage`** — binary writes.

## Installation

```bash
npm install github:Zenda-Holos-Produccion/enlace-dinamico-whatsapp
```

Not published to npm; installed from git. The repository is **public**, so no credentials are
required — on a workstation, in CI, or inside a Docker image. That was deliberate: a private
dependency requires a token in every build and introduces a new deployment failure mode.

Requires Node 20+. React is an optional peer dependency, needed only for the `/react` entry point.

## Configuration

Three blocks with different lifecycles: the **channel** (credentials, changes on token rotation),
the **form definition** (changes with the business process) and the **persistence adapters**
(stable). Keep them in separate modules.

### Channel: `WhatsAppConfig`

Every function that talks to the Graph API receives this object. The library does not read
environment variables; resolving configuration is the host application's responsibility.

```ts
import type { WhatsAppConfig } from "enlace-dinamico-whatsapp";

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
```

| field | description | source |
|---|---|---|
| `token` | Permanent system-user token | Business Settings → System users → Generate token, with `whatsapp_business_messaging`, `whatsapp_business_management`, `business_management` |
| `phoneNumberId` | Phone number **id**, not the number | App dashboard → WhatsApp → API Setup |
| `appSecret` | Verifies webhook signatures | App dashboard → Settings → Basic → App Secret |
| `verifyToken` | Chosen when registering the webhook | Must match on both sides |
| `version` | Graph API version | Meta retires versions every couple of years |
| `countryCode` | Calling code without `+` | Prepended to stored numbers |

If `token` or `phoneNumberId` are missing, send calls return `ok:false` with the reason instead of
throwing, so the caller can record the case as undelivered. If `appSecret` is missing,
`isValidSignature` always returns `false` — fail-closed.

### Form definition

A single exported constant. It is the only definition: dialog fields, what the conversation
collects, closing words and the template body all come from here.

```ts
import type { Form } from "enlace-dinamico-whatsapp";

export const siteFollowUp: Form = {
  key: "site-followup",
  button: "New follow-up",
  title: "New follow-up",
  description: "The recipient is contacted on WhatsApp and reports in that thread.",

  fields: [
    { key: "name", label: "Name", type: "text", required: true },
    { key: "phone", label: "Mobile number", type: "phone", required: true,
      help: "With or without country code." },
    { key: "note", label: "Description", type: "textarea",
      placeholder: "Which site this is about" },
  ],

  chat: {
    report: { enabled: true, requiredToClose: true },
    photos: { enabled: true, minToClose: 1 },
    closingWords: ["listo", "done"],   // optional
  },

  template: {
    name: "site_followup",
    language: "es",
    category: "utility",
    body:
      "Hello {{1}}. We are contacting you about {{2}}.\n\n" +
      "You can send photos and describe the work in this thread.\n\n" +
      "When there is nothing left to report, reply DONE.",
    variables: [{ field: "name" }, { field: "note", fallback: "a site" }],
  },
};
```

Constraints enforced by `validateTemplate`:

- **Exactly one `phone` field.** It is the delivery address; `invite` throws without it.
- **A `fallback` on every variable sourced from an optional field.** Meta rejects templates with
  empty variables.
- **No `photo` field type.** Images are configured under `chat`, not `fields`.

### Persistence adapters

Two objects implemented by the host. This is the boundary with your database; keeping it in one
module means a backend change rewrites that module and nothing else.

```ts
import type { Repository, Storage } from "enlace-dinamico-whatsapp";

export function repository(db: YourDatabase): Repository {
  return {
    createCase: async ({ form, phone, values }) => { /* … */ },
    openCaseFor: async (phone) => { /* … or null */ },

    // `false` when the wamid already exists. The uniqueness constraint must
    // live in the database — a unique index — not in process memory: retries
    // may reach a different instance.
    recordMessage: async (m) => { /* true when new */ },

    saveReport: async (caseId, text) => { /* … */ },
    savePhoto: async (caseId, photo) => { /* … */ },
    count: async (caseId) => ({ reports: 0, photos: 0 }),
    closeCase: async (caseId) => { /* … */ },
    recordDelivery: async (caseId, r) => { /* ok, wamid or error */ },
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

`count` determines whether a case may be closed: the library calls it when the recipient sends a
closing word and compares the result against `chat`.

## Usage

### Button

```tsx
import { WhatsAppFormButton } from "enlace-dinamico-whatsapp/react";
import { siteFollowUp } from "@/lib/forms/site-followup";

<WhatsAppFormButton
  form={siteFollowUp}
  classNames={{ button: "my-button", dialog: "my-dialog", field: "my-field" }}
  onSubmit={async (values) => {
    const r = await fetch("/api/follow-up", { method: "POST", body: JSON.stringify(values) });
    return r.json();
  }}
/>
```

Unstyled by design: every element carries a `data-edw` attribute and accepts an external class
(`button`, `overlay`, `dialog`, `title`, `description`, `field`, `label`, `help`, `error`,
`success`, `actions`, `submit`, `cancel`). It issues no server calls — `onSubmit` targets your
route, where your authorization lives.

If you already have a dialog component, use it and map over `form.fields` yourself. What matters is
that fields come from the definition rather than being hard-coded.

### Case creation

```ts
import { invite } from "enlace-dinamico-whatsapp";

const { case: created, sent, error } = await invite(
  { whatsapp: whatsappConfig(), repository: repository(db), storage },
  siteFollowUp,
  values,
);
// Respond 201 even when `sent` is false: the case was created. Reporting
// otherwise leads operators to create it twice.
```

### Webhook

```ts
import {
  extractMessages, isValidSignature, processInbound, verifyChallenge,
} from "enlace-dinamico-whatsapp";

const deps = {
  whatsapp: whatsappConfig(),
  repository: repository(db),
  storage,
  replies: {
    received: ({ withPhoto }) => withPhoto ? "Photo stored." : "Noted.",
    missingToClose: (m) => m.photos > 0 ? "Please send at least one photo first." : "Please describe the work first.",
    closed: () => "Follow-up closed. Thank you.",
  },
};

export async function GET(request: Request) {
  const r = verifyChallenge(whatsappConfig(), new URL(request.url).searchParams);
  return r.ok ? new Response(r.challenge) : new Response("no", { status: 403 });
}

export async function POST(request: Request) {
  const cfg = whatsappConfig();
  const raw = await request.text();                       // RAW, unparsed
  if (!isValidSignature(cfg, raw, request.headers.get("x-hub-signature-256"))) {
    return new Response("invalid signature", { status: 403 });
  }
  for (const m of extractMessages(JSON.parse(raw))) {
    try {
      await processInbound(deps, siteFollowUp, m);
    } catch (e) {
      console.error(e);   // one bad message must not block the rest
    }
  }
  return Response.json({ ok: true });                     // ALWAYS 200
}
```

`replies` is optional. They are sent as free-form text, which is valid only inside the 24-hour
window the recipient opens by replying — which is exactly when they are used.

### Template validation

```ts
import { validateTemplate, templateForMeta, previewTemplate } from "enlace-dinamico-whatsapp";

expect(validateTemplate(siteFollowUp)).toEqual([]);   // empty means consistent
templateForMeta(siteFollowUp);                        // payload for Meta's form
previewTemplate(siteFollowUp, { name: "Armando", note: "block B" });
```

`validateTemplate` checks placeholder count and ordering against the declared variables, that each
variable reads an existing field, and the documented Meta formatting rules: no leading or trailing
placeholder, no adjacent placeholders, lowercase name, body under 1024 characters.

`body` is optional so an externally approved template still works, but then `validateTemplate`
reports `no_body` and checks nothing — "unchecked" must be distinguishable from "valid".

**Out of scope:** this does not submit the template, nor verify that the approved one matches.
Editing it from the Meta console is not detected here; that requires the management API.

---

## Platform constraints

These design decisions follow from Cloud API limits and from failure modes observed in production.
They are documented here because they are not evident from the API surface.

### Signature verification

The webhook endpoint is public and writes to the database. No session protects it: the caller is
Meta, not a user. HMAC-SHA256 verification of `X-Hub-Signature-256` is the only access control.

The digest is computed over the **raw body**. Deserializing and re-serializing the JSON yields a
different string and verification fails.

`isValidSignature` returns `false` when `appSecret` is undefined. Fail-closed is deliberate: in an
incomplete deployment, accepting unverified payloads exposes the endpoint.

### Idempotency

Meta retries deliveries that do not receive `200` within its timeout. The same message may arrive
several times.

`Repository.recordMessage` must return `false` when the `wamid` already exists. The uniqueness
constraint has to live in the database — a unique index on `wamid` — not in process memory: with
more than one instance, retries may reach a different one.

The handler must respond `200` even when processing fails. Retrying an already-persisted message
corrects nothing and multiplies side effects.

### Media download

`GET /{media-id}` returns a signed URL that expires within minutes. The download must happen while
handling the webhook. Deferring it to a queue introduces a failure mode where the media is no
longer retrievable.

### File integrity

`Storage` cannot enforce verification because it does not know the backend. Implementations should
read the object back and compare size and digest before confirming the write.

Rationale: in the originating project, 88 files across 23 submissions were lost because the binary
body was transmitted as text, the runtime decoded it as UTF-8, and every byte ≥ 0x80 was replaced.
The API returned `200`, the record was written with the original size, and the corruption surfaced
only weeks later when the images were first read.

### 24-hour service window

Outside the 24 hours following the recipient's last message, Meta accepts approved templates only;
free-form text is rejected.

`sendTemplate` opens the conversation. `sendText` — used by `replies` — is valid only inside the
window the recipient opens by replying.

### Tokens

The token exposed in the API Setup panel is valid for 24 hours. Production requires a system-user
token with the `whatsapp_business_messaging`, `whatsapp_business_management` and
`business_management` scopes.

With an expired token, `sendTemplate` returns `ok:false` and the invitation is never delivered. The
failure is silent from the operator's perspective unless persisted through `recordDelivery`.

### Closing detection

`isClosingMessage` compares the whole normalized message — diacritics and non-alphabetic
characters removed — against the closing words. It does not match substrings.

The defaults are Spanish plus `done`, because the originating deployment is Spanish-speaking. They
are data, not code: declare `chat.closingWords` to replace them.

Rationale: "Listo, mañana sigo con el segundo piso" contains a closing word and does not express
closure. A false positive leaves the recipient without a channel to continue reporting, and
reopening the case is not under their control.

## Personal data

Phone numbers, message contents and attachments are processed by Meta and remain in its
infrastructure until downloaded.

Where the use case involves personal data, this requires a lawful basis for processing and an
international data transfer agreement with the provider. The library does not address that
requirement.

## Contributing

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/).
See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Status

`0.3.x`. One consumer in integration, no production traffic. The API surface may change: it is
validated by the second use case, not the first.
