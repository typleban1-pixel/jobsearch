/**
 * Resolving a company to an applicant tracking system.
 *
 * Two paths, and the order matters more than either one individually.
 *
 * PRIMARY: read the company's own careers page and take the board URL it
 * links to. The company is telling you where it posts; nothing has to be
 * inferred.
 *
 * FALLBACK: generate token candidates from the name and domain and test
 * each against the live board.
 *
 * The fallback is second because it is unreliable. The hand-written
 * candidate list in data/company-candidates.json paired 57 real companies
 * with 57 guessed tokens and 20 verified: 35%. Every miss is a company
 * silently absent from the corpus, indistinguishable from one that has no
 * board at all.
 *
 * Neither path activates anything. Both produce a CANDIDATE, and a
 * candidate becomes real only when the live board answers with postings.
 */
import type { AtsProviderName } from "../ingest/providers/types.ts";

export type ResolutionMethod = "CAREERS_PAGE" | "TOKEN_GUESS";

export interface TokenCandidate {
  provider: AtsProviderName;
  token: string;
  method: ResolutionMethod;
  /** The page the token was read from, for CAREERS_PAGE. */
  sourceUrl: string | null;
  /** Ordering within a company's candidates. Lower is tried first. */
  rank: number;
}

const UA = "jobsearch-personal/0.1 (single-user job search; contact via board owner)";

/** Board URL shapes, as they appear in careers-page markup. */
const BOARD_PATTERNS: Array<{ provider: AtsProviderName; re: RegExp }> = [
  { provider: "GREENHOUSE", re: /(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]{2,60})/gi },
  { provider: "GREENHOUSE", re: /greenhouse\.io\/embed\/job_board\/js\?for=([a-z0-9_-]{2,60})/gi },
  { provider: "LEVER",      re: /jobs\.(?:eu\.)?lever\.co\/([a-z0-9_-]{2,60})/gi },
  { provider: "ASHBY",      re: /jobs\.ashbyhq\.com\/([a-z0-9_-]{2,60})/gi },
  { provider: "ASHBY",      re: /api\.ashbyhq\.com\/posting-api\/job-board\/([a-z0-9_-]{2,60})/gi },
  // Workday needs BOTH the tenant and the site, and the pair only ever
  // appears together in the careers URL. A tenant on its own cannot be
  // queried, so the token here is the composite the provider expects:
  // "abbott.wd5.myworkdayjobs.com/abbottcareers".
  { provider: "WORKDAY",
    re: /([a-z0-9-]{2,40}\.wd\d{1,2}\.myworkdayjobs\.com)\/(?:[a-z]{2}-[A-Z]{2}\/)?([A-Za-z0-9_-]{2,60})/gi },
  // SmartRecruiters identifiers are case-insensitive, so the usual
  // lowercasing is safe, and they are often not the company name --
  // Bosch is "BoschGroup" -- which is why reading it off the careers
  // page matters more here than guessing from a domain.
  { provider: "SMARTRECRUITERS",
    re: /careers\.smartrecruiters\.com\/([A-Za-z0-9_-]{2,60})/gi },
  { provider: "SMARTRECRUITERS",
    re: /api\.smartrecruiters\.com\/v1\/companies\/([A-Za-z0-9_-]{2,60})/gi },
];

/**
 * Provider fingerprints that do NOT carry a token.
 *
 * Stripe and Samsara host listings on their own domain and link back with
 * a Greenhouse job id: stripe.com/jobs/search?gh_jid=8138000. The board
 * slug never appears, but the fingerprint says which ATS they use, and
 * knowing the provider turns a guess across three boards into a guess
 * across one.
 */
const PROVIDER_FINGERPRINTS: Array<{ provider: AtsProviderName; re: RegExp }> = [
  { provider: "GREENHOUSE", re: /\bgh_jid=|\bgh_src=|greenhouse\.io/i },
  { provider: "LEVER", re: /lever\.co|lever-jobs|leverdemo/i },
  { provider: "ASHBY", re: /ashbyhq\.com|_ashby_/i },
  { provider: "WORKDAY", re: /myworkdayjobs\.com|myworkdaysite\.com|\bworkday\b/i },
  { provider: "SMARTRECRUITERS", re: /smartrecruiters\.com/i },
  // iCIMS is deliberately absent. Its tenants are reachable but every
  // public interface probed returned 404, so there is no reader, and a
  // fingerprint without one sends the resolver to verify a board nothing
  // can read.
];

/** Tokens that are the platform's own words rather than a company slug. */
const NOT_A_TOKEN = new Set([
  "embed", "js", "job_board", "jobs", "careers", "board", "boards", "api",
  "posting-api", "www", "search", "company", "companies", "static", "assets",
  "legal", "widget", "privacy", "terms", "about", "login", "signup",
]);

const CAREERS_PATHS = ["/careers", "/jobs", "/company/careers", "/about/careers", "/careers/jobs", "/join-us", "/work-with-us"];

async function getText(url: string, timeoutMs = 15_000): Promise<string | null> {
  try {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "follow",
      headers: { "user-agent": UA, accept: "text/html,application/xhtml+xml" },
    });
    if (!res.ok) return null;
    const type = res.headers.get("content-type") ?? "";
    if (!/text\/html|application\/xhtml/.test(type)) return null;
    const body = await res.text();
    // Ramp's careers page is 3.9MB and mentions its Ashby board past the
    // 3MB mark. A truncation limit chosen for safety was silently
    // deciding that large careers pages have no board.
    return body.length > 12_000_000 ? body.slice(0, 12_000_000) : body;
  } catch {
    return null;
  }
}

/** Every board reference in a page, in the order they appear. */
export function boardsInHtml(html: string, sourceUrl: string): TokenCandidate[] {
  const out: TokenCandidate[] = [];
  const seen = new Set<string>();
  for (const { provider, re } of BOARD_PATTERNS) {
    for (const m of html.matchAll(re)) {
      // Most boards are identified by a single slug. Workday needs the
      // host and the site together, because a tenant alone cannot be
      // queried, so its pattern captures two groups and they are joined
      // into the composite token the provider expects.
      const token = provider === "WORKDAY"
        ? `${(m[1] ?? "").toLowerCase()}/${m[2] ?? ""}`
        : (m[1] ?? "").toLowerCase();
      const slug = provider === "WORKDAY" ? (m[2] ?? "").toLowerCase() : token;
      if (!token || !slug || NOT_A_TOKEN.has(slug)) continue;
      const key = `${provider}:${token}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ provider, token, method: "CAREERS_PAGE", sourceUrl, rank: out.length });
    }
  }
  return out;
}

/**
 * Reads the company's site looking for a board it links to.
 *
 * Tries the homepage last rather than first: a careers page that mentions
 * one board is better evidence than a homepage footer that might mention
 * a partner's.
 */
export async function detectFromCareersPage(
  domain: string,
  opts: { timeoutMs?: number } = {},
): Promise<{
  candidates: TokenCandidate[];
  pagesTried: number;
  pageFound: string | null;
  /** Providers the page fingerprints without naming a token. */
  providersSeen: AtsProviderName[];
}> {
  let pagesTried = 0;
  const providersSeen = new Set<AtsProviderName>();
  for (const path of [...CAREERS_PATHS, "/"]) {
    const url = `https://${domain}${path}`;
    const html = await getText(url, opts.timeoutMs);
    pagesTried++;
    if (!html) continue;

    for (const { provider, re } of PROVIDER_FINGERPRINTS) {
      if (re.test(html)) providersSeen.add(provider);
    }
    const found = boardsInHtml(html, url);
    if (found.length > 0) {
      return { candidates: found, pagesTried, pageFound: url, providersSeen: [...providersSeen] };
    }
  }
  return { candidates: [], pagesTried, pageFound: null, providersSeen: [...providersSeen] };
}

/**
 * Token guesses from a name and domain.
 *
 * Deliberately few. A long list of variants does not raise the hit rate;
 * it raises the number of live board requests spent proving that a
 * company has no board.
 */
export function guessTokens(name: string, domain: string | null): string[] {
  const out: string[] = [];
  const push = (t: string) => {
    const clean = t.toLowerCase().replace(/[^a-z0-9-]/g, "");
    if (clean.length >= 2 && clean.length <= 60 && !out.includes(clean)) out.push(clean);
  };

  const stem = domain ? domain.split(".")[0]! : "";
  if (stem) push(stem);

  const bare = name
    .toLowerCase()
    .replace(/[,.]/g, " ")
    .replace(/\b(inc|llc|ltd|corp|corporation|co|company|technologies|technology|labs|group|holdings|the)\b/g, " ")
    .trim();
  push(bare.replace(/\s+/g, ""));
  push(bare.replace(/\s+/g, "-"));
  const firstWord = bare.split(/\s+/)[0] ?? "";
  if (firstWord.length >= 3) push(firstWord);
  return out.slice(0, 5);
}

export function candidatesFor(
  name: string,
  domain: string | null,
  providers: AtsProviderName[] = ["GREENHOUSE", "LEVER", "ASHBY"],
): TokenCandidate[] {
  const tokens = guessTokens(name, domain);
  const out: TokenCandidate[] = [];
  let rank = 100; // after any CAREERS_PAGE candidate, which ranks from 0
  for (const token of tokens) {
    for (const provider of providers) {
      out.push({ provider, token, method: "TOKEN_GUESS", sourceUrl: null, rank: rank++ });
    }
  }
  return out;
}

/**
 * Does this board actually belong to this company?
 *
 * Live verification proves a board EXISTS. It says nothing about whose it
 * is, and that gap produced three wrong activations in the first batch:
 * "Agent FM" guessed ASHBY:agent and found a real board with 30 jobs
 * belonging to a different company, and "Intelligence Factory" guessed
 * ASHBY:intelligence the same way. Attributing another employer's
 * postings to a company is worse than leaving it unresolved, because the
 * jobs look real all the way through to the portal.
 *
 * A token read off the company's own careers page needs no corroboration:
 * the company published the link itself. A GUESSED token does, and the
 * evidence has to come from the board rather than from the guess.
 */
export interface Corroboration { ok: boolean; reason: string }

/** Letters and digits only, so "Agent FM" and "agent-fm" compare equal. */
function squash(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function corroborate(
  company: { name: string; domain: string | null },
  candidate: TokenCandidate,
  boardSample: string,
): Corroboration {
  if (candidate.method === "CAREERS_PAGE") {
    return { ok: true, reason: "the company published this board link on its own site" };
  }

  const raw = boardSample.slice(0, 400_000).toLowerCase();
  const haystack = squash(raw);

  // The evidence has to be SPECIFIC to this company.
  //
  // A first attempt accepted a bare domain stem, and "Agent FM" passed
  // because the board at ashbyhq.com/agent contains the word "agent".
  // Every board named agent does. A stem that is an ordinary English word
  // is a coincidence, not a match, and the corpus is full of companies
  // named after ordinary words.
  //
  // The full domain is the discriminating signal: employers link their
  // own site from their postings, and no unrelated board contains
  // "agent.fm".
  if (company.domain) {
    if (raw.includes(company.domain)) {
      return { ok: true, reason: `board content links ${company.domain}` };
    }
    const domainSquashed = squash(company.domain);
    if (domainSquashed.length >= 6 && haystack.includes(domainSquashed)) {
      return { ok: true, reason: `board content contains ${company.domain}` };
    }
  }

  // A multi-word company name is specific enough on its own. A
  // single-word one is not, for the reason above.
  const name = squash(company.name);
  const words = company.name.trim().split(/\s+/).filter((w) => w.length > 1);
  if (words.length >= 2 && name.length >= 8 && haystack.includes(name)) {
    return { ok: true, reason: `board content names "${company.name}"` };
  }

  return {
    ok: false,
    reason: `board exists but nothing in it links ${company.domain ?? company.name}; a guessed token that finds someone else's board is worse than no match`,
  };
}

/** Raw board text for corroboration. Reuses the provider's own fetcher. */
export async function boardSample(provider: AtsProviderName, token: string): Promise<string> {
  const { getProvider } = await import("../ingest/providers/index.ts");
  const res = await getProvider(provider).fetchBoard(token, { timeoutMs: 25_000 });
  return res.rawBody ?? "";
}
