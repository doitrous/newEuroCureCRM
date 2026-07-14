/**
 * In-memory `MetaStore`, used by the ingestion test suite.
 *
 * It models the parts of the real schema the rules depend on — unique keys,
 * the unread/SLA columns on `leads`, delivery-status monotonicity — so a test
 * that passes here is testing the rules, not a stub that agrees with them.
 */

import type {
  AttributionTouch,
  AuditInsert,
  CommentInsert,
  ConversationEventInsert,
  ConversationRef,
  ConversationUpsert,
  IngestLogInsert,
  LeadCreate,
  LeadRef,
  PatientSourceApplication,
  MessageInsert,
  MetaStore,
  ReactionInsert,
  StoredComment,
  StoredMessage,
  TimelineInsert,
} from "./store";
import type { Attachment, Platform } from "./types";
import { effectivePatientSourceId, type PatientSourceId } from "@/lib/patient-source/catalog";

export interface MemLead extends LeadRef {
  platform: string;
  platformUserId: string;
  conversationKey: string | null;
  name: string | null;
  hasUnread: boolean;
  unreadSince: string | null;
  unreadMessageCount: number;
  lastIncomingAt: string | null;
  lastOutgoingAt: string | null;
  lastHandledAt: string | null;
  replyOverdueAt: string | null;
  campaign: string | null;
  adName: string | null;
  patientSourceKey: string | null;
  tags: string[];
}

export interface MemAttribution {
  leadId: string;
  firstCampaign: string | null;
  firstAdId: string | null;
  firstAdName: string | null;
  firstSource: string | null;
  firstReferralCode: string | null;
  firstTouchAt: string | null;
  latestCampaign: string | null;
  latestAdId: string | null;
  latestAdName: string | null;
  latestSource: string | null;
  latestTouchAt: string | null;
  touchCount: number;
}

/** Minutes a moderator has to reply before an unanswered lead is overdue. */
export const REPLY_SLA_MINUTES = 30;

let counter = 0;
const id = (p: string) => `${p}_${++counter}`;

export function resetIds(): void {
  counter = 0;
}

export class MemoryStore implements MetaStore {
  leads: MemLead[] = [];
  conversations: (ConversationUpsert & { id: string })[] = [];
  messages: (MessageInsert & { id: string; editCount: number; deliveredAt: string | null; seenAt: string | null; editedAt: string | null })[] = [];
  attachments: (Attachment & { messageId: string })[] = [];
  commentAttachments: (Attachment & { commentId: string })[] = [];
  reactions: ReactionInsert[] = [];
  messageEdits: { messageId: string; editCount: number; previousText: string | null; newText: string | null; editedAt: string }[] = [];
  conversationEvents: ConversationEventInsert[] = [];
  comments: (CommentInsert & { id: string; editCount: number; deletedAt: string | null })[] = [];
  commentEdits: { commentId: string; revision: number; previousText: string | null; newText: string | null; changeType: string }[] = [];
  attribution: MemAttribution[] = [];
  timeline: TimelineInsert[] = [];
  audit: AuditInsert[] = [];
  logs: IngestLogInsert[] = [];
  sourceApplications: (PatientSourceApplication & { incomingSourceKey: string; effectiveSourceKey: string })[] = [];

  async applyPatientSource(input: PatientSourceApplication, incomingSourceKey: string): Promise<string> {
    const lead = input.leadId ? this.leads.find((item) => item.id === input.leadId) : null;
    const effectiveSourceKey = effectivePatientSourceId(
      lead?.patientSourceKey as PatientSourceId | null | undefined,
      incomingSourceKey as PatientSourceId,
    );
    if (lead) {
      lead.patientSourceKey = effectiveSourceKey;
      lead.tags = [effectiveSourceKey === "dr_ahmad_ghait" ? "Dr. Ahmad Ghait" : "EuroCure"];
    }
    this.sourceApplications.push({ ...input, incomingSourceKey, effectiveSourceKey });
    return effectiveSourceKey;
  }

  /* ── leads ─────────────────────────────────────────────────────────── */

  async findLeadByPlatformUser(platform: Platform, platformUserId: string): Promise<LeadRef | null> {
    return this.leads.find((l) => l.platform === platform && l.platformUserId === platformUserId) ?? null;
  }

  async findLeadByConversationKey(conversationKey: string): Promise<LeadRef | null> {
    return this.leads.find((l) => l.conversationKey === conversationKey) ?? null;
  }

  async createLead(input: LeadCreate): Promise<LeadRef> {
    const lead: MemLead = {
      id: id("lead"),
      leadCode: `L${String(this.leads.length + 1).padStart(4, "0")}`,
      platform: input.platform,
      platformUserId: input.platformUserId,
      conversationKey: input.conversationKey,
      name: input.name,
      hasUnread: false,
      unreadSince: null,
      unreadMessageCount: 0,
      lastIncomingAt: null,
      lastOutgoingAt: null,
      lastHandledAt: null,
      replyOverdueAt: null,
      campaign: input.campaign,
      adName: input.adName,
      patientSourceKey: null,
      tags: [],
    };
    this.leads.push(lead);
    return lead;
  }

  async markLeadIncoming(leadId: string, at: string): Promise<void> {
    const lead = this.leads.find((l) => l.id === leadId);
    if (!lead) return;
    // The SLA clock starts on the FIRST unanswered message and is not reset by
    // follow-up messages from the same patient — otherwise a chatty patient
    // could indefinitely postpone their own overdue flag.
    if (!lead.hasUnread) {
      lead.unreadSince = at;
      lead.replyOverdueAt = new Date(new Date(at).getTime() + REPLY_SLA_MINUTES * 60_000).toISOString();
    }
    lead.hasUnread = true;
    lead.unreadMessageCount += 1;
    if (!lead.lastIncomingAt || at > lead.lastIncomingAt) lead.lastIncomingAt = at;
  }

  async markLeadOutgoing(leadId: string, at: string): Promise<void> {
    const lead = this.leads.find((l) => l.id === leadId);
    if (!lead) return;
    lead.hasUnread = false;
    lead.unreadSince = null;
    lead.unreadMessageCount = 0;
    lead.replyOverdueAt = null;
    lead.lastHandledAt = at;
    if (!lead.lastOutgoingAt || at > lead.lastOutgoingAt) lead.lastOutgoingAt = at;
  }

  /* ── conversations ─────────────────────────────────────────────────── */

  async upsertConversation(input: ConversationUpsert): Promise<ConversationRef> {
    const match = this.conversations.find(
      (c) =>
        (input.conversationKey && c.conversationKey === input.conversationKey) ||
        (!input.conversationKey &&
          c.platform === input.platform &&
          !!input.platformUserId &&
          c.platformUserId === input.platformUserId),
    );
    if (match) {
      if (input.leadId && !match.leadId) match.leadId = input.leadId;
      return { id: match.id, leadId: match.leadId };
    }
    const row = { ...input, id: id("conv") };
    this.conversations.push(row);
    return { id: row.id, leadId: row.leadId };
  }

  async touchConversation(): Promise<void> {
    /* watermarks are not asserted in the rule tests */
  }

  /* ── messages ──────────────────────────────────────────────────────── */

  private toStored(m: (typeof this.messages)[number]): StoredMessage {
    return {
      id: m.id,
      leadId: m.leadId,
      conversationId: m.conversationId,
      platform: m.platform,
      platformMessageId: m.platformMessageId,
      direction: m.direction,
      messageAt: m.messageAt,
      text: m.text,
      editCount: m.editCount,
      deliveryStatus: m.deliveryStatus,
    };
  }

  async findMessageByPlatformId(platform: Platform, platformMessageId: string): Promise<StoredMessage | null> {
    const m = this.messages.find((x) => x.platform === platform && x.platformMessageId === platformMessageId);
    return m ? this.toStored(m) : null;
  }

  async findMessageByEventKey(eventKey: string): Promise<StoredMessage | null> {
    const m = this.messages.find((x) => x.eventKey === eventKey);
    return m ? this.toStored(m) : null;
  }

  async insertMessage(row: MessageInsert): Promise<{ message: StoredMessage; created: boolean }> {
    const dup =
      this.messages.find((x) => x.eventKey === row.eventKey) ??
      (row.platformMessageId
        ? this.messages.find((x) => x.platform === row.platform && x.platformMessageId === row.platformMessageId)
        : undefined);
    if (dup) return { message: this.toStored(dup), created: false };

    const stored = { ...row, id: id("msg"), editCount: 0, deliveredAt: null, seenAt: null, editedAt: null };
    this.messages.push(stored);
    return { message: this.toStored(stored), created: true };
  }

  async updateMessageText(messageId: string, text: string, editCount: number, editedAt: string): Promise<void> {
    const m = this.messages.find((x) => x.id === messageId);
    if (!m) return;
    m.text = text;
    m.editCount = editCount;
    m.editedAt = editedAt;
  }

  async setAttachments(messageId: string, attachments: Attachment[]): Promise<void> {
    this.attachments = this.attachments.filter((a) => a.messageId !== messageId);
    for (const a of attachments) this.attachments.push({ ...a, messageId });
  }

  async recordMessageEdit(input: {
    messageId: string;
    editCount: number;
    previousText: string | null;
    newText: string | null;
    editedAt: string;
  }): Promise<boolean> {
    const dup = this.messageEdits.find((e) => e.messageId === input.messageId && e.editCount === input.editCount);
    if (dup) return false;
    this.messageEdits.push({ ...input });
    return true;
  }

  /** Delivery status only ever moves forward: sent → delivered → seen. */
  private advance(m: (typeof this.messages)[number], state: "delivered" | "seen", at: string): boolean {
    if (m.direction !== "outgoing") return false;
    if (m.deliveryStatus === "seen") return false;
    if (state === "delivered" && m.deliveryStatus === "delivered") return false;
    m.deliveryStatus = state;
    if (state === "delivered") m.deliveredAt = at;
    else m.seenAt = at;
    return true;
  }

  async markMessagesDelivered(platform: Platform, messageIds: string[], at: string): Promise<number> {
    let n = 0;
    for (const m of this.messages) {
      if (m.platform === platform && m.platformMessageId && messageIds.includes(m.platformMessageId)) {
        if (this.advance(m, "delivered", at)) n++;
      }
    }
    return n;
  }

  async markMessagesSeen(platform: Platform, messageIds: string[], at: string): Promise<number> {
    let n = 0;
    for (const m of this.messages) {
      if (m.platform === platform && m.platformMessageId && messageIds.includes(m.platformMessageId)) {
        if (this.advance(m, "seen", at)) n++;
      }
    }
    return n;
  }

  async markOutgoingBeforeWatermark(
    conversationId: string | null,
    leadId: string | null,
    platform: Platform,
    watermark: string,
    state: "delivered" | "seen",
  ): Promise<number> {
    let n = 0;
    for (const m of this.messages) {
      if (m.platform !== platform || m.direction !== "outgoing") continue;
      if (conversationId && m.conversationId !== conversationId) continue;
      if (!conversationId && leadId && m.leadId !== leadId) continue;
      // Strictly "sent at or before the watermark".
      if (m.messageAt > watermark) continue;
      if (this.advance(m, state, watermark)) n++;
    }
    return n;
  }

  /* ── reactions ─────────────────────────────────────────────────────── */

  async recordReaction(input: ReactionInsert): Promise<boolean> {
    if (this.reactions.some((r) => r.eventKey === input.eventKey)) return false;
    this.reactions.push({ ...input });
    return true;
  }

  async deactivateReactions(platform: Platform, targetMessageId: string, actor: string | null): Promise<void> {
    for (const r of this.reactions) {
      if (
        r.platform === platform &&
        r.targetMessageId === targetMessageId &&
        r.actorPlatformUserId === actor &&
        r.reactionAction === "react"
      ) {
        r.isActive = false;
      }
    }
  }

  /** Reactions currently displayed on a message bubble. */
  activeReactions(targetMessageId: string): ReactionInsert[] {
    return this.reactions.filter((r) => r.targetMessageId === targetMessageId && r.isActive);
  }

  /* ── non-content events ────────────────────────────────────────────── */

  async insertConversationEvent(row: ConversationEventInsert): Promise<boolean> {
    if (this.conversationEvents.some((e) => e.eventKey === row.eventKey)) return false;
    this.conversationEvents.push({ ...row });
    return true;
  }

  /* ── comments ──────────────────────────────────────────────────────── */

  private toStoredComment(c: (typeof this.comments)[number]): StoredComment {
    return { id: c.id, leadId: c.leadId, commentId: c.commentId, text: c.text, editCount: c.editCount, isDeleted: c.isDeleted };
  }

  async findCommentByPlatformId(platform: Platform, commentId: string): Promise<StoredComment | null> {
    const c = this.comments.find((x) => x.platform === platform && x.commentId === commentId);
    return c ? this.toStoredComment(c) : null;
  }

  async findCommentByEventKey(eventKey: string): Promise<StoredComment | null> {
    const c = this.comments.find((x) => x.eventKey === eventKey);
    return c ? this.toStoredComment(c) : null;
  }

  async insertComment(row: CommentInsert): Promise<{ comment: StoredComment; created: boolean }> {
    const dup =
      this.comments.find((x) => x.eventKey === row.eventKey) ??
      (row.commentId ? this.comments.find((x) => x.platform === row.platform && x.commentId === row.commentId) : undefined);
    if (dup) return { comment: this.toStoredComment(dup), created: false };

    const stored = { ...row, id: id("cmt"), editCount: 0, deletedAt: null };
    this.comments.push(stored);
    return { comment: this.toStoredComment(stored), created: true };
  }

  async updateComment(
    commentId: string,
    patch: { text?: string | null; isEdited?: boolean; isDeleted?: boolean; deletedAt?: string | null; editCount?: number },
  ): Promise<void> {
    const c = this.comments.find((x) => x.id === commentId);
    if (!c) return;
    if (patch.text !== undefined) c.text = patch.text;
    if (patch.isEdited !== undefined) c.isEdited = patch.isEdited;
    if (patch.isDeleted !== undefined) c.isDeleted = patch.isDeleted;
    if (patch.deletedAt !== undefined) c.deletedAt = patch.deletedAt;
    if (patch.editCount !== undefined) c.editCount = patch.editCount;
  }

  async setCommentAttachments(commentId: string, attachments: Attachment[]): Promise<void> {
    this.commentAttachments = this.commentAttachments.filter((a) => a.commentId !== commentId);
    for (const a of attachments) this.commentAttachments.push({ ...a, commentId });
  }

  async recordCommentEdit(input: {
    commentId: string;
    revision: number;
    previousText: string | null;
    newText: string | null;
    changeType: "updated" | "deleted";
  }): Promise<boolean> {
    const dup = this.commentEdits.find((e) => e.commentId === input.commentId && e.revision === input.revision);
    if (dup) return false;
    this.commentEdits.push({ ...input });
    return true;
  }

  /* ── attribution / timeline / audit / logs ─────────────────────────── */

  async applyAttribution(touch: AttributionTouch): Promise<{ firstTouch: boolean }> {
    let row = this.attribution.find((a) => a.leadId === touch.leadId);
    if (!row) {
      row = {
        leadId: touch.leadId,
        firstCampaign: null,
        firstAdId: null,
        firstAdName: null,
        firstSource: null,
        firstReferralCode: null,
        firstTouchAt: null,
        latestCampaign: null,
        latestAdId: null,
        latestAdName: null,
        latestSource: null,
        latestTouchAt: null,
        touchCount: 0,
      };
      this.attribution.push(row);
    }

    // First touch is written exactly once and never overwritten.
    const firstTouch = row.firstTouchAt === null;
    if (firstTouch) {
      row.firstCampaign = touch.campaign;
      row.firstAdId = touch.adId;
      row.firstAdName = touch.adName;
      row.firstSource = touch.referralSource ?? touch.source;
      row.firstReferralCode = touch.referralCode;
      row.firstTouchAt = touch.touchedAt;
    }
    row.latestCampaign = touch.campaign;
    row.latestAdId = touch.adId;
    row.latestAdName = touch.adName;
    row.latestSource = touch.referralSource ?? touch.source;
    row.latestTouchAt = touch.touchedAt;
    row.touchCount += 1;
    return { firstTouch };
  }

  async addTimelineEvent(input: TimelineInsert): Promise<void> {
    this.timeline.push(input);
  }

  async addAuditLog(input: AuditInsert): Promise<void> {
    this.audit.push(input);
  }

  async log(entry: IngestLogInsert): Promise<void> {
    this.logs.push(entry);
  }

  /* ── test helpers ──────────────────────────────────────────────────── */

  lead(id: string): MemLead | undefined {
    return this.leads.find((l) => l.id === id);
  }

  contentMessages(): typeof this.messages {
    return this.messages.filter((m) => m.isConversationContent);
  }
}
