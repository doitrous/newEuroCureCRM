/**
 * The storage contract the ingestion pipeline writes through.
 *
 * `persist.ts` contains all the RULES (what may create a lead, what may mark a
 * conversation unread, what is a duplicate). This interface contains only the
 * MECHANICS. Splitting them means the rules can be exercised exhaustively in
 * tests against an in-memory store, with no database and no network.
 *
 * Every `find*` returns `null` when absent. Every `insert*` that can race with a
 * webhook retry returns the existing row instead of throwing, so the pipeline is
 * idempotent even under concurrent redelivery.
 */

import type { Attachment, Direction, IdentityConfidence, Platform } from "./types";

export interface LeadRef {
  id: string;
  leadCode: string;
}

export interface PatientSourceApplication {
  eventKey: string;
  leadId: string | null;
  messageId: string | null;
  commentId: string | null;
}

export interface ConversationRef {
  id: string;
  leadId: string | null;
}

export interface StoredMessage {
  id: string;
  leadId: string | null;
  conversationId: string | null;
  platform: string;
  platformMessageId: string | null;
  direction: Direction;
  messageAt: string;
  text: string | null;
  editCount: number;
  deliveryStatus: "sent" | "delivered" | "seen" | null;
}

export interface StoredComment {
  id: string;
  leadId: string | null;
  commentId: string | null;
  text: string | null;
  editCount: number;
  isDeleted: boolean;
}

export interface MessageInsert {
  leadId: string | null;
  conversationId: string | null;
  eventKey: string;
  platform: Platform;
  source: string | null;
  recordType: string;
  eventType: string;
  eventAction: string | null;
  direction: Direction;
  isConversationContent: boolean;
  text: string | null;
  messageType: string | null;
  platformMessageId: string | null;
  messageAt: string;
  identityConfidence: IdentityConfidence;
  platformUserId: string | null;
  senderId: string | null;
  recipientId: string | null;
  senderName: string | null;
  senderUsername: string | null;
  senderPhone: string | null;
  sentByType: string | null;
  sentByName: string | null;
  isEcho: boolean;
  isDeleted: boolean;
  isUnsupported: boolean;
  pageId: string | null;
  recipientPageId: string | null;
  instagramAccountId: string | null;
  customerPsid: string | null;
  customerInstagramId: string | null;
  conversationKey: string | null;
  chatLink: string | null;
  conversationLink: string | null;
  fallbackInboxLink: string | null;
  pageInboxLink: string | null;
  attachmentCount: number;
  attachmentUrl: string | null;
  quickReplyPayload: string | null;
  quickReplyText: string | null;
  postbackPayload: string | null;
  postbackTitle: string | null;
  replyToMessageId: string | null;
  replyTo: unknown;
  deliveryStatus: "sent" | "delivered" | "seen" | null;
  facebookAppId: string | null;
  campaign: string | null;
  adId: string | null;
  adName: string | null;
  referralSource: string | null;
  referralType: string | null;
  referralCode: string | null;
  referral: unknown;
  messageMetadata: unknown;
  webhookObject: string | null;
  webhookEventKeys: unknown;
  service: string | null;
  doctor: string | null;
  branch: string | null;
  rawPayload: unknown;
}

export interface CommentInsert {
  leadId: string | null;
  eventKey: string;
  platform: Platform;
  source: string | null;
  recordType: string;
  eventType: string;
  eventAction: string;
  commentId: string | null;
  parentCommentId: string | null;
  rawParentId: string | null;
  threadRootCommentId: string | null;
  threadRole: string;
  isReply: boolean;
  postId: string | null;
  mediaId: string | null;
  text: string | null;
  commentAt: string;
  direction: Direction;
  isPageOrBusinessReply: boolean;
  identityConfidence: IdentityConfidence;
  platformUserId: string | null;
  commenterId: string | null;
  commenterUsername: string | null;
  commenterName: string | null;
  pageId: string | null;
  instagramAccountId: string | null;
  conversationKey: string | null;
  commentThreadKey: string | null;
  messageType: string | null;
  commentType: string | null;
  facebookVerb: string | null;
  eventSourceField: string | null;
  isEdited: boolean;
  isDeleted: boolean;
  commentLink: string | null;
  fallbackInboxLink: string | null;
  mediaPermalink: string | null;
  mediaCaption: string | null;
  mediaType: string | null;
  mediaProductType: string | null;
  attachmentCount: number;
  attachmentUrl: string | null;
  campaign: string | null;
  adId: string | null;
  adName: string | null;
  webhookObject: string | null;
  webhookChangeField: string | null;
  rawPayload: unknown;
}

export interface ConversationUpsert {
  leadId: string | null;
  platform: Platform;
  source: string | null;
  conversationKey: string | null;
  platformUserId: string | null;
  identityConfidence: IdentityConfidence;
  pageId: string | null;
  instagramAccountId: string | null;
  customerPsid: string | null;
  customerInstagramId: string | null;
  chatLink: string | null;
  conversationLink: string | null;
  fallbackInboxLink: string | null;
  pageInboxLink: string | null;
  rawPayload: unknown;
}

export interface LeadCreate {
  platform: Platform;
  platformUserId: string;
  name: string | null;
  conversationKey: string | null;
  chatLink: string | null;
  pageId: string | null;
  instagramAccountId: string | null;
  conversationLink: string | null;
  fallbackInboxLink: string | null;
  pageInboxLink: string | null;
  firstContactAt: string;
  campaign: string | null;
  adName: string | null;
}

export interface ConversationEventInsert {
  leadId: string | null;
  conversationId: string | null;
  eventKey: string;
  platform: Platform;
  source: string | null;
  recordType: string;
  eventType: string;
  eventAction: string | null;
  pageId: string | null;
  instagramAccountId: string | null;
  platformUserId: string | null;
  identityConfidence: IdentityConfidence;
  conversationKey: string | null;
  direction: Direction | null;
  statusForDirection: Direction | null;
  targetMessageId: string | null;
  deliveredMessageIds: string[];
  statusWatermark: string | null;
  referralSource: string | null;
  referralType: string | null;
  referralCode: string | null;
  campaign: string | null;
  adId: string | null;
  adName: string | null;
  referral: unknown;
  webhookObject: string | null;
  webhookEventKeys: unknown;
  eventAt: string;
  rawPayload: unknown;
}

export interface ReactionInsert {
  messageId: string | null;
  targetMessageId: string;
  platform: Platform;
  actorPlatformUserId: string | null;
  reactionAction: string;
  reactionType: string | null;
  reactionEmoji: string | null;
  reactedAt: string;
  isActive: boolean;
  eventKey: string;
  rawPayload: unknown;
}

export interface AttributionTouch {
  leadId: string;
  source: string | null;
  campaign: string | null;
  adId: string | null;
  adName: string | null;
  referralSource: string | null;
  referralType: string | null;
  referralCode: string | null;
  referral: unknown;
  touchedAt: string;
}

export interface TimelineInsert {
  leadId: string;
  eventType: string;
  title: string;
  body: string | null;
  metadata: unknown;
  eventAt: string;
}

export interface AuditInsert {
  action: string;
  entityType: string;
  entityId: string;
  oldValues: unknown;
  newValues: unknown;
  metadata: unknown;
  /** Ingestion has no human actor — the source records that it was the webhook. */
  source: string;
}

export interface IngestLogInsert {
  source: string | null;
  platform: string;
  recordType: string;
  eventType: string;
  eventAction: string | null;
  eventKey: string;
  pageId: string | null;
  platformUserId: string | null;
  conversationKey: string | null;
  commentId: string | null;
  commentThreadKey: string | null;
  platformMessageId: string | null;
  messageId: string | null;
  leadId: string | null;
  direction: string | null;
  messageText: string | null;
  created: boolean;
  updated: boolean;
  skipped: boolean;
  skipReason: string | null;
  matchReason: string | null;
  errors: unknown;
  rawPayload: unknown;
}

export interface MetaStore {
  /**
   * Reconciles a canonical patient source after an event has been persisted.
   * Existing lead/patient sources win; missing sources are filled, canonical
   * tags are synchronized, and event rows receive the effective source key.
   */
  applyPatientSource(input: PatientSourceApplication, incomingSourceKey: string): Promise<string>;

  // ── leads ──────────────────────────────────────────────────────────────
  findLeadByPlatformUser(platform: Platform, platformUserId: string): Promise<LeadRef | null>;
  findLeadByConversationKey(conversationKey: string): Promise<LeadRef | null>;
  createLead(input: LeadCreate): Promise<LeadRef>;
  /** Applies the unread/SLA transition for a genuine incoming message. */
  markLeadIncoming(leadId: string, at: string, messageId: string | null): Promise<void>;
  /** Clears unread/SLA because the clinic replied. */
  markLeadOutgoing(leadId: string, at: string): Promise<void>;

  // ── conversations ──────────────────────────────────────────────────────
  upsertConversation(input: ConversationUpsert): Promise<ConversationRef>;
  touchConversation(
    id: string,
    patch: { lastMessageAt?: string; lastIncomingAt?: string; lastOutgoingAt?: string; lastDeliveredAt?: string; lastSeenAt?: string },
  ): Promise<void>;

  // ── messages ───────────────────────────────────────────────────────────
  findMessageByPlatformId(platform: Platform, platformMessageId: string): Promise<StoredMessage | null>;
  findMessageByEventKey(eventKey: string): Promise<StoredMessage | null>;
  /** Idempotent: returns `{message, created:false}` if `eventKey` already exists. */
  insertMessage(row: MessageInsert): Promise<{ message: StoredMessage; created: boolean }>;
  updateMessageText(id: string, text: string, editCount: number, editedAt: string): Promise<void>;
  setAttachments(messageId: string, attachments: Attachment[]): Promise<void>;
  /** Returns false when this exact revision was already recorded. */
  recordMessageEdit(input: {
    messageId: string;
    editCount: number;
    previousText: string | null;
    newText: string | null;
    editedAt: string;
    rawPayload: unknown;
  }): Promise<boolean>;

  /** Advance an outgoing message's lifecycle. Never moves backwards. */
  markMessagesDelivered(platform: Platform, messageIds: string[], at: string): Promise<number>;
  markMessagesSeen(platform: Platform, messageIds: string[], at: string): Promise<number>;
  /**
   * Watermark semantics: every OUTGOING message in the conversation sent at or
   * before `watermark` reaches the given state. Messages newer than the
   * watermark must not be touched.
   */
  markOutgoingBeforeWatermark(
    conversationId: string | null,
    leadId: string | null,
    platform: Platform,
    watermark: string,
    state: "delivered" | "seen",
  ): Promise<number>;

  // ── reactions ──────────────────────────────────────────────────────────
  /** Returns false when the event key was already recorded (webhook retry). */
  recordReaction(input: ReactionInsert): Promise<boolean>;
  /** Flip prior active reactions off when an `unreact` arrives. */
  deactivateReactions(platform: Platform, targetMessageId: string, actorPlatformUserId: string | null): Promise<void>;

  // ── non-content events ─────────────────────────────────────────────────
  /** Returns false when the event key was already recorded (webhook retry). */
  insertConversationEvent(row: ConversationEventInsert): Promise<boolean>;

  // ── comments ───────────────────────────────────────────────────────────
  findCommentByPlatformId(platform: Platform, commentId: string): Promise<StoredComment | null>;
  findCommentByEventKey(eventKey: string): Promise<StoredComment | null>;
  insertComment(row: CommentInsert): Promise<{ comment: StoredComment; created: boolean }>;
  updateComment(
    id: string,
    patch: { text?: string | null; isEdited?: boolean; isDeleted?: boolean; deletedAt?: string | null; editCount?: number },
  ): Promise<void>;
  setCommentAttachments(commentId: string, attachments: Attachment[]): Promise<void>;
  recordCommentEdit(input: {
    commentId: string;
    revision: number;
    previousText: string | null;
    newText: string | null;
    changeType: "updated" | "deleted";
    editedAt: string;
    rawPayload: unknown;
  }): Promise<boolean>;

  // ── attribution / timeline / audit / logs ──────────────────────────────
  applyAttribution(touch: AttributionTouch): Promise<{ firstTouch: boolean }>;
  addTimelineEvent(input: TimelineInsert): Promise<void>;
  addAuditLog(input: AuditInsert): Promise<void>;
  log(entry: IngestLogInsert): Promise<void>;
}
