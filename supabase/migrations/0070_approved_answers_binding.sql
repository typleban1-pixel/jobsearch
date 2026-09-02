-- Approval binds to what was actually reviewed.
--
-- approved_artifact_sha256 and approved_content_sha256 already pin the
-- resume a person approved, and job_version_id pins the posting. The
-- answers were not pinned to anything: an approval stayed valid while
-- the answer set underneath it changed, so a person could approve one
-- set of answers and a different set could reach the employer.
--
-- This records a hash of the answer set as reviewed. The submission
-- guard compares it against the answers as they stand and refuses when
-- they differ, the same way it already refuses a changed artifact.

alter table applications
  add column if not exists approved_answers_sha256 text;

comment on column applications.approved_answers_sha256 is
  'SHA-256 over the (field_key, answer_text) pairs as they stood when the '
  'application was approved. Null until approval. Compared at submission: '
  'a mismatch means the answers changed after review and the approval no '
  'longer describes what would be sent.';
