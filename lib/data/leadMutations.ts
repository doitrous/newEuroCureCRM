import "server-only";
import { supabaseAdmin } from "@/lib/supabase/server";
import { writeActor } from "@/lib/data/actor";
import { createFollowUpProgramForLead, ensureFollowUpPlanForLead } from "@/lib/data/followupPlans";
import { assertCan } from "@/lib/auth/permissions";
import type { PipelineStage, ReferenceOption } from "@/lib/types";
import { bookingCatalog } from "@/lib/booking/service";
import { notifyLeadStatusChanged } from "@/lib/email/triggers";
import { PATIENT_SOURCES } from "@/lib/patient-source/catalog";
import { applyPatientSourceToLead } from "@/lib/patient-source/server";

type NoteKey = "clientNotes" | "medicalHistory" | "generalNotes";

const UI_TO_DB_STAGE: Record<PipelineStage, string> = {
  new: "new_lead",
  qualified: "qualified",
  booked: "booked",
  follow_up: "follow_up",
  post_op: "post_op_follow_up",
  lost: "lost",
};

const DB_TO_LABEL: Record<string, string> = {
  new_lead: "New",
  qualified: "Qualified",
  booked: "Booked",
  follow_up: "Follow-Up",
  post_op_follow_up: "Post-Op F/U",
  lost: "Lost",
};

const NOTE_COLUMN: Record<NoteKey, string> = {
  clientNotes: "notes",
  medicalHistory: "medical_history",
  generalNotes: "medical_notes",
};

const NOTE_LABEL: Record<NoteKey, string> = {
  clientNotes: "Client Notes",
  medicalHistory: "Medical History",
  generalNotes: "Notes",
};

export class LeadMutationError extends Error {}

async function writeLeadActor() {
  const actor = await writeActor();
  assertCan(actor.role, "leads.edit");
  return actor;
}

function asNoteKey(value: string): NoteKey {
  if (value === "clientNotes" || value === "medicalHistory" || value === "generalNotes") {
    return value;
  }
  throw new LeadMutationError("Unknown note section.");
}

async function resolveLead(leadId: string) {
  const { data, error } = await supabaseAdmin()
    .from("leads")
    .select("id,lead_id,name,status,notes,medical_notes,medical_history,lost_reason_id,lost_notes,escalation_status,metadata,has_unread")
    .eq("lead_id", leadId)
    .maybeSingle();
  if (error) throw new Error(`resolveLead: ${error.message}`);
  if (!data) throw new LeadMutationError("Lead not found.");
  return data as {
    id: string;
    lead_id: string;
    name: string | null;
    status: string | null;
    notes: string | null;
    medical_notes: string | null;
    medical_history: string | null;
    lost_reason_id: string | null;
    lost_notes: string | null;
    escalation_status: string | null;
    metadata: Record<string, unknown> | null;
    has_unread: boolean;
  };
}

export async function markLeadRead(leadId: string): Promise<void> {
  const [actor, lead] = await Promise.all([writeLeadActor(), resolveLead(leadId)]);
  if (!lead.has_unread && !lead.metadata?.moderator_notice) return;
  const metadata = { ...(lead.metadata ?? {}) };
  delete metadata.moderator_notice;
  delete metadata.moderator_notice_tab;
  delete metadata.moderator_notice_escalation_id;
  delete metadata.moderator_notice_at;
  const { error } = await supabaseAdmin()
    .from("leads")
    .update({ has_unread: false, unread_since: null, metadata, updated_at: new Date().toISOString() })
    .eq("id", lead.id);
  if (error) throw new Error(`markLeadRead: ${error.message}`);
  await audit({
    actorId: actor.id,
    action: "lead.marked_read",
    entityType: "lead",
    entityId: lead.id,
    oldValues: { has_unread: lead.has_unread },
    newValues: { has_unread: false },
    metadata: { lead_id: leadId, actor_name: actor.name },
  });
}

export async function updateLeadProfile(input: {
  leadId: string;
  name: string;
  phone: string;
  additionalPhone?: string | null;
  mrn: string | null;
  gender: "male" | "female" | null;
  specialtyId: string | null;
  specialtyIds: string[];
  serviceIds: string[];
  doctorIds: string[];
}): Promise<void> {
  const actor = await writeLeadActor();
  const [lead, catalog] = await Promise.all([resolveLead(input.leadId), bookingCatalog()]);
  const name = input.name.trim();
  const phone = input.phone.trim();
  if (!name) throw new LeadMutationError("Patient name is required.");
  if (!phone) throw new LeadMutationError("Phone number is required.");
  const mrn = input.mrn?.trim() || null;
  if (mrn && !/^\d{1,9}$/.test(mrn)) throw new LeadMutationError("MRN must contain 1 to 9 digits.");
  const specialty = catalog.specialties.find((row) => row.id === input.specialtyId);
  const specialtyIds = [...new Set([...(specialty ? [specialty.id] : []), ...input.specialtyIds])]
    .filter((id) => catalog.specialties.some((row) => row.id === id));
  const uniqueServiceIds = [...new Set(input.serviceIds)];
  const selectedServices = uniqueServiceIds.map((id) => catalog.services.find((row) => row.id === id)).filter((row): row is NonNullable<typeof row> => Boolean(row));
  if (input.serviceIds.length && selectedServices.length !== uniqueServiceIds.length) throw new LeadMutationError("One or more selected services are not in the Admin service catalog.");
  const selectedDoctors = [...new Set(input.doctorIds)].map((id) => catalog.doctors.find((row) => row.id === id)).filter((row): row is NonNullable<typeof row> => Boolean(row));
  if (input.doctorIds.length && selectedDoctors.length !== new Set(input.doctorIds).size) throw new LeadMutationError("One or more selected doctors are not in the Admin doctor catalog.");
  const digits = phone.replace(/\D/g, "");
  const ccMatch = phone.match(/^\s*(\+\d{1,4})[\s-]+(.+)$/);
  const db = supabaseAdmin();
  const { error: assignmentSchemaError } = await db.from("crm_lead_treating_doctors").select("id").limit(1);
  if (assignmentSchemaError) throw new LeadMutationError("Treating-doctor storage is not available until migration 0019 is applied.");
  if (mrn) {
    const { data: duplicateMrn, error: duplicateError } = await db.from("leads").select("lead_id").eq("mrn", mrn).neq("id", lead.id).limit(1).maybeSingle();
    if (duplicateError) throw new Error(`updateLeadProfile(MRN check): ${duplicateError.message}`);
    if (duplicateMrn) {
      const { data: duplicateLead } = await db.from("leads").select("id").eq("lead_id", duplicateMrn.lead_id).single();
      if (duplicateLead?.id) {
        await db.from("lead_duplicate_flags").upsert({
          lead_id: lead.id < duplicateLead.id ? lead.id : duplicateLead.id,
          duplicate_lead_id: lead.id < duplicateLead.id ? duplicateLead.id : lead.id,
          duplicate_type: "mrn",
          identifier_value: mrn,
          confidence_score: 1,
          status: "pending",
          notes: "Repeated MRN entered from Patient Info. Review side by side and link identities.",
        }, { onConflict: "lead_id,duplicate_lead_id,duplicate_type,identifier_value" });
      }
      throw new LeadMutationError(`MRN ${mrn} belongs to ${duplicateMrn.lead_id}. A side-by-side identity review has been created in Timeline → Duplicates; link the records instead of overwriting either history.`);
    }
  }
  const { data: before, error: beforeError } = await db.from("leads").select("name,mrn,phone_country_code,phone_number,gender,service_name,doctor_id,metadata").eq("id", lead.id).single();
  if (beforeError) throw new Error(`updateLeadProfile(read): ${beforeError.message}`);
  const patch = {
    name,
    mrn,
    phone_country_code: ccMatch?.[1] ?? null,
    phone_number: (ccMatch?.[2] ?? phone).replace(/\s+/g, " "),
    normalized_phone: digits || null,
    gender: input.gender,
    service_name: selectedServices[0]?.nameEn ?? null,
    doctor_id: selectedDoctors[0]?.id ?? null,
    metadata: {
      ...((before.metadata as Record<string, unknown> | null) ?? {}),
      specialty_id: specialty?.id ?? null,
      specialty_ids: specialtyIds,
      specialty_names: specialtyIds.map((id) => catalog.specialties.find((row) => row.id === id)?.nameEn).filter(Boolean),
      service_ids: selectedServices.map((service) => service.id),
      service_names: selectedServices.map((service) => service.nameEn),
      treating_doctor_names: selectedDoctors.map((doctor) => doctor.nameEn),
    },
    updated_at: new Date().toISOString(),
  };
  const { error } = await db.from("leads").update(patch).eq("id", lead.id);
  if (error) throw new Error(`updateLeadProfile: ${error.message}`);
  const primaryPhone = {
    lead_id: lead.id,
    country_code: ccMatch?.[1] ?? null,
    phone_number: (ccMatch?.[2] ?? phone).replace(/\s+/g, " "),
    normalized_phone: digits,
    label: "Mobile",
    is_primary: true,
    updated_at: new Date().toISOString(),
  };
  const { error: clearPrimaryError } = await db.from("crm_lead_phones").update({ is_primary: false }).eq("lead_id", lead.id);
  if (clearPrimaryError) throw new Error(`updateLeadProfile(phone primary): ${clearPrimaryError.message}`);
  const { error: primaryPhoneError } = await db.from("crm_lead_phones").upsert(primaryPhone, { onConflict: "lead_id,normalized_phone" });
  if (primaryPhoneError) throw new Error(`updateLeadProfile(phone): ${primaryPhoneError.message}`);
  const additionalPhone = input.additionalPhone?.trim();
  if (additionalPhone) {
    const extraDigits = additionalPhone.replace(/\D/g, "");
    if (extraDigits.length < 7) throw new LeadMutationError("The additional phone number is too short.");
    const extraCc = additionalPhone.match(/^\s*(\+\d{1,4})[\s-]+(.+)$/);
    const { error: extraError } = await db.from("crm_lead_phones").upsert({
      lead_id: lead.id,
      country_code: extraCc?.[1] ?? null,
      phone_number: (extraCc?.[2] ?? additionalPhone).replace(/\s+/g, " "),
      normalized_phone: extraDigits,
      label: "Additional",
      is_primary: false,
      updated_at: new Date().toISOString(),
    }, { onConflict: "lead_id,normalized_phone" });
    if (extraError) throw new Error(`updateLeadProfile(additional phone): ${extraError.message}`);
  }
  const { error: deactivateError } = await db.from("crm_lead_treating_doctors").update({ active: false, updated_at: new Date().toISOString() }).eq("lead_id", lead.id);
  if (deactivateError) throw new Error(`updateLeadProfile(doctors): ${deactivateError.message}`);
  if (selectedDoctors.length) {
    const rows = selectedDoctors.map((doctor, index) => ({
      lead_id: lead.id,
      doctor_id: doctor.id,
      doctor_name: doctor.nameEn,
      specialty_id: doctor.specialtyId || specialty?.id || null,
      specialty_name: catalog.specialties.find((row) => row.id === (doctor.specialtyId || specialty?.id))?.nameEn ?? null,
      service_id: null,
      service_name: null,
      is_primary: index === 0,
      active: true,
      created_by: actor.id,
      updated_at: new Date().toISOString(),
    }));
    const { error: assignmentError } = await db.from("crm_lead_treating_doctors").upsert(rows, { onConflict: "lead_id,doctor_id,service_id" });
    if (assignmentError) throw new Error(`updateLeadProfile(assign doctors): ${assignmentError.message}`);
  }
  await audit({ actorId: actor.id, action: "lead.profile_updated", entityType: "lead", entityId: lead.id, oldValues: before as Record<string, unknown>, newValues: { ...patch, service_ids: selectedServices.map((service) => service.id), treating_doctor_ids: selectedDoctors.map((doctor) => doctor.id) }, metadata: { lead_id: input.leadId, actor_name: actor.name } });
}

async function audit(params: {
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  oldValues?: Record<string, unknown>;
  newValues?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}) {
  const { error } = await supabaseAdmin().from("audit_logs").insert({
    actor_user_id: params.actorId,
    action: params.action,
    entity_type: params.entityType,
    entity_id: params.entityId,
    old_values: params.oldValues ?? {},
    new_values: params.newValues ?? {},
    metadata: params.metadata ?? {},
  });
  if (error) throw new Error(`audit: ${error.message}`);
}

async function timeline(params: {
  leadUid: string;
  actorId: string;
  eventType: string;
  title: string;
  body?: string | null;
  metadata?: Record<string, unknown>;
}) {
  const { error } = await supabaseAdmin().from("lead_timeline_events").insert({
    lead_id: params.leadUid,
    event_type: params.eventType,
    title: params.title,
    body: params.body ?? null,
    actor_user_id: params.actorId,
    metadata: params.metadata ?? {},
  });
  if (error) throw new Error(`timeline: ${error.message}`);
}

export async function activeLeadTags(): Promise<ReferenceOption[]> {
  const { data, error } = await supabaseAdmin()
    .from("lead_tags")
    .select("id,name,color")
    .eq("is_active", true)
    .order("name", { ascending: true });
  if (error) throw new Error(`activeLeadTags: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    label: r.name as string,
    color: (r.color as string) ?? undefined,
  }));
}

export async function activeLostReasons(): Promise<ReferenceOption[]> {
  const { data, error } = await supabaseAdmin()
    .from("lost_reasons")
    .select("id,label")
    .eq("is_active", true)
    .order("display_order", { ascending: true });
  if (error) throw new Error(`activeLostReasons: ${error.message}`);
  return (data ?? []).map((r) => ({
    id: r.id as string,
    label: r.label as string,
  }));
}

export async function saveLeadNote(leadId: string, rawKey: string, value: string): Promise<void> {
  const key = asNoteKey(rawKey);
  const [actor, lead] = await Promise.all([writeLeadActor(), resolveLead(leadId)]);
  const column = NOTE_COLUMN[key] as "notes" | "medical_history" | "medical_notes";
  const oldValue = lead[column] ?? "";
  const nextValue = value.trim();

  const { data: saved, error } = await supabaseAdmin()
    .from("leads")
    .update({ [column]: nextValue, updated_at: new Date().toISOString() })
    .eq("id", lead.id)
    .select("id")
    .single();
  if (error) throw new Error(`saveLeadNote: ${error.message}`);
  if (!saved) throw new Error("saveLeadNote: Supabase did not return the updated lead.");

  await Promise.all([audit({
    actorId: actor.id,
    action: "lead.note_updated",
    entityType: "lead",
    entityId: lead.id,
    oldValues: { [column]: oldValue },
    newValues: { [column]: nextValue },
    metadata: { lead_id: leadId, field: column, label: NOTE_LABEL[key], actor_name: actor.name },
  }), timeline({
    leadUid: lead.id,
    actorId: actor.id,
    eventType: "note_updated",
    title: `Note updated: ${NOTE_LABEL[key]}`,
    metadata: { field: column },
  })]);

}

export async function updateLeadStage(params: {
  leadId: string;
  stage: PipelineStage;
  lostReasonId?: string;
  lostNotes?: string;
}): Promise<void> {
  const [actor, lead] = await Promise.all([writeLeadActor(), resolveLead(params.leadId)]);
  const nextStatus = UI_TO_DB_STAGE[params.stage];
  const patch: Record<string, unknown> = { status: nextStatus };

  if (params.stage === "lost") {
    if (!params.lostReasonId) throw new LeadMutationError("Choose a lost reason.");
    const { data: reason, error: reasonError } = await supabaseAdmin()
      .from("lost_reasons")
      .select("id,label")
      .eq("id", params.lostReasonId)
      .eq("is_active", true)
      .maybeSingle();
    if (reasonError) throw new Error(`lostReason: ${reasonError.message}`);
    if (!reason) throw new LeadMutationError("Lost reason is not available.");
    patch.lost_reason_id = params.lostReasonId;
    patch.lost_notes = params.lostNotes?.trim() || null;
  } else {
    patch.lost_reason_id = null;
    patch.lost_notes = null;
  }

  const { error } = await supabaseAdmin().from("leads").update(patch).eq("id", lead.id);
  if (error) throw new Error(`updateLeadStage: ${error.message}`);

  if (params.stage === "follow_up" || params.stage === "post_op") {
    await ensureFollowUpPlanForLead(params.leadId);
  }

  await Promise.all([audit({
    actorId: actor.id,
    action: "lead.status_updated",
    entityType: "lead",
    entityId: lead.id,
    oldValues: {
      status: lead.status,
      lost_reason_id: lead.lost_reason_id,
      lost_notes: lead.lost_notes,
    },
    newValues: patch,
    metadata: { lead_id: params.leadId, actor_name: actor.name },
  }), timeline({
    leadUid: lead.id,
    actorId: actor.id,
    eventType: "stage_change",
    title: `Stage -> ${nextStatus}`,
    body: params.stage === "lost" ? params.lostNotes?.trim() || null : null,
    metadata: {
      from: lead.status,
      to: nextStatus,
      from_label: lead.status ? DB_TO_LABEL[lead.status] : null,
      to_label: DB_TO_LABEL[nextStatus],
    },
  })]);

  try {
    await notifyLeadStatusChanged({
      leadUid: lead.id,
      leadId: params.leadId,
      patientName: lead.name || "Lead",
      fromStatus: lead.status ?? "",
      toStatus: nextStatus,
    });
  } catch (emailError) {
    console.error("lead_status_changed email dispatch failed", emailError);
  }
}

export async function setLeadTagAssignments(leadId: string, tagIds: string[]): Promise<string[]> {
  const actor = await writeLeadActor();
  const lead = await resolveLead(leadId);
  let unique = [...new Set(tagIds.filter(Boolean))];

  const [{ data: leadSource, error: leadSourceError }, { data: sourceRows, error: sourceRowsError }] = await Promise.all([
    supabaseAdmin().from("leads").select("patient_source_key").eq("id", lead.id).single(),
    supabaseAdmin().from("crm_patient_sources").select("key,tag_id").eq("is_active", true),
  ]);
  if (leadSourceError) throw new Error(`leadPatientSource: ${leadSourceError.message}`);
  if (sourceRowsError) throw new Error(`patientSources: ${sourceRowsError.message}`);
  const sourceTagByKey = new Map((sourceRows ?? []).map((row) => [String(row.key), String(row.tag_id)]));
  const sourceKeyByTag = new Map((sourceRows ?? []).map((row) => [String(row.tag_id), String(row.key)]));
  const requestedSourceKeys = [...new Set(unique.map((id) => sourceKeyByTag.get(id)).filter(Boolean))] as string[];
  const currentSourceKey = leadSource.patient_source_key ? String(leadSource.patient_source_key) : null;
  if (requestedSourceKeys.length > 1) throw new LeadMutationError("A lead cannot have more than one patient source.");
  if (currentSourceKey && requestedSourceKeys.length && requestedSourceKeys[0] !== currentSourceKey) {
    throw new LeadMutationError("The existing patient source cannot be replaced through ordinary tag editing.");
  }
  if (!currentSourceKey && requestedSourceKeys.length === 1) {
    await applyPatientSourceToLead(lead.id, requestedSourceKeys[0] as keyof typeof PATIENT_SOURCES, {
      origin: "explicit_tag_edit",
      actor_id: actor.id,
    });
  }
  const effectiveSourceKey = currentSourceKey || requestedSourceKeys[0] || null;
  const preservedSourceTagId = effectiveSourceKey ? sourceTagByKey.get(effectiveSourceKey) : null;
  unique = [
    ...unique.filter((id) => !sourceKeyByTag.has(id)),
    ...(preservedSourceTagId ? [preservedSourceTagId] : []),
  ];

  const { data: active, error: activeError } = await supabaseAdmin()
    .from("lead_tags")
    .select("id,name")
    .eq("is_active", true)
    .in("id", unique.length ? unique : ["00000000-0000-0000-0000-000000000000"]);
  if (activeError) throw new Error(`leadTags: ${activeError.message}`);
  if ((active ?? []).length !== unique.length) {
    throw new LeadMutationError("One or more selected tags are not available.");
  }

  const { data: existing, error: existingError } = await supabaseAdmin()
    .from("lead_tag_assignments")
    .select("tag_id,lead_tags(name)")
    .eq("lead_id", lead.id);
  if (existingError) throw new Error(`leadTagAssignments: ${existingError.message}`);
  const oldTagIds = ((existing ?? []) as { tag_id: string }[]).map((r) => r.tag_id);

  const toAdd = unique.filter((id) => !oldTagIds.includes(id));
  const toRemove = oldTagIds.filter((id) => !unique.includes(id));

  if (toRemove.length) {
    const { error } = await supabaseAdmin()
      .from("lead_tag_assignments")
      .delete()
      .eq("lead_id", lead.id)
      .in("tag_id", toRemove);
    if (error) throw new Error(`removeLeadTags: ${error.message}`);
  }
  if (toAdd.length) {
    const { error } = await supabaseAdmin().from("lead_tag_assignments").insert(
      toAdd.map((tagId) => ({
        lead_id: lead.id,
        tag_id: tagId,
        assigned_by: actor.id,
      })),
    );
    if (error) throw new Error(`addLeadTags: ${error.message}`);
  }

  // Never report success until the database confirms the exact assignment set.
  // This catches partial writes, unexpected triggers, and stale-client races.
  const { data: persisted, error: persistedError } = await supabaseAdmin()
    .from("lead_tag_assignments")
    .select("tag_id")
    .eq("lead_id", lead.id);
  if (persistedError) throw new Error(`verifyLeadTags: ${persistedError.message}`);
  const persistedIds = ((persisted ?? []) as { tag_id: string }[]).map((row) => row.tag_id).sort();
  const requestedIds = [...unique].sort();
  if (persistedIds.length !== requestedIds.length || persistedIds.some((id, index) => id !== requestedIds[index])) {
    throw new LeadMutationError("Tags could not be verified after saving. Refresh and try again.");
  }

  await audit({
    actorId: actor.id,
    action: "lead.tags_updated",
    entityType: "lead",
    entityId: lead.id,
    oldValues: { tag_ids: oldTagIds },
    newValues: { tag_ids: unique },
    metadata: { lead_id: leadId, actor_name: actor.name },
  });
  await timeline({
    leadUid: lead.id,
    actorId: actor.id,
    eventType: "tags_updated",
    title: "Tags updated",
    metadata: { tag_ids: unique },
  });
  const labelById = new Map((active ?? []).map((tag) => [tag.id as string, tag.name as string]));
  return unique.map((id) => labelById.get(id)).filter((label): label is string => Boolean(label));
}

export async function escalateLead(params: {
  leadId: string;
  reason: string;
  severity?: string;
}): Promise<void> {
  const reason = params.reason.trim();
  if (!reason) throw new LeadMutationError("Escalation reason is required.");
  const actor = await writeLeadActor();
  const lead = await resolveLead(params.leadId);
  const severity = ["low", "medium", "high", "critical"].includes(params.severity ?? "")
    ? params.severity
    : "medium";

  const { data: escalation, error: escalationError } = await supabaseAdmin()
    .from("escalations")
    .insert({
      lead_id: lead.id,
      status: "escalated",
      reason,
      severity,
      requested_by: actor.id,
    })
    .select("id")
    .single();
  if (escalationError) throw new Error(`escalateLead: ${escalationError.message}`);

  const { error: leadError } = await supabaseAdmin()
    .from("leads")
    .update({ escalation_status: "escalated" })
    .eq("id", lead.id);
  if (leadError) throw new Error(`escalateLeadStatus: ${leadError.message}`);

  await audit({
    actorId: actor.id,
    action: "lead.escalated",
    entityType: "lead",
    entityId: lead.id,
    oldValues: { escalation_status: lead.escalation_status },
    newValues: { escalation_status: "escalated", escalation_id: escalation.id, reason, severity },
    metadata: { lead_id: params.leadId, actor_name: actor.name },
  });
  await timeline({
    leadUid: lead.id,
    actorId: actor.id,
    eventType: "escalation_created",
    title: "Escalated to auditor",
    body: reason,
    metadata: { escalation_id: escalation.id, severity },
  });
}

export async function clearLeadEscalation(leadId: string, note?: string): Promise<void> {
  const actor = await writeLeadActor();
  const lead = await resolveLead(leadId);
  const now = new Date().toISOString();

  const { error: escalationError } = await supabaseAdmin()
    .from("escalations")
    .update({
      status: "resolved",
      resolved_by: actor.id,
      resolved_at: now,
      notes: note?.trim() || "Un-escalated by moderator.",
    })
    .eq("lead_id", lead.id)
    .neq("status", "resolved");
  if (escalationError) throw new Error(`clearEscalations: ${escalationError.message}`);

  const { error: leadError } = await supabaseAdmin()
    .from("leads")
    .update({ escalation_status: "none" })
    .eq("id", lead.id);
  if (leadError) throw new Error(`clearLeadEscalation: ${leadError.message}`);

  await audit({
    actorId: actor.id,
    action: "lead.unescalated",
    entityType: "lead",
    entityId: lead.id,
    oldValues: { escalation_status: lead.escalation_status },
    newValues: { escalation_status: "none", note: note ?? null },
    metadata: { lead_id: leadId, actor_name: actor.name },
  });
  await timeline({
    leadUid: lead.id,
    actorId: actor.id,
    eventType: "escalation_cleared",
    title: "Escalation cleared",
    body: note?.trim() || null,
  });
}

function normalizeWorkflowType(workflowType: string): "follow_up" | "post_op" {
  if (workflowType === "post_op" || workflowType === "postop") return "post_op";
  return "follow_up";
}

async function activeFollowUpStage(leadUid: string, stageId?: string) {
  let query = supabaseAdmin()
    .from("lead_follow_up_stages")
    .select("id,lead_id,workflow_type,stage_number,due_at,notes,status,outcome")
    .eq("lead_id", leadUid)
    .neq("status", "completed")
    .order("due_at", { ascending: true, nullsFirst: false })
    .limit(1);
  if (stageId) query = query.eq("id", stageId);
  const { data, error } = await query.maybeSingle();
  if (error) throw new Error(`activeFollowUpStage: ${error.message}`);
  if (!data) throw new LeadMutationError("No active follow-up is scheduled for this lead.");
  return data as {
    id: string;
    lead_id: string;
    workflow_type: string;
    stage_number: number;
    due_at: string | null;
    notes: string | null;
    status: string;
    outcome: string | null;
  };
}

export async function scheduleFollowUp(params: {
  leadId: string;
  workflowType: string;
  dueAt: string;
  notes?: string;
}): Promise<void> {
  const actor = await writeLeadActor();
  const lead = await resolveLead(params.leadId);
  const workflowType = normalizeWorkflowType(params.workflowType);
  const dueAt = new Date(params.dueAt);
  if (Number.isNaN(dueAt.getTime())) throw new LeadMutationError("Choose a valid follow-up date and time.");

  const { data: latest, error: latestError } = await supabaseAdmin()
    .from("lead_follow_up_stages")
    .select("stage_number")
    .eq("lead_id", lead.id)
    .eq("workflow_type", workflowType)
    .order("stage_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latestError) throw new Error(`followUpLatestStage: ${latestError.message}`);
  const stageNumber = ((latest?.stage_number as number | undefined) ?? 0) + 1;

  const { data: created, error } = await supabaseAdmin()
    .from("lead_follow_up_stages")
    .insert({
      lead_id: lead.id,
      workflow_type: workflowType,
      stage_number: stageNumber,
      due_at: dueAt.toISOString(),
      assigned_to: actor.id,
      notes: params.notes?.trim() || null,
      status: "not_started",
    })
    .select("id")
    .single();
  if (error) throw new Error(`scheduleFollowUp: ${error.message}`);

  await audit({
    actorId: actor.id,
    action: "lead.follow_up_scheduled",
    entityType: "lead",
    entityId: lead.id,
    oldValues: {},
    newValues: {
      follow_up_stage_id: created.id,
      workflow_type: workflowType,
      stage_number: stageNumber,
      due_at: dueAt.toISOString(),
      notes: params.notes?.trim() || null,
    },
    metadata: { lead_id: params.leadId, actor_name: actor.name },
  });
  await timeline({
    leadUid: lead.id,
    actorId: actor.id,
    eventType: "follow_up_scheduled",
    title: "Follow-up scheduled",
    body: params.notes?.trim() || null,
    metadata: { follow_up_stage_id: created.id, workflow_type: workflowType, stage_number: stageNumber },
  });
}

export async function addFollowUpProgram(leadId: string, workflowType: string): Promise<void> {
  const actor = await writeLeadActor();
  const normalized = normalizeWorkflowType(workflowType);
  await createFollowUpProgramForLead(leadId, normalized, actor.id);
}

export async function completeFollowUp(params: {
  leadId: string;
  followUpId?: string;
  outcome?: string;
}): Promise<void> {
  const actor = await writeLeadActor();
  const lead = await resolveLead(params.leadId);
  const stage = await activeFollowUpStage(lead.id, params.followUpId);
  const now = new Date().toISOString();
  const outcome = params.outcome?.trim() || "Completed";

  const { error } = await supabaseAdmin()
    .from("lead_follow_up_stages")
    .update({ status: "completed", completed_at: now, completed_by: actor.id, outcome, updated_at: now })
    .eq("id", stage.id);
  if (error) throw new Error(`completeFollowUp: ${error.message}`);

  await audit({
    actorId: actor.id,
    action: "lead.follow_up_completed",
    entityType: "lead",
    entityId: lead.id,
    oldValues: { follow_up_stage_id: stage.id, status: stage.status, outcome: stage.outcome },
    newValues: { follow_up_stage_id: stage.id, status: "completed", outcome },
    metadata: { lead_id: params.leadId, actor_name: actor.name },
  });
  await timeline({
    leadUid: lead.id,
    actorId: actor.id,
    eventType: "follow_up_completed",
    title: "Follow-up completed",
    body: outcome,
    metadata: { follow_up_stage_id: stage.id },
  });
}

export async function snoozeFollowUp(params: {
  leadId: string;
  followUpId?: string;
  days?: number;
}): Promise<void> {
  const actor = await writeLeadActor();
  const lead = await resolveLead(params.leadId);
  const stage = await activeFollowUpStage(lead.id, params.followUpId);
  const days = Math.max(1, Math.min(30, Math.floor(params.days ?? 1)));
  const base = stage.due_at ? new Date(stage.due_at) : new Date();
  const next = new Date(base.getTime() + days * 24 * 60 * 60 * 1000);
  const now = new Date().toISOString();

  const { error } = await supabaseAdmin()
    .from("lead_follow_up_stages")
    .update({ due_at: next.toISOString(), snoozed_at: now, snoozed_by: actor.id, updated_at: now })
    .eq("id", stage.id);
  if (error) throw new Error(`snoozeFollowUp: ${error.message}`);

  await audit({
    actorId: actor.id,
    action: "lead.follow_up_snoozed",
    entityType: "lead",
    entityId: lead.id,
    oldValues: { follow_up_stage_id: stage.id, due_at: stage.due_at },
    newValues: { follow_up_stage_id: stage.id, due_at: next.toISOString(), days },
    metadata: { lead_id: params.leadId, actor_name: actor.name },
  });
  await timeline({
    leadUid: lead.id,
    actorId: actor.id,
    eventType: "follow_up_snoozed",
    title: "Follow-up snoozed",
    body: `${days} day${days === 1 ? "" : "s"}`,
    metadata: { follow_up_stage_id: stage.id, due_at: next.toISOString() },
  });
}

export async function resolveEscalationWorkflow(params: {
  escalationId: string;
  resolution: "returned" | "resolved";
  note?: string;
}): Promise<{ leadId: string; resolution: "returned" | "resolved"; note: string | null }> {
  const actor = await writeLeadActor();
  const db = supabaseAdmin();
  const now = new Date().toISOString();
  const { data: escalation, error: loadError } = await db
    .from("escalations")
    .select("id,lead_id,status,notes")
    .eq("id", params.escalationId)
    .maybeSingle();
  if (loadError) throw new Error(`resolveEscalationWorkflow(load): ${loadError.message}`);
  if (!escalation) throw new LeadMutationError("Escalation not found.");
  const leadUid = escalation.lead_id as string;
  const note = params.note?.trim() || null;
  const { data: leadRow, error: leadLoadError } = await db
    .from("leads")
    .select("lead_id,metadata")
    .eq("id", leadUid)
    .maybeSingle<{ lead_id: string; metadata: Record<string, unknown> | null }>();
  if (leadLoadError) throw new Error(`resolveEscalationWorkflow(lead): ${leadLoadError.message}`);
  if (!leadRow) throw new LeadMutationError("Lead not found for this escalation.");

  if (params.resolution === "returned") {
    const { error } = await db
      .from("escalations")
      .update({ status: "in_review", assigned_to: null, notes: note, updated_at: now })
      .eq("id", params.escalationId);
    if (error) throw new Error(`returnEscalation: ${error.message}`);
    const { error: leadError } = await db
      .from("leads")
      .update({
        escalation_status: "in_review",
        has_unread: true,
        unread_since: now,
        metadata: {
          ...(leadRow.metadata ?? {}),
          moderator_notice: note ?? "The escalation was reviewed and returned by an admin or auditor.",
          moderator_notice_tab: "Log",
          moderator_notice_escalation_id: params.escalationId,
          moderator_notice_at: now,
        },
      })
      .eq("id", leadUid);
    if (leadError) throw new Error(`returnEscalationLead: ${leadError.message}`);
    const { error: unreadError } = await db.from("crm_unread_events").insert({
      lead_id: leadUid,
      event_type: "escalation_returned",
      actor_id: actor.id,
      reason: note ?? "Returned to moderator",
      previous_state: { escalation_status: escalation.status },
      new_state: { escalation_status: "in_review" },
    });
    if (unreadError) throw new Error(`returnEscalationUnread: ${unreadError.message}`);
  } else {
    const { error } = await db
      .from("escalations")
      .update({ status: "resolved", resolved_by: actor.id, resolved_at: now, notes: note, updated_at: now })
      .eq("id", params.escalationId);
    if (error) throw new Error(`resolveEscalationWorkflow: ${error.message}`);
    const { error: leadError } = await db
      .from("leads")
      .update({ escalation_status: "none" })
      .eq("id", leadUid);
    if (leadError) throw new Error(`resolveEscalationLead: ${leadError.message}`);
  }

  await audit({
    actorId: actor.id,
    action: params.resolution === "returned" ? "lead.escalation_returned" : "lead.escalation_resolved",
    entityType: "lead",
    entityId: leadUid,
    oldValues: { escalation_status: escalation.status, notes: escalation.notes },
    newValues: { escalation_status: params.resolution === "returned" ? "in_review" : "resolved", notes: note },
    metadata: { escalation_id: params.escalationId, actor_name: actor.name },
  });
  await timeline({
    leadUid,
    actorId: actor.id,
    eventType: params.resolution === "returned" ? "escalation_returned" : "escalation_resolved",
    title: params.resolution === "returned" ? "Escalation sent back" : "Escalation resolved",
    body: note,
    metadata: { escalation_id: params.escalationId },
  });
  return { leadId: leadRow.lead_id, resolution: params.resolution, note };
}

export async function mergeDuplicateFlag(flagId: string, notes?: string, keepStatus?: PipelineStage): Promise<void> {
  const actor = await writeLeadActor();
  const { error } = await supabaseAdmin().rpc("crm_merge_duplicate_flag_with_status", {
    target_flag_id: flagId,
    actor_id: actor.id,
    merge_note: notes?.trim() || null,
    keep_status: keepStatus ? UI_TO_DB_STAGE[keepStatus] : null,
  });
  if (error) throw new Error(`mergeDuplicateFlag: ${error.message}`);
}

export async function createManualLead(params: {
  name: string;
  phone: string;
  platform: string;
  sourceId?: string;
  serviceName?: string;
  mrn?: string;
  gender?: "male" | "female";
  notes?: string;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const actor = await writeLeadActor();
  const name = params.name.trim();
  const phone = params.phone.trim();
  if (!name) throw new LeadMutationError("Patient name is required.");
  if (!phone) throw new LeadMutationError("Phone is required.");
  const mrn = params.mrn?.trim() || null;
  if (mrn && !/^\d{1,9}$/.test(mrn)) throw new LeadMutationError("MRN must contain 1 to 9 digits.");

  const db = supabaseAdmin();
  if (mrn) {
    const { data: duplicateMrn, error: duplicateError } = await db.from("leads").select("lead_id").eq("mrn", mrn).limit(1).maybeSingle();
    if (duplicateError) throw new Error(`createManualLead(MRN check): ${duplicateError.message}`);
    if (duplicateMrn) throw new LeadMutationError(`MRN ${mrn} is already assigned to lead ${duplicateMrn.lead_id}.`);
  }

  const { data: generatedLeadId, error: idError } = await db.rpc("crm_generate_lead_id");
  if (idError) throw new Error(`crm_generate_lead_id: ${idError.message}`);
  const leadId = String(generatedLeadId);

  const { data, error } = await db
    .from("leads")
    .insert({
      lead_id: leadId,
      name,
      mrn,
      phone_country_code: "+20",
      phone_number: phone,
      platform: params.platform || "manual",
      patient_source_key: PATIENT_SOURCES.eurocure.id,
      source_id: params.sourceId || null,
      service_name: params.serviceName?.trim() || null,
      gender: params.gender ?? null,
      notes: params.notes?.trim() || null,
      metadata: params.metadata ?? {},
      status: "new_lead",
      has_unread: false,
      escalation_status: "none",
      coordinator_user_id: actor.id,
    })
    .select("id,lead_id")
    .single();
  if (error) throw new Error(`createManualLead: ${error.message}`);

  await audit({
    actorId: actor.id,
    action: "lead.created_manual",
    entityType: "lead",
    entityId: data.id as string,
    newValues: { lead_id: data.lead_id, name, phone, mrn, platform: params.platform },
    metadata: { actor_name: actor.name },
  });
  await timeline({
    leadUid: data.id as string,
    actorId: actor.id,
    eventType: "lead_created",
    title: "Lead created manually",
  });

  return data.lead_id as string;
}
