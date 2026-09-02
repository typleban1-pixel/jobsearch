-- One-off removal of test debris, for the same reason as 0046.
--
-- application-guard-test.ts created probe applications without
-- is_test = true and then tried to remove them with a plain delete,
-- which applications do not permit. The delete failed quietly, the rows
-- stayed, and the next run of the suite collided with them on
-- applications_one_active_per_canonical_opening.
--
-- Both halves of that are now fixed in the script: it marks its rows
-- is_test at creation, removes them through purge_test_application, and
-- fails loudly if a removal does not happen. These five rows predate the
-- fix. is_test is immutable by design, so purge correctly refuses them,
-- and a named, literal migration is the only way out. That is the
-- distinction 0045 exists to preserve.
--
-- The ids are literal. Nothing else can be affected. In particular the
-- SpotHero application 9af26bee-dd8d-4e8d-b037-a224a5be24aa is not
-- listed and is not touched.

do $$
declare v_id uuid;
begin
  perform set_config('app.allow_history_mutation', 'on', true);
  foreach v_id in array array[
    '84813005-8f44-4149-b40d-c2b0ee05e8ec'::uuid,
    'd570fe4b-2cf0-4233-885c-420337676f39'::uuid,
    '4e1e489a-78cb-4972-95eb-c16e532f50f6'::uuid,
    '34e2bf3e-d90d-473f-8061-d50584d2d5ec'::uuid,
    'fa001f3d-6c6d-4249-a7dc-fc7b6720501d'::uuid
  ] loop
    delete from application_events where application_id = v_id;
    delete from application_answers where application_id = v_id;
    delete from applications where id = v_id and status in ('DRAFT', 'WITHDRAWN');
  end loop;
  perform set_config('app.allow_history_mutation', 'off', true);
end $$;
