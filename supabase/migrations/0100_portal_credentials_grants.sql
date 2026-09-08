-- Grants the portal's signed-in role needs on the 0099 tables.
--
-- 0099 enabled RLS and added is_app_owner() policies, but not the table-level
-- GRANTs, so the authenticated role hit "permission denied for table
-- portal_credentials" on save (a privilege error, checked before RLS). RLS
-- still decides which rows are visible/writable; these grants just let the
-- role reach the table. service_role (the worker scripts) already bypasses
-- both, so only the portal was affected.
grant select, insert, update, delete on table portal_credentials to authenticated;
grant select on table worker_public_keys to authenticated;
