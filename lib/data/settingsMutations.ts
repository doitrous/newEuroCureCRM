import "server-only";
import { supabaseAdmin } from "@/lib/supabase/server";
import { writeActor } from "@/lib/data/actor";
import { assertCan } from "@/lib/auth/permissions";
import { logActivity } from "@/lib/audit/log";
import { patientSourceFromValue } from "@/lib/patient-source/catalog";

/**
 * Write side for the Settings backbone (§C). Every mutation here:
 *   1. resolves the real signed-in actor (never an impersonated one);
 *   2. re-authorizes server-side via `settings.manage` — the UI hiding a button
 *      is never the security boundary;
 *   3. performs the write against the feature's own table;
 *   4. records an `audit_logs` entry (who / when / old / new) via {@link logActivity}.
 */

export class SettingsError extends Error {}

async function guard() {
  const actor = await writeActor();
  assertCan(actor.role, "settings.manage");
  return actor;
}

/* ── Tags (lead_tags) ─────────────────────────────────────────── */

export async function upsertTag(input: {
  id?: string;
  name: string;
  color?: string | null;
  displayOrder?: number;
  isActive?: boolean;
}): Promise<void> {
  const actor = await guard();
  const name = input.name.trim();
  if (!name) throw new SettingsError("Tag name is required.");
  const db = supabaseAdmin();

  if (input.id) {
    const { data: before } = await db.from("lead_tags").select("name,color,is_active,display_order").eq("id", input.id).maybeSingle();
    const { data: patientSource } = await db
      .from("crm_patient_sources")
      .select("display_label")
      .eq("tag_id", input.id)
      .maybeSingle();
    if (patientSource && (name !== patientSource.display_label || input.isActive === false)) {
      throw new SettingsError("Canonical patient-source tags cannot be renamed or disabled.");
    }
    const patch = {
      name,
      color: input.color ?? null,
      display_order: input.displayOrder ?? 0,
      is_active: input.isActive ?? true,
      updated_at: new Date().toISOString(),
    };
    const { error } = await db.from("lead_tags").update(patch).eq("id", input.id);
    if (error) throw new SettingsError(error.message);
    await logActivity({
      actorId: actor.id,
      action: "settings.tag_updated",
      entityType: "tag",
      entityId: input.id,
      oldValues: (before ?? {}) as Record<string, unknown>,
      newValues: patch,
    });
    return;
  }

  if (patientSourceFromValue(name)) {
    throw new SettingsError("This name is reserved for a canonical patient source.");
  }

  const { data, error } = await db
    .from("lead_tags")
    .insert({ name, color: input.color ?? null, display_order: input.displayOrder ?? 0, is_active: input.isActive ?? true })
    .select("id")
    .single();
  if (error) throw new SettingsError(error.message);
  await logActivity({
    actorId: actor.id,
    action: "settings.tag_created",
    entityType: "tag",
    entityId: data.id as string,
    newValues: { name, color: input.color ?? null, display_order: input.displayOrder ?? 0, is_active: input.isActive ?? true },
  });
}

/* ── Lost reasons (lost_reasons) ──────────────────────────────── */

export async function upsertLostReason(input: {
  id?: string;
  label: string;
  isActive?: boolean;
  displayOrder?: number;
}): Promise<void> {
  const actor = await guard();
  const label = input.label.trim();
  if (!label) throw new SettingsError("Lost reason label is required.");
  const db = supabaseAdmin();

  if (input.id) {
    const { data: before } = await db.from("lost_reasons").select("label,is_active,display_order").eq("id", input.id).maybeSingle();
    const patch = {
      label,
      is_active: input.isActive ?? true,
      display_order: input.displayOrder ?? 0,
      updated_at: new Date().toISOString(),
    };
    const { error } = await db.from("lost_reasons").update(patch).eq("id", input.id);
    if (error) throw new SettingsError(error.message);
    await logActivity({
      actorId: actor.id,
      action: "settings.lost_reason_updated",
      entityType: "lost_reason",
      entityId: input.id,
      oldValues: (before ?? {}) as Record<string, unknown>,
      newValues: patch,
    });
    return;
  }

  const { data, error } = await db
    .from("lost_reasons")
    .insert({ label, is_active: input.isActive ?? true, display_order: input.displayOrder ?? 0 })
    .select("id")
    .single();
  if (error) throw new SettingsError(error.message);
  await logActivity({
    actorId: actor.id,
    action: "settings.lost_reason_created",
    entityType: "lost_reason",
    entityId: data.id as string,
    newValues: { label, is_active: input.isActive ?? true },
  });
}

/* ── Escalation reasons (crm_escalation_reasons) ─────────────── */

export async function upsertEscalationReason(input: {
  id?: string;
  label: string;
  severity?: "low" | "medium" | "high" | "critical";
  isActive?: boolean;
  displayOrder?: number;
}): Promise<void> {
  const actor = await guard();
  const label = input.label.trim();
  if (!label) throw new SettingsError("Escalation reason label is required.");
  const severity = input.severity ?? "medium";
  const db = supabaseAdmin();

  if (input.id) {
    const { data: before } = await db.from("crm_escalation_reasons").select("label,severity,is_active,display_order").eq("id", input.id).maybeSingle();
    const patch = {
      label,
      severity,
      is_active: input.isActive ?? true,
      display_order: input.displayOrder ?? 0,
      updated_at: new Date().toISOString(),
    };
    const { error } = await db.from("crm_escalation_reasons").update(patch).eq("id", input.id);
    if (error) throw new SettingsError(error.message);
    await logActivity({
      actorId: actor.id,
      action: "settings.escalation_reason_updated",
      entityType: "escalation_reason",
      entityId: input.id,
      oldValues: (before ?? {}) as Record<string, unknown>,
      newValues: patch,
    });
    return;
  }

  const { data, error } = await db
    .from("crm_escalation_reasons")
    .insert({ label, severity, is_active: input.isActive ?? true, display_order: input.displayOrder ?? 0 })
    .select("id")
    .single();
  if (error) throw new SettingsError(error.message);
  await logActivity({
    actorId: actor.id,
    action: "settings.escalation_reason_created",
    entityType: "escalation_reason",
    entityId: data.id as string,
    newValues: { label, severity, is_active: input.isActive ?? true, display_order: input.displayOrder ?? 0 },
  });
}

/* ── SLA / stage reply rules (crm_stage_reply_rules) ──────────── */

export async function updateSlaRule(input: {
  id: string;
  replyDeadlineMinutes: number;
  warningThresholdMinutes: number;
  isActive: boolean;
}): Promise<void> {
  const actor = await guard();
  if (input.replyDeadlineMinutes <= 0) throw new SettingsError("Reply deadline must be positive.");
  if (input.warningThresholdMinutes < 0) throw new SettingsError("Warning threshold cannot be negative.");
  const db = supabaseAdmin();
  const { data: before } = await db
    .from("crm_stage_reply_rules")
    .select("stage_key,reply_deadline_minutes,warning_threshold_minutes,is_active")
    .eq("id", input.id)
    .maybeSingle();
  const patch = {
    reply_deadline_minutes: input.replyDeadlineMinutes,
    warning_threshold_minutes: input.warningThresholdMinutes,
    is_active: input.isActive,
    updated_at: new Date().toISOString(),
  };
  const { error } = await db.from("crm_stage_reply_rules").update(patch).eq("id", input.id);
  if (error) throw new SettingsError(error.message);
  if (before?.stage_key) {
    const { data: openLeads, error: openError } = await db
      .from("leads")
      .select("id,unread_since")
      .eq("status", before.stage_key)
      .eq("has_unread", true)
      .not("unread_since", "is", null);
    if (openError) throw new SettingsError(openError.message);
    const now = Date.now();
    await Promise.all((openLeads ?? []).map(async (lead) => {
      const deadline = new Date(new Date(String(lead.unread_since)).getTime() + input.replyDeadlineMinutes * 60_000).toISOString();
      const result = await db.from("leads").update({
        reply_overdue_at: deadline,
        is_reply_overdue: input.isActive && new Date(deadline).getTime() <= now,
      }).eq("id", lead.id);
      if (result.error) throw new SettingsError(result.error.message);
    }));
  }
  await logActivity({
    actorId: actor.id,
    action: "settings.sla_rule_updated",
    entityType: "sla_rule",
    entityId: input.id,
    oldValues: (before ?? {}) as Record<string, unknown>,
    newValues: patch,
  });
}

/* ── Follow-up workflow stages (crm_followup_workflow_stages) ─── */

export async function upsertFollowUpStage(input: {
  id?: string;
  workflowType: "regular" | "postop";
  name: string;
  stageOrder: number;
  dueAfterAmount: number;
  dueAfterUnit: "hours" | "days" | "weeks";
  anchor?: string;
  applicableStatus?: string | null;
  applicableTagId?: string | null;
  moderatorInstruction?: string | null;
  isActive?: boolean;
}): Promise<void> {
  const actor = await guard();
  const name = input.name.trim();
  if (!name) throw new SettingsError("Step name is required.");
  if (input.dueAfterAmount < 0) throw new SettingsError("Delay cannot be negative.");
  const db = supabaseAdmin();
  const row = {
    workflow_type: input.workflowType,
    name,
    stage_order: input.stageOrder,
    due_after_amount: input.dueAfterAmount,
    due_after_unit: input.dueAfterUnit,
    anchor: input.anchor?.trim() || "stage_entry",
    applicable_status: input.applicableStatus?.trim() || null,
    applicable_tag_id: input.applicableTagId || null,
    plan_version: 1,
    moderator_instruction: input.moderatorInstruction ?? null,
    is_active: input.isActive ?? true,
    updated_at: new Date().toISOString(),
  };

  if (input.id) {
    const { data: before } = await db.from("crm_followup_workflow_stages").select("*").eq("id", input.id).maybeSingle();
    const nextVersion = (((before?.plan_version as number | undefined) ?? 1) + 1);
    const { error } = await db.from("crm_followup_workflow_stages").update({ ...row, plan_version: nextVersion }).eq("id", input.id);
    if (error) throw new SettingsError(error.message);
    await logActivity({
      actorId: actor.id,
      action: "settings.followup_stage_updated",
      entityType: "followup_stage",
      entityId: input.id,
      oldValues: (before ?? {}) as Record<string, unknown>,
      newValues: { ...row, plan_version: nextVersion },
    });
    return;
  }

  const { data, error } = await db.from("crm_followup_workflow_stages").insert(row).select("id").single();
  if (error) throw new SettingsError(error.message);
  await logActivity({
    actorId: actor.id,
    action: "settings.followup_stage_created",
    entityType: "followup_stage",
    entityId: data.id as string,
    newValues: row,
  });
}

export async function deleteFollowUpStage(id: string): Promise<void> {
  const actor = await guard();
  const db = supabaseAdmin();
  const { data: before } = await db.from("crm_followup_workflow_stages").select("*").eq("id", id).maybeSingle();
  const { error } = await db.from("crm_followup_workflow_stages").delete().eq("id", id);
  if (error) throw new SettingsError(error.message);
  await logActivity({
    actorId: actor.id,
    action: "settings.followup_stage_deleted",
    entityType: "followup_stage",
    entityId: id,
    oldValues: (before ?? {}) as Record<string, unknown>,
  });
}

/* ── Target CPL + auditor thresholds (auditor_settings) ───────── */

export async function updateAuditorTargets(input: {
  targetCplEgp: number;
  responseTimeThresholdMinutes?: number;
  followupCompletionTarget?: number;
}): Promise<void> {
  const actor = await guard();
  if (input.targetCplEgp < 0) throw new SettingsError("Target CPL cannot be negative.");
  const db = supabaseAdmin();

  // auditor_settings is effective-dated; update the current row if one exists,
  // otherwise create the first. Only whitelisted numeric fields are touched.
  const { data: current } = await db
    .from("auditor_settings")
    .select("id,target_cpl_egp,response_time_threshold_minutes,followup_completion_target")
    .order("effective_from", { ascending: false })
    .limit(1)
    .maybeSingle();

  const patch: Record<string, unknown> = {
    target_cpl_egp: input.targetCplEgp,
    updated_at: new Date().toISOString(),
  };
  if (input.responseTimeThresholdMinutes !== undefined)
    patch.response_time_threshold_minutes = input.responseTimeThresholdMinutes;
  if (input.followupCompletionTarget !== undefined)
    patch.followup_completion_target = input.followupCompletionTarget;

  if (current?.id) {
    const { error } = await db.from("auditor_settings").update(patch).eq("id", current.id);
    if (error) throw new SettingsError(error.message);
    await logActivity({
      actorId: actor.id,
      action: "settings.auditor_targets_updated",
      entityType: "auditor_settings",
      entityId: current.id as string,
      oldValues: (current ?? {}) as Record<string, unknown>,
      newValues: patch,
    });
    return;
  }

  const { data, error } = await db
    .from("auditor_settings")
    .insert({ ...patch, created_by: actor.id })
    .select("id")
    .single();
  if (error) throw new SettingsError(error.message);
  await logActivity({
    actorId: actor.id,
    action: "settings.auditor_targets_created",
    entityType: "auditor_settings",
    entityId: data.id as string,
    newValues: patch,
  });
}

/* ── AI reply-assistant prompt (ai_prompt_templates) ──────────── */

export async function updateAiPrompt(input: {
  id?: string;
  promptKey: string;
  title: string;
  systemPrompt: string;
  replyRules?: string | null;
}): Promise<void> {
  const actor = await guard();
  const systemPrompt = input.systemPrompt.trim();
  if (!systemPrompt) throw new SettingsError("The system prompt cannot be empty.");
  const db = supabaseAdmin();

  if (input.id) {
    const { data: before } = await db
      .from("ai_prompt_templates")
      .select("system_prompt,reply_rules,version")
      .eq("id", input.id)
      .maybeSingle();
    const patch = {
      system_prompt: systemPrompt,
      reply_rules: input.replyRules ?? null,
      title: input.title.trim() || "CRM reply assistant",
      version: ((before?.version as number) ?? 1) + 1,
      updated_at: new Date().toISOString(),
    };
    const { error } = await db.from("ai_prompt_templates").update(patch).eq("id", input.id);
    if (error) throw new SettingsError(error.message);
    await logActivity({
      actorId: actor.id,
      action: "settings.ai_prompt_updated",
      entityType: "ai_prompt",
      entityId: input.id,
      oldValues: (before ?? {}) as Record<string, unknown>,
      newValues: patch,
    });
    return;
  }

  const { data, error } = await db
    .from("ai_prompt_templates")
    .insert({
      prompt_key: input.promptKey || "crm_reply_assistant",
      title: input.title.trim() || "CRM reply assistant",
      system_prompt: systemPrompt,
      reply_rules: input.replyRules ?? null,
      provider: "n8n",
      is_active: true,
      created_by: actor.id,
    })
    .select("id")
    .single();
  if (error) throw new SettingsError(error.message);
  await logActivity({
    actorId: actor.id,
    action: "settings.ai_prompt_created",
    entityType: "ai_prompt",
    entityId: data.id as string,
    newValues: { prompt_key: input.promptKey, system_prompt: systemPrompt },
  });
}
