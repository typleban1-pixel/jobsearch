-- One-off removal of test debris.
--
-- Two applications were created by earlier runs of
-- verify-applications.ts before that test learned to mark and reuse a
-- single probe row. They are fictional, they are ABANDONED, and they are
-- not marked is_test, so purge_test_application correctly refuses them.
--
-- That refusal is the invariant working. Removing them therefore needs a
-- deliberate, named, one-off migration rather than a general door, which
-- is exactly the distinction 0045 was written to preserve.
--
-- The ids are literal. This migration can never affect anything else.

do $$
begin
  perform set_config('app.allow_history_mutation', 'on', true);
  delete from application_events where application_id = '6eb535db-ca1e-4205-a8b7-e6318bb66df4';
  delete from application_answers where application_id = '6eb535db-ca1e-4205-a8b7-e6318bb66df4';
  delete from applications where id = '6eb535db-ca1e-4205-a8b7-e6318bb66df4';
  delete from application_events where application_id = '0ebc22ff-2a2f-4bf1-8638-c1939282272e';
  delete from application_answers where application_id = '0ebc22ff-2a2f-4bf1-8638-c1939282272e';
  delete from applications where id = '0ebc22ff-2a2f-4bf1-8638-c1939282272e';
  perform set_config('app.allow_history_mutation', 'off', true);
end $$;
