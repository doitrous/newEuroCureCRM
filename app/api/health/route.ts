import { NextResponse } from "next/server";
import { validateEnvironment } from "@/lib/env";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  const issues = validateEnvironment(process.env, { production: process.env.NODE_ENV === "production" });
  if (issues.length > 0) {
    return NextResponse.json(
      { ok: false, status: "misconfigured", missingOrInvalid: issues.map((issue) => issue.key) },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
  return NextResponse.json(
    { ok: true, status: "ready" },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}
