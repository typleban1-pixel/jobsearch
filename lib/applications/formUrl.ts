/**
 * The URL the browser opens to reach an application form.
 *
 * Most providers publish a board form route in application_form_url.
 * Ashby does not: its apply page IS the form, so it falls back to the
 * apply_url (or the canonical url). Keeping this in one place stops the
 * fill path and the submit path from disagreeing -- which is exactly how
 * submit-application.ts came to call page.goto with a null/object for an
 * Ashby job while fill-application.ts opened it correctly.
 */
export interface FormUrlJob {
  source?: string | null;
  application_form_url?: string | null;
  apply_url?: string | null;
  url?: string | null;
}

export function resolveFormUrl(job: FormUrlJob): string | null {
  if (job.application_form_url) return job.application_form_url;
  const source = (job.source ?? "").toUpperCase();
  if (source === "ASHBY") return job.apply_url ?? job.url ?? null;
  if (source === "GREENHOUSE") {
    // Greenhouse's application form is the embed route, keyed by board token
    // and numeric job id. When application_form_url was not captured at ingest
    // (~40% of open GH postings), derive it from a job-boards apply/canonical
    // URL of the form job-boards.greenhouse.io/{token}/jobs/{id}. Verified
    // against every GH job that has BOTH fields: this reproduces the stored
    // application_form_url exactly (910/910, zero mismatches). Without this the
    // submit path fail-closed stopped on a form the prepare/fill path had
    // already read -- the two paths disagreeing, the exact bug this module
    // exists to prevent. Company-hosted apply URLs (careers.acme.com?gh_jid=)
    // carry no token in the path and stay null, so the caller still stops
    // safely rather than opening a guessed page.
    for (const u of [job.apply_url, job.url]) {
      const m = u?.match(/job-boards\.greenhouse\.io\/([^/]+)\/jobs\/(\d+)/);
      if (m) return `https://job-boards.greenhouse.io/embed/job_app?for=${m[1]}&token=${m[2]}`;
    }
  }
  return null;
}
