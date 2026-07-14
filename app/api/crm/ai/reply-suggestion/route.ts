import { NextResponse } from "next/server";
import { assertCan } from "@/lib/auth/permissions";
import { writeActor } from "@/lib/data/actor";
import { supabaseAdmin } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function uuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

export async function POST(req: Request) {
  const actor = await writeActor();
  assertCan(actor.role, "leads.edit");
  const webhookUrl = process.env.N8N_AI_REPLY_WEBHOOK_URL;
  const webhookSecret = process.env.N8N_AI_REPLY_WEBHOOK_SECRET;
  if (!webhookUrl || !webhookSecret) {
    return NextResponse.json({ success: false, error: "AI reply assistant is not configured." }, { status: 428 });
  }

  let body: { lead_id?: unknown; moderator_instruction?: unknown; user_instruction?: unknown; regenerate?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON." }, { status: 400 });
  }
  if (!uuid(body.lead_id)) return NextResponse.json({ success: false, error: "A valid lead_id is required." }, { status: 400 });
  const instruction = String(body.moderator_instruction ?? body.user_instruction ?? "").trim().slice(0, 1_000);
  const db = supabaseAdmin();
  const [leadResult, messagesResult, tagsResult, promptResult] = await Promise.all([
    db.from("leads").select("id,name,status,platform,patient_source_key,source_id,service_name,doctor_id,branch_id").eq("id", body.lead_id).single(),
    db.from("crm_messages").select("id,conversation_id,direction,message_text,message_at").eq("lead_id", body.lead_id).eq("is_conversation_content", true).order("message_at", { ascending: false }).limit(30),
    db.from("lead_tag_assignments").select("lead_tags(name)").eq("lead_id", body.lead_id),
    db.from("ai_prompt_templates").select("id,system_prompt,reply_rules,tone,language,required_fields,escalation_rules,provider,model,temperature").eq("prompt_key", "reply_assistant").eq("is_active", true).order("version", { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (leadResult.error) return NextResponse.json({ success: false, error: "Lead not found." }, { status: 404 });
  if (messagesResult.error) return NextResponse.json({ success: false, error: "Conversation could not be loaded." }, { status: 500 });

  const messages = (messagesResult.data ?? []).map((message) => ({
    direction: message.direction,
    text: message.message_text,
    at: message.message_at,
  }));
  const lastIncoming = messages.find((message) => message.direction === "incoming" && message.text);
  if (!lastIncoming?.text) return NextResponse.json({ success: false, error: "No customer message is available." }, { status: 400 });
  const tags = (tagsResult.data ?? []).flatMap((assignment) => {
    const relation = assignment.lead_tags as { name?: string } | { name?: string }[] | null;
    return (Array.isArray(relation) ? relation : relation ? [relation] : []).map((tag) => tag.name).filter(Boolean);
  });

  let response: Response;
  try {
    response = await fetch(webhookUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${webhookSecret}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        lead_id: body.lead_id,
        patient_name: leadResult.data.name,
        patient_source: leadResult.data.patient_source_key,
        platform: leadResult.data.platform,
        lead_status: leadResult.data.status,
        service: leadResult.data.service_name,
        doctor: leadResult.data.doctor_id,
        branch: leadResult.data.branch_id,
        tags,
        last_customer_message: lastIncoming.text,
        recent_conversation: messages.slice().reverse(),
        moderator_instruction: instruction,
        regenerate: body.regenerate === true,
        prompt_template: promptResult.data ?? null,
      }),
    });
  } catch {
    return NextResponse.json({ success: false, error: "AI workflow is unavailable." }, { status: 502 });
  }
  const output = await response.json().catch(() => ({})) as Record<string, unknown>;
  const suggestedReply = typeof output.suggested_reply === "string" ? output.suggested_reply.trim() : "";
  if (!response.ok || !suggestedReply) {
    return NextResponse.json({ success: false, error: "AI workflow returned an invalid response." }, { status: 502 });
  }

  const { data: suggestion, error } = await db.from("ai_reply_suggestions").insert({
    lead_id: body.lead_id,
    conversation_id: messagesResult.data?.find((message) => message.conversation_id)?.conversation_id ?? null,
    requested_by: actor.id,
    prompt_template_id: promptResult.data?.id ?? null,
    moderator_instruction: instruction || null,
    last_customer_message: lastIncoming.text,
    suggested_reply: suggestedReply,
    suggested_next_action: typeof output.suggested_next_action === "string" ? output.suggested_next_action : null,
    missing_fields: Array.isArray(output.missing_fields) ? output.missing_fields : [],
    should_escalate: output.should_escalate === true,
    raw_ai_metadata: typeof output.raw_ai_metadata === "object" && output.raw_ai_metadata ? output.raw_ai_metadata : {},
    provider: typeof output.provider === "string" ? output.provider : "n8n",
    model: typeof output.model === "string" ? output.model : null,
    status: "success",
  }).select("id").single();
  if (error) return NextResponse.json({ success: false, error: "Suggestion could not be saved." }, { status: 500 });

  return NextResponse.json({
    success: true,
    suggestion_id: suggestion.id,
    suggested_reply: suggestedReply,
    suggested_next_action: output.suggested_next_action ?? null,
    missing_fields: Array.isArray(output.missing_fields) ? output.missing_fields : [],
    should_escalate: output.should_escalate === true,
  });
}

export async function PATCH(req: Request) {
  const actor = await writeActor();
  assertCan(actor.role, "leads.edit");
  const body = await req.json().catch(() => null) as { lead_id?: unknown; suggestion_id?: unknown; log_id?: unknown } | null;
  const suggestionId = body?.suggestion_id ?? body?.log_id;
  if (!body || !uuid(body.lead_id) || !uuid(suggestionId)) {
    return NextResponse.json({ success: false, error: "Valid lead_id and suggestion_id are required." }, { status: 400 });
  }
  const { data, error } = await supabaseAdmin().from("ai_reply_suggestions").update({
    accepted: true,
    accepted_at: new Date().toISOString(),
  }).eq("id", suggestionId).eq("lead_id", body.lead_id).select("id").maybeSingle();
  if (error || !data) return NextResponse.json({ success: false, error: "Suggestion not found." }, { status: 404 });
  return NextResponse.json({ success: true });
}
