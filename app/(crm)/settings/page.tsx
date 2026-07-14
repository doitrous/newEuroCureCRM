import { notFound } from "next/navigation";
import Link from "next/link";
import { Topbar } from "@/components/shell/Topbar";
import { SchedulingSettings } from "@/components/settings/SchedulingSettings";
import { FinancialSettingsManager } from "@/components/financial/FinancialSettingsManager";
import { SettingsManager, type IntegrationStatus, type SettingsTabKey } from "@/components/settings/SettingsManager";
import { bookingConfigured } from "@/lib/booking/client";
import { bookingSchedulingSnapshot } from "@/lib/booking/service";
import { emailConfigured } from "@/lib/email/resend";
import { whatsappConfigured } from "@/lib/whatsapp/config";
import { can } from "@/lib/auth/permissions";
import { requireSession } from "@/lib/data/session";
import { leadSourcesList } from "@/lib/data";
import { financialSettingsData } from "@/lib/data/financialSettings";
import {
  getAiPrompt,
  getAuditorSettings,
  listEscalationReasons,
  listEmailRules,
  listFollowUpStages,
  listLostReasons,
  listSlaRules,
  listTags,
  listIngestLogs,
} from "@/lib/data/settingsData";

export const dynamic = "force-dynamic";

function integrations(): IntegrationStatus[] {
  const facebook = Boolean(
    (process.env.FACEBOOK_APP_SECRET || process.env.META_APP_SECRET)
      && (process.env.FACEBOOK_WEBHOOK_VERIFY_TOKEN || process.env.META_VERIFY_TOKEN),
  );
  const instagram = Boolean(process.env.INSTAGRAM_APP_SECRET && process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN);
  return [
    { key: "facebook", label: "Facebook", configured: facebook, evidence: facebook ? "Webhook secret and verify token are present." : "Missing Facebook webhook/app credentials." },
    { key: "instagram", label: "Instagram", configured: instagram, evidence: instagram ? "Webhook secret and verify token are present." : "Missing Instagram webhook/app credentials." },
    { key: "whatsapp", label: "WhatsApp", configured: whatsappConfigured(), evidence: whatsappConfigured() ? "WhatsApp access token plus phone/business identifier are present." : "Missing WhatsApp Cloud API credentials." },
    { key: "booking", label: "Booking system", configured: bookingConfigured(), evidence: bookingConfigured() ? "Booking Supabase URL and service role key are present." : "Missing booking Supabase server credentials." },
    { key: "resend", label: "Resend", configured: emailConfigured(), evidence: emailConfigured() ? "Resend API key is present." : "Email sends will be logged as skipped." },
  ];
}

const SETTINGS_SECTIONS = new Set<SettingsTabKey>([
  "general", "bulkImport", "leadFields", "tags", "lost", "escalation", "followup", "rules", "sources",
  "idRules", "duplicates", "reporting", "ai", "integrations", "ingestion", "users", "scheduling", "financial", "email",
]);

export default async function SettingsPage({ searchParams }: { searchParams: Promise<{ section?: string; financeTab?: string }> }) {
  const { effective: user } = await requireSession();
  if (!can(user.role, "settings.view")) notFound();
  const canManage = can(user.role, "settings.manage");
  const params = await searchParams;
  const initialTab = SETTINGS_SECTIONS.has(params.section as SettingsTabKey) ? params.section as SettingsTabKey : "general";

  const [tags, lostReasons, escalationReasons, slaRules, followUpStages, auditorSettings, aiPrompt, emailRules, sources, scheduling, financial, ingestLogs] =
    await Promise.all([
      listTags(),
      listLostReasons(),
      listEscalationReasons(),
      listSlaRules(),
      listFollowUpStages(),
      getAuditorSettings(),
      getAiPrompt(),
      listEmailRules(),
      leadSourcesList(),
      bookingSchedulingSnapshot(),
      financialSettingsData(),
      listIngestLogs(),
    ]);

  return (
    <>
      <Topbar title="CRM Settings" />
      <div className="flex-1 overflow-auto px-[18px] py-4">
        <div className="mb-4 grid gap-2 sm:grid-cols-2">
          <Link href="/settings/account" className="flex items-center justify-between rounded-xl border border-line bg-panel px-4 py-3 text-[13px] font-black text-ink-900 shadow-sm hover:border-primary"><span>Profile &amp; security</span><span className="text-[11px] font-bold text-primary">Manage account →</span></Link>
          {can(user.role, "users.view") && <Link href="/settings/users" className="flex items-center justify-between rounded-xl border border-primary/20 bg-primary-soft/60 px-4 py-3 text-[13px] font-black text-ink-900 shadow-sm hover:border-primary"><span>Users &amp; roles</span><span className="text-[11px] font-bold text-primary">Manage access →</span></Link>}
        </div>
        <SettingsManager
          initialTab={initialTab}
          canManage={canManage}
          tags={tags}
          lostReasons={lostReasons}
          escalationReasons={escalationReasons}
          slaRules={slaRules}
          followUpStages={followUpStages}
          auditorSettings={auditorSettings}
          aiPrompt={aiPrompt}
          emailRules={emailRules}
          sources={sources}
          integrations={integrations()}
          scheduling={<SchedulingSettings snapshot={scheduling} />}
          financial={<FinancialSettingsManager data={financial} initialTab={params.financeTab} />}
          ingestLogs={ingestLogs}
        />
      </div>
    </>
  );
}
