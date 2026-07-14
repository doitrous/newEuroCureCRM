import { handleIngest } from "@/lib/ingest/meta/http";

/** Backward-compatible batch adapter; accepts arrays and legacy `{items:[…]}`. */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function POST(req: Request) {
  return handleIngest(req);
}
