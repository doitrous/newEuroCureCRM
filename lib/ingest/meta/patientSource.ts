import { resolvePatientSource, type PatientSourceResolution } from "@/lib/patient-source/catalog";
import { eventKey as computeEventKey } from "./keys";
import { ingestEvents } from "./persist";
import type { MetaStore } from "./store";
import type { MetaEvent } from "./types";

export type PreparedPatientSource = Extract<PatientSourceResolution, { status: "resolved" }>;

export function preparePatientSources(
  records: Record<string, unknown>[],
  headerMarkers: Record<string, unknown> = {},
): { sources: PreparedPatientSource[]; error: PatientSourceResolution | null } {
  const sources: PreparedPatientSource[] = [];
  for (const record of records) {
    // The legacy CRM explicitly defaulted missing workflow markers to EuroCure.
    // Keep that compatibility visible through `usedFallback` and server logs.
    const resolution = resolvePatientSource([record, headerMarkers], { fallbackToEuroCure: true });
    if (resolution.status !== "resolved") return { sources: [], error: resolution };
    sources.push(resolution);
  }
  return { sources, error: null };
}

export async function ingestEventsWithPatientSources(
  store: MetaStore,
  events: MetaEvent[],
  sources: PreparedPatientSource[],
) {
  const sourceByEventKey = new Map<string, PreparedPatientSource>();
  events.forEach((event, index) => sourceByEventKey.set(computeEventKey(event), sources[index]));

  const result = await ingestEvents(store, events);
  for (const outcome of result.outcomes) {
    const resolved = sourceByEventKey.get(outcome.eventKey);
    if (!resolved) continue;
    try {
      await store.applyPatientSource({
        eventKey: outcome.eventKey,
        leadId: outcome.leadId,
        messageId: outcome.messageId,
        commentId: outcome.commentId,
      }, resolved.source.id);
    } catch (error) {
      result.errors.push({
        eventKey: outcome.eventKey,
        error: error instanceof Error ? error.message : "Patient source persistence failed",
      });
    }
  }
  return result;
}
