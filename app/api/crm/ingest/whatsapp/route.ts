import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { whatsappIngestSecret } from "@/lib/whatsapp/config";
import { secretsEqual } from "@/lib/security/secrets";
import { matchablePhoneDigits } from "@/lib/phoneMatching";
import { resolvePatientSource, type PatientSourceId } from "@/lib/patient-source/catalog";
import { applyPatientSourceToLead } from "@/lib/patient-source/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type Media = {
  type?: string;
  rawType?: string;
  url?: string;
  title?: string;
  name?: string;
  stickerId?: string;
};

type DeliveryStatus = "sent" | "delivered" | "seen";

type Payload = {
  messageId?: string;
  conversationId?: string;
  whatsappUserId?: string;
  phone?: string;
  phoneCountryCode?: string;
  patientName?: string;
  direction?: "incoming" | "outgoing";
  text?: string;
  timestamp?: string;
  deliveryStatusAt?: string;
  media?: Media[];
  messageType?: string;
  deliveryStatus?: DeliveryStatus | null;
  senderName?: string;
  statusOnly?: boolean;
  rawPayload?: unknown;
  messageMetadata?: Record<string, unknown>;
  source?: unknown;
  sourceId?: unknown;
  source_id?: unknown;
  patientSource?: unknown;
  patient_source?: unknown;
  ownership_tag?: unknown;
  ingestion_profile?: unknown;
  tags?: unknown;
  patientSourceKey?: PatientSourceId;
};

const MAX_BODY_BYTES = 1_000_000;
const MAX_RECORDS = 50;
const MAX_MEDIA_PER_MESSAGE = 20;

function bearer(req: Request): string | null {
  const auth = req.headers.get("authorization") ?? "";
  if (auth.toLowerCase().startsWith("bearer ")) return auth.slice(7).trim();
  return req.headers.get("x-crm-ingest-key") ?? req.headers.get("x-api-key");
}

function normalizePhone(value?: string | null): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits || null;
}

function records(body: unknown): Payload[] | null {
  if (Array.isArray(body)) return body.every(isRecord) ? (body as Payload[]) : null;
  if (body && typeof body === "object" && Array.isArray((body as { records?: unknown }).records)) {
    const items = (body as { records: unknown[] }).records;
    return items.every(isRecord) ? (items as Payload[]) : null;
  }
  return isRecord(body) ? [body as Payload] : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function validateRecord(input: Payload): string | null {
  if (typeof input.messageId !== "string" || !input.messageId.trim() || input.messageId.length > 300) {
    return "Every record requires a valid messageId.";
  }
  if (!input.statusOnly && !input.phone && !input.whatsappUserId && !input.conversationId) {
    return "Every message requires a phone, WhatsApp user ID, or conversation ID.";
  }
  if (input.media !== undefined && !Array.isArray(input.media)) return "media must be an array.";
  if ((input.media?.length ?? 0) > MAX_MEDIA_PER_MESSAGE) {
    return `A message may contain at most ${MAX_MEDIA_PER_MESSAGE} media items.`;
  }
  if (typeof input.text === "string" && input.text.length > 100_000) return "Message text is too long.";
  return null;
}

function isoOrNow(value?: string | null): string {
  return value && !Number.isNaN(new Date(value).getTime())
    ? new Date(value).toISOString()
    : new Date().toISOString();
}

async function updateExistingMessage(
  db: ReturnType<typeof supabaseAdmin>,
  messageId: string,
  input: Payload,
  at: string,
): Promise<{ statusUpdated: boolean; metadataUpdated: boolean }> {
  let metadataUpdated = false;
  if (input.messageMetadata && Object.keys(input.messageMetadata).length) {
    const { error } = await db
      .from("crm_messages")
      .update({ message_metadata: input.messageMetadata })
      .eq("id", messageId);
    if (error) throw new Error(`whatsappMessage(metadata): ${error.message}`);
    metadataUpdated = true;
  }

  if (!input.deliveryStatus) return { statusUpdated: false, metadataUpdated };

  const patch: Record<string, string> =
    input.deliveryStatus === "seen"
      ? { delivery_status: "seen", seen_at: at }
      : input.deliveryStatus === "delivered"
        ? { delivery_status: "delivered", delivered_at: at }
        : { delivery_status: "sent" };

  let query = db
    .from("crm_messages")
    .update(patch)
    .eq("id", messageId)
    .eq("direction", "outgoing");

  if (input.deliveryStatus === "seen") {
    query = query.neq("delivery_status", "seen");
  } else if (input.deliveryStatus === "delivered") {
    query = query.neq("delivery_status", "seen").neq("delivery_status", "delivered");
  } else {
    query = query.is("delivery_status", null);
  }

  const { data, error } = await query.select("id");
  if (error) throw new Error(`whatsappMessage(status): ${error.message}`);
  return { statusUpdated: Boolean(data?.length), metadataUpdated };
}

async function leadFor(input: Payload): Promise<{ id: string; lead_id: string }> {
  const db = supabaseAdmin();
  const phone = normalizePhone(input.phone ?? input.whatsappUserId ?? input.conversationId);
  const matchablePhone = matchablePhoneDigits(phone);
  const explicitPlatformId = input.whatsappUserId || input.conversationId || null;
  const platformId = explicitPlatformId || matchablePhone;
  if (matchablePhone) {
    const { data: byPhone, error } = await db
      .from("leads")
      .select("id,lead_id")
      .eq("normalized_phone", matchablePhone)
      .is("merged_into_lead_id", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`whatsappLead(find phone): ${error.message}`);
    if (byPhone) return byPhone as { id: string; lead_id: string };
  }
  if (platformId) {
    const { data: byPlatform, error } = await db
      .from("leads")
      .select("id,lead_id")
      .eq("platform_id", platformId)
      .is("merged_into_lead_id", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw new Error(`whatsappLead(find platform): ${error.message}`);
    if (byPlatform) return byPlatform as { id: string; lead_id: string };
  }

  const { data: generatedLeadId, error: idError } = await db.rpc("crm_generate_lead_id");
  if (idError) throw new Error(`whatsappLead(id): ${idError.message}`);
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("leads")
    .insert({
      lead_id: String(generatedLeadId),
      name: input.patientName?.trim() || input.senderName?.trim() || input.phone || "WhatsApp lead",
      phone_country_code: input.phoneCountryCode || null,
      phone_number: input.phone || null,
      normalized_phone: phone,
      platform: "whatsapp",
      platform_id: platformId,
      normalized_platform_id: explicitPlatformId ?? matchablePhone,
      status: "new_lead",
      has_unread: input.direction !== "outgoing",
      first_contact_at: now,
      last_contact_at: now,
      last_incoming_at: input.direction === "outgoing" ? null : now,
      last_outgoing_at: input.direction === "outgoing" ? now : null,
      escalation_status: "none",
      patient_source_key: input.patientSourceKey || null,
    })
    .select("id,lead_id")
    .single();
  if (error) throw new Error(`whatsappLead(create): ${error.message}`);
  return data as { id: string; lead_id: string };
}

async function ingestOne(input: Payload) {
  if (!input.messageId) throw new Error("messageId is required.");
  const direction = input.direction === "outgoing" ? "outgoing" : "incoming";
  const db = supabaseAdmin();
  const messageAt = isoOrNow(input.timestamp);
  const statusAt = isoOrNow(input.deliveryStatusAt ?? input.timestamp);

  const { data: existing, error: existingError } = await db
    .from("crm_messages")
    .select("id,lead_id")
    .eq("platform", "whatsapp")
    .eq("platform_message_id", input.messageId)
    .maybeSingle();
  if (existingError) throw new Error(`whatsappMessage(find): ${existingError.message}`);
  if (existing?.id) {
    let effectiveSourceKey = input.patientSourceKey!;
    if (existing.lead_id) {
      effectiveSourceKey = await applyPatientSourceToLead(String(existing.lead_id), input.patientSourceKey!, {
        origin: "whatsapp_retry",
        platform_message_id: input.messageId,
      });
      await db.from("crm_messages").update({ patient_source_key: effectiveSourceKey }).eq("id", existing.id);
    }
    const updates = await updateExistingMessage(db, existing.id as string, input, statusAt);
    return { messageId: existing.id as string, inserted: false, patientSource: effectiveSourceKey, ...updates };
  }

  if (input.statusOnly) {
    return { messageId: input.messageId, inserted: false, skipped: true, reason: "status_without_message" };
  }

  const lead = await leadFor(input);
  const effectiveSourceKey = await applyPatientSourceToLead(lead.id, input.patientSourceKey!, {
    origin: "whatsapp_ingest",
    platform_message_id: input.messageId,
  });

  const media = Array.isArray(input.media) ? input.media : [];
  const deliveryStatus = direction === "outgoing" ? input.deliveryStatus ?? "sent" : input.deliveryStatus ?? null;
  const { data: message, error } = await db
    .from("crm_messages")
    .insert({
      lead_id: lead.id,
      platform: "whatsapp",
      platform_message_id: input.messageId,
      conversation_key: input.conversationId || input.whatsappUserId || input.phone || null,
      platform_user_id: input.whatsappUserId || input.phone || input.conversationId || null,
      direction,
      message_text: input.text ?? "",
      message_type: input.messageType || media[0]?.type || "text",
      attachment_count: media.length,
      is_conversation_content: true,
      message_at: messageAt,
      sent_by_name: input.senderName || (direction === "outgoing" ? "Aspects Clinica" : input.patientName) || null,
      sender_phone: input.phone || null,
      delivery_status: deliveryStatus,
      delivered_at: deliveryStatus === "delivered" ? statusAt : null,
      seen_at: deliveryStatus === "seen" ? statusAt : null,
      record_type: "message",
      event_type: "message",
      service: "WhatsApp",
      raw_payload: input.rawPayload ?? {},
      message_metadata: input.messageMetadata ?? null,
      patient_source_key: effectiveSourceKey,
    })
    .select("id")
    .single();
  if (error) throw new Error(`whatsappMessage(insert): ${error.message}`);

  if (media.length) {
    const { error: attachmentError } = await db.from("crm_message_attachments").insert(
      media.map((item, index) => ({
        message_id: message.id,
        attachment_index: index,
        type: item.type || "file",
        raw_type: item.rawType || item.type || null,
        url: item.url || null,
        title: item.title || null,
        name: item.name || null,
        sticker_id: item.stickerId || null,
      })),
    );
    if (attachmentError) throw new Error(`whatsappAttachment(insert): ${attachmentError.message}`);
  }

  const patch = direction === "outgoing"
    ? { has_unread: false, last_outgoing_at: messageAt, last_contact_at: messageAt }
    : { has_unread: true, last_incoming_at: messageAt, last_contact_at: messageAt };
  const { error: leadError } = await db.from("leads").update(patch).eq("id", lead.id);
  if (leadError) throw new Error(`whatsappLead(update): ${leadError.message}`);

  await db.from("lead_timeline_events").insert({
    lead_id: lead.id,
    event_type: direction === "outgoing" ? "message_out" : "message_in",
    title: direction === "outgoing" ? "WhatsApp message sent" : "WhatsApp message received",
    body: input.text ?? null,
    metadata: { platform_message_id: input.messageId, source: "whatsapp" },
  });

  return { leadId: lead.lead_id, messageId: message.id as string, patientSource: effectiveSourceKey, inserted: true };
}

export async function POST(req: Request) {
  const secret = whatsappIngestSecret();
  if (!secret) return NextResponse.json({ error: "WhatsApp ingest is not configured." }, { status: 503 });
  if (!secretsEqual(bearer(req), secret)) return NextResponse.json({ error: "Unauthorized." }, { status: 401 });

  try {
    const declaredLength = Number(req.headers.get("content-length") ?? "0");
    if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
      return NextResponse.json({ ok: false, error: "Payload is too large." }, { status: 413 });
    }
    const raw = await req.text();
    if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
      return NextResponse.json({ ok: false, error: "Payload is too large." }, { status: 413 });
    }
    const body: unknown = JSON.parse(raw);
    const inputs = records(body);
    if (!inputs || inputs.length === 0) {
      return NextResponse.json({ ok: false, error: "No valid records were supplied." }, { status: 422 });
    }
    if (inputs.length > MAX_RECORDS) {
      return NextResponse.json(
        { ok: false, error: `A batch may contain at most ${MAX_RECORDS} records.` },
        { status: 413 },
      );
    }
    const validationError = inputs.map(validateRecord).find(Boolean);
    if (validationError) {
      return NextResponse.json({ ok: false, error: validationError }, { status: 422 });
    }

    let fallbackCount = 0;
    for (const input of inputs) {
      const resolution = resolvePatientSource([input], { fallbackToEuroCure: true });
      if (resolution.status !== "resolved") {
        return NextResponse.json(
          { ok: false, error: resolution.status === "ambiguous" ? "ambiguous_patient_source" : "unsupported_patient_source" },
          { status: 422 },
        );
      }
      input.patientSourceKey = resolution.source.id;
      if (resolution.usedFallback) fallbackCount += 1;
    }
    if (fallbackCount > 0) {
      console.warn("WhatsApp ingest used confirmed legacy EuroCure source fallback", { count: fallbackCount });
    }

    // Keep ordering deterministic and avoid racing two messages into duplicate
    // lead creation for the same new phone number.
    const result = [];
    for (const input of inputs) result.push(await ingestOne(input));
    return NextResponse.json({ ok: true, records: result, ...(fallbackCount ? { patientSourceFallbacks: fallbackCount } : {}) });
  } catch (error) {
    console.error("WhatsApp ingest failed", error);
    return NextResponse.json(
      { ok: false, error: "WhatsApp ingest failed." },
      { status: 400 },
    );
  }
}
