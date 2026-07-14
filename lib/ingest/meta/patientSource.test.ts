import assert from "node:assert/strict";
import test from "node:test";
import { collectRecords, toEvents } from "./normalize";
import { ingestEventsWithPatientSources, preparePatientSources } from "./patientSource";
import { MemoryStore, resetIds } from "./store.memory";

const base = {
  record_type: "message",
  event_type: "message",
  source: "facebook",
  platform: "facebook_messenger",
  page_id: "PAGE_SOURCE_TEST",
  platform_user_id: "PSID_SOURCE_TEST",
  sender_id: "PSID_SOURCE_TEST",
  recipient_id: "PAGE_SOURCE_TEST",
  identity_confidence: "strong",
  sender_name: "Source Test Patient",
  conversation_key: "facebook_messenger:PAGE_SOURCE_TEST:PSID_SOURCE_TEST",
  direction: "incoming",
  message_timestamp: "2026-07-01T10:00:00.000Z",
  platform_message_id: "mid.source.1",
  message_text: "Hello",
};

async function ingest(body: Record<string, unknown>, store = new MemoryStore()) {
  const records = collectRecords(body);
  const prepared = preparePatientSources(records);
  assert.equal(prepared.error, null);
  const result = await ingestEventsWithPatientSources(store, toEvents(body), prepared.sources);
  assert.deepEqual(result.errors, []);
  return { store, result };
}

test("EuroCure workflow creates a lead with the canonical visible tag", async () => {
  resetIds();
  const { store } = await ingest({ ...base, patient_source: "EuroCure" });
  assert.equal(store.leads[0].patientSourceKey, "eurocure");
  assert.deepEqual(store.leads[0].tags, ["EuroCure"]);
  assert.equal(store.sourceApplications[0].messageId, store.contentMessages()[0].id);
  assert.equal(store.sourceApplications[0].effectiveSourceKey, "eurocure");
});

test("Dr. Ahmad workflow creates a lead with the canonical visible tag", async () => {
  resetIds();
  const { store } = await ingest({
    ...base,
    ownership_tag: "Dr. Ahmad Ghait",
    ingestion_profile: "dr_ahmad_ghait",
  });
  assert.equal(store.leads[0].patientSourceKey, "dr_ahmad_ghait");
  assert.deepEqual(store.leads[0].tags, ["Dr. Ahmad Ghait"]);
});

test("an update from another workflow preserves the existing source", async () => {
  resetIds();
  const first = await ingest({ ...base, patient_source: "Dr. Ahmad Ghait" });
  await ingest({
    ...base,
    platform_message_id: "mid.source.2",
    message_timestamp: "2026-07-01T10:01:00.000Z",
    patient_source: "EuroCure",
  }, first.store);
  assert.equal(first.store.leads.length, 1);
  assert.equal(first.store.leads[0].patientSourceKey, "dr_ahmad_ghait");
  assert.deepEqual(first.store.leads[0].tags, ["Dr. Ahmad Ghait"]);
});

test("a workflow retry is idempotent for lead, message and source tag", async () => {
  resetIds();
  const first = await ingest({ ...base, patient_source: "EuroCure" });
  await ingest({ ...base, patient_source: "EuroCure" }, first.store);
  assert.equal(first.store.leads.length, 1);
  assert.equal(first.store.contentMessages().length, 1);
  assert.deepEqual(first.store.leads[0].tags, ["EuroCure"]);
});

test("unsupported source is rejected before ingestion", () => {
  const records = collectRecords({ ...base, patient_source: "Unregistered Clinic" });
  const prepared = preparePatientSources(records);
  assert.equal(prepared.error?.status, "unsupported");
});
