import assert from "node:assert/strict";
import test from "node:test";
import { effectivePatientSourceId, resolvePatientSource } from "./catalog";

test("EuroCure workflow markers resolve to the canonical source", () => {
  const result = resolvePatientSource([{ patient_source: " euro cure " }]);
  assert.equal(result.status, "resolved");
  if (result.status === "resolved") {
    assert.equal(result.source.id, "eurocure");
    assert.equal(result.source.label, "EuroCure");
    assert.equal(result.usedFallback, false);
  }
});

test("Dr. Ahmad n8n ownership tag and profile resolve to one canonical source", () => {
  const result = resolvePatientSource([{
    tags: ["Dr. Ahmad Ghait"],
    ingestion_profile: "dr_ahmad_ghait",
  }]);
  assert.equal(result.status, "resolved");
  if (result.status === "resolved") {
    assert.equal(result.source.id, "dr_ahmad_ghait");
    assert.equal(result.source.label, "Dr. Ahmad Ghait");
  }
});

test("legacy Dr. Ahmad Instagram account detection remains exact", () => {
  const result = resolvePatientSource([{ instagram_account_id: "17841465229188207" }]);
  assert.equal(result.status, "resolved");
  if (result.status === "resolved") assert.equal(result.source.id, "dr_ahmad_ghait");
});

test("known spelling/case variants do not create duplicate sources", () => {
  for (const value of ["DR_AHMAD_GHAIT", "Dr. Ahmed Ghait", "doctor-ahmad-ghait"]) {
    const result = resolvePatientSource([{ ownership_tag: value }]);
    assert.equal(result.status, "resolved");
    if (result.status === "resolved") assert.equal(result.source.id, "dr_ahmad_ghait");
  }
});

test("unrelated platform source does not become a patient source", () => {
  assert.deepEqual(resolvePatientSource([{ source: "facebook" }]), {
    status: "missing",
    reason: "no_source_marker",
  });
});

test("unsupported explicit patient source is rejected", () => {
  const result = resolvePatientSource([{ patientSource: "Unknown Clinic" }], { fallbackToEuroCure: true });
  assert.equal(result.status, "unsupported");
});

test("an invalid explicit patient source cannot be masked by a valid ordinary tag", () => {
  const result = resolvePatientSource([{ patientSource: "Unknown Clinic", tags: ["EuroCure"] }]);
  assert.equal(result.status, "unsupported");
});

test("conflicting canonical markers are ambiguous", () => {
  const result = resolvePatientSource([{ patient_source: "EuroCure", tags: ["Dr. Ahmad Ghait"] }]);
  assert.equal(result.status, "ambiguous");
});

test("legacy missing-source fallback is explicit and observable", () => {
  const result = resolvePatientSource([{ source: "instagram" }], { fallbackToEuroCure: true });
  assert.equal(result.status, "resolved");
  if (result.status === "resolved") {
    assert.equal(result.source.id, "eurocure");
    assert.equal(result.usedFallback, true);
  }
});

test("lead-to-patient linking preserves an established patient source", () => {
  assert.equal(effectivePatientSourceId("dr_ahmad_ghait", "eurocure"), "dr_ahmad_ghait");
  assert.equal(effectivePatientSourceId(null, "eurocure"), "eurocure");
});

test("duplicate merge preserves the survivor source and only fills a missing one", () => {
  assert.equal(effectivePatientSourceId("eurocure", "dr_ahmad_ghait"), "eurocure");
  assert.equal(effectivePatientSourceId(null, "dr_ahmad_ghait"), "dr_ahmad_ghait");
});
