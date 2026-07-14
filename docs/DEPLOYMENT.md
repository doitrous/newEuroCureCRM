# EuroCure New CRM production deployment

## Coolify application

- Repository: the standalone `EuroCure New CRM` Git repository
- Coolify root directory: `/` (the `Dockerfile` and `package.json` are at the
  root of that repository)
- Runtime: Node.js 22 (`.nvmrc` and `package.json` engines)
- Install: `npm ci`
- Build: `npm run build`
- Start: `npm run start`
- Internal port: `3100`
- Health check: `GET /api/health` (HTTP 200 only when required CRM configuration is present)
- Docker alternative: the included `Dockerfile` uses the same Node version and commands.

Do not deploy the parent directory or the production `eurocure` website as the
new CRM application.

## Required environment mapping

The old combined application used prefixed variables for its separate CRM
Supabase project. In the standalone CRM, that project becomes the primary
Supabase/Auth project:

| Standalone CRM variable | Source in old deployment | Visibility | Required |
|---|---|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | `CRM_SUPABASE_URL` | Public URL | Yes |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `CRM_SUPABASE_ANON_KEY` | Public anon key | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | `CRM_SUPABASE_SERVICE_ROLE_KEY` | Server-only | Yes |
| `BOOKING_SUPABASE_URL` | old website `NEXT_PUBLIC_SUPABASE_URL` | Server-only here | For booking/calendar |
| `BOOKING_SUPABASE_SERVICE_ROLE_KEY` | old website `SUPABASE_SERVICE_ROLE_KEY` | Server-only | For booking/calendar |
| `CRM_INGEST_API_KEY` | same old variable | Server-only | For n8n/reservation ingest |
| `CRM_BOOKING_SOURCE_ID` | CRM `lead_sources.id` for website bookings | Server-only identifier | Optional |
| `CRON_SECRET` | same old variable | Server-only | For scheduled email routes |
| `RESEND_API_KEY` / `EMAIL_FROM` | same old variables | Server-only | When email is enabled |

Copy values only in Coolify's secret/environment UI. Never place production
values in `.env.example`, a Docker build argument, a commit, or documentation.

Meta/WhatsApp variables are listed in `.env.example`. App secrets, webhook
verify tokens, page/access tokens and WhatsApp credentials are server-only.
`BOOKING_API_BASE_URL`, `BOOKING_API_KEY`, and direct-provider AI placeholder
variables are retained for compatibility but are not read by the current
production path. The n8n reply assistant reads
`N8N_AI_REPLY_WEBHOOK_URL`/`N8N_AI_REPLY_WEBHOOK_SECRET` when enabled.
Google Sheets variables are required only when the authenticated mirror route
is used.

## Database migration

The CRM and booking website are separate Supabase projects. Apply only the CRM
migration below to the CRM project, after all migrations through `0034`:

```text
supabase/migrations/0035_patient_source_continuity.sql
```

Use the existing controlled Supabase migration process or SQL editor. The file
is idempotent, does not overwrite ambiguous rows, does not weaken RLS, and does
not touch the booking Supabase schema.

For an operator shell with `psql`, use a temporary CRM-project connection
string (do not add it to the application or Coolify environment):

```text
psql "$CRM_DATABASE_URL" --set ON_ERROR_STOP=on --file supabase/migrations/0035_patient_source_continuity.sql
```

Confirm that `CRM_DATABASE_URL` points to the CRM Supabase project before
running it. Do not run this command against the booking project, and do not
re-run the `baseline/` directory.

## Domains and authentication

1. Attach the intended CRM domain (for example `https://<crm-domain>`) to the
   standalone Coolify application and route it to port 3100.
2. In the CRM Supabase project, add the exact production origin to Auth Site URL
   and allowed Redirect URLs. This CRM uses cookie-based email/password auth;
   it does not use the old website's `/admin/crm` rewrite.
3. Keep webhook/n8n URLs on the standalone CRM origin.
4. Review Meta webhook subscriptions and verify tokens if direct Meta delivery
   is enabled. n8n delivery needs only `CRM_INGEST_API_KEY`.
5. No browser CORS allow-list is required for n8n: ingestion is server-to-server
   and authenticated. Do not expose service-role keys to browser code.

## n8n endpoints

Use `https://<crm-domain>` as the base URL:

```text
POST /api/crm/ingest/message
POST /api/crm/ingest/comment
POST /api/crm/ingest/conversation
POST /api/crm/ingest/bulk
POST /api/crm/ingest/whatsapp
POST /api/ingest/reservation
POST /api/crm/mirror/google-sheets
```

Preferred header:

```http
Authorization: Bearer <CRM_INGEST_API_KEY>
```

`x-api-key` and legacy `x-crm-api-key` are also accepted for Meta/n8n routes.
WhatsApp may use a dedicated `WHATSAPP_INGEST_API_KEY`.

Sanitized examples:

```json
{
  "record_type": "message",
  "source": "facebook",
  "platform": "facebook_messenger",
  "platform_user_id": "<platform-user-id>",
  "platform_message_id": "<message-id>",
  "message_text": "<patient message>",
  "message_timestamp": "2026-07-14T10:00:00.000Z",
  "patient_source": "EuroCure"
}
```

```json
{
  "record_type": "message",
  "source": "instagram",
  "platform": "instagram_dm",
  "platform_user_id": "<platform-user-id>",
  "platform_message_id": "<message-id>",
  "message_text": "<patient message>",
  "ownership_tag": "Dr. Ahmad Ghait",
  "ingestion_profile": "dr_ahmad_ghait"
}
```

Expected responses are 401 for invalid authentication, 400 for invalid JSON,
422 for unsupported/ambiguous patient sources, and 200 for accepted or
idempotently replayed events.

## Release verification

Before switching n8n or DNS, run:

```text
npm ci
npx tsc --noEmit
npm run lint
npm run test
npm run build
```

After deployment, verify `/api/health`, login, one payload from each patient
source, a retry of each payload, a booking sync, and a duplicate merge using a
safe staging/test record before enabling production traffic.
