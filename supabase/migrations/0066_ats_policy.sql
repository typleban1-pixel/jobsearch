-- Per-ATS operating switches.
--
-- A table rather than a boolean per provider on operating_policy, because
-- adding Workday or SmartRecruiters later should be an insert, not a
-- migration. operating_policy keeps the single global auto-submit switch;
-- this holds the per-provider pause and the honest statement of what each
-- adapter can currently do.
--
-- Pausing is deliberately independent of capability. An adapter can be
-- production-ready and paused, or unimplemented and unpaused, and
-- conflating the two would let "we cannot" read as "you chose not to".

create table if not exists ats_policy (
  provider ats_provider primary key,

  -- Operator switch. True stops unattended processing for this provider
  -- and nothing else; it never affects ingestion or scoring.
  paused boolean not null default true,
  paused_reason text,

  -- What the adapter can actually do, in this system's own words.
  -- NONE means no application automation exists for this provider yet.
  capability text not null default 'NONE'
    check (capability in ('NONE', 'IN_DEVELOPMENT', 'PRODUCTION')),
  capability_note text,

  updated_at timestamptz not null default now()
);

comment on table ats_policy is
  'Per-provider operator switches and adapter capability. Pausing is an operator choice; capability is a statement of fact about the adapter. The two are kept separate on purpose.';

insert into ats_policy (provider, paused, capability, capability_note) values
  ('GREENHOUSE', true, 'PRODUCTION',
   'Form resolution, deterministic upload identity, snapshot comparison, typed-filter comboboxes, exact geographic location matching, repeatable education, dynamic rescans, submission with genuine confirmation, and ordinary email OTP. Frozen.'),
  ('LEVER', true, 'NONE',
   'Ingest only. Application adapter not started; forms inspected and the adapter surface specified.'),
  ('ASHBY', true, 'NONE',
   'Ingest only. Application adapter not started.')
on conflict (provider) do nothing;

alter table ats_policy enable row level security;
drop policy if exists owner_read on public.ats_policy;
create policy owner_read on public.ats_policy for select using (is_app_owner());
drop policy if exists owner_write on public.ats_policy;
create policy owner_write on public.ats_policy for update using (is_app_owner()) with check (is_app_owner());
revoke all on public.ats_policy from authenticated;
grant select, update on public.ats_policy to authenticated;
