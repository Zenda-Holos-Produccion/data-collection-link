/**
 * Data collection links: a chat thread — WhatsApp or Telegram — that works as
 * a form for someone without an account.
 *
 * The core imports neither React nor any database driver: it covers the
 * channels, the free-form conversation and the guided one (`advance`), and
 * everything else arrives through `Repository`, `Storage` and `GuidedContext`. The UI lives behind a separate entry
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
  renderTelegram,
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
  advance,
  guidedAnswers,
  guidedRemembered,
  parseGuidedNumber,
  startGuided,
  validateGuided,
  type GuidedAnswer,
  type GuidedAnswers,
  type GuidedButton,
  type GuidedChoiceStep,
  type GuidedCondition,
  type GuidedContext,
  type GuidedCursor,
  type GuidedHandoffStep,
  type GuidedIssue,
  type GuidedItem,
  type GuidedItemStep,
  type GuidedListStep,
  type GuidedLocationAnswer,
  type GuidedLocationStep,
  type GuidedNumberStep,
  type GuidedOption,
  type GuidedOutput,
  type GuidedPending,
  type GuidedPhotosStep,
  type GuidedPlace,
  type GuidedResolver,
  type GuidedScalar,
  type GuidedSnapshot,
  type GuidedState,
  type GuidedStep,
  type GuidedSummaryStep,
  type GuidedTemplate,
  type GuidedTextStep,
  type GuidedTexts,
} from "./guided.js";

export {
  CHANNELS,
  invitationVariables,
  parseForm,
  previewInvitation,
  templateForMeta,
  validateForm,
  type FormIssue,
} from "./form.js";
