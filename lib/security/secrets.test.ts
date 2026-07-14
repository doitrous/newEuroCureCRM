import assert from "node:assert/strict";
import test from "node:test";
import { secretsEqual } from "./secretComparison";

test("ingestion authentication rejects missing and invalid keys", () => {
  assert.equal(secretsEqual(null, "expected-placeholder"), false);
  assert.equal(secretsEqual("wrong-placeholder", "expected-placeholder"), false);
  assert.equal(secretsEqual("expected-placeholder", "expected-placeholder"), true);
});
