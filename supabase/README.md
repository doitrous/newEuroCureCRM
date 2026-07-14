# Supabase — source of truth

The live Supabase project **already contains the full CRM schema** (55 public
tables) with reference data and settings. That live schema — not any file in
this repo — is the source of truth.

The app reads/writes it through the adapter in
[`lib/data/supabase.ts`](../lib/data/supabase.ts), which maps real rows to the
UI view models. Selected at runtime by `CRM_DATA_SOURCE` (`supabase` | `mock`).

## Key tables the app currently uses

- `leads` — core lead record (`lead_id` human id, `status` pipeline stage,
  `platform`, `service_name`, `has_unread`, `is_reply_overdue`,
  `escalation_status`, `coordinator_user_id`, `ai_*` columns, …).
- `crm_users` — operators (Supabase Auth + booking-system links, `role`).
- `lead_sources`, `lost_reasons`, `crm_escalation_reasons` — reference data.
- `crm_conversations` / `crm_messages` / `crm_comments` — unified message model.
- `escalations`, `lead_duplicate_flags`, `lead_timeline_events`,
  `lead_status_history`.
- `audit_daily_reports` (+ `audit_*`), `crm_settings`, `crm_integrations`.

### Enum values (verbatim)

- `leads.status`: `new_lead, qualified, booked, follow_up, post_op_follow_up, lost`
- `leads.escalation_status` / `escalations.status`: `none, escalated, in_review, resolved`
- `crm_users.role`: `owner_admin, manager, moderator, doctor, viewer, auditor`
- `audit_daily_reports.status`: `draft, submitted, approved, reopened`

The UI keeps a slightly shorter pipeline enum (`new`, `post_op`); the adapter
translates both directions.

## Apply order

The live CRM schema was built in two stages, by two repositories. Filenames
alone do not sort into apply order (`0002_` sorts before `014_`), so read this
list, not `ls`:

1. **`baseline/014_crm_schema.sql` … `baseline/029_*.sql`** — applied first.
   These created the CRM tables (`leads`, `crm_users`, `escalations`,
   `crm_conversations`, `crm_messages`, ingest logs, auditor reporting, …).
   They were authored in the **booking-website repository** and are restored
   here so this repo can describe its own database. Verified 2026-07-10: all
   52 tables they create exist in the live CRM project.
2. **`migrations/0002_*.sql` onward** — applied second, from
   this repo. They add the financial source of truth, role history, and comment
   metadata **on top of** the baseline (e.g. `crm_lead_financials` has an FK to
   `leads`, created in `014`).

The current last migration is `0035_patient_source_continuity.sql`. It is
additive and idempotent: it seeds the two canonical patient sources, reconciles
source-tag spelling variants, adds durable source keys to lead/patient/event
rows, and installs preservation triggers for patient linking and duplicate
merges. Apply it after `0034_exclude_database_patients_from_new_leads.sql`.

`baseline/` is history, already applied — do not re-run it against the live
database. New work goes in `migrations/` with the next `00NN_` number.

> Migrations `001`–`013` are **not** in this repo on purpose: they belong to the
> booking website's own Supabase project (`kuaoowjnatgixcupqdac`), which is a
> different database from the CRM project (`wgczgrhcqishvhbitvml`). That is why
> the CRM has no local `services` / `doctors` / `branches` tables.

## `archive/`

`archive/0001_init.sql.obsolete` is an **early invented schema draft**. It does
NOT match the live database and must never be applied — kept only for reference.
Do not add new migrations here without reconciling against the live schema.
