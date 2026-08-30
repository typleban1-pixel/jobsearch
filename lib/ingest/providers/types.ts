import type { RemotePolicy } from "../normalize/location.ts";
import type { Seniority } from "../normalize/title.ts";
import type { EmploymentArrangement } from "../normalize/compensation.ts";

export type AtsProviderName = "GREENHOUSE" | "LEVER";

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
  fetchBoard(token: string, opts?: { timeoutMs?: number }): Promise<FetchResult>;
  normalize(posting: RawPosting): NormalizedJob;
}
