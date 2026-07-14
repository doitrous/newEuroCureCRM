import "server-only";

import { supabaseAdmin } from "@/lib/supabase/server";
import type { PatientSourceId } from "./catalog";

/**
 * Assigns a source only when the lead does not already have one. The database
 * RPC owns the preservation, canonical-tag and patient propagation rules so
 * every ingestion path and retry receives identical behavior.
 */
export async function applyPatientSourceToLead(
  leadId: string,
  incomingSource: PatientSourceId,
  context: Record<string, unknown> = {},
): Promise<PatientSourceId> {
  const { data, error } = await supabaseAdmin().rpc("crm_apply_patient_source", {
    target_lead_id: leadId,
    incoming_source_key: incomingSource,
    source_context: context,
  });
  if (error) throw new Error(`crm_apply_patient_source: ${error.message}`);
  return String(data) as PatientSourceId;
}
