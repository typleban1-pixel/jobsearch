-- SUBMITTED means something different for a human submission.
--
-- submitted_requires_authorization insisted on all_fields_confident for
-- any submitted application. That flag is computed from mapped answer
-- rows, and it exists to stop the machine submitting a package whose
-- fields were never checked. It is the right rule for the automated
-- path and a category error for the manual one: when Ashby publishes no
-- form there are no fields to be confident about, and a person filled
-- the form themselves on the employer's site.
--
-- The machine path is untouched: an AUTOMATED or ASSISTED submission
-- still requires all_fields_confident exactly as before. A MANUAL
-- submission requires a person's approval and employer confirmation
-- evidence instead, which is the corresponding assurance for an act a
-- person performed.

alter table applications drop constraint if exists submitted_requires_authorization;

alter table applications add constraint submitted_requires_authorization check (
  status not in ('SUBMITTED','ACKNOWLEDGED','IN_PROCESS','INTERVIEWING','OFFER')
  or (
    submitted_at is not null
    and (human_approved or authorization_mode = 'POLICY_AUTHORIZED')
    and (
      -- The machine path, unchanged.
      (submission_mode is distinct from 'MANUAL' and all_fields_confident)
      -- The manual path: a person did it, and there is evidence they did.
      or (submission_mode = 'MANUAL'
          and human_approved
          and confirmation_reference is not null
          and btrim(confirmation_reference) <> '')
    )
  )
);

comment on constraint submitted_requires_authorization on applications is
  'A submitted application must carry authorization and, for machine submissions, '
  'all_fields_confident. A MANUAL submission substitutes a person''s approval plus '
  'employer confirmation evidence, because the fields it would describe were filled '
  'by a person on the employer''s own site.';
