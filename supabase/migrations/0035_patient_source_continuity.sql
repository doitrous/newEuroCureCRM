-- Canonical patient ownership/source continuity.
--
-- `lead_sources` already means acquisition channel (Facebook, Instagram,
-- database, ...), so patient ownership uses its own stable key and keeps the
-- existing visible lead-tag relation in sync. This migration is additive,
-- idempotent and does not default ambiguous historical rows.

set search_path = public, extensions;

insert into public.lead_tags (name, color, is_active)
values
  ('EuroCure', '#B7791F', true),
  ('Dr. Ahmad Ghait', '#7C3AED', true)
on conflict (name) do update set
  color = excluded.color,
  is_active = true,
  updated_at = now();

-- Consolidate source-tag spelling/case variants into the exact visible labels.
insert into public.lead_tag_assignments (lead_id, tag_id, assigned_by, created_at)
select a.lead_id, canonical.id, a.assigned_by, a.created_at
from public.lead_tag_assignments a
join public.lead_tags variant on variant.id = a.tag_id
join public.lead_tags canonical on canonical.name = case
  when lower(regexp_replace(trim(variant.name), '[._-]+', ' ', 'g')) in
    ('eurocure', 'euro cure', 'eurocure clinic', 'eurocure workflow') then 'EuroCure'
  when lower(regexp_replace(trim(variant.name), '[._-]+', ' ', 'g')) in
    ('dr ahmad ghait', 'dr ahmed ghait', 'doctor ahmad ghait', 'doctor ahmed ghait', 'dr ahmad ghait workflow') then 'Dr. Ahmad Ghait'
end
where variant.id <> canonical.id
on conflict (lead_id, tag_id) do nothing;

do $$
begin
  -- Some production installations have the original follow-up table but have
  -- not applied migration 0012, which added applicable_tag_id. The source-tag
  -- consolidation does not require that optional feature, so only rewrite its
  -- references when both the table and column are present.
  if to_regclass('public.crm_followup_workflow_stages') is not null
     and exists (
       select 1
       from information_schema.columns
       where table_schema = 'public'
         and table_name = 'crm_followup_workflow_stages'
         and column_name = 'applicable_tag_id'
     ) then
    update public.crm_followup_workflow_stages stage
       set applicable_tag_id = canonical.id
      from public.lead_tags variant
      join public.lead_tags canonical on canonical.name = case
        when lower(regexp_replace(trim(variant.name), '[._-]+', ' ', 'g')) in
          ('eurocure', 'euro cure', 'eurocure clinic', 'eurocure workflow') then 'EuroCure'
        when lower(regexp_replace(trim(variant.name), '[._-]+', ' ', 'g')) in
          ('dr ahmad ghait', 'dr ahmed ghait', 'doctor ahmad ghait', 'doctor ahmed ghait', 'dr ahmad ghait workflow') then 'Dr. Ahmad Ghait'
      end
     where stage.applicable_tag_id = variant.id
       and variant.id <> canonical.id;
  end if;
end $$;

delete from public.lead_tags variant
where variant.name not in ('EuroCure', 'Dr. Ahmad Ghait')
  and lower(regexp_replace(trim(variant.name), '[._-]+', ' ', 'g')) in (
    'eurocure', 'euro cure', 'eurocure clinic', 'eurocure workflow',
    'dr ahmad ghait', 'dr ahmed ghait', 'doctor ahmad ghait',
    'doctor ahmed ghait', 'dr ahmad ghait workflow'
  );

create table if not exists public.crm_patient_sources (
  key text primary key check (key ~ '^[a-z0-9_]+$'),
  display_label text not null unique,
  tag_id uuid not null unique references public.lead_tags(id) on delete restrict,
  aliases text[] not null default '{}'::text[],
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.crm_patient_sources (key, display_label, tag_id, aliases, is_active)
select 'eurocure', 'EuroCure', id,
  array['eurocure','euro cure','eurocure clinic','eurocure workflow'], true
from public.lead_tags where name = 'EuroCure'
on conflict (key) do update set
  display_label = excluded.display_label,
  tag_id = excluded.tag_id,
  aliases = excluded.aliases,
  is_active = true,
  updated_at = now();

insert into public.crm_patient_sources (key, display_label, tag_id, aliases, is_active)
select 'dr_ahmad_ghait', 'Dr. Ahmad Ghait', id,
  array['dr ahmad ghait','dr ahmed ghait','doctor ahmad ghait','doctor ahmed ghait','dr ahmad ghait workflow'], true
from public.lead_tags where name = 'Dr. Ahmad Ghait'
on conflict (key) do update set
  display_label = excluded.display_label,
  tag_id = excluded.tag_id,
  aliases = excluded.aliases,
  is_active = true,
  updated_at = now();

alter table public.leads
  add column if not exists patient_source_key text references public.crm_patient_sources(key) on delete restrict;
alter table public.patients
  add column if not exists patient_source_key text references public.crm_patient_sources(key) on delete restrict;
alter table if exists public.lead_messages
  add column if not exists patient_source_key text references public.crm_patient_sources(key) on delete restrict;
alter table if exists public.crm_messages
  add column if not exists patient_source_key text references public.crm_patient_sources(key) on delete restrict;
alter table if exists public.crm_comments
  add column if not exists patient_source_key text references public.crm_patient_sources(key) on delete restrict;
alter table if exists public.crm_conversations
  add column if not exists patient_source_key text references public.crm_patient_sources(key) on delete restrict;
alter table if exists public.crm_conversation_events
  add column if not exists patient_source_key text references public.crm_patient_sources(key) on delete restrict;
alter table if exists public.crm_ingest_logs
  add column if not exists patient_source_key text references public.crm_patient_sources(key) on delete restrict;

create index if not exists leads_patient_source_key_idx on public.leads(patient_source_key);
create index if not exists patients_patient_source_key_idx on public.patients(patient_source_key);
do $$
begin
  if to_regclass('public.crm_messages') is not null then
    execute 'create index if not exists crm_messages_patient_source_key_idx on public.crm_messages(patient_source_key)';
  end if;
  if to_regclass('public.crm_comments') is not null then
    execute 'create index if not exists crm_comments_patient_source_key_idx on public.crm_comments(patient_source_key)';
  end if;
  if to_regclass('public.crm_conversations') is not null then
    execute 'create index if not exists crm_conversations_patient_source_key_idx on public.crm_conversations(patient_source_key)';
  end if;
end $$;

create table if not exists public.crm_patient_source_history (
  id uuid primary key default gen_random_uuid(),
  lead_id uuid references public.leads(id) on delete set null,
  patient_id uuid references public.patients(id) on delete set null,
  effective_source_key text not null references public.crm_patient_sources(key) on delete restrict,
  incoming_source_key text references public.crm_patient_sources(key) on delete restrict,
  reason text not null,
  context jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists crm_patient_source_history_lead_idx
  on public.crm_patient_source_history(lead_id, created_at desc);
create index if not exists crm_patient_source_history_patient_idx
  on public.crm_patient_source_history(patient_id, created_at desc);

create or replace function public.crm_apply_patient_source(
  target_lead_id uuid,
  incoming_source_key text,
  source_context jsonb default '{}'::jsonb
)
returns text
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  lead_row public.leads%rowtype;
  patient_row public.patients%rowtype;
  effective_key text;
  effective_tag_id uuid;
begin
  if not exists (
    select 1 from public.crm_patient_sources
    where key = incoming_source_key and is_active
  ) then
    raise exception 'Unsupported patient source key';
  end if;

  select * into lead_row from public.leads where id = target_lead_id for update;
  if not found then raise exception 'Lead not found'; end if;

  effective_key := coalesce(lead_row.patient_source_key, incoming_source_key);
  if lead_row.patient_source_key is null then
    update public.leads set patient_source_key = effective_key, updated_at = now()
    where id = target_lead_id;
  elsif lead_row.patient_source_key <> incoming_source_key then
    insert into public.crm_patient_source_history (
      lead_id, patient_id, effective_source_key, incoming_source_key, reason, context
    ) values (
      target_lead_id, lead_row.patient_id, effective_key, incoming_source_key,
      'incoming_source_conflict_preserved_existing', coalesce(source_context, '{}'::jsonb)
    );
  end if;

  select tag_id into effective_tag_id from public.crm_patient_sources where key = effective_key;
  delete from public.lead_tag_assignments assignment
  using public.crm_patient_sources source
  where assignment.lead_id = target_lead_id
    and assignment.tag_id = source.tag_id
    and source.key <> effective_key;
  insert into public.lead_tag_assignments (lead_id, tag_id, assigned_by)
  values (target_lead_id, effective_tag_id, null)
  on conflict (lead_id, tag_id) do nothing;

  if lead_row.patient_id is not null then
    select * into patient_row from public.patients where id = lead_row.patient_id for update;
    if found and patient_row.patient_source_key is null then
      update public.patients set patient_source_key = effective_key, updated_at = now()
      where id = lead_row.patient_id;
    elsif found and patient_row.patient_source_key <> effective_key then
      insert into public.crm_patient_source_history (
        lead_id, patient_id, effective_source_key, incoming_source_key, reason, context
      ) values (
        target_lead_id, lead_row.patient_id, patient_row.patient_source_key, effective_key,
        'lead_patient_source_conflict_preserved_patient', coalesce(source_context, '{}'::jsonb)
      );
    end if;
  end if;

  return effective_key;
end;
$$;

revoke all on function public.crm_apply_patient_source(uuid, text, jsonb) from public, anon, authenticated;
grant execute on function public.crm_apply_patient_source(uuid, text, jsonb) to service_role;

create or replace function public.crm_sync_lead_patient_source()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
begin
  if new.patient_source_key is not null then
    perform public.crm_apply_patient_source(
      new.id,
      new.patient_source_key,
      jsonb_build_object('origin', 'lead_source_trigger')
    );
  end if;
  return new;
end;
$$;

drop trigger if exists leads_patient_source_sync on public.leads;
create trigger leads_patient_source_sync
after insert or update of patient_source_key, patient_id on public.leads
for each row
when (new.patient_source_key is not null)
execute function public.crm_sync_lead_patient_source();

-- The existing merge RPC moves all ordinary tags. Once it marks the duplicate
-- as merged, reconcile patient ownership: adopt the duplicate source only when
-- the survivor was unassigned; otherwise preserve the survivor and audit the
-- conflict. The RPC transaction makes this rollback-safe if a merge fails.
create or replace function public.crm_reconcile_patient_source_after_merge()
returns trigger
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  survivor_source text;
begin
  if new.merged_into_lead_id is null or old.merged_into_lead_id is not null then return new; end if;
  select patient_source_key into survivor_source
  from public.leads where id = new.merged_into_lead_id;

  if new.patient_source_key is not null then
    perform public.crm_apply_patient_source(
      new.merged_into_lead_id,
      new.patient_source_key,
      jsonb_build_object('origin', 'duplicate_merge', 'merged_lead_id', new.id)
    );
  elsif survivor_source is not null then
    perform public.crm_apply_patient_source(
      new.merged_into_lead_id,
      survivor_source,
      jsonb_build_object('origin', 'duplicate_merge_cleanup', 'merged_lead_id', new.id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists leads_patient_source_merge_reconcile on public.leads;
create trigger leads_patient_source_merge_reconcile
after update of merged_into_lead_id on public.leads
for each row execute function public.crm_reconcile_patient_source_after_merge();

-- Backfill only when one canonical historical tag proves the source. Rows with
-- no source tag or both tags remain NULL for explicit review.
with tagged as (
  select assignment.lead_id, min(source.key) as source_key, count(distinct source.key) as source_count
  from public.lead_tag_assignments assignment
  join public.crm_patient_sources source on source.tag_id = assignment.tag_id
  group by assignment.lead_id
)
update public.leads lead
set patient_source_key = tagged.source_key, updated_at = now()
from tagged
where lead.id = tagged.lead_id
  and lead.patient_source_key is null
  and tagged.source_count = 1;

update public.patients patient
set patient_source_key = lead.patient_source_key, updated_at = now()
from public.leads lead
where patient.patient_source_key is null
  and lead.patient_id = patient.id
  and lead.patient_source_key is not null
  and not exists (
    select 1 from public.leads other
    where other.patient_id = patient.id
      and other.patient_source_key is not null
      and other.patient_source_key <> lead.patient_source_key
  );

do $$
declare
  event_table text;
begin
  foreach event_table in array array[
    'lead_messages',
    'crm_messages',
    'crm_comments',
    'crm_conversations',
    'crm_conversation_events',
    'crm_ingest_logs'
  ] loop
    if to_regclass('public.' || event_table) is not null then
      execute format(
        'update public.%I event set patient_source_key = lead.patient_source_key
         from public.leads lead
         where event.lead_id = lead.id and event.patient_source_key is null',
        event_table
      );
    end if;
  end loop;
end $$;

alter table public.crm_patient_sources enable row level security;
alter table public.crm_patient_source_history enable row level security;
revoke all on table public.crm_patient_sources, public.crm_patient_source_history from public, anon, authenticated;
grant all on table public.crm_patient_sources, public.crm_patient_source_history to service_role;

comment on column public.leads.patient_source_key is
  'Stable patient ownership source; distinct from acquisition-channel source_id.';
comment on column public.patients.patient_source_key is
  'Canonical ownership source propagated from linked leads without overwriting an existing patient source.';
