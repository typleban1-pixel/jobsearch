/**
 * Location and remote policy.
 *
 * Two rules, both from the spec, both easy to get wrong:
 *
 *   Chicagoland is not a string match on "Chicago". Naperville is
 *   Chicagoland. A posting labelled "Chicago" that is onsite in a
 *   different Chicago is not.
 *
 *   UNCLEAR never silently becomes FULLY_REMOTE. A posting that says
 *   "Remote" while requiring residency elsewhere is not remote for this
 *   profile, and the restriction has to survive normalization to be
 *   checked later.
 */

export type RemotePolicy =
  | "FULLY_REMOTE" | "REMOTE_WITH_TRAVEL" | "HYBRID" | "ONSITE" | "UNCLEAR";

export interface ParsedLocation {
  locationRaw: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  metro: string | null;
  remotePolicy: RemotePolicy;
  remoteRestriction: string | null;
  onsiteDaysPerWeek: number | null;
  warnings: string[];
}

const US_STATES: Record<string, string> = {
  alabama:"AL",alaska:"AK",arizona:"AZ",arkansas:"AR",california:"CA",colorado:"CO",
  connecticut:"CT",delaware:"DE",florida:"FL",georgia:"GA",hawaii:"HI",idaho:"ID",
  illinois:"IL",indiana:"IN",iowa:"IA",kansas:"KS",kentucky:"KY",louisiana:"LA",
  maine:"ME",maryland:"MD",massachusetts:"MA",michigan:"MI",minnesota:"MN",
  mississippi:"MS",missouri:"MO",montana:"MT",nebraska:"NE",nevada:"NV",
  "new hampshire":"NH","new jersey":"NJ","new mexico":"NM","new york":"NY",
  "north carolina":"NC","north dakota":"ND",ohio:"OH",oklahoma:"OK",oregon:"OR",
  pennsylvania:"PA","rhode island":"RI","south carolina":"SC","south dakota":"SD",
  tennessee:"TN",texas:"TX",utah:"UT",vermont:"VT",virginia:"VA",washington:"WA",
  "west virginia":"WV",wisconsin:"WI",wyoming:"WY","district of columbia":"DC",
  "washington dc":"DC","washington, d.c.":"DC",
};
const STATE_CODES = new Set(Object.values(US_STATES));

// The Chicago metropolitan area as municipalities, not as a substring.
// Held as data because the boundary is a judgement call that belongs in
// configuration, and because a commute the user would actually make is
// the real test rather than a county line.
const CHICAGOLAND = new Set([
  "chicago","evanston","naperville","schaumburg","oak brook","oakbrook terrace","deerfield",
  "northbrook","skokie","arlington heights","des plaines","elmhurst","downers grove","lisle",
  "aurora","joliet","rosemont","chicago heights","oak park","wheaton","lombard","itasca",
  "bannockburn","lake forest","libertyville","vernon hills","buffalo grove","hoffman estates",
  "elgin","st. charles","saint charles","geneva","batavia","warrenville","westchester",
  "burr ridge","hinsdale","westmont","woodridge","bolingbrook","romeoville","orland park",
  "tinley park","palatine","mount prospect","park ridge","niles","morton grove","glenview",
  "wilmette","highland park","waukegan","gurnee","mundelein","barrington","crystal lake",
  "algonquin","carol stream","glen ellyn","villa park","addison","bensenville","wood dale",
  "melrose park","cicero","berwyn","lincolnshire","northfield","riverwoods","rolling meadows",
  "elk grove village","schiller park","franklin park","hammond","gary","merrillville",
  "east chicago","munster","schererville","crown point",
]);

const REMOTE_WORD = /\b(remote|work from home|wfh|distributed|virtual)\b/i;
const HYBRID_WORD = /\bhybrid\b/i;
const ONSITE_WORD = /\b(on-?site|in-?office|in-?person)\b/i;

/**
 * Provider hints are structured fields the ATS itself supplies (Lever's
 * workplaceType). They win over text, because a board's own dropdown is a
 * better source than our reading of a location string.
 */
export function parseLocation(
  raw: string | null | undefined,
  opts: { providerHint?: RemotePolicy | null; country?: string | null; extraText?: string } = {},
): ParsedLocation {
  const warnings: string[] = [];
  const locationRaw = raw?.trim() || null;
  const text = locationRaw ?? "";

  let city: string | null = null;
  let state: string | null = null;
  let country: string | null = opts.country?.trim() || null;

  // Strip a leading "Remote -" / "Remote:" so the geography behind it can
  // still be parsed. "Remote - Chicago, IL" carries both facts.
  const geoPart = text.replace(/^\s*remote\s*[-–—:,(]?\s*/i, "").replace(/\)$/, "").trim();

  // Multi-location postings: take the first for the resolved columns and
  // keep the whole string in location_raw. Splitting into several jobs
  // would invent postings the board never made.
  const primary = geoPart.split(/\s*[;|]\s*|\s+\/\s+/)[0] ?? "";
  const parts = primary.split(",").map((p) => p.trim()).filter(Boolean);

  if (parts.length >= 2) {
    const maybeState = parts[1]!;
    const code = toStateCode(maybeState);
    if (code) {
      city = parts[0]!;
      state = code;
      country = country ?? "US";
      if (parts.length >= 3 && !/^(usa|us|united states)$/i.test(parts[2]!)) {
        country = parts[2]!;
      }
    } else {
      city = parts[0]!;
      country = country ?? parts[parts.length - 1]!;
    }
  } else if (parts.length === 1 && parts[0]) {
    const trailing = splitTrailingStateCode(parts[0]);
    const code = toStateCode(parts[0]);
    if (trailing) { city = trailing.city; state = trailing.state; country = country ?? "US"; }
    else if (code) { state = code; country = country ?? "US"; }
    else if (/^(usa|us|united states|remote)$/i.test(parts[0])) { country = country ?? "US"; }
    else { city = parts[0]; }
  }

  const haystack = `${text}\n${opts.extraText ?? ""}`;
  let remotePolicy: RemotePolicy = "UNCLEAR";
  let remoteRestriction: string | null = null;

  if (opts.providerHint) {
    remotePolicy = opts.providerHint;
    // Lever routinely reports workplaceType "remote" on a posting that
    // also names a city. That is a real constraint, not noise, so the
    // city is preserved as a restriction rather than discarded.
    if (remotePolicy === "FULLY_REMOTE" && (city || state)) {
      remoteRestriction = [city, state, country].filter(Boolean).join(", ");
      warnings.push(
        `provider reports remote but posting names a location (${remoteRestriction}); remote eligibility needs verification`,
      );
    }
  } else if (REMOTE_WORD.test(text)) {
    remotePolicy = HYBRID_WORD.test(haystack) ? "HYBRID" : "FULLY_REMOTE";
    if (geoPart && geoPart.toLowerCase() !== "remote") remoteRestriction = geoPart;
  } else if (HYBRID_WORD.test(haystack)) {
    remotePolicy = "HYBRID";
  } else if (ONSITE_WORD.test(haystack)) {
    remotePolicy = "ONSITE";
  } else if (city || state) {
    // A named city with no remote language anywhere is the one case where
    // silence is informative. Still not asserted as ONSITE: plenty of
    // remote postings name an anchor office and say so only in the body.
    remotePolicy = "UNCLEAR";
    warnings.push("no remote/hybrid/onsite language found; policy left UNCLEAR");
  }

  if (remotePolicy === "FULLY_REMOTE" && !remoteRestriction) {
    const m = haystack.match(/\bremote\b[^.\n]{0,40}?\b(?:in|within|from|based in|residents? of)\b\s+([A-Z][\w .,'-]{2,40})/i);
    if (m?.[1]) remoteRestriction = m[1].trim();
  }

  let onsiteDaysPerWeek: number | null = null;
  const days = haystack.match(/\b([1-5])\s*(?:\+\s*)?days?\s*(?:per|a|\/)\s*week\s*(?:in|at|on)?\s*(?:the\s*)?(?:office|onsite|on-site|hq)/i)
    ?? haystack.match(/\b(?:in\s*(?:the\s*)?office|onsite|on-site)\s*([1-5])\s*days?\s*(?:per|a|\/)\s*week/i);
  if (days?.[1]) {
    onsiteDaysPerWeek = Number(days[1]);
    if (remotePolicy === "UNCLEAR") remotePolicy = "HYBRID";
  }

  return {
    locationRaw, city, state, country,
    metro: resolveMetro(city, state),
    remotePolicy, remoteRestriction, onsiteDaysPerWeek, warnings,
  };
}

function toStateCode(input: string): string | null {
  const cleaned = input.trim().replace(/\.$/, "");
  if (STATE_CODES.has(cleaned.toUpperCase()) && cleaned.length === 2) return cleaned.toUpperCase();
  const full = US_STATES[cleaned.toLowerCase()];
  if (full) return full;

  // "IL or Remote", "IL (Hybrid) OR Remote": the state is the first
  // token of the part and the rest is qualifier text.
  //
  // Only the FIRST token, and only when it was already uppercase in the
  // source. Scanning every token would read "London OR Dublin" as
  // Oregon, and "Chennai or Remote, India" as Oregon too. That
  // collision between the postal code OR and the English word "or" has
  // no general solution from a location string alone, so this stays
  // narrow rather than clever.
  const first = cleaned.split(/[\s,(/]+/)[0] ?? "";
  if (first.length === 2 && first === first.toUpperCase() && STATE_CODES.has(first)) {
    return first;
  }
  return null;
}

/** "Fort Worth TX": a trailing uppercase state code with no comma before it. */
function splitTrailingStateCode(input: string): { city: string; state: string } | null {
  const m = input.trim().match(/^(.*[a-z].*)\s+([A-Z]{2})$/);
  if (!m?.[1] || !m[2] || !STATE_CODES.has(m[2])) return null;
  return { city: m[1].trim(), state: m[2] };
}

/** Only Chicagoland is resolved today, because it is the only metro any preference depends on. */
export function resolveMetro(city: string | null, state: string | null): string | null {
  if (!city) return null;
  const key = city.toLowerCase().replace(/\s+/g, " ").trim();
  if (!CHICAGOLAND.has(key)) return null;
  // Guards against Chicago Heights in another state, and against the
  // several other US cities named Aurora, Naperville and Geneva.
  if (state && !["IL", "IN", "WI"].includes(state)) return null;
  return "Chicagoland";
}

export const CHICAGOLAND_MUNICIPALITIES = CHICAGOLAND;
