import type { RemotePolicy } from "../normalize/location.ts";
import type { Seniority } from "../normalize/title.ts";
import type { EmploymentArrangement } from "../normalize/compensation.ts";

export type AtsProviderName = "GREENHOUSE" | "LEVER" | "ASHBY" | "WORKDAY" | "SMARTRECRUITERS";

/** One raw posting, exactly as the board returned it, plus its identity. */
export interface RawPosting {
  sourceJobId: string;
  raw: unknown;
}

export interface FetchResult {
  ok: boolean;
  httpStatus: number | null;
  endpointUrl: string;
  durationMs: number;
  responseBytes: number;
  responseHash: string | null;
  rawBody: string | null;
  postings: RawPosting[];
  error: string | null;
}

/** The canonical shape every provider must produce. Mirrors job_versions. */
export interface NormalizedJob {
  sourceJobId: string;
  /**
   * The provider's own id for the underlying requisition, where it has
   * one. Greenhouse calls it internal_job_id and publishes one
   * requisition as several posts, one per location; Lever exposes
   * nothing equivalent, so this is null there.
   *
   * NOT the same as sourceJobId, which identifies the POST. And never
   * Greenhouse's requisition_id, which is free text: 573 rows in this
   * corpus carry the literal string "See Opening ID".
   */
  providerOpeningKey: string | null;
  url: string | null;
  applyUrl: string | null;
  title: string;
  normalizedTitle: string;
  department: string | null;

  locationRaw: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  metro: string | null;
  remotePolicy: RemotePolicy;
  remoteRestriction: string | null;
  onsiteDaysPerWeek: number | null;

  employmentArrangement: EmploymentArrangement;
  seniority: Seniority;

  salaryMin: number | null;
  salaryMax: number | null;
  salaryCurrency: string | null;
  salaryPeriod: string | null;
  salaryIsEstimated: boolean;
  salarySource: string | null;

  isIndividualContributor: boolean | null;
  managesPeople: boolean | null;
  travelRequirementPct: number | null;
  hasQuotaOrCommission: boolean | null;
  mentionsEquity: boolean | null;

  postedAt: string | null;
  descriptionText: string;

  normalizationWarnings: string[];
}

export interface AtsProvider {
  readonly name: AtsProviderName;
  readonly normalizerVersion: number;
  readonly fetcherVersion: number;
  boardUrl(token: string): string;
  /**
   * `maxPages` exists for verification: proving a board is real and
   * non-empty needs one page, not the whole board. Providers that return
   * everything in a single request may ignore it.
   */
  fetchBoard(token: string, opts?: { timeoutMs?: number; maxPages?: number; startOffset?: number }): Promise<FetchResult>;
  normalize(posting: RawPosting): NormalizedJob;
}
