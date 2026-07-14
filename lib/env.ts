export const REQUIRED_PRODUCTION_ENV = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

export type EnvironmentIssue = { key: string; message: string };

export function validateEnvironment(
  env: Record<string, string | undefined>,
  options: { production?: boolean } = {},
): EnvironmentIssue[] {
  const issues: EnvironmentIssue[] = [];
  for (const key of REQUIRED_PRODUCTION_ENV) {
    if (!env[key]?.trim()) issues.push({ key, message: `${key} is required.` });
  }

  if (env.SUPABASE_SERVICE_ROLE_KEY && env.SUPABASE_SERVICE_ROLE_KEY === env.NEXT_PUBLIC_SUPABASE_ANON_KEY) {
    issues.push({ key: "SUPABASE_SERVICE_ROLE_KEY", message: "The service-role key must not equal the anonymous key." });
  }
  if (options.production && env.CRM_DATA_SOURCE === "mock") {
    issues.push({ key: "CRM_DATA_SOURCE", message: "CRM_DATA_SOURCE=mock is forbidden in production." });
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith("NEXT_PUBLIC_") && /(SECRET|SERVICE_ROLE|PRIVATE_KEY|ACCESS_TOKEN|API_KEY)/i.test(key)) {
      issues.push({ key, message: `${key} appears to expose a server-only credential to the browser.` });
    }
  }
  return issues;
}
