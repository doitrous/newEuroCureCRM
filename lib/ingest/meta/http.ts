import "server-only";

import { createHmac } from "node:crypto";
import { NextResponse } from "next/server";

import { secretsEqual } from "@/lib/security/secrets";
import { collectRecords, toEvents } from "./normalize";
import { ingestEventsWithPatientSources, preparePatientSources } from "./patientSource";
import { SupabaseMetaStore } from "./store.supabase";
import { isCommentEvent } from "./types";

/**
 * The one HTTP surface for Facebook / Instagram ingestion, shared by every
 * route that accepts it. Auth, parsing, normalization and the response shape
 * live here so the routes cannot drift apart from one another.
 *
 * Two auth paths, either sufficient:
 *   - `X-Hub-Signature-256`, verified against `FACEBOOK_APP_SECRET` — Meta
 *     posting directly to us.
 *   - `x-api-key` / `Authorization: Bearer`, matched against `CRM_INGEST_API_KEY`
 *     — n8n, which cannot re-sign a body it rewrote.
 */

const MAX_BODY_BYTES = 1_000_000;
const MAX_EVENTS = 500;

function verifySignature(raw: string, header: string | null): boolean {
  const secret = process.env.FACEBOOK_APP_SECRET || process.env.META_APP_SECRET;
  if (!secret || !header?.startsWith("sha256=")) return false;
  const expected = createHmac("sha256", secret).update(raw, "utf8").digest("hex");
  return secretsEqual(header.slice(7), expected);
}

function verifyApiKey(req: Request): boolean {
  const expected = process.env.CRM_INGEST_API_KEY;
  if (!expected) return false;
  const bearer = req.headers.get("authorization");
  const presented = bearer?.startsWith("Bearer ")
    ? bearer.slice(7)
    : req.headers.get("x-api-key")
      ?? req.headers.get("x-crm-api-key")
      ?? req.headers.get("x-crm-ingest-key");
  return secretsEqual(presented, expected);
}

/** What the endpoint's URL implies the caller meant to send. */
export type ExpectedRecord = "message" | "comment";

/**
 * Ingest a request body.
 *
 * `expect` is derived from the route and used for *reporting only*. A comment
 * arriving on the message endpoint is still stored as a comment: routing is an
 * n8n configuration detail, and silently dropping a real patient's comment to
 * punish a misconfigured URL would be the worse failure. The mismatch is
 * counted in the response so the misconfiguration is visible rather than
 * invisible.
 */
export async function handleIngest(req: Request, expect?: ExpectedRecord) {
  const configured = Boolean(process.env.FACEBOOK_APP_SECRET || process.env.META_APP_SECRET || process.env.CRM_INGEST_API_KEY);
  if (!configured) {
    return NextResponse.json({ ok: false, error: "ingest_not_configured" }, { status: 503 });
  }

  const declaredLength = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "payload_too_large" }, { status: 413 });
  }

  // The raw body is needed byte-for-byte to verify Meta's HMAC.
  const raw = await req.text();
  if (Buffer.byteLength(raw, "utf8") > MAX_BODY_BYTES) {
    return NextResponse.json({ ok: false, error: "payload_too_large" }, { status: 413 });
  }

  const authorized = verifySignature(raw, req.headers.get("x-hub-signature-256")) || verifyApiKey(req);
  if (!authorized) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ ok: false, error: "invalid_json" }, { status: 400 });
  }

  let events;
  let records;
  try {
    records = collectRecords(body);
    events = toEvents(body);
  } catch (err) {
    // Return 200 so Meta stops retrying malformed input. Keep the diagnostic in
    // server logs; database/stack details must not be reflected to callers.
    console.error("Meta ingest normalization failed", err);
    return NextResponse.json(
      { ok: false, error: "normalize_failed" },
      { status: 200 },
    );
  }

  if (events.length === 0) {
    return NextResponse.json({ ok: true, received: 0, results: [] }, { status: 200 });
  }
  if (events.length > MAX_EVENTS) {
    return NextResponse.json({ ok: false, error: "too_many_events", maximum: MAX_EVENTS }, { status: 413 });
  }

  const prepared = preparePatientSources(records, {
    ownership_tag: req.headers.get("x-crm-lead-tag"),
    ingestion_profile: req.headers.get("x-crm-ingestion-profile"),
    patient_source: req.headers.get("x-crm-patient-source"),
  });
  if (prepared.error) {
    return NextResponse.json(
      {
        ok: false,
        error: prepared.error.status === "ambiguous" ? "ambiguous_patient_source" : "unsupported_patient_source",
      },
      { status: 422 },
    );
  }
  const fallbackCount = prepared.sources.filter((source) => source.usedFallback).length;
  if (fallbackCount > 0) {
    console.warn("CRM ingest used confirmed legacy EuroCure patient-source fallback", { count: fallbackCount });
  }

  const mismatched = expect
    ? events.filter((e) => (isCommentEvent(e) ? "comment" : "message") !== expect).length
    : 0;

  const { outcomes, errors } = await ingestEventsWithPatientSources(
    new SupabaseMetaStore(),
    events,
    prepared.sources,
  );
  if (errors.length > 0) {
    console.error("Meta ingest event failures", {
      count: errors.length,
      eventKeys: errors.map((item) => item.eventKey),
    });
  }

  return NextResponse.json(
    {
      ok: errors.length === 0,
      received: events.length,
      created: outcomes.filter((o) => o.created).length,
      updated: outcomes.filter((o) => o.updated).length,
      // A retry lands entirely in `skipped` — that is the success signal.
      skipped: outcomes.filter((o) => o.skipped).length,
      ...(mismatched > 0 ? { mismatched, expected: expect } : {}),
      ...(fallbackCount > 0 ? { patientSourceFallbacks: fallbackCount } : {}),
      results: outcomes.map((o) => ({
        eventType: o.eventType,
        recordType: o.recordType,
        created: o.created,
        updated: o.updated,
        skipped: o.skipped,
        skipReason: o.skipReason,
        leadId: o.leadId,
        messageId: o.messageId,
        commentId: o.commentId,
      })),
      errors: errors.map((item) => ({ eventKey: item.eventKey, error: "ingest_failed" })),
    },
    { status: 200 },
  );
}

/** Meta's subscription handshake. Only the webhook URL needs this. */
export function handleVerify(req: Request) {
  const url = new URL(req.url);
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");

  const expected = process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN || process.env.META_VERIFY_TOKEN;
  if (!expected) {
    return NextResponse.json({ ok: false, error: "verify_token_not_configured" }, { status: 503 });
  }
  if (mode !== "subscribe" || !secretsEqual(token, expected)) {
    return NextResponse.json({ ok: false, error: "verification_failed" }, { status: 403 });
  }
  // Meta requires the bare challenge string, not JSON.
  return new Response(challenge ?? "", { status: 200, headers: { "content-type": "text/plain" } });
}
