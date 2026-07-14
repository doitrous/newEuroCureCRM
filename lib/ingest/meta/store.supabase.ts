import "server-only";

import { supabaseAdmin } from "@/lib/supabase/server";
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
  MessageInsert,
  MetaStore,
  PatientSourceApplication,
  ReactionInsert,
  StoredComment,
  StoredMessage,
  TimelineInsert,
} from "./store";
import type { Attachment, Direction, Platform } from "./types";

/**
 * The service-role `MetaStore`. Mechanics only — every rule about what may
 * create a lead or move an unread flag lives in `persist.ts`.
 *
 * Two things here are load-bearing and easy to break:
 *
 *  - **Platform values.** `leads.platform` is a Postgres enum whose members are
 *    `facebook_messenger | instagram | manual | whatsapp`. The canonical value
 *    inside the ingestion pipeline is `facebook`, so it is translated on the way
 *    to the database and never on the way back (the read layer already accepts
 *    both spellings).
 *  - **Unread / SLA.** No trigger maintains these columns; the application does.
 *    `markLeadIncoming` / `markLeadOutgoing` are the only places that write them
 *    for Meta traffic, mirroring what `/api/ingest/reservation` does for
 *    bookings.
 */

type Db = ReturnType<typeof supabaseAdmin>;

const LEADS = "leads";
const MESSAGES = "crm_messages";
const CONVERSATIONS = "crm_conversations";
const COMMENTS = "crm_comments";

/** Compatibility fallback when a stage rule has not been configured. */
const DEFAULT_REPLY_SLA_MINUTES = 30;

/** Canonical pipeline platform → the value stored in the database. */
function dbPlatform(platform: Platform): string {
  return platform === "facebook" ? "facebook_messenger" : "instagram";
}

/** A Postgres unique-violation. Under a webhook retry this is the expected path. */
function isUniqueViolation(error: { code?: string } | null): boolean {
  return error?.code === "23505";
}

function addMinutes(iso: string, minutes: number): string {
  return new Date(new Date(iso).getTime() + minutes * 60_000).toISOString();
}

/** `lead_sources.id` for a platform, resolved once per process. */
const sourceIdCache = new Map<string, string | null>();

async function leadSourceId(db: Db, platform: Platform): Promise<string | null> {
  const key = dbPlatform(platform);
  const cached = sourceIdCache.get(key);
  if (cached !== undefined) return cached;

  const { data } = await db.from("lead_sources").select("id").eq("key", key).maybeSingle();
  const id = (data?.id as string | undefined) ?? null;
  sourceIdCache.set(key, id);
  return id;
}

export class SupabaseMetaStore implements MetaStore {
  private db: Db;

  constructor(db: Db = supabaseAdmin()) {
    this.db = db;
  }

  async applyPatientSource(input: PatientSourceApplication, incomingSourceKey: string): Promise<string> {
    let effectiveSourceKey = incomingSourceKey;
    if (input.leadId) {
      const { data, error } = await this.db.rpc("crm_apply_patient_source", {
        target_lead_id: input.leadId,
        incoming_source_key: incomingSourceKey,
        source_context: { event_key: input.eventKey, ingestion: "meta" },
      });
      if (error) throw new Error(`applyPatientSource: ${error.message}`);
      if (data) effectiveSourceKey = String(data);
    }

    const updates: PromiseLike<unknown>[] = [];
    if (input.messageId) {
      updates.push(this.db.from(MESSAGES).update({ patient_source_key: effectiveSourceKey }).eq("id", input.messageId));
    }
    if (input.commentId) {
      updates.push(this.db.from(COMMENTS).update({ patient_source_key: effectiveSourceKey }).eq("id", input.commentId));
    }
    if (input.leadId) {
      updates.push(this.db.from(CONVERSATIONS).update({ patient_source_key: effectiveSourceKey }).eq("lead_id", input.leadId));
    }
    updates.push(this.db.from("crm_ingest_logs").update({ patient_source_key: effectiveSourceKey }).eq("event_key", input.eventKey));
    updates.push(this.db.from("crm_conversation_events").update({ patient_source_key: effectiveSourceKey }).eq("event_key", input.eventKey));

    const results = await Promise.all(updates);
    const failed = results.find((result) => {
      const candidate = result as { error?: { message?: string } | null };
      return Boolean(candidate.error);
    }) as { error?: { message?: string } | null } | undefined;
    if (failed?.error) throw new Error(`applyPatientSource(event rows): ${failed.error.message || "update failed"}`);
    return effectiveSourceKey;
  }

  /* ── leads ─────────────────────────────────────────────────────────── */

  async findLeadByPlatformUser(platform: Platform, platformUserId: string): Promise<LeadRef | null> {
    const { data } = await this.db
      .from(LEADS)
      .select("id, lead_id")
      .eq("platform", dbPlatform(platform))
      .eq("platform_id", platformUserId)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    return data ? { id: data.id as string, leadCode: data.lead_id as string } : null;
  }

  async findLeadByConversationKey(conversationKey: string): Promise<LeadRef | null> {
    const { data } = await this.db
      .from(LEADS)
      .select("id, lead_id")
      .eq("conversation_key", conversationKey)
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();
    if (data) return { id: data.id as string, leadCode: data.lead_id as string };

    // The conversation may exist and already point at a lead even when the lead
    // itself never stored the key.
    const { data: conv } = await this.db
      .from(CONVERSATIONS)
      .select("lead_id")
      .eq("conversation_key", conversationKey)
      .not("lead_id", "is", null)
      .limit(1)
      .maybeSingle();
    if (!conv?.lead_id) return null;

    const { data: lead } = await this.db
      .from(LEADS)
      .select("id, lead_id")
      .eq("id", conv.lead_id)
      .maybeSingle();
    return lead ? { id: lead.id as string, leadCode: lead.lead_id as string } : null;
  }

  /** Next sequential lead code. Prefers the database's own generator. */
  private async nextLeadCode(): Promise<string> {
    const { data, error } = await this.db.rpc("crm_generate_lead_id");
    if (!error && typeof data === "string" && data) return data;

    const { data: last } = await this.db
      .from(LEADS)
      .select("lead_id")
      .order("lead_id", { ascending: false })
      .limit(1)
      .maybeSingle();
    const prev = last?.lead_id as string | undefined;
    const n = prev && /^L\d+$/.test(prev) ? Number(prev.slice(1)) + 1 : 1;
    return `L${String(n).padStart(4, "0")}`;
  }

  async createLead(input: LeadCreate): Promise<LeadRef> {
    const now = new Date().toISOString();
    const sourceId = await leadSourceId(this.db, input.platform);

    // Reuse the CRM's own identifier normalisation so duplicate detection sees
    // the same normalised value it would for a manually created lead.
    let normalizedPlatformId: string | null = null;
    const { data: normalized, error: normalizeError } = await this.db.rpc("crm_normalize_text_identifier", {
      value: input.platformUserId,
    });
    if (!normalizeError && typeof normalized === "string") normalizedPlatformId = normalized;

    const row = {
      lead_id: await this.nextLeadCode(),
      name: input.name ?? "Unknown",
      status: "new_lead",
      platform: dbPlatform(input.platform),
      platform_id: input.platformUserId,
      normalized_platform_id: normalizedPlatformId,
      source_id: sourceId,
      escalation_status: "none",
      conversation_key: input.conversationKey,
      chat_link: input.chatLink,
      conversation_link: input.conversationLink,
      fallback_inbox_link: input.fallbackInboxLink,
      page_inbox_link: input.pageInboxLink,
      page_id: input.pageId,
      instagram_account_id: input.instagramAccountId,
      campaign: input.campaign,
      ad_name: input.adName,
      first_contact_at: input.firstContactAt,
      // Unread is applied by `markLeadIncoming`, not here: a lead created by a
      // referral has nothing unread to answer.
      has_unread: false,
      unread_message_count: 0,
      created_at: now,
      updated_at: now,
    };

    const { data, error } = await this.db.from(LEADS).insert(row).select("id, lead_id").single();

    if (error) {
      // Two webhook deliveries for the same new user can race. The loser reads
      // the winner's row rather than failing the request.
      if (isUniqueViolation(error)) {
        const existing = await this.findLeadByPlatformUser(input.platform, input.platformUserId);
        if (existing) return existing;
      }
      throw new Error(`createLead: ${error.message}`);
    }

    const lead = { id: data.id as string, leadCode: data.lead_id as string };

    // Hand the new lead to the CRM's existing duplicate detector rather than
    // inventing a second one. A failure here must not fail ingestion.
    await this.db.rpc("crm_flag_duplicate_for_lead", { target_lead_id: lead.id }).then(
      () => undefined,
      () => undefined,
    );

    await this.db.from("lead_timeline_events").insert({
      lead_id: lead.id,
      event_type: "lead_created",
      title: `Lead created from ${input.platform === "instagram" ? "Instagram" : "Facebook"}`,
      body: input.name,
      metadata: { platform_user_id: input.platformUserId, source: "meta_webhook" },
      event_at: input.firstContactAt,
    });

    return lead;
  }

  async markLeadIncoming(leadId: string, at: string, messageId: string | null): Promise<void> {
    const { data: lead } = await this.db
      .from(LEADS)
      .select("has_unread, unread_message_count, unread_since, last_incoming_at, status")
      .eq("id", leadId)
      .maybeSingle();
    if (!lead) return;

    const wasUnread = Boolean(lead.has_unread);
    const count = (lead.unread_message_count as number | null) ?? 0;
    const lastIncoming = lead.last_incoming_at as string | null;

    // The SLA clock starts at the FIRST unanswered message. A patient sending
    // three messages in a row must not keep pushing their own deadline out.
    const unreadSince = wasUnread ? ((lead.unread_since as string | null) ?? at) : at;
    const { data: rule } = await this.db
      .from("crm_stage_reply_rules")
      .select("reply_deadline_minutes")
      .eq("stage_key", String(lead.status ?? "new_lead"))
      .eq("is_active", true)
      .maybeSingle();
    const replyDeadlineMinutes = Math.max(1, Number(rule?.reply_deadline_minutes ?? DEFAULT_REPLY_SLA_MINUTES));

    await this.db
      .from(LEADS)
      .update({
        has_unread: true,
        unread_since: unreadSince,
        unread_message_count: count + 1,
        last_unread_message_id: messageId,
        last_incoming_at: !lastIncoming || at > lastIncoming ? at : lastIncoming,
        reply_overdue_at: addMinutes(unreadSince, replyDeadlineMinutes),
        is_reply_overdue: false,
        updated_at: new Date().toISOString(),
      })
      .eq("id", leadId);

    await this.db.from("crm_unread_events").insert({
      lead_id: leadId,
      event_type: "incoming_message",
      message_id: messageId,
      reason: "meta_webhook_incoming",
      previous_state: { has_unread: wasUnread, unread_message_count: count },
      new_state: { has_unread: true, unread_message_count: count + 1 },
    });
  }

  async markLeadOutgoing(leadId: string, at: string): Promise<void> {
    const { data: lead } = await this.db
      .from(LEADS)
      .select("has_unread, unread_message_count, last_outgoing_at")
      .eq("id", leadId)
      .maybeSingle();
    if (!lead) return;

    const lastOutgoing = lead.last_outgoing_at as string | null;

    await this.db
      .from(LEADS)
      .update({
        has_unread: false,
        unread_since: null,
        unread_message_count: 0,
        last_unread_message_id: null,
        reply_overdue_at: null,
        is_reply_overdue: false,
        last_handled_at: at,
        last_outgoing_at: !lastOutgoing || at > lastOutgoing ? at : lastOutgoing,
        updated_at: new Date().toISOString(),
      })
      .eq("id", leadId);

    if (lead.has_unread) {
      await this.db.from("crm_unread_events").insert({
        lead_id: leadId,
        event_type: "moderator_replied",
        reason: "meta_webhook_outgoing",
        previous_state: { has_unread: true, unread_message_count: lead.unread_message_count ?? 0 },
        new_state: { has_unread: false, unread_message_count: 0 },
      });
    }
  }

  /* ── conversations ─────────────────────────────────────────────────── */

  async upsertConversation(input: ConversationUpsert): Promise<ConversationRef> {
    const platform = dbPlatform(input.platform);

    let query = this.db.from(CONVERSATIONS).select("id, lead_id").limit(1);
    if (input.conversationKey) query = query.eq("conversation_key", input.conversationKey);
    else if (input.platformUserId) query = query.eq("platform", platform).eq("platform_user_id", input.platformUserId);
    else throw new Error("upsertConversation: no conversation_key and no platform_user_id");

    const { data: existing } = await query.maybeSingle();

    if (existing) {
      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
      // Backfill only. A conversation never changes which lead it belongs to
      // here — merges are a deliberate, audited action elsewhere.
      if (input.leadId && !existing.lead_id) patch.lead_id = input.leadId;
      if (input.identityConfidence) patch.identity_confidence = input.identityConfidence;
      await this.db.from(CONVERSATIONS).update(patch).eq("id", existing.id);
      return { id: existing.id as string, leadId: (existing.lead_id as string | null) ?? input.leadId ?? null };
    }

    const now = new Date().toISOString();
    const { data, error } = await this.db
      .from(CONVERSATIONS)
      .insert({
        lead_id: input.leadId,
        platform,
        source: input.source,
        conversation_key: input.conversationKey,
        platform_user_id: input.platformUserId,
        identity_confidence: input.identityConfidence,
        page_id: input.pageId,
        instagram_account_id: input.instagramAccountId,
        customer_psid: input.customerPsid,
        customer_instagram_id: input.customerInstagramId,
        chat_link: input.chatLink,
        conversation_link: input.conversationLink,
        fallback_inbox_link: input.fallbackInboxLink,
        page_inbox_link: input.pageInboxLink,
        raw_payload: input.rawPayload ?? {},
        created_at: now,
        updated_at: now,
      })
      .select("id, lead_id")
      .single();

    if (error) {
      if (isUniqueViolation(error) && input.conversationKey) {
        const { data: raced } = await this.db
          .from(CONVERSATIONS)
          .select("id, lead_id")
          .eq("conversation_key", input.conversationKey)
          .maybeSingle();
        if (raced) return { id: raced.id as string, leadId: (raced.lead_id as string | null) ?? null };
      }
      throw new Error(`upsertConversation: ${error.message}`);
    }
    return { id: data.id as string, leadId: (data.lead_id as string | null) ?? null };
  }

  async touchConversation(
    id: string,
    patch: {
      lastMessageAt?: string;
      lastIncomingAt?: string;
      lastOutgoingAt?: string;
      lastDeliveredAt?: string;
      lastSeenAt?: string;
    },
  ): Promise<void> {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.lastMessageAt) row.last_message_at = patch.lastMessageAt;
    if (patch.lastIncomingAt) row.last_incoming_at = patch.lastIncomingAt;
    if (patch.lastOutgoingAt) row.last_outgoing_at = patch.lastOutgoingAt;
    if (patch.lastDeliveredAt) row.last_delivered_at = patch.lastDeliveredAt;
    if (patch.lastSeenAt) row.last_seen_at = patch.lastSeenAt;
    await this.db.from(CONVERSATIONS).update(row).eq("id", id);
  }

  /* ── messages ──────────────────────────────────────────────────────── */

  private static readonly MESSAGE_COLS =
    "id, lead_id, conversation_id, platform, platform_message_id, direction, message_at, message_text, edit_count, delivery_status";

  private static toStoredMessage(r: Record<string, unknown>): StoredMessage {
    return {
      id: r.id as string,
      leadId: (r.lead_id as string | null) ?? null,
      conversationId: (r.conversation_id as string | null) ?? null,
      platform: r.platform as string,
      platformMessageId: (r.platform_message_id as string | null) ?? null,
      direction: r.direction as Direction,
      messageAt: r.message_at as string,
      text: (r.message_text as string | null) ?? null,
      editCount: (r.edit_count as number | null) ?? 0,
      deliveryStatus: (r.delivery_status as StoredMessage["deliveryStatus"]) ?? null,
    };
  }

  async findMessageByPlatformId(platform: Platform, platformMessageId: string): Promise<StoredMessage | null> {
    const { data } = await this.db
      .from(MESSAGES)
      .select(SupabaseMetaStore.MESSAGE_COLS)
      .eq("platform", dbPlatform(platform))
      .eq("platform_message_id", platformMessageId)
      .maybeSingle();
    return data ? SupabaseMetaStore.toStoredMessage(data) : null;
  }

  async findMessageByEventKey(eventKey: string): Promise<StoredMessage | null> {
    const { data } = await this.db
      .from(MESSAGES)
      .select(SupabaseMetaStore.MESSAGE_COLS)
      .eq("event_key", eventKey)
      .maybeSingle();
    return data ? SupabaseMetaStore.toStoredMessage(data) : null;
  }

  async insertMessage(row: MessageInsert): Promise<{ message: StoredMessage; created: boolean }> {
    const now = new Date().toISOString();
    const { data, error } = await this.db
      .from(MESSAGES)
      .insert({
        lead_id: row.leadId,
        conversation_id: row.conversationId,
        event_key: row.eventKey,
        platform: dbPlatform(row.platform),
        source: row.source,
        record_type: row.recordType,
        event_type: row.eventType,
        event_action: row.eventAction,
        direction: row.direction,
        is_conversation_content: row.isConversationContent,
        message_text: row.text,
        message_type: row.messageType,
        platform_message_id: row.platformMessageId,
        message_at: row.messageAt,
        identity_confidence: row.identityConfidence,
        platform_user_id: row.platformUserId,
        sender_id: row.senderId,
        recipient_id: row.recipientId,
        sender_name: row.senderName,
        sender_username: row.senderUsername,
        sender_phone: row.senderPhone,
        sent_by_type: row.sentByType,
        sent_by_name: row.sentByName,
        is_echo: row.isEcho,
        message_is_deleted: row.isDeleted,
        message_is_unsupported: row.isUnsupported,
        page_id: row.pageId,
        recipient_page_id: row.recipientPageId,
        instagram_account_id: row.instagramAccountId,
        customer_psid: row.customerPsid,
        customer_instagram_id: row.customerInstagramId,
        conversation_key: row.conversationKey,
        chat_link: row.chatLink,
        conversation_link: row.conversationLink,
        fallback_inbox_link: row.fallbackInboxLink,
        page_inbox_link: row.pageInboxLink,
        attachment_count: row.attachmentCount,
        attachment_url: row.attachmentUrl,
        quick_reply_payload: row.quickReplyPayload,
        quick_reply_text: row.quickReplyText,
        postback_payload: row.postbackPayload,
        postback_title: row.postbackTitle,
        reply_to_message_id: row.replyToMessageId,
        reply_to: row.replyTo,
        delivery_status: row.deliveryStatus,
        facebook_app_id: row.facebookAppId,
        campaign: row.campaign,
        ad_id: row.adId,
        ad_name: row.adName,
        referral_source: row.referralSource,
        referral_type: row.referralType,
        referral_code: row.referralCode,
        referral: row.referral,
        message_metadata: row.messageMetadata,
        webhook_object: row.webhookObject,
        webhook_event_keys: row.webhookEventKeys,
        service: row.service,
        doctor: row.doctor,
        branch: row.branch,
        raw_payload: row.rawPayload ?? {},
        created_at: now,
      })
      .select(SupabaseMetaStore.MESSAGE_COLS)
      .single();

    if (error) {
      // The unique indexes on (platform, platform_message_id) and (event_key)
      // are the real dedupe guarantee; the pre-check in `persist.ts` is only an
      // optimisation. A retry that races past it lands here.
      if (isUniqueViolation(error)) {
        const existing = row.platformMessageId
          ? await this.findMessageByPlatformId(row.platform, row.platformMessageId)
          : await this.findMessageByEventKey(row.eventKey);
        if (existing) return { message: existing, created: false };
      }
      throw new Error(`insertMessage: ${error.message}`);
    }
    return { message: SupabaseMetaStore.toStoredMessage(data), created: true };
  }

  async updateMessageText(id: string, text: string, editCount: number, editedAt: string): Promise<void> {
    await this.db
      .from(MESSAGES)
      .update({ message_text: text, edit_count: editCount, edited_at: editedAt })
      .eq("id", id);
  }

  async setAttachments(messageId: string, attachments: Attachment[]): Promise<void> {
    if (attachments.length === 0) return;
    const { error } = await this.db.from("crm_message_attachments").upsert(
      attachments.map((a) => ({
        message_id: messageId,
        attachment_index: a.index,
        type: a.type,
        raw_type: a.rawType,
        url: a.url,
        title: a.title,
        name: a.name,
        sticker_id: a.stickerId,
        payload: a.payload ?? null,
      })),
      { onConflict: "message_id,attachment_index" },
    );
    if (error) throw new Error(`setAttachments: ${error.message}`);
  }

  async recordMessageEdit(input: {
    messageId: string;
    editCount: number;
    previousText: string | null;
    newText: string | null;
    editedAt: string;
    rawPayload: unknown;
  }): Promise<boolean> {
    const { error } = await this.db.from("crm_message_edits").insert({
      message_id: input.messageId,
      edit_count: input.editCount,
      previous_text: input.previousText,
      new_text: input.newText,
      edited_at: input.editedAt,
      raw_payload: input.rawPayload ?? {},
    });
    if (!error) return true;
    if (isUniqueViolation(error)) return false;
    throw new Error(`recordMessageEdit: ${error.message}`);
  }

  /**
   * Advance outgoing messages to `state`. The `neq` guards make the transition
   * monotonic: a late `delivered` receipt can never demote a message already
   * marked `seen`.
   */
  private async advance(
    platform: Platform,
    messageIds: string[],
    state: "delivered" | "seen",
    at: string,
  ): Promise<number> {
    if (messageIds.length === 0) return 0;

    const patch: Record<string, unknown> =
      state === "seen" ? { delivery_status: "seen", seen_at: at } : { delivery_status: "delivered", delivered_at: at };

    let query = this.db
      .from(MESSAGES)
      .update(patch)
      .eq("platform", dbPlatform(platform))
      .eq("direction", "outgoing")
      .in("platform_message_id", messageIds)
      .neq("delivery_status", "seen");

    if (state === "delivered") query = query.neq("delivery_status", "delivered");

    const { data, error } = await query.select("id");
    if (error) throw new Error(`markMessages${state}: ${error.message}`);
    return data?.length ?? 0;
  }

  async markMessagesDelivered(platform: Platform, messageIds: string[], at: string): Promise<number> {
    return this.advance(platform, messageIds, "delivered", at);
  }

  async markMessagesSeen(platform: Platform, messageIds: string[], at: string): Promise<number> {
    return this.advance(platform, messageIds, "seen", at);
  }

  async markOutgoingBeforeWatermark(
    conversationId: string | null,
    leadId: string | null,
    platform: Platform,
    watermark: string,
    state: "delivered" | "seen",
  ): Promise<number> {
    // Without a conversation or a lead the watermark has no scope, and applying
    // it page-wide would mark other patients' messages as seen.
    if (!conversationId && !leadId) return 0;

    const patch: Record<string, unknown> =
      state === "seen"
        ? { delivery_status: "seen", seen_at: watermark }
        : { delivery_status: "delivered", delivered_at: watermark };

    let query = this.db
      .from(MESSAGES)
      .update(patch)
      .eq("platform", dbPlatform(platform))
      .eq("direction", "outgoing")
      // "At or before the watermark" — anything newer has genuinely not been
      // seen yet and must keep its current status.
      .lte("message_at", watermark)
      .neq("delivery_status", "seen");

    if (state === "delivered") query = query.neq("delivery_status", "delivered");
    query = conversationId ? query.eq("conversation_id", conversationId) : query.eq("lead_id", leadId as string);

    const { data, error } = await query.select("id");
    if (error) throw new Error(`markOutgoingBeforeWatermark: ${error.message}`);
    return data?.length ?? 0;
  }

  /* ── reactions ─────────────────────────────────────────────────────── */

  async recordReaction(input: ReactionInsert): Promise<boolean> {
    const { error } = await this.db.from("crm_message_reactions").insert({
      message_id: input.messageId,
      target_message_id: input.targetMessageId,
      platform: dbPlatform(input.platform),
      actor_platform_user_id: input.actorPlatformUserId,
      reaction_action: input.reactionAction,
      reaction_type: input.reactionType,
      reaction_emoji: input.reactionEmoji,
      reacted_at: input.reactedAt,
      is_active: input.isActive,
      event_key: input.eventKey,
      raw_payload: input.rawPayload ?? {},
    });
    if (!error) return true;
    if (isUniqueViolation(error)) return false;
    throw new Error(`recordReaction: ${error.message}`);
  }

  async deactivateReactions(platform: Platform, targetMessageId: string, actor: string | null): Promise<void> {
    let query = this.db
      .from("crm_message_reactions")
      .update({ is_active: false })
      .eq("platform", dbPlatform(platform))
      .eq("target_message_id", targetMessageId)
      .eq("reaction_action", "react")
      .eq("is_active", true);

    query = actor ? query.eq("actor_platform_user_id", actor) : query.is("actor_platform_user_id", null);
    await query;
  }

  /* ── non-content events ────────────────────────────────────────────── */

  async insertConversationEvent(row: ConversationEventInsert): Promise<boolean> {
    const { error } = await this.db.from("crm_conversation_events").insert({
      lead_id: row.leadId,
      conversation_id: row.conversationId,
      event_key: row.eventKey,
      platform: dbPlatform(row.platform),
      source: row.source,
      record_type: row.recordType,
      event_type: row.eventType,
      event_action: row.eventAction,
      page_id: row.pageId,
      instagram_account_id: row.instagramAccountId,
      platform_user_id: row.platformUserId,
      identity_confidence: row.identityConfidence,
      conversation_key: row.conversationKey,
      direction: row.direction,
      status_for_direction: row.statusForDirection,
      target_message_id: row.targetMessageId,
      delivered_message_ids: row.deliveredMessageIds,
      status_watermark: row.statusWatermark,
      referral_source: row.referralSource,
      referral_type: row.referralType,
      referral_code: row.referralCode,
      campaign: row.campaign,
      ad_id: row.adId,
      ad_name: row.adName,
      referral: row.referral,
      webhook_object: row.webhookObject,
      webhook_event_keys: row.webhookEventKeys,
      event_at: row.eventAt,
      raw_payload: row.rawPayload ?? {},
    });
    if (!error) return true;
    if (isUniqueViolation(error)) return false;
    throw new Error(`insertConversationEvent: ${error.message}`);
  }

  /* ── comments ──────────────────────────────────────────────────────── */

  private static readonly COMMENT_COLS = "id, lead_id, comment_id, comment_text, edit_count, is_deleted";

  private static toStoredComment(r: Record<string, unknown>): StoredComment {
    return {
      id: r.id as string,
      leadId: (r.lead_id as string | null) ?? null,
      commentId: (r.comment_id as string | null) ?? null,
      text: (r.comment_text as string | null) ?? null,
      editCount: (r.edit_count as number | null) ?? 0,
      isDeleted: Boolean(r.is_deleted),
    };
  }

  async findCommentByPlatformId(platform: Platform, commentId: string): Promise<StoredComment | null> {
    const { data } = await this.db
      .from(COMMENTS)
      .select(SupabaseMetaStore.COMMENT_COLS)
      .eq("platform", dbPlatform(platform))
      .eq("comment_id", commentId)
      .maybeSingle();
    return data ? SupabaseMetaStore.toStoredComment(data) : null;
  }

  async findCommentByEventKey(eventKey: string): Promise<StoredComment | null> {
    const { data } = await this.db
      .from(COMMENTS)
      .select(SupabaseMetaStore.COMMENT_COLS)
      .eq("event_key", eventKey)
      .maybeSingle();
    return data ? SupabaseMetaStore.toStoredComment(data) : null;
  }

  async insertComment(row: CommentInsert): Promise<{ comment: StoredComment; created: boolean }> {
    const now = new Date().toISOString();
    const { data, error } = await this.db
      .from(COMMENTS)
      .insert({
        lead_id: row.leadId,
        event_key: row.eventKey,
        platform: dbPlatform(row.platform),
        source: row.source,
        record_type: row.recordType,
        event_type: row.eventType,
        event_action: row.eventAction,
        comment_id: row.commentId,
        parent_comment_id: row.parentCommentId,
        raw_parent_id: row.rawParentId,
        thread_root_comment_id: row.threadRootCommentId,
        thread_role: row.threadRole,
        is_reply: row.isReply,
        post_id: row.postId,
        media_id: row.mediaId,
        comment_text: row.text,
        comment_timestamp: row.commentAt,
        direction: row.direction,
        is_page_or_business_reply: row.isPageOrBusinessReply,
        identity_confidence: row.identityConfidence,
        platform_user_id: row.platformUserId,
        commenter_id: row.commenterId,
        commenter_username: row.commenterUsername,
        commenter_name: row.commenterName,
        page_id: row.pageId,
        instagram_account_id: row.instagramAccountId,
        conversation_key: row.conversationKey,
        comment_thread_key: row.commentThreadKey,
        message_type: row.messageType,
        comment_type: row.commentType,
        facebook_verb: row.facebookVerb,
        event_source_field: row.eventSourceField,
        is_edited: row.isEdited,
        is_deleted: row.isDeleted,
        comment_link: row.commentLink,
        fallback_inbox_link: row.fallbackInboxLink,
        media_permalink: row.mediaPermalink,
        media_caption: row.mediaCaption,
        media_type: row.mediaType,
        media_product_type: row.mediaProductType,
        attachment_count: row.attachmentCount,
        attachment_url: row.attachmentUrl,
        campaign: row.campaign,
        ad_id: row.adId,
        ad_name: row.adName,
        webhook_object: row.webhookObject,
        webhook_change_field: row.webhookChangeField,
        raw_payload: row.rawPayload ?? {},
        created_at: now,
        updated_at: now,
      })
      .select(SupabaseMetaStore.COMMENT_COLS)
      .single();

    if (error) {
      if (isUniqueViolation(error)) {
        const existing = row.commentId
          ? await this.findCommentByPlatformId(row.platform, row.commentId)
          : await this.findCommentByEventKey(row.eventKey);
        if (existing) return { comment: existing, created: false };
      }
      throw new Error(`insertComment: ${error.message}`);
    }
    return { comment: SupabaseMetaStore.toStoredComment(data), created: true };
  }

  async updateComment(
    id: string,
    patch: { text?: string | null; isEdited?: boolean; isDeleted?: boolean; deletedAt?: string | null; editCount?: number },
  ): Promise<void> {
    const row: Record<string, unknown> = { updated_at: new Date().toISOString() };
    if (patch.text !== undefined) row.comment_text = patch.text;
    if (patch.isEdited !== undefined) row.is_edited = patch.isEdited;
    if (patch.isDeleted !== undefined) row.is_deleted = patch.isDeleted;
    if (patch.deletedAt !== undefined) row.deleted_at = patch.deletedAt;
    if (patch.editCount !== undefined) row.edit_count = patch.editCount;
    await this.db.from(COMMENTS).update(row).eq("id", id);
  }

  async setCommentAttachments(commentId: string, attachments: Attachment[]): Promise<void> {
    if (attachments.length === 0) return;
    const { error } = await this.db.from("crm_comment_attachments").upsert(
      attachments.map((a) => ({
        comment_id: commentId,
        attachment_index: a.index,
        type: a.type,
        raw_type: a.rawType,
        url: a.url,
        title: a.title,
        name: a.name,
        sticker_id: a.stickerId,
        payload: a.payload ?? null,
      })),
      { onConflict: "comment_id,attachment_index" },
    );
    if (error) throw new Error(`setCommentAttachments: ${error.message}`);
  }

  async recordCommentEdit(input: {
    commentId: string;
    revision: number;
    previousText: string | null;
    newText: string | null;
    changeType: "updated" | "deleted";
    editedAt: string;
    rawPayload: unknown;
  }): Promise<boolean> {
    const { error } = await this.db.from("crm_comment_edits").insert({
      comment_id: input.commentId,
      revision: input.revision,
      previous_text: input.previousText,
      new_text: input.newText,
      change_type: input.changeType,
      edited_at: input.editedAt,
      raw_payload: input.rawPayload ?? {},
    });
    if (!error) return true;
    if (isUniqueViolation(error)) return false;
    throw new Error(`recordCommentEdit: ${error.message}`);
  }

  /* ── attribution / timeline / audit / logs ─────────────────────────── */

  async applyAttribution(touch: AttributionTouch): Promise<{ firstTouch: boolean }> {
    const { data: existing } = await this.db
      .from("crm_lead_attribution")
      .select("lead_id, first_touch_at, touch_count")
      .eq("lead_id", touch.leadId)
      .maybeSingle();

    const latest = {
      latest_source: touch.referralSource ?? touch.source,
      latest_campaign: touch.campaign,
      latest_ad_id: touch.adId,
      latest_ad_name: touch.adName,
      latest_referral_source: touch.referralSource,
      latest_referral_type: touch.referralType,
      latest_referral_code: touch.referralCode,
      latest_referral: touch.referral,
      latest_touch_at: touch.touchedAt,
      updated_at: new Date().toISOString(),
    };

    if (existing) {
      // First-touch columns are written once, at insert. They are never part of
      // an update, so a later ad click cannot rewrite where the lead came from.
      await this.db
        .from("crm_lead_attribution")
        .update({ ...latest, touch_count: ((existing.touch_count as number | null) ?? 0) + 1 })
        .eq("lead_id", touch.leadId);
      return { firstTouch: false };
    }

    const { error } = await this.db.from("crm_lead_attribution").insert({
      lead_id: touch.leadId,
      first_source: touch.referralSource ?? touch.source,
      first_campaign: touch.campaign,
      first_ad_id: touch.adId,
      first_ad_name: touch.adName,
      first_referral_source: touch.referralSource,
      first_referral_type: touch.referralType,
      first_referral_code: touch.referralCode,
      first_referral: touch.referral,
      first_touch_at: touch.touchedAt,
      touch_count: 1,
      ...latest,
    });

    if (error) {
      if (isUniqueViolation(error)) {
        // Raced with a concurrent first touch: the other writer owns "first".
        await this.db.from("crm_lead_attribution").update(latest).eq("lead_id", touch.leadId);
        return { firstTouch: false };
      }
      throw new Error(`applyAttribution: ${error.message}`);
    }
    return { firstTouch: true };
  }

  async addTimelineEvent(input: TimelineInsert): Promise<void> {
    await this.db.from("lead_timeline_events").insert({
      lead_id: input.leadId,
      event_type: input.eventType,
      title: input.title,
      body: input.body,
      metadata: input.metadata,
      event_at: input.eventAt,
    });
  }

  async addAuditLog(input: AuditInsert): Promise<void> {
    await this.db.from("audit_logs").insert({
      // No `actor_user_id`: the webhook has no human actor. `source` records
      // that the change came from Meta, not from a moderator.
      action: input.action,
      entity_type: input.entityType,
      entity_id: input.entityId,
      old_values: input.oldValues,
      new_values: input.newValues,
      metadata: input.metadata,
      source: input.source,
    });
  }

  async log(entry: IngestLogInsert): Promise<void> {
    const { error } = await this.db.from("crm_ingest_logs").insert({
      source: entry.source,
      platform: entry.platform,
      record_type: entry.recordType,
      event_type: entry.eventType,
      event_action: entry.eventAction,
      event_key: entry.eventKey,
      page_id: entry.pageId,
      platform_user_id: entry.platformUserId,
      conversation_key: entry.conversationKey,
      comment_id: entry.commentId,
      comment_thread_key: entry.commentThreadKey,
      platform_message_id: entry.platformMessageId,
      message_id: entry.messageId,
      lead_id: entry.leadId,
      direction: entry.direction,
      message_text: entry.messageText,
      created: entry.created,
      updated: entry.updated,
      skipped: entry.skipped,
      skip_reason: entry.skipReason,
      match_reason: entry.matchReason,
      errors: entry.errors ?? [],
      raw_payload: entry.rawPayload ?? {},
    });
    if (error) throw new Error(`ingestLog: ${error.message}`);
  }
}
