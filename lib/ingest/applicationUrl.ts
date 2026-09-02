/**
 * Where a job's application form is, as opposed to where it is described.
 *
 * Greenhouse's API reports absolute_url, and a company with a custom
 * board reports its own careers page there. That URL is correct for
 * provenance and useless to a browser adapter: it renders a job
 * description with an "Apply" button and no form. The form always exists
 * at the board route, and the board token is something ingest already
 * knows, because it is what the board was fetched with.
 *
 * Two rules run through everything here. The token is never guessed from
 * a hostname: stripe.com does not imply the board is "stripe", it only
 * looks like it does, and a wrong guess sends an application to another
 * company's requisition. And a URL that cannot be verified is not
 * returned at all, because the alternative to a form URL is refusing to
 * fill, never following whatever link an employer page happens to offer.
 */

export const APPLICATION_URL_VERSION = 1;

/** Board tokens are slugs. Anything else is not a token we will use. */
const SAFE_TOKEN = /^[a-z0-9][a-z0-9-]{0,62}$/i;
/** Greenhouse job ids are numeric, and long. */
const SAFE_JOB_ID = /^[0-9]{4,20}$/;

export type FormUrlResult =
  | { ok: true; url: string }
  | { ok: false; why: string };

/**
 * The application form for one Greenhouse job.
 *
 * The route matters and the obvious one is wrong. job-boards.greenhouse.io
 * /{token}/jobs/{id} looks like a form URL and answers 200, but for every
 * employer with a custom board it 302s straight back to the company's own
 * careers page: stripe/jobs/7844214 lands on stripe.com, brex on brex.com,
 * toast on careers.toasttab.com. Following one and reading its status is
 * how this was got wrong the first time; the effective URL is the thing to
 * check, not the response code.
 *
 * The form lives at the embed route, which does not redirect. It answers
 * with one <form>, a file input, and a title reading "Job Application for
 * {title} at {employer}" -- verified against Stripe, Brex, SpotHero,
 * Affirm, Toast and Samsara.
 *
 * Pure and total: it validates its inputs and returns a reason rather
 * than a malformed URL. Both components are escaped even though both are
 * pattern-checked, because a token reaching here unchecked from a future
 * caller must not be able to build a path into another board.
 */
export function greenhouseFormUrl(boardToken: string | null | undefined,
                                  jobId: string | number | null | undefined): FormUrlResult {
  const token = String(boardToken ?? "").trim();
  const id = String(jobId ?? "").trim();
  if (!token) return { ok: false, why: "no board token is recorded for this employer" };
  if (!SAFE_TOKEN.test(token)) return { ok: false, why: `board token ${JSON.stringify(token)} is not a plain slug` };
  if (!id) return { ok: false, why: "no external job id is recorded" };
  if (!SAFE_JOB_ID.test(id)) return { ok: false, why: `job id ${JSON.stringify(id)} is not a Greenhouse numeric id` };
  return { ok: true,
    url: `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(token)}&token=${encodeURIComponent(id)}` };
}

/** The board's job-description route, which is not a form. Kept so the
 *  difference is nameable in tests rather than implied. */
export function greenhouseBoardUrl(boardToken: string, jobId: string | number): string {
  return `https://job-boards.greenhouse.io/${encodeURIComponent(boardToken)}/jobs/${encodeURIComponent(String(jobId))}`;
}

/** What the ATS says lives at a board token and job id. */
export interface BoardJob {
  id: number;
  title: string;
  companyName: string | null;
}

export type VerifyResult =
  | { ok: true; job: BoardJob; url: string }
  | { ok: false; why: string };

/**
 * Confirms a board and job id name the posting we think they name.
 *
 * The check that matters is not that the URL loads. It is that the job
 * behind it is the same job: a board token belonging to another employer
 * will usually 404, but a token that happens to hold a job with the same
 * numeric id would load perfectly and be the wrong company. So the id is
 * compared, and the company name is returned for the caller to compare
 * against its own record.
 *
 * Uses the boards API rather than the rendered page, because the form is
 * client-rendered and fetching HTML proves nothing about which job it is.
 */
export async function verifyGreenhouseForm(
  boardToken: string, jobId: string | number,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyResult> {
  const built = greenhouseFormUrl(boardToken, jobId);
  if (!built.ok) return built;

  const api = `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(boardToken)}/jobs/${encodeURIComponent(String(jobId))}`;
  let res: Response;
  try {
    res = await fetchImpl(api, { headers: { accept: "application/json" } });
  } catch (e: any) {
    return { ok: false, why: `the board could not be reached: ${e?.message ?? e}` };
  }
  if (res.status === 404) {
    return { ok: false, why: `board ${JSON.stringify(boardToken)} has no job ${jobId}` };
  }
  if (!res.ok) return { ok: false, why: `the board answered ${res.status}` };

  let body: any;
  try { body = await res.json(); } catch { return { ok: false, why: "the board did not return JSON" }; }

  // The id has to come back the same. Anything else means the route
  // resolved to a different posting than the one asked for.
  if (String(body?.id ?? "") !== String(jobId)) {
    return { ok: false, why: `asked for job ${jobId} and the board returned ${body?.id}` };
  }
  return {
    ok: true, url: built.url,
    job: { id: Number(body.id), title: String(body.title ?? ""), companyName: body.company_name ?? null },
  };
}

/**
 * Confirms the form URL actually serves a form, for the right job.
 *
 * The API check above proves the board and id name the posting we mean.
 * It says nothing about whether the URL we built is a form, which is the
 * question that matters and the one the first attempt at this got wrong.
 * So this fetches the page and requires three things of it: it must not
 * have been redirected somewhere else, it must contain a form, and its
 * title must name the employer we expect.
 *
 * Greenhouse titles these pages "Job Application for {title} at
 * {employer}", which is why the employer can be read straight off the
 * document rather than inferred from the URL that produced it.
 */
export async function verifyFormPage(
  url: string, expectEmployer: string, fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; title: string } | { ok: false; why: string }> {
  let res: Response;
  try {
    res = await fetchImpl(url, { redirect: "follow" });
  } catch (e: any) {
    return { ok: false, why: `the form page could not be reached: ${e?.message ?? e}` };
  }
  if (!res.ok) return { ok: false, why: `the form page answered ${res.status}` };

  // A redirect away from the embed route means this is not a form: it is
  // the employer's description page wearing a 200.
  if (!new URL(res.url).pathname.startsWith("/embed/job_app")) {
    return { ok: false, why: `redirected to ${res.url}, which is not an application form` };
  }

  const html = await res.text();
  if (!/<form/i.test(html)) return { ok: false, why: "the page contains no form" };

  const title = (html.match(/<title>([^<]*)/i)?.[1] ?? "").replace(/&amp;/g, "&").trim();
  const at = title.match(/\bat\s+(.+)$/i)?.[1] ?? null;
  if (at && !sameEmployer(at, expectEmployer)) {
    return { ok: false, why: `the form is titled for ${JSON.stringify(at)}, not ${JSON.stringify(expectEmployer)}` };
  }
  return { ok: true, title };
}

/**
 * Do two company names refer to the same employer?
 *
 * Deliberately loose about punctuation and suffixes and strict about
 * everything else. It exists to catch a board token pointing at another
 * company, which is the failure that would send an application to the
 * wrong employer, so it compares the meaningful part of the name and
 * refuses to treat a mismatch as a near miss.
 */
export function sameEmployer(a: string | null | undefined, b: string | null | undefined): boolean {
  const norm = (s: string | null | undefined) => String(s ?? "").toLowerCase()
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|holdings|group|plc|gmbh|technologies|labs)\b/g, " ")
    .replace(/[^a-z0-9]+/g, "");
  const x = norm(a), y = norm(b);
  if (!x || !y) return false;
  return x === y || x.startsWith(y) || y.startsWith(x);
}
