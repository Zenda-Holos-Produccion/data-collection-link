/**
 * Data model for a data collection link.
 *
 * ## What it is
 *
 * An **operator** — an authenticated user of the host application — opens a
 * case through a dialog of N fields. A **recipient** — an external person with
 * no account — is reached on a chat channel (WhatsApp or Telegram), and from
 * then on that chat thread is the form: the text and photos they send are
 * persisted wherever the host decides, until they reply with a closing word.
 *
 * ## Two actors, two datasets
 *
 * | config  | actor     | when                        |
 * |---------|-----------|-----------------------------|
 * | `fields`| operator  | before the conversation     |
 * | `chat`  | recipient | during the conversation     |
 *
 * There is no `photo` field type: images are sent by the recipient over the
 * channel, not by the operator through the dialog.
 *
 * ## A definition is data
 *
 * A `Form` is plain, JSON-serializable data. It can be a constant in code,
 * reviewed and deployed like code, or a row loaded at runtime and checked with
 * `parseForm`. The library treats both the same. See "Static or dynamic
 * definitions" in the README for what each costs.
 *
 * ## Persistence is out of scope
 *
 * Storage is supplied by the host application through `Repository` and
 * `Storage`. The same definition can write to different backends.
 */

/** The chat channels a form can be sent over. */
export type ChannelName = "whatsapp" | "telegram";

/** A dialog field filled in by the operator. */
export type DialogField = {
  /** Key under which the value reaches the repository. */
  key: string;
  label: string;
  /**
   * A `phone` field is the WhatsApp delivery address: a form sent over
   * WhatsApp needs exactly one. Telegram does not use it — the recipient is
   * identified by the chat that opens the link.
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

/** The message that opens the conversation. */
export type Invitation = {
  /**
   * Text with `{{1}}`, `{{2}}` placeholders.
   *
   * On WhatsApp it is the body of a Meta-approved template and has to match
   * the approved text word for word: changing it means a new review by Meta.
   * On Telegram it is sent as written when the recipient opens the link.
   */
  body: string;
  /**
   * Values for `{{1}}`, `{{2}}`… in order, each naming the field it reads.
   *
   * Meta rejects templates with empty variables, so any variable sourced from
   * an optional field needs a `fallback`.
   */
  variables: { field: string; fallback?: string }[];
};

/** The Meta template that carries `invitation.body` on WhatsApp. */
export type WhatsAppTemplate = {
  /** Lowercase letters, digits and underscores, as registered in Meta. */
  name: string;
  language?: string;
  /** Defaults to `utility`. See `templateForMeta`. */
  category?: "utility" | "marketing" | "authentication";
};

export type Form = {
  /** Identifies this form in the repository. */
  key: string;
  /** Label of the button that opens the dialog. */
  button: string;
  /** Dialog title. Falls back to `button`. */
  title?: string;
  description?: string;
  /** Channels this form may be sent over. The first one is the default. */
  channels: ChannelName[];
  fields: DialogField[];
  chat: ChatCapture;
  invitation: Invitation;
  /** Required when `channels` includes `whatsapp`. */
  whatsapp?: WhatsAppTemplate;
};

/** An open case, created when the operator invites someone. */
export type Case = {
  id: string;
  form: string;
  channel: ChannelName;
  /**
   * Where the recipient is reached: the phone number as stored on WhatsApp,
   * the chat id on Telegram. `null` on Telegram until the recipient opens the
   * link.
   */
  address: string | null;
  /** Dialog values, keyed by field. */
  values: Record<string, string | null>;
  status: "invited" | "in_progress" | "closed";
};

/**
 * Persistence, implemented by the host application.
 *
 * `recordMessage` **must return `false` when the message id already exists**
 * for that channel. That is the deduplication primitive: both platforms retry
 * webhook deliveries that do not receive `200` in time, and the uniqueness
 * constraint has to live in the database — a unique index on channel and
 * message id — rather than in process memory, since retries may reach a
 * different instance.
 */
export type Repository = {
  createCase(input: {
    form: string;
    channel: ChannelName;
    /** The phone on WhatsApp; `null` on Telegram until the link is opened. */
    address: string | null;
    values: Record<string, string | null>;
    /**
     * Telegram: SHA-256 (hex) of the one-time token inside the link. Store the
     * digest, never the token: the link is shown once and cannot be recovered
     * from the database. `null` on WhatsApp.
     */
    linkTokenHash: string | null;
  }): Promise<Case>;

  /** The open case for that address on that channel, or null. At most one may exist. */
  openCaseFor(channel: ChannelName, address: string): Promise<Case | null>;

  /**
   * Telegram: attaches the chat that opened the link to the case holding that
   * token digest, and returns the case.
   *
   * Must be atomic and single-use: the first chat binds; a later open of the
   * same link — forwarded to someone else — returns `null`, as does an
   * unknown token or a closed case. A conditional update (`where address is
   * null`) is enough. A host that only uses WhatsApp returns `null`.
   */
  bindCase(channel: ChannelName, linkTokenHash: string, address: string): Promise<Case | null>;

  /** `false` when the message id was already stored — a retry, nothing to do. */
  recordMessage(m: {
    caseId: string | null;
    channel: ChannelName;
    messageId: string;
    direction: "inbound" | "outbound";
    type: "text" | "image" | "invitation" | "other";
    text: string | null;
    occurredAt: string | null;
  }): Promise<boolean>;

  saveReport(caseId: string, text: string): Promise<void>;

  savePhoto(caseId: string, photo: { path: string; contentType: string; bytes: number; sha256: string }): Promise<void>;

  /** Used to decide whether the case meets `chat` requirements for closing. */
  count(caseId: string): Promise<{ reports: number; photos: number }>;

  closeCase(caseId: string): Promise<void>;

  /**
   * Outcome of the invitation attempt, so a failed send is not lost.
   *
   * `delivered` is false on Telegram by design: nothing is sent until the
   * recipient opens the link. The link itself is never passed here — it
   * carries the token, which must not be stored.
   */
  recordDelivery(caseId: string, r: { ok: boolean; delivered: boolean; messageId?: string; error?: string }): Promise<void>;
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
