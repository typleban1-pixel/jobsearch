/**
 * Ashby.
 *
 * The third canonical board. The ats_provider enum has listed ASHBY since
 * migration 0002 with nothing behind it, which meant every company using
 * it was invisible no matter how many directories named them.
 *
 * Its posting API is public and needs no key:
 *
 *   https://api.ashbyhq.com/posting-api/job-board/{token}?includeCompensation=true
 *
 * One thing it does that the other two do not: an unknown token answers
 * HTTP 200 with an empty job list rather than a 404. Verification
 * therefore cannot trust the status code, which is why verifyBoard
 * requires at least one posting before a token counts as proven.
 */
import { sha256 } from "../hash.ts";
import { htmlToText, normalizeWhitespace } from "../normalize/text.ts";
import { parseLocation, type RemotePolicy } from "../normalize/location.ts";
import { analyzeTitle } from "../normalize/title.ts";
import { parseEmployment, parseStructuredSalary, parseSalaryFromText, parseCareerSignals } from "../normalize/compensation.ts";
import type { AtsProvider, FetchResult, NormalizedJob, RawPosting } from "./types.ts";
import { describeError, fail, toIso, USER_AGENT } from "./greenhouse.ts";

const BASE = "https://api.ashbyhq.com/posting-api/job-board";

interface AshbyJob {
  id: string;
  title?: string;
  department?: string | null;
  team?: string | null;
  employmentType?: string | null;
  location?: string | null;
  secondaryLocations?: Array<{ location?: string | null }> | null;
  publishedAt?: string | null;
  isListed?: boolean;
  isRemote?: boolean;
  workplaceType?: string | null;
  address?: { postalAddress?: { addressCountry?: string | null; addressRegion?: string | null; addressLocality?: string | null } } | null;
  jobUrl?: string | null;
  applyUrl?: string | null;
  descriptionHtml?: string | null;
  descriptionPlain?: string | null;
  compensation?: {
    compensationTiers?: Array<{
      components?: Array<{ minValue?: number | null; maxValue?: number | null; currencyCode?: string | null; interval?: string | null; summary?: string | null; compensationType?: string | null }>;
    }> | null;
  } | null;
}

export const ashby: AtsProvider = {
  name: "ASHBY",
  normalizerVersion: 1,
  fetcherVersion: 1,

  boardUrl(token) {
    return `${BASE}/${encodeURIComponent(token)}?includeCompensation=true`;
  },

  async fetchBoard(token, opts = {}) {
    const endpointUrl = this.boardUrl(token);
    const started = Date.now();
    try {
      const res = await fetch(endpointUrl, {
        signal: AbortSignal.timeout(opts.timeoutMs ?? 45_000),
        headers: { accept: "application/json", "user-agent": USER_AGENT },
      });
      const body = await res.text();
      const durationMs = Date.now() - started;
      if (!res.ok) return fail(endpointUrl, res.status, durationMs, body, `HTTP ${res.status}`);

      let parsed: unknown;
      try { parsed = JSON.parse(body); }
      catch { return fail(endpointUrl, res.status, durationMs, body, "response was not JSON"); }

      const jobs = (parsed as { jobs?: AshbyJob[] })?.jobs;
      if (!Array.isArray(jobs)) {
        return fail(endpointUrl, res.status, durationMs, body, "response had no jobs array");
      }

      return {
        ok: true, httpStatus: res.status, endpointUrl, durationMs,
        responseBytes: Buffer.byteLength(body), responseHash: sha256(body), rawBody: body,
        // Unlisted postings are on the board but not published. They are
        // not opportunities and are dropped here rather than filtered
        // later, so nothing downstream has to know Ashby has the concept.
        postings: jobs.filter((j) => j.isListed !== false).map((j) => ({ sourceJobId: String(j.id), raw: j })),
        error: null,
      } satisfies FetchResult;
    } catch (e) {
      return fail(endpointUrl, null, Date.now() - started, null, describeError(e));
    }
  },

  normalize(posting: RawPosting): NormalizedJob {
    const j = posting.raw as AshbyJob;
    const warnings: string[] = [];
    const title = normalizeWhitespace(j.title ?? "");
    const titleInfo = analyzeTitle(title);

    const descriptionText = j.descriptionPlain
      ? normalizeWhitespace(j.descriptionPlain)
      : htmlToText(j.descriptionHtml ?? "");

    // Ashby splits a multi-location posting into a primary plus
    // secondaries. Joined with the same separator the location-set parser
    // already understands, so a variant naming four cities keeps all four.
    const allLocations = [j.location, ...(j.secondaryLocations ?? []).map((s) => s?.location)]
      .map((s) => (s ?? "").trim()).filter(Boolean);
    const locationRaw = allLocations.length > 0 ? allLocations.join("; ") : null;

    const loc = parseLocation(locationRaw, {
      providerHint: mapWorkplaceType(j.workplaceType) ?? (j.isRemote ? "FULLY_REMOTE" : null),
      country: j.address?.postalAddress?.addressCountry ?? null,
      extraText: descriptionText.slice(0, 4000),
    });
    warnings.push(...loc.warnings);

    // Only base-salary components. Ashby also reports equity and bonus
    // tiers, and reading one of those as salary is the mistake that put
    // "$32,000-$48,000 new hire equity" into the salary column earlier in
    // this project.
    const base = (j.compensation?.compensationTiers ?? [])
      .flatMap((t) => t.components ?? [])
      .find((c) => /salary/i.test(c.compensationType ?? "") && (c.minValue ?? c.maxValue));
    let comp = base
      ? parseStructuredSalary({
          min: base.minValue ?? null, max: base.maxValue ?? null,
          currency: base.currencyCode ?? "USD", interval: base.interval ?? null,
          source: "ashby_compensation",
        })
      : parseSalaryFromText(descriptionText);
    if (comp) warnings.push(...comp.warnings);

    const signals = parseCareerSignals(descriptionText);

    return {
      // Ashby's public API exposes only the posting id. There is no
      // separate requisition id, so multi-location postings arrive as one
      // record with secondaryLocations rather than as sibling posts.
      providerOpeningKey: null,
      sourceJobId: String(j.id),
      url: j.jobUrl ?? null,
      applyUrl: j.applyUrl ?? j.jobUrl ?? null,
      title,
      normalizedTitle: titleInfo.normalizedTitle,
      department: [j.department, j.team].filter(Boolean).join(" / ") || null,
      locationRaw,
      city: loc.city, state: loc.state, country: loc.country, metro: loc.metro,
      remotePolicy: loc.remotePolicy,
      remoteRestriction: loc.remoteRestriction,
      onsiteDaysPerWeek: loc.onsiteDaysPerWeek,
      employmentArrangement: parseEmployment(j.employmentType ?? null, title),
      seniority: titleInfo.seniority,
      salaryMin: comp?.salaryMin ?? null,
      salaryMax: comp?.salaryMax ?? null,
      salaryCurrency: comp?.salaryCurrency ?? null,
      salaryPeriod: comp?.salaryPeriod ?? null,
      salaryIsEstimated: false,
      salarySource: comp?.salarySource ?? null,
      isIndividualContributor: titleInfo.isIndividualContributor,
      managesPeople: titleInfo.managesPeople,
      travelRequirementPct: signals.travelRequirementPct,
      hasQuotaOrCommission: signals.hasQuotaOrCommission,
      mentionsEquity: signals.mentionsEquity,
      postedAt: toIso(j.publishedAt ?? null),
      descriptionText,
      normalizationWarnings: warnings,
    } satisfies NormalizedJob;
  },
};

/** Ashby's own vocabulary, mapped without interpretation. */
function mapWorkplaceType(v: string | null | undefined): RemotePolicy | null {
  switch ((v ?? "").toLowerCase()) {
    case "remote": return "FULLY_REMOTE";
    case "hybrid": return "HYBRID";
    case "onsite":
    case "on-site":
    case "inoffice": return "ONSITE";
    default: return null;
  }
}
