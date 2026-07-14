import "server-only";

import crypto from "node:crypto";
import { supabaseAdmin } from "@/lib/supabase/server";

export const GOOGLE_SHEETS_COLUMNS = [
  "ID",
  "Chat Link",
  "Status",
  "Name",
  "First Contact",
  "Gender",
  "Phone",
  "Patient Source",
  "Acquisition Source",
  "Service",
  "Doctor",
  "Notes",
  "Medical Notes",
  "Medical History",
  "Branch",
  "Campaign",
  "Ad Name",
  "Tags",
  "Escalation Status",
] as const;

type SheetsConfig = {
  spreadsheetId: string;
  tabName: string;
  serviceAccountEmail: string;
  privateKey: string;
  missing: string[];
};

function config(): SheetsConfig {
  const result = {
    spreadsheetId: process.env.CRM_GOOGLE_SHEETS_SPREADSHEET_ID || "",
    tabName: process.env.CRM_GOOGLE_SHEETS_TAB_NAME || "Leads Collection",
    serviceAccountEmail: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL || "",
    privateKey: (process.env.GOOGLE_PRIVATE_KEY || "").replace(/\\n/g, "\n"),
  };
  return {
    ...result,
    missing: [
      ["CRM_GOOGLE_SHEETS_SPREADSHEET_ID", result.spreadsheetId],
      ["GOOGLE_SERVICE_ACCOUNT_EMAIL", result.serviceAccountEmail],
      ["GOOGLE_PRIVATE_KEY", result.privateKey],
    ].filter(([, value]) => !value).map(([key]) => key),
  };
}

type ExportFilters = { status?: string; patientSource?: string; platform?: string };

async function exportRows(filters: ExportFilters, columns: readonly string[]) {
  const db = supabaseAdmin();
  const [{ data: patientSources }, { data: acquisitionSources }] = await Promise.all([
    db.from("crm_patient_sources").select("key,display_label"),
    db.from("lead_sources").select("id,label"),
  ]);
  const patientSourceLabels = new Map((patientSources ?? []).map((row) => [String(row.key), String(row.display_label)]));
  const acquisitionLabels = new Map((acquisitionSources ?? []).map((row) => [String(row.id), String(row.label)]));

  const rows: Record<string, unknown>[] = [];
  for (let start = 0; start < 20_000; start += 1_000) {
    let query = db
      .from("leads")
      .select("id,lead_id,chat_link,status,name,first_contact_at,gender,phone_country_code,phone_number,patient_source_key,source_id,service_name,doctor_id,notes,medical_notes,medical_history,branch_id,campaign,ad_name,escalation_status,lead_tag_assignments(lead_tags(name))")
      .is("merged_into_lead_id", null)
      .order("created_at", { ascending: true })
      .range(start, start + 999);
    if (filters.status) query = query.eq("status", filters.status);
    if (filters.patientSource) query = query.eq("patient_source_key", filters.patientSource);
    if (filters.platform) query = query.eq("platform", filters.platform);
    const { data, error } = await query;
    if (error) throw new Error(`Google Sheets lead export: ${error.message}`);
    rows.push(...((data ?? []) as Record<string, unknown>[]));
    if ((data?.length ?? 0) < 1_000) break;
  }

  return [
    [...columns],
    ...rows.map((lead) => {
      const assignments = Array.isArray(lead.lead_tag_assignments) ? lead.lead_tag_assignments : [];
      const tags = assignments.flatMap((assignment) => {
        const relation = (assignment as { lead_tags?: unknown }).lead_tags;
        const values = Array.isArray(relation) ? relation : relation ? [relation] : [];
        return values.map((tag) => String((tag as { name?: unknown }).name || "")).filter(Boolean);
      });
      const values: Record<string, unknown> = {
        ID: lead.lead_id,
        "Chat Link": lead.chat_link,
        Status: lead.status,
        Name: lead.name,
        "First Contact": lead.first_contact_at,
        Gender: lead.gender,
        Phone: `${lead.phone_country_code || ""} ${lead.phone_number || ""}`.trim(),
        "Patient Source": lead.patient_source_key ? patientSourceLabels.get(String(lead.patient_source_key)) : "",
        "Acquisition Source": lead.source_id ? acquisitionLabels.get(String(lead.source_id)) : "",
        Service: lead.service_name,
        Doctor: lead.doctor_id,
        Notes: lead.notes,
        "Medical Notes": lead.medical_notes,
        "Medical History": lead.medical_history,
        Branch: lead.branch_id,
        Campaign: lead.campaign,
        "Ad Name": lead.ad_name,
        Tags: tags.join(", "),
        "Escalation Status": lead.escalation_status,
      };
      return columns.map((column) => String(values[column] ?? ""));
    }),
  ];
}

function base64Url(value: string) {
  return Buffer.from(value).toString("base64url");
}

async function accessToken(settings: SheetsConfig) {
  const now = Math.floor(Date.now() / 1_000);
  const unsigned = `${base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64Url(JSON.stringify({
    iss: settings.serviceAccountEmail,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: "https://oauth2.googleapis.com/token",
    exp: now + 3_600,
    iat: now,
  }))}`;
  const signature = crypto.createSign("RSA-SHA256").update(unsigned).sign(settings.privateKey, "base64url");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const json = await response.json() as { access_token?: string; error?: string; error_description?: string };
  if (!response.ok || !json.access_token) throw new Error(json.error_description || json.error || "Google authentication failed.");
  return json.access_token;
}

async function writeValues(settings: SheetsConfig, token: string, values: string[][]) {
  await fetch(`https://sheets.googleapis.com/v4/spreadsheets/${settings.spreadsheetId}:batchUpdate`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ requests: [{ addSheet: { properties: { title: settings.tabName } } }] }),
  });
  const range = encodeURIComponent(`'${settings.tabName}'!A1`);
  const response = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${settings.spreadsheetId}/values/${range}:update?valueInputOption=RAW`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ values }),
    },
  );
  const json = await response.json().catch(() => ({})) as { error?: { message?: string } };
  if (!response.ok) throw new Error(json.error?.message || "Google Sheets write failed.");
}

export async function exportLeadsToGoogleSheets(
  filters: ExportFilters,
  columns: readonly string[] = GOOGLE_SHEETS_COLUMNS,
) {
  const settings = config();
  const safeColumns = columns.filter((column) => GOOGLE_SHEETS_COLUMNS.includes(column as typeof GOOGLE_SHEETS_COLUMNS[number]));
  const selectedColumns = safeColumns.length ? safeColumns : [...GOOGLE_SHEETS_COLUMNS];
  const values = await exportRows(filters, selectedColumns);
  const db = supabaseAdmin();
  const { data: run } = await db.from("google_sheets_export_runs").insert({
    export_scope: Object.values(filters).some(Boolean) ? "filtered" : "all",
    spreadsheet_id: settings.spreadsheetId || null,
    tab_name: settings.tabName,
    row_count: Math.max(0, values.length - 1),
    status: settings.missing.length ? "setup_required" : "pending",
    filters,
  }).select("id").maybeSingle();

  if (settings.missing.length) return { ok: false as const, setupRequired: true, missing: settings.missing, rows: values.length - 1 };
  try {
    await writeValues(settings, await accessToken(settings), values);
    if (run?.id) await db.from("google_sheets_export_runs").update({ status: "completed", completed_at: new Date().toISOString() }).eq("id", run.id);
    return { ok: true as const, rows: values.length - 1 };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Google Sheets export failed.";
    if (run?.id) await db.from("google_sheets_export_runs").update({ status: "failed", error: message, completed_at: new Date().toISOString() }).eq("id", run.id);
    return { ok: false as const, setupRequired: false, error: message, rows: values.length - 1 };
  }
}
