"use server";

import { randomUUID } from "crypto";
import { revalidatePath } from "next/cache";
import { assertCan, PermissionError } from "@/lib/auth/permissions";
import { ActorError, writeActor } from "@/lib/data/actor";
import { logActivity } from "@/lib/audit/log";
import { supabaseAdmin } from "@/lib/supabase/server";
import { forcedLeadName } from "@/lib/import/leadImportMapping";
import { phoneDigits, phoneDuplicateKey } from "@/lib/phoneMatching";
import { resolvePatientSource, type PatientSourceId } from "@/lib/patient-source/catalog";
import { applyPatientSourceToLead } from "@/lib/patient-source/server";

export interface LeadImportRowInput {
  rowIndex: number;
  name?: string;
  phone?: string;
  mrn?: string;
  nationality?: string;
  gender?: "male" | "female";
  source?: string;
  serviceName?: string;
  doctorName?: string;
  specialtyName?: string;
  age?: number;
  patientType?: string;
  notes?: string;
}

export interface LeadImportRowResult {
  rowIndex: number;
  status: "imported" | "merged" | "existing" | "skipped" | "error";
  leadId?: string;
  message: string;
}

export interface LeadImportResult {
  ok: boolean;
  error?: string;
  imported: number;
  merged: number;
  existing: number;
  skipped: number;
  failed: number;
  rows: LeadImportRowResult[];
}

export interface LeadImportOptions {
  importInvalid: boolean;
  mergeSameMrn: boolean;
  mergeSamePhone: boolean;
  batch?: {
    importId: string;
    index: number;
    total: number;
    isFinal: boolean;
  };
}

interface ExistingMatch {
  match: "mrn" | "phone" | "import_row";
  lead: Record<string, unknown> & { id: string; lead_id: string };
}

const EXISTING_COLUMNS = "id,lead_id,name,mrn,phone_number,service_name,gender,notes,metadata";

async function existingLead(row: LeadImportRowInput, importId?: string): Promise<ExistingMatch | null> {
  const db = supabaseAdmin();
  if (row.mrn && /^\d{1,9}$/.test(row.mrn)) {
    const { data, error } = await db.from("leads").select(EXISTING_COLUMNS).eq("mrn", row.mrn.trim()).is("merged_into_lead_id", null).limit(1).maybeSingle();
    if (error) throw error;
    if (data?.lead_id) return { match: "mrn", lead: data as ExistingMatch["lead"] };
  }
  const phone = phoneDuplicateKey(row.phone);
  if (phone) {
    const phoneQuery = db.from("leads").select(EXISTING_COLUMNS).is("merged_into_lead_id", null).limit(1);
    const { data, error } = await (phone.length >= 7
      ? phoneQuery.ilike("normalized_phone", `%${phone}`)
      : phoneQuery.or(`normalized_phone.eq.${phone},normalized_phone.eq.20${phone}`)).maybeSingle();
    if (error) throw error;
    if (data?.lead_id) return { match: "phone", lead: data as ExistingMatch["lead"] };
  }
  // Rows explicitly imported despite missing MRN/phone have no natural
  // identity. The import id + original row number makes a resumed batch
  // idempotent instead of creating a second placeholder lead.
  if (importId) {
    const { data, error } = await db
      .from("leads")
      .select(EXISTING_COLUMNS)
      .eq("metadata->>bulk_import_id", importId)
      .eq("metadata->>import_row", String(row.rowIndex + 1))
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    if (data?.lead_id) return { match: "import_row", lead: data as ExistingMatch["lead"] };
  }
  return null;
}

async function sourceId(
  label: string | undefined,
  cache?: Map<string, string | undefined>,
): Promise<string | undefined> {
  const source = label?.trim();
  if (!source) return undefined;
  const key = source.toLocaleLowerCase();
  if (cache?.has(key)) return cache.get(key);
  const db = supabaseAdmin();
  const byKey = await db.from("lead_sources").select("id").ilike("key", source).limit(1).maybeSingle();
  if (byKey.error) throw byKey.error;
  if (byKey.data?.id) {
    const id = byKey.data.id as string;
    cache?.set(key, id);
    return id;
  }
  const byLabel = await db.from("lead_sources").select("id").ilike("label", source).limit(1).maybeSingle();
  if (byLabel.error) throw byLabel.error;
  const id = byLabel.data?.id as string | undefined;
  cache?.set(key, id);
  return id;
}

function emptyResult(error: string): LeadImportResult {
  return { ok: false, error, imported: 0, merged: 0, existing: 0, skipped: 0, failed: 0, rows: [] };
}

function identityErrors(row: LeadImportRowInput): string[] {
  const errors: string[] = [];
  if (!row.name?.trim()) errors.push("Patient name is required");
  const phone = phoneDigits(row.phone);
  if (!row.phone?.trim()) errors.push("Phone number is required");
  else if (phone.length < 7) errors.push("Phone number must contain at least 7 digits");
  if (!row.mrn?.trim()) errors.push("MRN is required");
  else if (!/^\d{1,9}$/.test(row.mrn.trim())) errors.push("MRN must contain 1 to 9 digits");
  if (!row.nationality?.trim()) errors.push("Nationality is required");
  return errors;
}

function importMetadata(row: LeadImportRowInput, errors: string[], importId?: string, databaseRecord = true) {
  return {
    imported_via: "patient_bulk_import",
    ...(databaseRecord ? { record_source: "database" } : {}),
    imported_at: new Date().toISOString(),
    import_row: row.rowIndex + 1,
    import_validation_errors: errors,
    imported_mrn_raw: row.mrn ?? null,
    nationality: row.nationality ?? null,
    original_source_name: row.source ?? null,
    doctor_name: row.doctorName ?? null,
    specialty_name: row.specialtyName ?? null,
    patient_age: row.age ?? null,
    patient_type: row.patientType ?? null,
    bulk_import_id: importId ?? null,
  };
}

async function createImportedLead(
  row: LeadImportRowInput,
  actorId: string,
  errors: string[],
  sourceCache: Map<string, string | undefined>,
  importId?: string,
): Promise<{ leadId: string; uid: string }> {
  const db = supabaseAdmin();
  const validMrn = row.mrn && /^\d{1,9}$/.test(row.mrn.trim()) ? row.mrn.trim() : null;
  const patientSource = resolvePatientSource([{ patient_source: row.source }]);
  const patientSourceKey = patientSource.status === "resolved" ? patientSource.source.id : null;
  const { data, error } = await db.from("leads").insert({
    // `crm_prepare_lead` generates the sequential lead ID atomically. Omitting
    // it here removes one network round-trip per imported row.
    // An explicit override may have no usable name. Give it a traceable neutral
    // display name while preserving the original validation error in metadata.
    name: forcedLeadName(row.name, row.rowIndex),
    mrn: validMrn,
    phone_country_code: row.phone?.trim() ? "+20" : null,
    phone_number: row.phone?.trim() || null,
    platform: "manual",
    source_id: await sourceId("database", sourceCache),
    patient_source_key: patientSourceKey,
    service_name: row.serviceName?.trim() || null,
    gender: row.gender ?? null,
    notes: row.notes?.trim() || null,
    // The schema requires a pipeline status. `record_source=database` is the
    // authoritative queue gate, so this record is visible only in Database
    // until a later reservation marks it as a revisiting patient.
    status: "new_lead",
    has_unread: false,
    escalation_status: "none",
    coordinator_user_id: actorId,
    metadata: importMetadata(row, errors, importId),
  }).select("id,lead_id").single();
  if (error || !data) throw error ?? new Error("Could not create imported lead.");
  return { leadId: String(data.lead_id), uid: String(data.id) };
}

async function mergeImportedRow(match: ExistingMatch, row: LeadImportRowInput, errors: string[], importId?: string): Promise<void> {
  const current = match.lead;
  const metadata = (current.metadata as Record<string, unknown> | null) ?? {};
  const patch: Record<string, unknown> = { metadata: { ...metadata, ...importMetadata(row, errors, importId, false), bulk_merged_by: match.match }, updated_at: new Date().toISOString() };
  if (!current.name && row.name?.trim()) patch.name = row.name.trim();
  if (!current.mrn && row.mrn && /^\d{1,9}$/.test(row.mrn.trim())) patch.mrn = row.mrn.trim();
  if (!current.phone_number && row.phone?.trim()) { patch.phone_country_code = "+20"; patch.phone_number = row.phone.trim(); }
  if (!current.service_name && row.serviceName?.trim()) patch.service_name = row.serviceName.trim();
  if (!current.gender && row.gender) patch.gender = row.gender;
  if (!current.notes && row.notes?.trim()) patch.notes = row.notes.trim();
  const { error } = await supabaseAdmin().from("leads").update(patch).eq("id", current.id);
  if (error) throw error;
  const patientSource = resolvePatientSource([{ patient_source: row.source }]);
  if (patientSource.status === "resolved") {
    await applyPatientSourceToLead(current.id, patientSource.source.id as PatientSourceId, {
      origin: "historical_import_merge",
      import_id: importId ?? null,
      row: row.rowIndex + 1,
    });
  }
}

export async function importLeadRows(rows: LeadImportRowInput[], options: LeadImportOptions): Promise<LeadImportResult> {
  let actor: Awaited<ReturnType<typeof writeActor>>;
  try {
    actor = await writeActor();
    assertCan(actor.role, "leads.bulkImport");
  } catch (error) {
    if (error instanceof PermissionError) return emptyResult("Only an admin or auditor may bulk import patient leads.");
    if (error instanceof ActorError) return emptyResult(error.message);
    throw error;
  }

  if (!Array.isArray(rows) || rows.length === 0) return emptyResult("No import rows were supplied.");
  if (rows.length > 100) {
    return emptyResult("Import batches may contain at most 100 rows.");
  }

  const importId = options.batch?.importId;
  if (options.batch && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(options.batch.importId)) {
    return emptyResult("The import session ID is invalid. Start the import again.");
  }

  const results: LeadImportRowResult[] = [];
  const timelineRows: Array<Record<string, unknown>> = [];
  const sourceCache = new Map<string, string | undefined>();
  for (const row of rows) {
    try {
      const errors = identityErrors(row);
      if (errors.length && !options.importInvalid) {
        results.push({ rowIndex: row.rowIndex, status: "skipped", message: errors.join("; ") });
        continue;
      }
      const existing = await existingLead(row, importId);
      if (existing) {
        const mergeEnabled = existing.match === "mrn"
          ? options.mergeSameMrn
          : existing.match === "phone" && options.mergeSamePhone;
        if (mergeEnabled) {
          await mergeImportedRow(existing, row, errors, importId);
          results.push({ rowIndex: row.rowIndex, status: "merged", leadId: existing.lead.lead_id, message: `Merged into ${existing.lead.lead_id} by exact ${existing.match.toUpperCase()} match.` });
        } else {
          const message = existing.match === "import_row"
            ? `Row was already imported as ${existing.lead.lead_id}; safely skipped during resume.`
            : `Matched existing lead ${existing.lead.lead_id} by ${existing.match}; enable that bulk-merge option to enrich it.`;
          results.push({ rowIndex: row.rowIndex, status: "existing", leadId: existing.lead.lead_id, message });
        }
        continue;
      }
      // The batch already authenticated the actor and checked MRN/phone
      // duplicates. Avoid calling the general manual-lead flow, which repeats
      // both operations for every spreadsheet row.
      const created = await createImportedLead(row, actor.id, errors, sourceCache, importId);
      timelineRows.push({ lead_id: created.uid, event_type: "lead_created", title: "Lead created by bulk import", actor_user_id: actor.id, metadata: { import_row: row.rowIndex + 1, forced_invalid_import: errors.length > 0, bulk_import_id: importId ?? null } });
      results.push({ rowIndex: row.rowIndex, status: "imported", leadId: created.leadId, message: `Created database patient ${created.leadId}.` });
    } catch (error) {
      console.error("Bulk lead import row failed", {
        row: row.rowIndex + 1,
        code: typeof error === "object" && error && "code" in error ? String(error.code) : undefined,
      });
      results.push({ rowIndex: row.rowIndex, status: "error", message: "This row could not be imported. Review its identity fields and try again." });
    }
  }

  if (timelineRows.length) {
    const { error } = await supabaseAdmin().from("lead_timeline_events").insert(timelineRows);
    if (error) console.error("Bulk lead import timeline batch failed", { count: timelineRows.length, code: error.code });
  }

  if (options.batch?.isFinal ?? true) {
    for (const path of ["/bulk-import", "/database", "/leads", "/calendar"]) revalidatePath(path);
  }
  await logActivity({
    actorId: actor.id,
    action: "import.bulk_leads",
    entityType: "bulk_import",
    entityId: randomUUID(),
    newValues: {
      total: rows.length,
      imported: results.filter((row) => row.status === "imported").length,
      merged: results.filter((row) => row.status === "merged").length,
      existing: results.filter((row) => row.status === "existing").length,
      skipped: results.filter((row) => row.status === "skipped").length,
      failed: results.filter((row) => row.status === "error").length,
    },
    metadata: {
      actor_name: actor.name,
      actor_role: actor.role,
      // Counts provide the durable audit trail for successful rows. Store
      // only exceptions/details that an administrator may need to review.
      row_results: results.filter((row) => row.status !== "imported"),
      import_id: importId ?? null,
      batch_index: options.batch?.index ?? 1,
      batch_total: options.batch?.total ?? 1,
    },
  });

  return {
    ok: true,
    imported: results.filter((row) => row.status === "imported").length,
    merged: results.filter((row) => row.status === "merged").length,
    existing: results.filter((row) => row.status === "existing").length,
    skipped: results.filter((row) => row.status === "skipped").length,
    failed: results.filter((row) => row.status === "error").length,
    rows: results,
  };
}
