/**
 * Data collection links: a chat thread — WhatsApp or Telegram — that works as
 * a form for someone without an account.
 *
 * The core imports neither React nor any database driver: it covers the
 * channels and the conversation state machine, and everything else arrives
 * through `Repository` and `Storage`. The UI lives behind a separate entry
 * point, `data-collection-link/react`, so consumers that only need the webhook
 * do not pull React in.
 */
export type {
  Case,
  ChannelName,
  ChatCapture,
  DialogField,
  Form,
  Invitation,
  Repository,
  Storage,
  WhatsAppTemplate,
} from "./types.js";

export type {
  Channel,
  HeaderReader,
  InboundLocation,
  InboundMessage,
  InvitationResult,
  Media,
  SendResult,
} from "./channel.js";

export {
  downloadMedia,
  extractMessages,
  isValidSignature,
  normalizePhone,
  sendTemplate,
  sendText,
  verifyChallenge,
  whatsappChannel,
  type WhatsAppConfig,
} from "./whatsapp.js";

export {
  CALLBACK_DATA_LIMIT,
  TELEGRAM_TEXT_LIMIT,
  answerCallback,
  downloadFile,
  extractUpdate,
  isValidSecret,
  requestLocation,
  sendChoices,
  sendMessage,
  setWebhook,
  sendWebApp,
  telegramChannel,
  telegramLink,
  type TelegramConfig,
} from "./telegram.js";

export {
  hashLinkToken,
  invite,
  isClosingMessage,
  processInbound,
  type Deps,
  type InboundResult,
} from "./conversation.js";

export {
  CHANNELS,
  invitationVariables,
  parseForm,
  previewInvitation,
  templateForMeta,
  validateForm,
  type FormIssue,
} from "./form.js";
