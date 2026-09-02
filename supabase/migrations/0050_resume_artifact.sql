-- The document, not a description of the document.
--
-- The review screen showed tailored claims while the browser uploaded a
-- PDF recomposed from the frozen profile. Both were grounded, so nothing
-- untrue would have reached an employer, but the approval gate was
-- meaningless: a person reviewed one document and a different one would
-- have been sent.
--
-- The invariant this exists to enforce:
--
--   THE EXACT DOCUMENT APPROVED IS THE EXACT DOCUMENT UPLOADED.
--
-- So the rendered PDF becomes a stored artifact with a content hash.
-- Approval binds to that hash. The fill path verifies the bytes it is
-- about to upload still hash to the approved value, and stops if they do
-- not. Nothing is re-rendered at fill time; a resume that needs
-- regenerating goes back through review.

alter table resumes add column if not exists artifact_pdf text;
alter table resumes add column if not exists artifact_sha256 text;
alter table resumes add column if not exists artifact_bytes integer;
alter table resumes add column if not exists artifact_rendered_at timestamptz;
alter table resumes add column if not exists renderer_version integer;

alter table resumes drop constraint if exists artifact_hash_is_sha256;
alter table resumes add constraint artifact_hash_is_sha256
  check (artifact_sha256 is null or artifact_sha256 ~ '^[0-9a-f]{64}$');

-- An artifact is bytes and a hash together, or neither.
alter table resumes drop constraint if exists artifact_is_complete;
alter table resumes add constraint artifact_is_complete
  check ((artifact_pdf is null and artifact_sha256 is null and artifact_bytes is null)
      or (artifact_pdf is not null and artifact_sha256 is not null and artifact_bytes is not null));

comment on column resumes.artifact_pdf is
  'The rendered PDF, base64. This IS the employer-facing document; the claim rows describe it and do not replace it.';
comment on column resumes.artifact_sha256 is
  'SHA-256 of the decoded PDF bytes. Approval binds to this value and the fill path re-checks it before uploading.';
comment on column resumes.renderer_version is
  'Which renderer produced the artifact. A design change bumps it, so an artifact approved under an older renderer is identifiable rather than assumed current.';

-- What the human actually approved.
-- What the document SAYS, independent of how a PDF encodes it.
--
-- A PDF carries a creation timestamp and a document id, so re-rendering
-- identical content produces different bytes. That is why the byte hash
-- is the gate and this is not: content_sha256 lets a reader tell "the
-- same resume, re-rendered" from "a different resume", and is never
-- permission to render a replacement for a missing or mismatched
-- artifact.
alter table resumes add column if not exists content_sha256 text;

alter table resumes drop constraint if exists content_hash_is_sha256;
alter table resumes add constraint content_hash_is_sha256
  check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$');

comment on column resumes.content_sha256 is
  'SHA-256 of the canonicalized employer-facing ResumeDoc. Stable across re-renders and across visual templates. Recorded for audit; approval and upload are gated on artifact_sha256, never on this.';

alter table applications add column if not exists approved_artifact_sha256 text;
alter table applications add column if not exists approved_content_sha256 text;

alter table applications drop constraint if exists approved_content_hash_is_sha256;
alter table applications add constraint approved_content_hash_is_sha256
  check (approved_content_sha256 is null or approved_content_sha256 ~ '^[0-9a-f]{64}$');

comment on column applications.approved_content_sha256 is
  'The content hash of what was approved, recorded alongside the byte hash. Informational: the fill path gates on approved_artifact_sha256 and never accepts a document because its content hash matches.';

alter table applications drop constraint if exists approved_artifact_hash_is_sha256;
alter table applications add constraint approved_artifact_hash_is_sha256
  check (approved_artifact_sha256 is null or approved_artifact_sha256 ~ '^[0-9a-f]{64}$');

-- Approval without a named artifact is approval of nothing.
alter table applications drop constraint if exists approval_names_an_artifact;
alter table applications add constraint approval_names_an_artifact
  check (not human_approved or approved_artifact_sha256 is not null);

comment on column applications.approved_artifact_sha256 is
  'The hash of the exact PDF the human approved. Set at approval, never by the worker. The fill path uploads the artifact matching this hash or stops; it never regenerates one.';
