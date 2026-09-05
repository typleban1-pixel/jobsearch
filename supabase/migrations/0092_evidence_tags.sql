-- Tags on evidence, so a capability can retrieve a coherent subset (e.g.
-- personality/interest facts for a "fun fact" question) without scanning
-- free text. Additive; existing rows get an empty array.
alter table evidence add column if not exists tags text[] not null default '{}';
create index if not exists evidence_tags_idx on evidence using gin (tags);
