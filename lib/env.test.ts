import assert from "node:assert/strict";
import test from "node:test";
import { validateEnvironment } from "./env";

const valid = {
  NEXT_PUBLIC_SUPABASE_URL: "https://example.supabase.co",
  NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-placeholder",
  SUPABASE_SERVICE_ROLE_KEY: "service-placeholder",
  CRM_DATA_SOURCE: "supabase",
};

test("environment validation reports every missing required variable by name", () => {
  const issues = validateEnvironment({}, { production: true });
  assert.deepEqual(issues.map((issue) => issue.key).sort(), [
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_SERVICE_ROLE_KEY",
  ]);
});

test("valid production environment passes without exposing values", () => {
  assert.deepEqual(validateEnvironment(valid, { production: true }), []);
});

test("server-only credentials may not use NEXT_PUBLIC names", () => {
  const issues = validateEnvironment({ ...valid, NEXT_PUBLIC_PRIVATE_KEY: "placeholder" }, { production: true });
  assert.equal(issues.some((issue) => issue.key === "NEXT_PUBLIC_PRIVATE_KEY"), true);
});

test("mock data is rejected in production", () => {
  const issues = validateEnvironment({ ...valid, CRM_DATA_SOURCE: "mock" }, { production: true });
  assert.equal(issues.some((issue) => issue.key === "CRM_DATA_SOURCE"), true);
});
