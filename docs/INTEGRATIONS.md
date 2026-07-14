# Aspects Clinica CRM Integrations

This repository connects only to Aspects Clinica systems.

## Booking and Admin Scheduling

The CRM reads and writes the canonical Aspects booking/Admin project through the
server-only `BOOKING_SUPABASE_URL` and `BOOKING_SUPABASE_SERVICE_ROLE_KEY`.
Doctors, specialties, services, branches, schedules, blocked times, slots, and
appointments are not duplicated into a second CRM availability database.

The CRM Booking drawer and Calendar use the same booking tables. Website
reservations are linked to canonical CRM leads by booking appointment ID, with
normalized phone as the fallback. The reservation ingest receiver is
`POST /api/ingest/reservation` and requires `CRM_INGEST_API_KEY`.

## Facebook and Instagram

Meta can post directly to `POST /api/webhooks/meta`, where signatures and ingest
credentials are validated server-side. The production n8n flow instead receives
Meta's webhook and posts normalized events to
`POST /api/crm/ingest/message` and `POST /api/crm/ingest/comment`.
Normalized conversation content is stored in the canonical CRM
conversation/message tables; receipts, reactions, and referrals remain distinct
event records.

Legacy `POST /api/crm/ingest/conversation` and
`POST /api/crm/ingest/bulk` contracts remain available as adapters. n8n may
authenticate with `Authorization: Bearer`, `x-api-key`, or the old
`x-crm-api-key`; each must carry the same `CRM_INGEST_API_KEY` value.

There is currently no interactive Instagram OAuth flow or
`/api/auth/instagram/callback` route. Production uses server-managed Meta tokens,
so an `INSTAGRAM_REDIRECT_URI` variable is neither read nor required.

## Patient source contract

Patient ownership is distinct from the existing acquisition-channel
`lead_sources` relation. Every new or edited n8n flow should send one canonical
marker:

```json
{ "patient_source": "EuroCure" }
```

or:

```json
{
  "ownership_tag": "Dr. Ahmad Ghait",
  "ingestion_profile": "dr_ahmad_ghait"
}
```

The old Dr. Ahmad workflows already emit the second shape. Existing EuroCure
workflows that omit a marker continue through the old, confirmed EuroCure
fallback; the server logs only a sanitized fallback count. Unsupported or
conflicting explicit markers return HTTP 422 and never fall through to
EuroCure.

The same marker may be sent as `x-crm-patient-source`; legacy
`x-crm-lead-tag` and `x-crm-ingestion-profile` headers are also supported.
Retries are idempotent. An established lead source is preserved if a later
payload disagrees, and the conflict is recorded without replacing the visible
source tag.

## Google Sheets mirror

The old authenticated mirror contract remains at
`POST /api/crm/mirror/google-sheets`. It accepts the same ingestion key via
Bearer, `x-api-key`, or `x-crm-api-key`, records each export run, and writes the
canonical patient-source label separately from acquisition source. Configure
`CRM_GOOGLE_SHEETS_SPREADSHEET_ID`, `CRM_GOOGLE_SHEETS_TAB_NAME`,
`GOOGLE_SERVICE_ACCOUNT_EMAIL`, and `GOOGLE_PRIVATE_KEY` only when this mirror
is used.

## WhatsApp

Normalized WhatsApp records enter through `POST /api/crm/ingest/whatsapp` using
`WHATSAPP_INGEST_API_KEY` or `CRM_INGEST_API_KEY`. Access tokens and phone/account
IDs remain server-only. When credentials are absent, the drawer reports that the
integration is not configured and does not fabricate messages or connection
state. Outbound WhatsApp sending still requires provider credentials and is not
claimed as verified.

The n8n Code-node normalizer is tracked at
`docs/whatsapp-n8n-normalizer.js`. Subscribe the WhatsApp Business Account
webhook to `messages`, `message_echoes`, and `smb_message_echoes` when available.
The normalizer ignores non-message account/admin webhook fields, normalizes
incoming messages and outgoing echoes into CRM message records, and turns
WhatsApp `sent` / `delivered` / `read` status callbacks into monotonic CRM
delivery-state updates.

## Email

Resend delivery uses the server-only `RESEND_API_KEY` and `EMAIL_FROM`. Missing
credentials produce a persisted skipped result, never a fabricated delivery.
The overdue route requires `CRON_SECRET`.
Schedulers should call `POST /api/cron/overdue-emails` with the secret in the
`Authorization: Bearer` header. The legacy query-token form remains supported
for compatibility but should not be used for new configuration because URLs
are commonly retained in proxy and scheduler logs.

## AI reply assistant

The old moderator-only n8n suggestion contract is available at
`POST /api/crm/ai/reply-suggestion` for authenticated CRM users. Configure
`N8N_AI_REPLY_WEBHOOK_URL` and `N8N_AI_REPLY_WEBHOOK_SECRET`. The CRM sends the
canonical patient-source key with the lead context, validates and persists the
returned suggestion, and never sends a message to the patient automatically.

## Required Deployment Variables

See `.env.example` for the complete list. At minimum, production requires the
CRM Supabase URL/anonymous/service-role values and the booking Supabase
URL/service-role values. Integration secrets must never use `NEXT_PUBLIC_`.

See `DEPLOYMENT.md` for the old-to-new variable mapping, Coolify commands,
migration order, health check, and callback/domain review.
