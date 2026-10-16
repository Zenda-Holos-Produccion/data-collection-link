/**
 * Forms whose response channel is a WhatsApp conversation.
 *
 * The core imports neither React nor any database driver: it covers the
 * WhatsApp protocol and the conversation state machine, and everything else
 * arrives through `Repository` and `Storage`. The UI lives behind a separate
 * entry point, `whatsapp-conversational-form/react`, so consumers that only need
 * the webhook do not pull React in.
 */
export type {
  ChatCapture,
  Case,
  DialogField,
  Form,
  Repository,
  Storage,
} from "./types.js";

export {
  downloadMedia,
  extractMessages,
  isValidSignature,
  sendTemplate,
  sendText,
  verifyChallenge,
  type InboundMessage,
  type SendResult,
  type WhatsAppConfig,
} from "./whatsapp.js";

export {
  invite,
  isClosingMessage,
  normalizePhone,
  processInbound,
  type Deps,
  type InboundResult,
} from "./conversation.js";

export {
  previewTemplate,
  templateForMeta,
  validateTemplate,
  type TemplateIssue,
} from "./template.js";
