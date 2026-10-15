/**
 * Data model for a WhatsApp-backed conversational form.
 *
 * ## Two actors, two datasets
 *
 * An **operator** — an authenticated user of the host application — creates a
 * case through a dialog of N fields. A **recipient** — an external person with
 * no account — then replies over WhatsApp, and that thread acts as the form.
 *
 * The configuration keeps both datasets apart because they differ in author
 * and in timing:
 *
 * | config  | actor     | when                        |
 * |---------|-----------|-----------------------------|
 * | `fields`| operator  | before the conversation     |
 * | `chat`  | recipient | during the conversation     |
 *
 * There is no `photo` field type: images are sent by the recipient over the
 * channel, not by the operator through the dialog. Merging both datasets into
 * one list would require a per-field discriminator expressing this same
 * distinction less clearly.
 *
 * ## Persistence is out of scope
 *
 * This package covers the WhatsApp protocol and the conversation state
 * machine. Storage is supplied by the host application through `Repository`
 * and `Storage`, which is what lets the same form definition write to
 * different backends.
 */

/** A dialog field filled in by the operator. */
export type DialogField = {
  /** Key under which the value reaches the repository. */
  key: string;
  label: string;
  /**
   * Exactly one `phone` field is required: it is the delivery address.
   *
   * There is no `photo` type — see the module note above.
   */
  type: "phone" | "text" | "textarea";
  required?: boolean;
  /** Hint rendered below the field. For format, not to restate the label. */
  help?: string;
  placeholder?: string;
  maxLength?: number;
};

/** What the conversation collects, and what is required before closing. */
export type ChatCapture = {
  /** Free text sent by the recipient. */
  report?: {
    enabled: boolean;
    requiredToClose?: boolean;
  };
  photos?: {
    enabled: boolean;
    /** How many are required before the case may be closed. */
    minToClose?: number;
  };
  /**
   * Words the recipient uses to declare the case finished.
   *
   * Matched against the whole normalized message, not as a substring — see
   * `isClosingMessage`.
   */
  closingWords?: string[];
};

export type Form = {
  /** Identifies this form in the repository. */
  key: string;
  /** Label of the button that opens the dialog. */
  button: string;
  /** Dialog title. Falls back to `button`. */
  title?: string;
  description?: string;
  fields: DialogField[];
  chat: ChatCapture;
  /** The Meta-approved template used to open the conversation. */
  template: {
    name: string;
    language?: string;
    /** Defaults to `utility`. See `templateForMeta`. */
    category?: "utility" | "marketing" | "authentication";
    /**
     * Body as submitted to Meta, with its `{{1}}`, `{{2}}` placeholders.
     *
     * Optional, so an externally approved template still works. Declaring it
     * lets `validateTemplate` check that placeholders match the variables
     * below; without it, a mismatch surfaces only at send time in production —
     * Meta rejects the message, the case exists, and the recipient is never
     * contacted.
     */
    body?: string;
    /**
     * Values for `{{1}}`, `{{2}}`… in order, each naming the field it reads.
     *
     * Meta rejects templates with empty variables, so any variable sourced
     * from an optional field needs a `fallback`.
     */
    variables: { field: string; fallback?: string }[];
  };
};

/** An open case, created when the operator invites someone. */
export type Case = {
  id: string;
  form: string;
  phone: string;
  /** Dialog values, keyed by field. */
  values: Record<string, string | null>;
  status: "invited" | "in_progress" | "closed";
};

/**
 * Persistence, implemented by the host application.
 *
 * `recordMessage` **must return `false` when the `wamid` already exists**. That
 * is the deduplication primitive: Meta retries deliveries that do not receive
 * `200` within its timeout, and the uniqueness constraint has to live in the
 * database — a unique index on `wamid` — rather than in process memory, since
 * retries may reach a different instance.
 */
export type Repository = {
  createCase(input: {
    form: string;
    phone: string;
    values: Record<string, string | null>;
  }): Promise<Case>;

  /** The open case for that phone number, or null. At most one may exist. */
  openCaseFor(phone: string): Promise<Case | null>;

  /** `false` when the `wamid` was already stored — a retry, nothing to do. */
  recordMessage(m: {
    caseId: string | null;
    wamid: string;
    direction: "inbound" | "outbound";
    type: "text" | "image" | "template" | "other";
    text: string | null;
    occurredAt: string | null;
  }): Promise<boolean>;

  saveReport(caseId: string, text: string): Promise<void>;

  savePhoto(caseId: string, photo: { path: string; contentType: string; bytes: number; sha256: string }): Promise<void>;

  /** Used to decide whether the case meets `chat` requirements for closing. */
  count(caseId: string): Promise<{ reports: number; photos: number }>;

  closeCase(caseId: string): Promise<void>;

  /** Outcome of the invitation attempt, so a failed send is not lost. */
  recordDelivery(caseId: string, r: { ok: boolean; wamid?: string; error?: string }): Promise<void>;
};

/**
 * Binary storage, implemented by the host application.
 *
 * Implementations should read the object back and compare size and digest
 * before confirming the write. See "File integrity" in the README.
 */
export type Storage = {
  save(input: {
    bytes: Uint8Array;
    contentType: string;
    /** Suggested folder, derived from the form key. */
    prefix: string;
  }): Promise<{ path: string; sha256: string; bytes: number }>;
};
