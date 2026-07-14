# Aspects Clinica CRM

Production CRM for Aspects Clinica lead management, Messenger/Instagram/WhatsApp
conversations, follow-up, booking, financial operations, audit, and reporting.

## Stack

- Next.js 15 App Router, React 19, TypeScript
- Tailwind CSS with light/dark semantic tokens and English/Arabic direction support
- Supabase Postgres/Auth for CRM data
- The Aspects booking/Admin Supabase project for canonical doctors, services,
  schedules, slots, reservations, and calendar data

## Data Sources

Production defaults to the live Supabase provider. The in-memory provider is an
explicit development/test fixture only; `CRM_DATA_SOURCE=mock` is rejected when
`NODE_ENV=production`.

Server-only credentials stay in server modules. Browser code receives only the
public CRM Supabase URL and anonymous key.

## Local Commands

```bash
npm install
npm run dev       # http://localhost:3100
npm run lint
npm run test
npx tsc --noEmit
npm run build
```

## Production deployment

1. Configure the mandatory CRM Supabase variables documented in `.env.example`.
2. Apply unapplied CRM migrations in `supabase/migrations/` in numeric order.
   Migration `0026_dashboard_metrics.sql` is additive and should be applied
   before or alongside this release; the application retains a slower fallback
   during a rolling deployment.
   Apply `0035_patient_source_continuity.sql` after `0034`; it is required
   before enabling the migrated n8n endpoints.
3. Run `npm ci`, `npm run build`, then `npm run start` (port 3100).
4. Schedule `POST /api/cron/overdue-emails` with `Authorization: Bearer
   <CRON_SECRET>`. Do not place the secret in a URL for new schedulers.
5. Configure Coolify to check `GET /api/health` and review the full standalone
   deployment checklist in `docs/DEPLOYMENT.md`.

The booking integration and messaging/email integrations degrade independently
when they are not configured; CRM authentication and the CRM service-role key
are mandatory.

See `.env.example`, `PERFORMANCE_AUDIT.md`,
`CRM_IMPLEMENTATION_CHECKLIST.md`, and `docs/INTEGRATIONS.md` for deployment and
verification details.
