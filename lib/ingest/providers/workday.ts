import { sha256 } from "../hash.ts";
import { htmlToText, normalizeWhitespace } from "../normalize/text.ts";
import { parseLocation } from "../normalize/location.ts";
import { analyzeTitle } from "../normalize/title.ts";
import { parseCareerSignals, parseEmployment, parseSalaryFromText } from "../normalize/compensation.ts";
import type { AtsProvider, FetchResult, NormalizedJob, RawPosting } from "./types.ts";
import { describeError, fail, toIso, USER_AGENT } from "./greenhouse.ts";

/**
 * Workday's own maximum. Asking for 100 returns HTTP 400, so a board of
 * two thousand jobs is a hundred round trips and pagination is the whole
 * cost of this provider.
 */
const BASE_LIMIT = 20;

/**
 * Pages per run, not jobs in the world.
 *
 * The first version walked to 2,000 with no ceiling. Abbott took 946
 * seconds and then threw, because one slow page tripped the timeout and
 * the failure took the entire board with it. A truncated board that
 * arrives is worth more than a complete one that never does, so this
 * stops early, says so, and picks up the rest on the next run.
 */
// 30 pages x 20 = 600, which sat just under Boeing (719) and Northern
// Trust (637) and so split both into permanent two-pass backfills. The
// cursor handles that correctly now, but a board that finishes in one
// pass is a board whose absence checks actually run, so give the cap
// real headroom. Per-page timeouts, not this number, bound the runtime.
const MAX_PAGES = 100;

/**
 * Workday.
 *
 * The enterprise gap. Greenhouse, Lever and Ashby are venture-backed-tech
 * systems, so the employers that dominate this market -- the hospital
 * networks, the exchanges, the manufacturers, the insurers -- were
 * invisible. Workday is what most of them run.
 *
 * The endpoint is the one Workday's own careers SPA calls:
 *
 *   POST {tenant}.{host}/wday/cxs/{tenant}/{site}/jobs
 *   {"appliedFacets":{},"limit":20,"offset":0,"searchText":""}
 *
 * It is public, it is JSON, and it needs no key. What it does need is
 * the tenant AND the site, which differ per employer and cannot be
 * guessed from a domain, so the token here is a composite written by the
 * resolver: "{tenant}.{host}/{site}".
 *
 * The listing is deliberately thin: title, locations, a posted date and
 * an externalPath. The full description needs a second call per job, so
 * ingestion records what the listing gives and the description is
 * fetched lazily. A thin job is still a job worth knowing about.
 */
export const workday: AtsProvider = {
  name: "WORKDAY" as any,
  normalizerVersion: 1,
  fetcherVersion: 1,

  boardUrl(token) {
    const { host, tenant, site } = split(token);
    return `https://${host}/wday/cxs/${tenant}/${site}/jobs`;
  },

  async fetchBoard(token, opts = {}) {
    const endpointUrl = this.boardUrl(token);
    const started = Date.now();
    const postings: RawPosting[] = [];
    let bytes = 0;
    let lastBody = "";

    const warnings: string[] = [];
    let truncated = false;
    const nextOffset = { v: 0 };

    const pageBudget = Math.max(1, Math.min(MAX_PAGES, opts.maxPages ?? MAX_PAGES));
    // Where this run picks up. The board's order is stable across
    // requests, which is what makes resuming by offset sound rather than
    // a way to skip postings.
    const startOffset = Math.max(0, opts.startOffset ?? 0);
    let reachedEnd = false;
    for (let page = 0; page < pageBudget; page++) {
      const offset = startOffset + page * BASE_LIMIT;
      let body = "";
      let status = 0;
      try {
        const res = await fetch(endpointUrl, {
          method: "POST",
          // Per page, not per board. One slow page used to abort every
          // page that came before it.
          signal: AbortSignal.timeout(opts.timeoutMs ?? 25_000),
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            "user-agent": USER_AGENT,
          },
          body: JSON.stringify({ appliedFacets: {}, limit: BASE_LIMIT, offset, searchText: "" }),
        });
        status = res.status;
        body = await res.text();
        bytes += body.length;
        lastBody = body;
      } catch (err) {
        // A page that fails after the first one leaves the board partial
        // rather than absent, which is the more useful of the two.
        if (page === 0) return fail(endpointUrl, null, Date.now() - started, null, describeError(err));
        warnings.push(`stopped at offset ${offset}: ${describeError(err)}`);
        truncated = true;
        break;
      }

      if (status !== 200) {
        if (page === 0) {
          return fail(endpointUrl, status, Date.now() - started, body,
            `Workday returned ${status} for ${token}`);
        }
        warnings.push(`stopped at offset ${offset}: HTTP ${status}`);
        truncated = true;
        break;
      }

      let parsed: { total?: number; jobPostings?: any[] };
      try {
        parsed = JSON.parse(body);
      } catch {
        if (page === 0) {
          return fail(endpointUrl, status, Date.now() - started, body,
            "Workday returned a 200 that was not JSON");
        }
        warnings.push(`stopped at offset ${offset}: response was not JSON`);
        truncated = true;
        break;
      }

      const postingsPage = parsed.jobPostings ?? [];
      for (const p of postingsPage) {
        const id = String(p.externalPath ?? p.bulletFields?.[0] ?? "").trim();
        if (!id) continue;
        postings.push({ sourceJobId: id, raw: { ...p, __token: token } });
      }
      if (postingsPage.length < BASE_LIMIT) { reachedEnd = true; break; }
      if (page === pageBudget - 1) truncated = true;
      // Their infrastructure, their pace.
      await new Promise((r) => setTimeout(r, 250));
    }

    if (truncated && !reachedEnd) {
      warnings.push(`read ${postings.length} postings from offset ${startOffset}; the rest arrive on a later run`);
    }
    // Handed back so the caller can advance its cursor without having to
    // re-derive where the traversal stopped.
    (nextOffset as { v: number }).v = reachedEnd ? -1 : startOffset + postings.length;

    return {
      ok: true, httpStatus: 200, endpointUrl,
      durationMs: Date.now() - started,
      responseBytes: bytes,
      responseHash: sha256(String(postings.length) + endpointUrl),
      rawBody: null,
      postings,
      error: warnings.length ? warnings.join("; ") : null,
      // -1 means the end of the board was reached.
      nextOffset: nextOffset.v,
    } as FetchResult & { nextOffset: number };
  },

  normalize(posting) {
    const p = posting.raw as any;
    const token = String(p.__token ?? "");
    const { host, site } = split(token);
    const title = normalizeWhitespace(String(p.title ?? ""));
    const path = String(p.externalPath ?? "");
    const url = path ? `https://${host}/${site}${path}` : null;

    // locationsText is the only geography the listing carries, and it is
    // sometimes a count rather than a place: "4 Locations". A count is
    // not a location, so it is recorded raw and left for the normalizer
    // to refuse rather than being invented into one.
    const locationRaw = normalizeWhitespace(String(p.locationsText ?? "")) || null;
    const multi = /^\d+\s+locations?$/i.test(locationRaw ?? "");
    const loc = parseLocation(workdayLocation(locationRaw));

    const text = htmlToText(String(p.jobDescription ?? "")) || "";
    const t = analyzeTitle(title);
    // Title analysis already decides these; the description only confirms.
    const salary = parseSalaryFromText(text);
    const signals = parseCareerSignals(text);

    const warnings: string[] = [];
    if (multi) warnings.push(`the listing gives "${locationRaw}" instead of a place`);
    if (!text) warnings.push("the listing carries no description; it needs a per-job fetch");

    return {
      sourceJobId: posting.sourceJobId,
      providerOpeningKey: String(p.bulletFields?.[0] ?? "") || null,
      url,
      applyUrl: url ? `${url}/apply` : null,
      title,
      normalizedTitle: t.normalizedTitle,
      department: null,
      locationRaw,
      city: loc.city, state: loc.state, country: loc.country, metro: loc.metro,
      remotePolicy: loc.remotePolicy,
      remoteRestriction: loc.remoteRestriction,
      onsiteDaysPerWeek: null,
      employmentArrangement: parseEmployment(text, title),
      seniority: t.seniority,
      salaryMin: salary?.salaryMin ?? null, salaryMax: salary?.salaryMax ?? null,
      salaryCurrency: salary?.salaryCurrency ?? null, salaryPeriod: salary?.salaryPeriod ?? null,
      salaryIsEstimated: false, salarySource: salary?.salarySource ?? null,
      isIndividualContributor: t.isIndividualContributor,
      managesPeople: t.managesPeople,
      travelRequirementPct: signals.travelRequirementPct,
      hasQuotaOrCommission: signals.hasQuotaOrCommission,
      mentionsEquity: signals.mentionsEquity,
      postedAt: workdayPostedAt(p.postedOn ?? null),
      descriptionText: text,
      normalizationWarnings: warnings,
    };
  },
};

/** "abbott.wd5.myworkdayjobs.com/abbottcareers" -> its three parts. */
export function split(token: string): { host: string; tenant: string; site: string } {
  const [host = "", site = ""] = token.split("/");
  const tenant = host.split(".")[0] ?? "";
  return { host, tenant, site };
}

/**
 * Workday's location strings, turned into something parseLocation reads.
 *
 * Every tenant configures its own format and none of them is the "City,
 * ST" the normalizer expects, so every Workday job came back with no
 * city and an UNCLEAR remote policy. The four shapes actually observed:
 *
 *   United States > Phoenix : 445 North 5th St     country > city : street
 *   United States - Kentucky - Lexington           country - state - city
 *   US, CA, Santa Clara                            country, state, city
 *   3 Locations                                    a count, not a place
 *
 * A count is not a location and is returned as null rather than being
 * turned into one. The street address is dropped: it is precise and
 * useless, and keeping it makes the string fail to match anything.
 */
export function workdayLocation(raw: string | null): string | null {
  const s = normalizeWhitespace(String(raw ?? ""));
  if (!s) return null;
  if (/^\d+\s+locations?$/i.test(s)) return null;

  // "country > city : street"
  if (s.includes(">")) {
    const [country = "", rest = ""] = s.split(">").map((x) => x.trim());
    const city = rest.split(":")[0]?.trim();
    return city ? `${city}, ${country}` : null;
  }

  // "country - state - city" and "country - city"
  if (s.includes(" - ")) {
    const parts = s.split(" - ").map((x) => x.trim()).filter(Boolean);
    if (parts.length >= 3) return `${parts[2]}, ${parts[1]}, ${parts[0]}`;
    if (parts.length === 2) return `${parts[1]}, ${parts[0]}`;
    return parts[0] ?? null;
  }

  // "country, state, city", dropping any street tail after a colon
  const head = s.split(":")[0]!.trim();
  const parts = head.split(",").map((x) => x.trim()).filter(Boolean);
  if (parts.length >= 3) return `${parts[2]}, ${parts[1]}, ${parts[0]}`;
  if (parts.length === 2) return `${parts[1]}, ${parts[0]}`;
  return head || null;
}


/**
 * Workday reports posting age in words, not dates.
 *
 * "Posted Today", "Posted Yesterday", "Posted 30+ Days Ago". Passing any
 * of those to a date parser produced nothing, so every Workday job
 * arrived with no posted date at all. Relative ages are resolved against
 * now; anything vaguer than a number of days stays null rather than
 * becoming a date nobody stated.
 */
export function workdayPostedAt(raw: string | null): string | null {
  const s = normalizeWhitespace(String(raw ?? "")).toLowerCase();
  if (!s) return null;
  const day = 86_400_000;
  const at = (daysAgo: number) => new Date(Date.now() - daysAgo * day).toISOString();
  if (/\btoday\b|\bjust posted\b/.test(s)) return at(0);
  if (/\byesterday\b/.test(s)) return at(1);
  const days = /posted\s+(\d+)\+?\s*days?\s*ago/.exec(s);
  if (days) return at(Number(days[1]));
  const m = /posted\s+(\d+)\+?\s*months?\s*ago/.exec(s);
  if (m) return at(Number(m[1]) * 30);
  // A real date, if a tenant ever sends one.
  const asDate = toIso(raw);
  return asDate;
}
