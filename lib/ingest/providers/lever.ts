import { sha256 } from "../hash.ts";
import { htmlToText, normalizeWhitespace } from "../normalize/text.ts";
import { parseLocation, type RemotePolicy } from "../normalize/location.ts";
import { analyzeTitle } from "../normalize/title.ts";
import {
  parseCareerSignals, parseEmployment, parseSalaryFromText, parseStructuredSalary,
} from "../normalize/compensation.ts";
import type { AtsProvider, FetchResult, NormalizedJob, RawPosting } from "./types.ts";
import { describeError, fail, toIso, USER_AGENT } from "./greenhouse.ts";

const BASE = "https://api.lever.co/v0/postings";

/**
 * Lever.
 *
 * Returns the full board as a flat array in one request, descriptions
 * included. Two structured fields matter and are used directly rather
 * than inferred: `workplaceType` (remote/hybrid/onsite) and
 * `categories.commitment` (employment type). Deriving either from prose
 * when the board states it outright would be inventing uncertainty.
 *
 * The posting body arrives in four pieces (opening, description, lists,
 * additional) and has to be reassembled in order, or the text hash moves
 * whenever Lever reorders its own payload.
 */
export const lever: AtsProvider = {
  name: "LEVER",
  normalizerVersion: 4,
  fetcherVersion: 1,

  boardUrl(token) {
    return `${BASE}/${encodeURIComponent(token)}?mode=json`;
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
      try {
        parsed = JSON.parse(body);
      } catch {
        return fail(endpointUrl, res.status, durationMs, body, "response was not valid JSON");
      }
      if (!Array.isArray(parsed)) {
        return fail(endpointUrl, res.status, durationMs, body, "response was not a postings array");
      }

      return {
        ok: true, httpStatus: res.status, endpointUrl, durationMs,
        responseBytes: Buffer.byteLength(body, "utf8"),
        responseHash: sha256(body),
        rawBody: body,
        postings: parsed.map((p) => {
          const post = p as { id?: unknown };
          return { sourceJobId: String(post.id), raw: p };
        }),
        error: null,
      };
    } catch (err) {
      return fail(endpointUrl, null, Date.now() - started, null, describeError(err));
    }
  },

  normalize(posting) {
    const j = posting.raw as LeverPosting;
    const warnings: string[] = [];

    const descriptionText = assembleBody(j);
    if (!descriptionText) warnings.push("posting had no description body");

    const title = (j.text ?? "").trim();
    const titleInfo = analyzeTitle(title);
    warnings.push(...titleInfo.warnings);

    const hint = mapWorkplaceType(j.workplaceType);
    const allLocations = j.categories?.allLocations ?? [];
    if (allLocations.length > 1) {
      warnings.push(
        `posting lists ${allLocations.length} locations (${allLocations.join(" | ")}); resolved columns use the first`,
      );
    }

    const loc = parseLocation(j.categories?.location ?? allLocations[0] ?? null, {
      providerHint: hint,
      country: j.country ?? null,
      extraText: descriptionText.slice(0, 4000),
    });
    warnings.push(...loc.warnings);

    let comp =
      parseStructuredSalary({
        min: j.salaryRange?.min ?? null,
        max: j.salaryRange?.max ?? null,
        currency: j.salaryRange?.currency ?? "USD",
        interval: j.salaryRange?.interval ?? null,
        source: "lever_salary_range",
      }) ?? parseSalaryFromText(descriptionText);
    if (comp) warnings.push(...comp.warnings);

    const signals = parseCareerSignals(descriptionText);

    return {
      sourceJobId: String(j.id),
      url: j.hostedUrl ?? null,
      applyUrl: j.applyUrl ?? j.hostedUrl ?? null,
      title,
      normalizedTitle: titleInfo.normalizedTitle,
      department: [j.categories?.department, j.categories?.team].filter(Boolean).join(" / ") || null,
      locationRaw: allLocations.length > 1 ? allLocations.join("; ") : loc.locationRaw,
      city: loc.city, state: loc.state, country: loc.country, metro: loc.metro,
      remotePolicy: loc.remotePolicy,
      remoteRestriction: loc.remoteRestriction,
      onsiteDaysPerWeek: loc.onsiteDaysPerWeek,
      employmentArrangement: parseEmployment(j.categories?.commitment ?? null, title),
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
      postedAt: toIso(j.createdAt ?? null),
      descriptionText,
      normalizationWarnings: warnings,
    } satisfies NormalizedJob;
  },
};

/** Lever's own vocabulary, mapped without interpretation. */
function mapWorkplaceType(v: string | null | undefined): RemotePolicy | null {
  switch ((v ?? "").toLowerCase()) {
    case "remote": return "FULLY_REMOTE";
    case "hybrid": return "HYBRID";
    case "onsite":
    case "on-site": return "ONSITE";
    default: return null;
  }
}

/** Reassembled in display order so the text hash does not depend on payload order. */
function assembleBody(j: LeverPosting): string {
  const parts: string[] = [];
  if (j.openingPlain) parts.push(j.openingPlain);
  else if (j.opening) parts.push(htmlToText(j.opening));

  if (j.descriptionBodyPlain) parts.push(j.descriptionBodyPlain);
  else if (j.descriptionPlain) parts.push(j.descriptionPlain);
  else if (j.description) parts.push(htmlToText(j.description));

  for (const list of j.lists ?? []) {
    if (list.text) parts.push(list.text);
    if (list.content) parts.push(htmlToText(list.content));
  }

  if (j.additionalPlain) parts.push(j.additionalPlain);
  else if (j.additional) parts.push(htmlToText(j.additional));

  return normalizeWhitespace(parts.filter(Boolean).join("\n\n"));
}

interface LeverPosting {
  id: string;
  text?: string;
  hostedUrl?: string;
  applyUrl?: string;
  createdAt?: number;
  country?: string;
  workplaceType?: string;
  opening?: string;
  openingPlain?: string;
  description?: string;
  descriptionPlain?: string;
  descriptionBody?: string;
  descriptionBodyPlain?: string;
  additional?: string;
  additionalPlain?: string;
  lists?: Array<{ text?: string; content?: string }>;
  categories?: {
    commitment?: string; department?: string; location?: string;
    team?: string; allLocations?: string[];
  };
  salaryRange?: { min?: number; max?: number; currency?: string; interval?: string };
}
