import { hashObject, sha256 } from "../hash.ts";
import { htmlToText } from "../normalize/text.ts";
import { parseLocation } from "../normalize/location.ts";
import { analyzeTitle } from "../normalize/title.ts";
import {
  parseCareerSignals, parseEmployment, parseSalaryFromText, parseStructuredSalary,
} from "../normalize/compensation.ts";
import type { AtsProvider, FetchResult, NormalizedJob, RawPosting } from "./types.ts";

const BASE = "https://boards-api.greenhouse.io/v1/boards";

/**
 * Greenhouse.
 *
 * `?content=true` returns the whole board WITH full descriptions in a
 * single response, so a company costs exactly one request no matter how
 * many jobs it has. Stripe's board is 574 jobs in one 4.4 MB call. Paging
 * per job would be 574 requests for the same data.
 *
 * The board endpoint is the canonical list: a job absent from it is
 * absent from the company's careers page. That is what makes staged
 * closed detection possible without guessing.
 */
export const greenhouse: AtsProvider = {
  name: "GREENHOUSE",
  normalizerVersion: 5,
  fetcherVersion: 1,

  boardUrl(token) {
    return `${BASE}/${encodeURIComponent(token)}/jobs?content=true`;
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

      if (!res.ok) {
        return fail(endpointUrl, res.status, durationMs, body, `HTTP ${res.status}`);
      }

      let parsed: { jobs?: unknown[] };
      try {
        parsed = JSON.parse(body);
      } catch {
        return fail(endpointUrl, res.status, durationMs, body, "response was not valid JSON");
      }
      if (!Array.isArray(parsed.jobs)) {
        return fail(endpointUrl, res.status, durationMs, body, "response had no jobs array");
      }

      return {
        ok: true,
        httpStatus: res.status,
        endpointUrl,
        durationMs,
        responseBytes: Buffer.byteLength(body, "utf8"),
        responseHash: sha256(body),
        rawBody: body,
        postings: parsed.jobs.map((j) => {
          const job = j as { id?: unknown };
          return { sourceJobId: String(job.id), raw: j };
        }),
        error: null,
      };
    } catch (err) {
      return fail(endpointUrl, null, Date.now() - started, null, describeError(err));
    }
  },

  normalize(posting) {
    const j = posting.raw as GreenhouseJob;
    const warnings: string[] = [];

    const descriptionText = j.content ? htmlToText(j.content) : "";
    if (!descriptionText) warnings.push("posting had no content; description is empty");

    const title = (j.title ?? "").trim();
    const titleInfo = analyzeTitle(title);
    warnings.push(...titleInfo.warnings);

    // Greenhouse has no structured remote field, so location text and the
    // description body are all there is. No provider hint is passed.
    const loc = parseLocation(j.location?.name ?? null, { extraText: descriptionText.slice(0, 4000) });
    warnings.push(...loc.warnings);

    let comp =
      parseStructuredSalary({
        min: j.pay_input_ranges?.[0]?.min_cents ? j.pay_input_ranges[0]!.min_cents! / 100 : null,
        max: j.pay_input_ranges?.[0]?.max_cents ? j.pay_input_ranges[0]!.max_cents! / 100 : null,
        currency: j.pay_input_ranges?.[0]?.currency_type ?? "USD",
        interval: null,
        source: "greenhouse_pay_input_ranges",
      }) ?? parseSalaryFromText(descriptionText);
    if (comp) warnings.push(...comp.warnings);

    const signals = parseCareerSignals(descriptionText);
    const department = j.departments?.map((d) => d.name).filter(Boolean).join(" / ") || null;

    return {
      sourceJobId: String(j.id),
      providerOpeningKey: j.internal_job_id != null ? String(j.internal_job_id) : null,
      url: j.absolute_url ?? null,
      applyUrl: j.absolute_url ?? null,
      title,
      normalizedTitle: titleInfo.normalizedTitle,
      department,
      locationRaw: loc.locationRaw,
      city: loc.city, state: loc.state, country: loc.country, metro: loc.metro,
      remotePolicy: loc.remotePolicy,
      remoteRestriction: loc.remoteRestriction,
      onsiteDaysPerWeek: loc.onsiteDaysPerWeek,
      employmentArrangement: parseEmployment(null, title),
      seniority: titleInfo.seniority,
      salaryMin: comp?.salaryMin ?? null,
      salaryMax: comp?.salaryMax ?? null,
      salaryCurrency: comp?.salaryCurrency ?? null,
      salaryPeriod: comp?.salaryPeriod ?? null,
      // False throughout: everything here came from the employer's own
      // board. salary_is_estimated is reserved for aggregator guesses.
      salaryIsEstimated: false,
      salarySource: comp?.salarySource ?? null,
      isIndividualContributor: titleInfo.isIndividualContributor,
      managesPeople: titleInfo.managesPeople,
      travelRequirementPct: signals.travelRequirementPct,
      hasQuotaOrCommission: signals.hasQuotaOrCommission,
      mentionsEquity: signals.mentionsEquity,
      postedAt: toIso(j.first_published ?? j.updated_at ?? null),
      descriptionText,
      normalizationWarnings: warnings,
    } satisfies NormalizedJob;
  },
};

interface GreenhouseJob {
  id: number | string;
  title?: string;
  content?: string;
  absolute_url?: string;
  updated_at?: string;
  first_published?: string;
  // The requisition. Several posts share one when a job is published to
  // several locations.
  internal_job_id?: number | string;
  // Free text the company fills in however it likes. Never used as identity.
  requisition_id?: string;
  location?: { name?: string };
  departments?: Array<{ name?: string }>;
  pay_input_ranges?: Array<{ min_cents?: number; max_cents?: number; currency_type?: string }>;
}

export const USER_AGENT =
  "jobsearch-personal/0.1 (single-user job search; contact via board owner)";

export function fail(
  endpointUrl: string, httpStatus: number | null, durationMs: number,
  body: string | null, error: string,
): FetchResult {
  return {
    ok: false, httpStatus, endpointUrl, durationMs,
    responseBytes: body ? Buffer.byteLength(body, "utf8") : 0,
    responseHash: body ? sha256(body) : null,
    // A failed fetch always keeps its body. It is small, and it is the
    // only evidence of what went wrong.
    rawBody: body ? body.slice(0, 20_000) : null,
    postings: [], error,
  };
}

export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

export function toIso(value: string | number | null): string | null {
  if (value === null) return null;
  const d = typeof value === "number" ? new Date(value) : new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export { hashObject };
