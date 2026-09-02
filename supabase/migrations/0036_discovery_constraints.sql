-- Constraints discovery needs.
--
-- company_sources is meant to hold one row per source, updated on each
-- sweep with what it found. Without a unique key on the label, a weekly
-- sweep would append a new row every week and the "companies_added"
-- history would become a pile rather than a record.
alter table company_sources add constraint company_sources_label_unique unique (label);

-- A domain identifies a company. Two directories naming the same employer
-- differently must resolve to one row, and the application-level dedup in
-- scripts/discover.ts should not be the only thing enforcing that.
create unique index companies_domain_unique on companies (lower(domain)) where domain is not null;

comment on constraint company_sources_label_unique on company_sources is
  'One row per source, updated per sweep. The row is the source''s history, not a log line.';
