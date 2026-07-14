export const PATIENT_SOURCES = {
  eurocure: {
    id: "eurocure",
    label: "EuroCure",
    color: "#B7791F",
    aliases: ["eurocure", "euro cure", "eurocure clinic", "eurocure workflow"],
    accountIds: [],
  },
  dr_ahmad_ghait: {
    id: "dr_ahmad_ghait",
    label: "Dr. Ahmad Ghait",
    color: "#7C3AED",
    aliases: [
      "dr ahmad ghait",
      "dr ahmed ghait",
      "doctor ahmad ghait",
      "doctor ahmed ghait",
      "dr ahmad ghait workflow",
    ],
    // Exact account fallback from the production CRM. The Dr. Ahmad n8n flows
    // still send explicit markers; this preserves direct/legacy IG delivery.
    accountIds: ["17841465229188207"],
  },
} as const;

export type PatientSourceId = keyof typeof PATIENT_SOURCES;
export type PatientSource = (typeof PATIENT_SOURCES)[PatientSourceId];

export type PatientSourceResolution =
  | { status: "resolved"; source: PatientSource; usedFallback: boolean }
  | { status: "missing"; reason: "no_source_marker" }
  | { status: "unsupported"; values: string[] }
  | { status: "ambiguous"; sourceIds: PatientSourceId[] };

const EXACT_ALIAS_TO_ID = new Map<string, PatientSourceId>(
  Object.values(PATIENT_SOURCES).flatMap((source) =>
    [source.id, source.label, ...source.aliases, ...source.accountIds].map((alias) => [normalizeMarker(alias), source.id]),
  ),
);

const STRICT_FIELDS = new Set([
  "patientSource",
  "patient_source",
  "patientSourceId",
  "patient_source_id",
  "ownership_tag",
  "lead_owner",
  "ingestion_profile",
  "brand",
  "clinic",
]);

// These names are overloaded by the existing CRM: `source_id` is a UUID FK to
// lead_sources, while `source` normally means facebook/instagram/whatsapp.
// Known patient-source aliases are accepted, but unrelated values are ignored.
const OVERLOADED_FIELDS = new Set([
  "source",
  "sourceId",
  "source_id",
  "workflow",
  "workflowId",
  "workflow_id",
  "platform_account_id",
  "instagram_account_id",
  "page_id",
]);
const TAG_FIELDS = new Set(["tag", "tags", "lead_tag", "lead_tags"]);
const MARKER_FIELDS = new Set([...STRICT_FIELDS, ...OVERLOADED_FIELDS, ...TAG_FIELDS]);

function normalizeMarker(value: string): string {
  return value
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ");
}

function scalarValues(value: unknown): string[] {
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  if (Array.isArray(value)) return value.flatMap(scalarValues);
  if (!value || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const named = record.name ?? record.label ?? record.value ?? record.id;
  return named === undefined ? [] : scalarValues(named);
}

type Marker = { field: string; value: string; strict: boolean };

function collectMarkers(value: unknown, depth = 0): Marker[] {
  if (!value || depth > 5) return [];
  if (typeof value === "string") {
    const trimmed = value.trim();
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length < 200_000) {
      try {
        return collectMarkers(JSON.parse(trimmed), depth + 1);
      } catch {
        return [];
      }
    }
    return [];
  }
  if (Array.isArray(value)) return value.flatMap((item) => collectMarkers(item, depth + 1));
  if (typeof value !== "object") return [];

  const markers: Marker[] = [];
  for (const [field, nested] of Object.entries(value as Record<string, unknown>)) {
    if (MARKER_FIELDS.has(field)) {
      for (const candidate of scalarValues(nested)) {
        const normalized = candidate.trim();
        if (normalized) markers.push({ field, value: normalized, strict: STRICT_FIELDS.has(field) });
      }
    }
    if (nested && (typeof nested === "object" || typeof nested === "string")) {
      markers.push(...collectMarkers(nested, depth + 1));
    }
  }
  return markers;
}

export function patientSourceById(id: PatientSourceId): PatientSource {
  return PATIENT_SOURCES[id];
}

/** Shared preservation rule used by lead updates, patient linking and merges. */
export function effectivePatientSourceId(
  existing: PatientSourceId | null | undefined,
  incoming: PatientSourceId,
): PatientSourceId {
  return existing || incoming;
}

export function patientSourceFromValue(value: unknown): PatientSource | null {
  const candidate = scalarValues(value)[0];
  if (!candidate) return null;
  const id = EXACT_ALIAS_TO_ID.get(normalizeMarker(candidate));
  return id ? PATIENT_SOURCES[id] : null;
}

/**
 * Resolve only exact, registered aliases. No substring/fuzzy matching is used:
 * a campaign or clinic with a similar name must never acquire the wrong owner.
 */
export function resolvePatientSource(
  inputs: unknown[],
  options: { fallbackToEuroCure?: boolean } = {},
): PatientSourceResolution {
  const markers = inputs.flatMap((input) => collectMarkers(input));
  const ids = new Set<PatientSourceId>();
  const unsupported = new Set<string>();

  for (const marker of markers) {
    const id = EXACT_ALIAS_TO_ID.get(normalizeMarker(marker.value));
    if (id) ids.add(id);
    else if (marker.strict) unsupported.add(marker.value.slice(0, 120));
  }

  if (ids.size > 1) return { status: "ambiguous", sourceIds: [...ids].sort() };
  if (unsupported.size > 0) return { status: "unsupported", values: [...unsupported].sort() };
  if (ids.size === 1) {
    const id = [...ids][0];
    return { status: "resolved", source: PATIENT_SOURCES[id], usedFallback: false };
  }
  if (options.fallbackToEuroCure) {
    return { status: "resolved", source: PATIENT_SOURCES.eurocure, usedFallback: true };
  }
  return { status: "missing", reason: "no_source_marker" };
}
