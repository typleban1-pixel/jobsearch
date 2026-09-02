import { sha256 } from "../hash.ts";
import { htmlToText, normalizeWhitespace } from "../normalize/text.ts";
import { parseLocation } from "../normalize/location.ts";
import { analyzeTitle } from "../normalize/title.ts";
import { parseCareerSignals, parseEmployment, parseSalaryFromText } from "../normalize/compensation.ts";
import type { AtsProvider, FetchResult, NormalizedJob, RawPosting } from "./types.ts";
import { describeError, fail, toIso, USER_AGENT } from "./greenhouse.ts";

const BASE = "https://api.smartrecruiters.com/v1/companies";
const PAGE = 100;
const MAX_PAGES = 25;

/**
 * SmartRecruiters.
 *
 * A documented public postings API, no key, and it pages properly.
 *
 * One trap worth naming: an unknown company identifier returns HTTP 200
 * with `totalFound: 0` rather than a 404, so the status code says
 * nothing about whether the board exists. That is fine here only because
 * verification already requires postings > 0 -- a guessed slug returns
 * an empty list and is refused. If that requirement were ever relaxed,
 * every guess would look like a valid board.
 *
 * Identifiers are case-insensitive, so lowercasing them in the resolver
 * is safe. They are frequently not the company name: Bosch is
 * "BoschGroup", which is why guessing from a domain works poorly and the
 * careers-page path matters more here than elsewhere.
 */
export const smartrecruiters: AtsProvider = {
  name: "SMARTRECRUITERS" as any,
  normalizerVersion: 1,
  fetcherVersion: 1,

  boardUrl(token) {
    return `${BASE}/${encodeURIComponent(token)}/postings`;
  },

  async fetchBoard(token, opts = {}) {
    const endpointUrl = this.boardUrl(token);
    const started = Date.now();
    const postings: RawPosting[] = [];
    const warnings: string[] = [];
    let bytes = 0;

    const budget = Math.max(1, Math.min(MAX_PAGES, opts.maxPages ?? MAX_PAGES));
    const startOffset = Math.max(0, opts.startOffset ?? 0);
    let reachedEnd = false;

    for (let p = 0; p < budget; p++) {
      const offset = startOffset + p * PAGE;
      const url = `${endpointUrl}?limit=${PAGE}&offset=${offset}`;
      let body = "";
      let status = 0;
      try {
        const res = await fetch(url, {
          signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
          headers: { accept: "application/json", "user-agent": USER_AGENT },
        });
        status = res.status;
        body = await res.text();
        bytes += body.length;
      } catch (err) {
        if (p === 0) return fail(endpointUrl, null, Date.now() - started, null, describeError(err));
        warnings.push(`stopped at offset ${offset}: ${describeError(err)}`);
        break;
      }
      if (status !== 200) {
        if (p === 0) return fail(endpointUrl, status, Date.now() - started, body,
          `SmartRecruiters returned ${status} for ${token}`);
        warnings.push(`stopped at offset ${offset}: HTTP ${status}`);
        break;
      }

      let parsed: { totalFound?: number; content?: any[] };
      try { parsed = JSON.parse(body); }
      catch {
        if (p === 0) return fail(endpointUrl, status, Date.now() - started, body,
          "SmartRecruiters returned a 200 that was not JSON");
        break;
      }

      const content = parsed.content ?? [];
      for (const c of content) {
        const id = String(c.id ?? c.uuid ?? "").trim();
        if (id) postings.push({ sourceJobId: id, raw: { ...c, __token: token } });
      }
      if (content.length < PAGE) { reachedEnd = true; break; }
      await new Promise((r) => setTimeout(r, 250));
    }

    if (!reachedEnd && postings.length) {
      warnings.push(`read ${postings.length} postings from offset ${startOffset}; the rest arrive on a later run`);
    }

    return {
      ok: true, httpStatus: 200, endpointUrl,
      durationMs: Date.now() - started,
      responseBytes: bytes,
      responseHash: sha256(String(postings.length) + endpointUrl),
      rawBody: null,
      postings,
      error: warnings.length ? warnings.join("; ") : null,
      nextOffset: reachedEnd ? -1 : startOffset + postings.length,
    } as FetchResult & { nextOffset: number };
  },

  normalize(posting) {
    const c = posting.raw as any;
    const token = String(c.__token ?? "");
    const title = normalizeWhitespace(String(c.name ?? ""));
    const loc = c.location ?? {};

    // The listing carries a structured location, which is better than
    // the free text most boards give. Remote is a flag on it, not a
    // guess from the city.
    const parts = [loc.city, loc.region, loc.country].map((x: any) => normalizeWhitespace(String(x ?? ""))).filter(Boolean);
    const locationRaw = parts.join(", ") || null;
    const parsedLoc = parseLocation(locationRaw);
    const remote = loc.remote === true;

    const text = htmlToText([
      c.jobAd?.sections?.jobDescription?.text,
      c.jobAd?.sections?.qualifications?.text,
      c.jobAd?.sections?.additionalInformation?.text,
    ].filter(Boolean).join("\n")) || "";

    const t = analyzeTitle(title);
    const salary = parseSalaryFromText(text);
    const signals = parseCareerSignals(text);
    const url = String(c.applyUrl ?? c.ref ?? "") || null;

    return {
      sourceJobId: posting.sourceJobId,
      providerOpeningKey: String(c.refNumber ?? "") || null,
      url,
      applyUrl: url,
      title,
      normalizedTitle: t.normalizedTitle,
      department: normalizeWhitespace(String(c.department?.label ?? "")) || null,
      locationRaw,
      city: parsedLoc.city, state: parsedLoc.state,
      country: parsedLoc.country, metro: parsedLoc.metro,
      // The board states remote outright; trust it over inference.
      remotePolicy: remote ? "FULLY_REMOTE" : parsedLoc.remotePolicy,
      remoteRestriction: parsedLoc.remoteRestriction,
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
      postedAt: toIso(c.releasedDate ?? c.createdOn ?? null),
      descriptionText: text,
      normalizationWarnings: text ? [] : ["the listing carries no description"],
    };
  },
};
