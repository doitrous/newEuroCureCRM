import { NextResponse } from "next/server";
import { supabaseAdmin } from "@/lib/supabase/server";
import { dispatchTrigger } from "@/lib/email/send";
import { secretsEqual } from "@/lib/security/secrets";
import {
  assignRevisitingPatientTag,
  isRevisitingMetadata,
  normalizePatientMrn,
  withRevisitingMetadata,
  type RevisitingMatch,
} from "@/lib/booking/revisiting";
import { phoneDuplicateKey } from "@/lib/phoneMatching";
import { resolvePatientSource } from "@/lib/patient-source/catalog";
import { applyPatientSourceToLead } from "@/lib/patient-source/server";

/**
 * Booking → CRM ingest receiver.
 *
 * The public booking site (directly, or via an n8n workflow) POSTs every new
 * patient reservation here. The reservation is turned into / linked to a CRM
 * lead so a new patient surfaces under "New Leads" as **unread**, in addition
 * to appearing live under "Website Reservations". A matching database patient
 * re-enters the queue with the explicit "Revisiting Patient" marker.
 *
 * Auth: shared secret in `CRM_INGEST_API_KEY`, sent as either
 *   Authorization: Bearer <key>   or   x-api-key: <key>
 *
 * This endpoint is the *receiver* only; the booking-side push (or n8n) is wired
 * in Phase 5. It writes to the CRM's own Supabase via the service role, so it is
 * independent of `CRM_DATA_SOURCE` (always live).
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Minimal payload the booking platform sends for a reservation. */
interface ReservationPayload {
  bookingAppointmentId: string;
  patientName: string;
  patientMrn?: string;
  phoneCountryCode?: string;
  phoneNumber?: string;
  patientEmail?: string;
  gender?: "male" | "female" | null;
  serviceName?: string;
  doctorName?: string;
  branchName?: string;
  specialtyName?: string;
  appointmentDate?: string; // YYYY-MM-DD
  startTime?: string; // HH:MM
  isNewPatient?: boolean;
  primaryComplaint?: string;
  referralSource?: string;
  feeAtBooking?: number;
  createdAt?: string; // ISO, when the reservation was booked
}

const LEADS = "leads";
const MAX_BODY_BYTES = 64_000;

function unauthorized(): NextResponse {
  return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
}

function presentedKey(req: Request): string | null {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const x = req.headers.get("x-api-key");
  return x ? x.trim() : null;
}

/** Same normalization the CRM uses elsewhere: digits of country code + number. */
function normalizePhone(cc?: string, num?: string): string | null {
  const digits = `${cc ?? ""}${num ?? ""}`.replace(/\D/g, "");
  return digits.length ? digits : null;
}

/** Next sequential lead code, e.g. "L0110" → "L0111". Defensive fallback in case
 *  the table has no DB-side default; harmless if it does. */
async function nextLeadCode(db: ReturnType<typeof supabaseAdmin>): Promise<string> {
  const { data: generated, error: generateError } = await db.rpc("crm_generate_lead_id");
  if (!generateError && generated) return String(generated);

  // Compatibility fallback for installations that have not applied the lead
  // ID generator migration yet. The database function is the atomic path.
  const { data } = await db
    .from(LEADS)
    .select("lead_id")
    .order("lead_id", { ascending: false })
    .limit(1)
    .maybeSingle();
  const last = data?.lead_id as string | undefined;
  const n = last && /^L\d+$/.test(last) ? Number(last.slice(1)) + 1 : 1;
  return `L${String(n).padStart(4, "0")}`;
}

function optionalString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  return normalized ? normalized.slice(0, maxLength) : undefined;
}

function parsePayload(value: unknown): ReservationPayload | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const input = value as Record<string, unknown>;
  const bookingAppointmentId = optionalString(input.bookingAppointmentId, 100);
  const patientName = optionalString(input.patientName, 200);
  if (!bookingAppointmentId || !patientName) return null;
  const patientMrn = optionalString(input.patientMrn ?? input.mrn, 9);
  if (patientMrn && !normalizePatientMrn(patientMrn)) return null;

  const fee = input.feeAtBooking;
  if (fee !== undefined && fee !== null && (typeof fee !== "number" || !Number.isFinite(fee) || fee < 0)) {
    return null;
  }
  const gender = input.gender;
  if (gender !== undefined && gender !== null && gender !== "male" && gender !== "female") return null;

  return {
    bookingAppointmentId,
    patientName,
    patientMrn,
    phoneCountryCode: optionalString(input.phoneCountryCode, 10),
    phoneNumber: optionalString(input.phoneNumber, 30),
    patientEmail: optionalString(input.patientEmail, 320),
    gender: gender === "male" || gender === "female" ? gender : null,
    serviceName: optionalString(input.serviceName, 200),
    doctorName: optionalString(input.doctorName, 200),
    branchName: optionalString(input.branchName, 200),
    specialtyName: optionalString(input.specialtyName, 200),
    appointmentDate: optionalString(input.appointmentDate, 10),
    startTime: optionalString(input.startTime, 8),
    isNewPatient: typeof input.isNewPatient === "boolean" ? input.isNewPatient : undefined,
    primaryComplaint: optionalString(input.primaryComplaint, 2_000),
    referralSource: optionalString(input.referralSource, 200),
    feeAtBooking: typeof fee === "number" ? fee : undefined,
    createdAt: optionalString(input.createdAt, 40),
  };
}

export async function POST(req: Request) {
  const expected = process.env.CRM_INGEST_API_KEY;
  if (!expected) {
    return NextResponse.json(
      { ok: false, error: "ingest_not_configured" },
      { status: 503 },
    );
  }
  if (!secretsEqual(presentedKey(req), expected)) return unauthorized();

  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "payload_too_large" }, { status: 413 });
  }

  let raw: unknown;
  try {
    const text = await req.text();
    if (Buffer.byteLength(text, "utf8") > MAX_BODY_BYTES) {
      return NextResponse.json({ ok: false, error: "payload_too_large" }, { status: 413 });
    }
    raw = JSON.parse(text);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  const body = parsePayload(raw);
  if (!body) {
    return NextResponse.json(
      { ok: false, error: "invalid_payload", need: ["bookingAppointmentId", "patientName"] },
      { status: 422 },
    );
  }

  // The route is the EuroCure website booking receiver, so the old system's
  // confirmed EuroCure fallback is safe when no marker is present. An explicit
  // unknown/ambiguous source is never allowed to fall through that default.
  const sourceResolution = resolvePatientSource([raw], { fallbackToEuroCure: true });
  if (sourceResolution.status !== "resolved") {
    return NextResponse.json(
      { ok: false, error: sourceResolution.status === "ambiguous" ? "ambiguous_patient_source" : "unsupported_patient_source" },
      { status: 422 },
    );
  }
  if (sourceResolution.usedFallback) {
    console.warn("Reservation ingest used confirmed EuroCure source fallback", { count: 1 });
  }

  const db = supabaseAdmin();
  const now = new Date().toISOString();
  const normalizedPhone = normalizePhone(body.phoneCountryCode, body.phoneNumber);
  const matchablePhone = phoneDuplicateKey(normalizedPhone);

  const channelMeta = {
    channel: "website_booking",
    booking_appointment_id: body.bookingAppointmentId,
    patient_mrn: body.patientMrn ?? null,
    doctor_name: body.doctorName ?? null,
    branch_name: body.branchName ?? null,
    specialty_name: body.specialtyName ?? null,
    appointment_date: body.appointmentDate ?? null,
    start_time: body.startTime ?? null,
    primary_complaint: body.primaryComplaint ?? null,
    referral_source: body.referralSource ?? null,
    fee_at_booking: body.feeAtBooking ?? null,
    is_new_patient: body.isNewPatient ?? null,
    booked_at: body.createdAt ?? now,
    ingested_at: now,
  };

  // 1) Already ingested this exact reservation? Touch its unread state.
  const { data: byAppt } = await db
    .from(LEADS)
    .select("id, lead_id, metadata")
    .eq("booking_appointment_id", body.bookingAppointmentId)
    .maybeSingle();

  if (byAppt) {
    const { error: linkError } = await db.from("crm_lead_booking_links").upsert({
      lead_id: byAppt.id,
      appointment_id: body.bookingAppointmentId,
      source: "website_ingest",
    }, { onConflict: "appointment_id" });
    if (linkError) return NextResponse.json({ ok: false, error: "booking_link_failed" }, { status: 500 });
    const { error: updateError } = await db
      .from(LEADS)
      .update({
        has_unread: true,
        unread_since: now,
        last_incoming_at: now,
        metadata: { ...(byAppt.metadata ?? {}), ...channelMeta },
        updated_at: now,
      })
      .eq("id", byAppt.id);
    if (updateError) {
      console.error("Reservation ingest existing-lead update failed", {
        appointmentId: body.bookingAppointmentId,
        code: updateError.code,
      });
      return NextResponse.json({ ok: false, error: "lead_update_failed" }, { status: 500 });
    }
    await applyPatientSourceToLead(String(byAppt.id), sourceResolution.source.id, {
      origin: "reservation_retry",
      appointment_id: body.bookingAppointmentId,
    });
    return NextResponse.json({ ok: true, action: "updated", leadId: byAppt.id, leadCode: byAppt.lead_id, revisiting: isRevisitingMetadata(byAppt.metadata) });
  }

  // 2) Same patient by exact MRN first, then normalized phone. Re-enter the
  // operational queue and mark the existing record as a revisiting patient.
  type MatchedLead = { id: string; lead_id: string; metadata: Record<string, unknown> | null };
  let matchedLead: MatchedLead | null = null;
  let matchedBy: RevisitingMatch | null = null;
  const patientMrn = normalizePatientMrn(body.patientMrn);
  if (patientMrn) {
    const { data } = await db
      .from(LEADS)
      .select("id, lead_id, metadata")
      .eq("mrn", patientMrn)
      .is("merged_into_lead_id", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) {
      matchedLead = {
        id: String(data.id),
        lead_id: String(data.lead_id),
        metadata: (data.metadata as Record<string, unknown> | null) ?? null,
      };
      matchedBy = "mrn";
    }
  }
  if (!matchedLead && matchablePhone) {
    let phoneQuery = db
      .from(LEADS)
      .select("id, lead_id, metadata")
      .is("merged_into_lead_id", null)
      .order("created_at", { ascending: false })
      .limit(1);
    phoneQuery = matchablePhone.length >= 7
      ? phoneQuery.ilike("normalized_phone", `%${matchablePhone}`)
      : phoneQuery.eq("normalized_phone", matchablePhone);
    const { data } = await phoneQuery.maybeSingle();
    if (data) {
      matchedLead = {
        id: String(data.id),
        lead_id: String(data.lead_id),
        metadata: (data.metadata as Record<string, unknown> | null) ?? null,
      };
      matchedBy = "phone";
    }
  }

  if (matchedLead && matchedBy) {
    const { error: updateError } = await db
      .from(LEADS)
      .update({
        booking_appointment_id: body.bookingAppointmentId,
        service_name: body.serviceName ?? undefined,
        status: "new_lead",
        has_unread: true,
        unread_since: now,
        last_incoming_at: now,
        metadata: withRevisitingMetadata({ ...(matchedLead.metadata ?? {}), ...channelMeta }, matchedBy, body.bookingAppointmentId),
        updated_at: now,
      })
      .eq("id", matchedLead.id);
    if (updateError) {
      console.error("Reservation ingest linked-lead update failed", {
        appointmentId: body.bookingAppointmentId,
        code: updateError.code,
      });
      return NextResponse.json({ ok: false, error: "lead_update_failed" }, { status: 500 });
    }
    const { error: linkError } = await db.from("crm_lead_booking_links").upsert({
      lead_id: matchedLead.id,
      appointment_id: body.bookingAppointmentId,
      source: "website_ingest",
    }, { onConflict: "appointment_id" });
    if (linkError) return NextResponse.json({ ok: false, error: "booking_link_failed" }, { status: 500 });
    await assignRevisitingPatientTag(matchedLead.id);
    await applyPatientSourceToLead(matchedLead.id, sourceResolution.source.id, {
      origin: "reservation_revisit",
      appointment_id: body.bookingAppointmentId,
    });
    return NextResponse.json({ ok: true, action: "linked", leadId: matchedLead.id, leadCode: matchedLead.lead_id, revisiting: true, matchedBy });
  }

  // 3) Brand-new lead from the reservation.
  const leadCode = await nextLeadCode(db);
  const insert = {
    lead_id: leadCode,
    mrn: patientMrn,
    name: body.patientName,
    status: "new_lead",
    platform: "manual", // no distinct `website_booking` platform value yet; channel is in metadata
    gender: body.gender ?? null,
    phone_country_code: body.phoneCountryCode ?? null,
    phone_number: body.phoneNumber ?? null,
    normalized_phone: normalizedPhone,
    service_name: body.serviceName ?? null,
    booking_appointment_id: body.bookingAppointmentId,
    source_id: process.env.CRM_BOOKING_SOURCE_ID || null,
    patient_source_key: sourceResolution.source.id,
    escalation_status: "none",
    has_unread: true,
    unread_since: now,
    unread_message_count: 1,
    last_incoming_at: now,
    first_contact_at: body.createdAt ?? now,
    metadata: channelMeta,
    created_at: now,
    updated_at: now,
  };

  const { data: created, error } = await db
    .from(LEADS)
    .insert(insert)
    .select("id, lead_id")
    .single();

  if (error) {
    console.error("Reservation ingest lead insert failed", {
      appointmentId: body.bookingAppointmentId,
      code: error.code,
    });
    return NextResponse.json({ ok: false, error: "insert_failed" }, { status: 500 });
  }
  await applyPatientSourceToLead(String(created.id), sourceResolution.source.id, {
    origin: "reservation_create",
    appointment_id: body.bookingAppointmentId,
  });
  const { error: linkError } = await db.from("crm_lead_booking_links").upsert({
    lead_id: created.id,
    appointment_id: body.bookingAppointmentId,
    source: "website_ingest",
  }, { onConflict: "appointment_id" });
  if (linkError) return NextResponse.json({ ok: false, error: "booking_link_failed" }, { status: 500 });

  // Best-effort booking-created notification for the new public reservation.
  // Idempotent on the appointment id, so a re-POST does not re-notify. An email
  // failure must never fail ingest.
  try {
    await dispatchTrigger("booking_created", {
      discriminator: body.bookingAppointmentId,
      leadUid: created.id as string,
      ctx: {
        patient_name: body.patientName,
        appointment_date: body.appointmentDate ?? "",
        appointment_datetime: `${body.appointmentDate ?? ""} ${body.startTime ?? ""}`.trim(),
        service_name: body.serviceName ?? "",
        patient_email: body.patientEmail ?? "",
      },
    });
  } catch (emailErr) {
    console.error("ingest booking_created email dispatch failed", emailErr);
  }

  return NextResponse.json({ ok: true, action: "created", leadId: created.id, leadCode: created.lead_id });
}
