import { handleIngest } from "@/lib/ingest/meta/http";

/** Backward-compatible adapter for the legacy n8n conversation endpoint. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  return handleIngest(req, "message");
}
