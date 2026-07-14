import "server-only";
import { supabaseAdmin } from "@/lib/supabase/server";
import type { Reservation } from "@/lib/types";
import {
  assignRevisitingPatientTag,
  isRevisitingMetadata,
  normalizePatientMrn,
  withRevisitingMetadata,
  type RevisitingMatch,
} from "@/lib/booking/revisiting";
import { phoneDuplicateKey } from "@/lib/phoneMatching";
import { PATIENT_SOURCES } from "@/lib/patient-source/catalog";
import { applyPatientSourceToLead } from "@/lib/patient-source/server";

function normalizePhone(phone: string): string | null {
  const digits = phone.replace(/\D/g, "");
  return digits || null;
}

function splitPhone(phone: string): { cc: string | null; number: string | null } {
  const digits = phone.replace(/\D/g, "");
  if (!digits) return { cc: null, number: null };
  if (digits.startsWith("20")) return { cc: "+20", number: digits.slice(2) };
  return { cc: null, number: digits };
}

const QUERY_CHUNK_SIZE = 200;

function chunks<T>(values: T[]): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += QUERY_CHUNK_SIZE) {
    result.push(values.slice(index, index + QUERY_CHUNK_SIZE));
  }
  return result;
}

interface ExistingLeadRow {
  id: string;
  lead_id: string;
  metadata: Record<string, unknown> | null;
  booking_appointment_id?: string | null;
  status?: string | null;
  normalized_phone?: string | null;
  mrn?: string | null;
}

export interface SyncedReservationLead {
  leadId: string;
  revisiting: boolean;
}

async function loadExistingReservations(reservations: Reservation[]): Promise<{
  linkedLeadIdByAppointment: Map<string, string>;
  leadsById: Map<string, ExistingLeadRow>;
  legacyByAppointment: Map<string, ExistingLeadRow>;
  leadsByMrn: Map<string, ExistingLeadRow>;
  leadsByPhone: Map<string, ExistingLeadRow>;
}> {
  const db = supabaseAdmin();
  const appointmentIds = [...new Set(reservations.map((reservation) => reservation.id))];
  const linkedLeadIdByAppointment = new Map<string, string>();

  for (const group of chunks(appointmentIds)) {
    const { data, error } = await db
      .from("crm_lead_booking_links")
      .select("appointment_id,lead_id")
      .in("appointment_id", group);
    if (error) throw new Error(`syncReservation(find booking links): ${error.message}`);
    for (const row of data ?? []) {
      linkedLeadIdByAppointment.set(String(row.appointment_id), String(row.lead_id));
    }
  }

  const leadsById = new Map<string, ExistingLeadRow>();
  const linkedLeadIds = [...new Set(linkedLeadIdByAppointment.values())];
  for (const group of chunks(linkedLeadIds)) {
    const { data, error } = await db.from("leads").select("id,lead_id,metadata").in("id", group);
    if (error) throw new Error(`syncReservation(find linked leads): ${error.message}`);
    for (const row of (data ?? []) as ExistingLeadRow[]) leadsById.set(row.id, row);
  }

  const legacyByAppointment = new Map<string, ExistingLeadRow>();
  const unlinkedAppointmentIds = appointmentIds.filter((id) => !linkedLeadIdByAppointment.has(id));
  for (const group of chunks(unlinkedAppointmentIds)) {
    const { data, error } = await db
      .from("leads")
      .select("id,lead_id,metadata,booking_appointment_id")
      .in("booking_appointment_id", group);
    if (error) throw new Error(`syncReservation(find legacy appointments): ${error.message}`);
    for (const row of (data ?? []) as ExistingLeadRow[]) {
      if (row.booking_appointment_id) legacyByAppointment.set(row.booking_appointment_id, row);
    }
  }

  const unresolvedPhones = [
    ...new Set(
      reservations
        .filter(
          (reservation) =>
            !linkedLeadIdByAppointment.has(reservation.id) &&
            !legacyByAppointment.has(reservation.id),
        )
        .map((reservation) => phoneDuplicateKey(reservation.patientPhone))
        .filter((phone): phone is string => Boolean(phone)),
    ),
  ];
  const unresolvedMrns = [
    ...new Set(
      reservations
        .filter(
          (reservation) =>
            !linkedLeadIdByAppointment.has(reservation.id) &&
            !legacyByAppointment.has(reservation.id),
        )
        .map((reservation) => normalizePatientMrn(reservation.patientMrn))
        .filter((mrn): mrn is string => Boolean(mrn)),
    ),
  ];
  const leadsByMrn = new Map<string, ExistingLeadRow>();
  for (const group of chunks(unresolvedMrns)) {
    const { data, error } = await db
      .from("leads")
      .select("id,lead_id,mrn,metadata,booking_appointment_id,status,normalized_phone,created_at")
      .in("mrn", group)
      .is("merged_into_lead_id", null)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`syncReservation(find MRNs): ${error.message}`);
    for (const row of (data ?? []) as ExistingLeadRow[]) {
      if (row.mrn && !leadsByMrn.has(row.mrn)) leadsByMrn.set(row.mrn, row);
    }
  }
  const leadsByPhone = new Map<string, ExistingLeadRow>();
  for (const group of chunks(unresolvedPhones)) {
    const phoneFilters = group.map((phone) =>
      phone.length >= 7
        ? `normalized_phone.ilike.%${phone}`
        : `normalized_phone.eq.${phone}`,
    );
    const { data, error } = await db
      .from("leads")
      .select("id,lead_id,metadata,booking_appointment_id,status,normalized_phone,created_at")
      .or(phoneFilters.join(","))
      .is("merged_into_lead_id", null)
      .order("created_at", { ascending: false });
    if (error) throw new Error(`syncReservation(find phones): ${error.message}`);
    for (const row of (data ?? []) as ExistingLeadRow[]) {
      const phoneKey = phoneDuplicateKey(row.normalized_phone);
      if (phoneKey && !leadsByPhone.has(phoneKey)) {
        leadsByPhone.set(phoneKey, row);
      }
    }
  }

  return { linkedLeadIdByAppointment, leadsById, legacyByAppointment, leadsByMrn, leadsByPhone };
}

async function nextLeadCode(db: ReturnType<typeof supabaseAdmin>): Promise<string> {
  const { data: generated, error } = await db.rpc("crm_generate_lead_id");
  if (!error && generated) return String(generated);
  const { data } = await db.from("leads").select("lead_id").order("lead_id", { ascending: false }).limit(1).maybeSingle();
  const last = data?.lead_id as string | undefined;
  const n = last && /^L\d+$/.test(last) ? Number(last.slice(1)) + 1 : 1;
  return `L${String(n).padStart(4, "0")}`;
}

async function logSystemLeadEvent(params: {
  leadUid: string;
  action: string;
  title: string;
  body?: string | null;
  oldValues?: Record<string, unknown>;
  newValues?: Record<string, unknown>;
}) {
  const db = supabaseAdmin();
  const [audit, timeline] = await Promise.all([
    db.from("audit_logs").insert({
      actor_user_id: null,
      action: params.action,
      entity_type: "lead",
      entity_id: params.leadUid,
      old_values: params.oldValues ?? {},
      new_values: params.newValues ?? {},
      metadata: { actor_name: "System" },
    }),
    db.from("lead_timeline_events").insert({
      lead_id: params.leadUid,
      event_type: params.action,
      title: params.title,
      body: params.body ?? null,
      actor_user_id: null,
      metadata: { ...(params.newValues ?? {}), actor_name: "System" },
    }),
  ]);
  if (audit.error) throw new Error(`syncReservation(audit): ${audit.error.message}`);
  if (timeline.error) throw new Error(`syncReservation(timeline): ${timeline.error.message}`);
}

async function linkBooking(leadUid: string, appointmentId: string, source = "website"): Promise<void> {
  const { error } = await supabaseAdmin().from("crm_lead_booking_links").upsert({
    lead_id: leadUid,
    appointment_id: appointmentId,
    source,
  }, { onConflict: "appointment_id" });
  if (error) throw new Error(`syncReservation(booking link): ${error.message}`);
}

export async function syncReservationsToLeads(reservations: Reservation[]): Promise<Map<string, SyncedReservationLead>> {
  const db = supabaseAdmin();
  const result = new Map<string, SyncedReservationLead>();
  if (reservations.length === 0) return result;

  const { linkedLeadIdByAppointment, leadsById, legacyByAppointment, leadsByMrn, leadsByPhone } =
    await loadExistingReservations(reservations);

  for (const reservation of reservations) {
    const now = new Date().toISOString();
    const normalizedPhone = normalizePhone(reservation.patientPhone);
    const patientMrn = normalizePatientMrn(reservation.patientMrn);
    const phoneParts = splitPhone(reservation.patientPhone);
    const meta = {
      channel: "website_booking",
      booking_appointment_id: reservation.id,
      booking_status: reservation.status,
      doctor_id: reservation.doctorId ?? null,
      doctor_name: reservation.doctorName ?? null,
      branch_id: reservation.branchId ?? null,
      branch_name: reservation.branchName ?? null,
      specialty_id: reservation.specialtyId ?? null,
      specialty_name: reservation.specialtyName ?? null,
      service_id: reservation.serviceId ?? null,
      service_name: reservation.serviceName ?? null,
      appointment_date: reservation.date,
      start_time: reservation.startTime,
      primary_complaint: reservation.primaryComplaint ?? null,
      referral_source: reservation.referralSource ?? null,
      fee_at_booking: reservation.feeAtBooking ?? null,
      patient_mrn: patientMrn,
      is_new_patient: reservation.isNewPatient,
      booked_at: reservation.createdAt,
      ingested_at: now,
    };

    const linkedLeadId = linkedLeadIdByAppointment.get(reservation.id);
    const linkedLead = linkedLeadId ? leadsById.get(linkedLeadId) : undefined;
    const legacyLead = legacyByAppointment.get(reservation.id);
    const byAppointment = linkedLead ?? legacyLead;
    if (byAppointment) {
      if (!linkedLead) await linkBooking(byAppointment.id, reservation.id);
      await applyPatientSourceToLead(byAppointment.id, PATIENT_SOURCES.eurocure.id, {
        origin: "website_booking_sync_existing",
        appointment_id: reservation.id,
      });
      result.set(reservation.id, {
        leadId: byAppointment.lead_id,
        revisiting: isRevisitingMetadata(byAppointment.metadata),
      });
      continue;
    }

    const byMrn = patientMrn ? leadsByMrn.get(patientMrn) : undefined;
    const matchablePhone = phoneDuplicateKey(reservation.patientPhone);
    const byPhone = matchablePhone ? leadsByPhone.get(matchablePhone) : undefined;
    const matchedLead = byMrn ?? byPhone;
    const matchedBy: RevisitingMatch | null = byMrn ? "mrn" : byPhone ? "phone" : null;
    if (matchedLead && matchedBy) {
      const oldValues = { booking_appointment_id: matchedLead.booking_appointment_id, status: matchedLead.status };
      const nextStatus = reservation.status === "confirmed" || reservation.status === "attended" ? "booked" : "new_lead";
      const { error: updateError } = await db
        .from("leads")
        .update({
          booking_appointment_id: reservation.id,
          service_name: reservation.serviceName ?? undefined,
          status: nextStatus,
          has_unread: true,
          unread_since: now,
          last_incoming_at: now,
          metadata: withRevisitingMetadata({ ...((matchedLead.metadata as Record<string, unknown> | null) ?? {}), ...meta }, matchedBy, reservation.id),
          updated_at: now,
        })
        .eq("id", matchedLead.id);
      if (updateError) throw new Error(`syncReservation(link): ${updateError.message}`);
      await linkBooking(matchedLead.id as string, reservation.id);
      await applyPatientSourceToLead(matchedLead.id as string, PATIENT_SOURCES.eurocure.id, {
        origin: "website_booking_sync_revisit",
        appointment_id: reservation.id,
      });
      await assignRevisitingPatientTag(matchedLead.id as string);
      await logSystemLeadEvent({
        leadUid: matchedLead.id as string,
        action: "lead.booking_linked",
        title: "Revisiting patient reservation linked",
        body: `${reservation.date} ${reservation.startTime}`,
        oldValues,
        newValues: { booking_appointment_id: reservation.id, booking_status: reservation.status, status: nextStatus, revisiting_patient: true, matched_by: matchedBy },
      });
      result.set(reservation.id, { leadId: matchedLead.lead_id, revisiting: true });
      continue;
    }

    const leadCode = await nextLeadCode(db);
    const newStatus = reservation.status === "confirmed" || reservation.status === "attended" ? "booked" : "new_lead";
    const { data: created, error: createError } = await db
      .from("leads")
      .insert({
        lead_id: leadCode,
        mrn: patientMrn,
        name: reservation.patientName,
        status: newStatus,
        platform: "web",
        phone_country_code: phoneParts.cc,
        phone_number: phoneParts.number,
        normalized_phone: normalizedPhone,
        service_name: reservation.serviceName ?? null,
        booking_appointment_id: reservation.id,
        source_id: process.env.CRM_BOOKING_SOURCE_ID || null,
        patient_source_key: PATIENT_SOURCES.eurocure.id,
        escalation_status: "none",
        has_unread: true,
        unread_since: now,
        unread_message_count: 1,
        last_incoming_at: now,
        first_contact_at: reservation.createdAt,
        metadata: meta,
      })
      .select("id,lead_id")
      .single();
    if (createError) throw new Error(`syncReservation(create): ${createError.message}`);
    await applyPatientSourceToLead(created.id as string, PATIENT_SOURCES.eurocure.id, {
      origin: "website_booking_sync",
      appointment_id: reservation.id,
    });
    await linkBooking(created.id as string, reservation.id);
    await logSystemLeadEvent({
      leadUid: created.id as string,
      action: "lead.created_from_booking",
      title: "Lead created from reservation",
      body: `${reservation.date} ${reservation.startTime}`,
      newValues: { lead_id: created.lead_id, booking_appointment_id: reservation.id, booking_status: reservation.status },
    });
    const createdPhoneKey = phoneDuplicateKey(normalizedPhone);
    if (createdPhoneKey) {
      leadsByPhone.set(createdPhoneKey, {
        id: created.id as string,
        lead_id: created.lead_id as string,
        metadata: meta,
        booking_appointment_id: reservation.id,
        status: newStatus,
        normalized_phone: normalizedPhone,
      });
    }
    if (patientMrn) {
      leadsByMrn.set(patientMrn, {
        id: created.id as string,
        lead_id: created.lead_id as string,
        mrn: patientMrn,
        metadata: meta,
        booking_appointment_id: reservation.id,
        status: newStatus,
        normalized_phone: normalizedPhone,
      });
    }
    result.set(reservation.id, { leadId: created.lead_id as string, revisiting: false });
  }
  return result;
}
