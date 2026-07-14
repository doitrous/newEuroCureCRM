import { NextResponse } from "next/server";
import { exportLeadsToGoogleSheets } from "@/lib/integrations/googleSheets";
import { secretsEqual } from "@/lib/security/secrets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function presented(req: Request) {
  const bearer = req.headers.get("authorization");
  return bearer?.toLowerCase().startsWith("bearer ")
    ? bearer.slice(7).trim()
    : req.headers.get("x-api-key") ?? req.headers.get("x-crm-api-key");
}

export async function POST(req: Request) {
  const expected = process.env.CRM_INGEST_API_KEY || process.env.CRON_SECRET;
  if (!expected || !secretsEqual(presented(req), expected)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  let body: { filters?: { status?: string; patientSource?: string; platform?: string }; columns?: string[] } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }
  const result = await exportLeadsToGoogleSheets(body.filters ?? {}, body.columns);
  return NextResponse.json(result, { status: result.ok ? 200 : result.setupRequired ? 428 : 502 });
}
