-- What the user has actually said about credentials, per family.
--
-- The distinction this table exists to hold is one he drew himself and it
-- is a sharp one. Confirming "the Health Science degree carries no
-- clinical licence" is not the same as confirming "I hold no professional
-- certifications of any kind", and collapsing the two would manufacture a
-- verified absence he never stated.
--
-- So declarations are per family, and a family nobody has asked about
-- stays UNDECLARED. Only NOT_HELD turns a credential requirement into a
-- genuine qualification failure; UNDECLARED keeps preserving uncertainty.
create type credential_status as enum ('HELD', 'NOT_HELD', 'UNDECLARED');

create table credential_declarations (
  family text primary key,
  status credential_status not null default 'UNDECLARED',
  note text,
  declared_at timestamptz,
  created_at timestamptz not null default now()
);

comment on table credential_declarations is
  'Per family, never global. A family with status UNDECLARED means the user has not been asked, and a requirement in that family must resolve UNKNOWN rather than ABSENT.';

insert into credential_declarations (family, status, note, declared_at) values
  ('CLINICAL', 'NOT_HELD',
   'Confirmed 30 Aug 2026: holds no professional healthcare licence or clinical certification. RN, LPN, NP, PA, physician, pharmacist and therapist licensure must never be inferred from the Health Science degree or its coursework.',
   now()),
  ('LEGAL', 'UNDECLARED', 'Never asked.', null),
  ('FINANCE', 'UNDECLARED', 'Never asked.', null),
  ('ENGINEERING', 'UNDECLARED', 'Never asked.', null),
  ('OTHER', 'UNDECLARED', 'Never asked. Deliberately not inferred from the clinical declaration.', null);
