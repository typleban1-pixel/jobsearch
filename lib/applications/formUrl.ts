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
  if ((job.source ?? "").toUpperCase() === "ASHBY") return job.apply_url ?? job.url ?? null;
  return null;
}
