/**
 * A posting's locations, as a set.
 *
 * The single-location parser this sits beside takes the FIRST place a
 * posting names and drops the rest. That is wrong in a way that was
 * quietly expensive: of 186 open postings naming Chicago, 61 were not
 * tagged Chicagoland, because Chicago was listed second or later.
 * "San Francisco, Chicago, New York City or Seattle" became San
 * Francisco. Worse, "Chicago, New York, San Francisco" was read as
 * city Chicago in state New York, which loses the metro entirely.
 *
 * What this does NOT do
 * ---------------------
 * It does not split one posting into several jobs rows. A jobs row is the
 * published variant, and a variant that lists four cities is still one
 * thing the board published. The locations hang underneath it.
 *
 * It does not read locations out of description prose. A city name in a
 * paragraph is not a work location, and treating it as one would
 * manufacture eligibility. Only the provider's own location field is
 * parsed here. If description-derived locations are ever needed they get
 * their own provenance and must not silently create eligibility.
 */
import { resolveMetro, type RemotePolicy } from "./location.ts";

export const LOCATION_SET_VERSION = 1;

export type LocationProvenance =
  /** The ATS location field. The only source used today. */
  | "PROVIDER_LOCATION_FIELD"
  /** A structured provider field such as Lever's workplaceType. */
  | "PROVIDER_STRUCTURED"
  /** Read from description prose. Never eligibility-creating on its own. */
  | "DESCRIPTION_TEXT";

export type LocationConfidence =
  /** City and state (or country) both resolved from explicit tokens. */
  | "EXACT"
  /** Resolved, but something was inferred. */
  | "PARSED"
  /** The segment named a place we could not decompose. */
  | "AMBIGUOUS";

export interface NormalizedLocation {
  city: string | null;
  /** US state code. Null for non-US. */
  state: string | null;
  /** Province or region for non-US places, kept out of `state`. */
  region: string | null;
  country: string | null;
  /** Only when deterministically known. Never guessed. */
  metro: string | null;
  isRemote: boolean;
  /** For remote entries: the country or region the remote role is scoped to. */
  remoteScope: string | null;
  provenance: LocationProvenance;
  confidence: LocationConfidence;
  /** The exact slice of the source string this came from. */
  rawSegment: string;
  position: number;
}

export interface LocationSetResult {
  locations: NormalizedLocation[];
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
  "washington dc":"DC","washington, d.c.":"DC","d.c.":"DC",
};
const STATE_CODES = new Set(Object.values(US_STATES));

/**
 * Major US cities and the state they are actually in.
 *
 * Used for one job: deciding whether "Chicago, New York" is a city in a
 * state or two cities. Chicago is in Illinois, so the pair is two places.
 * Without this, every city followed by a state-shaped word collapses into
 * a single wrong location, and "New York", "Washington" and "Indiana" are
 * all also city names.
 *
 * Deliberately small. It resolves a genuine ambiguity in the source text
 * and is not a geocoder.
 */
const KNOWN_CITY_STATE: Record<string, string> = {
  chicago:"IL", "new york":"NY", "new york city":"NY", nyc:"NY", brooklyn:"NY",
  "san francisco":"CA", sf:"CA", "los angeles":"CA", "san diego":"CA", "san jose":"CA",
  oakland:"CA", sacramento:"CA", "palo alto":"CA", "mountain view":"CA",
  seattle:"WA", bellevue:"WA", redmond:"WA", spokane:"WA",
  boston:"MA", cambridge:"MA", atlanta:"GA", austin:"TX", dallas:"TX", houston:"TX",
  "san antonio":"TX", denver:"CO", boulder:"CO", miami:"FL", orlando:"FL", tampa:"FL",
  jacksonville:"FL", philadelphia:"PA", pittsburgh:"PA", phoenix:"AZ", tucson:"AZ",
  portland:"OR", "salt lake city":"UT", "las vegas":"NV", reno:"NV",
  minneapolis:"MN", "st. paul":"MN", "saint paul":"MN", detroit:"MI", cleveland:"OH",
  columbus:"OH", cincinnati:"OH", nashville:"TN", memphis:"TN", charlotte:"NC",
  raleigh:"NC", durham:"NC", baltimore:"MD", richmond:"VA", arlington:"VA",
  "kansas city":"MO", "st. louis":"MO", "saint louis":"MO", milwaukee:"WI", madison:"WI",
  "new orleans":"LA", "oklahoma city":"OK", indianapolis:"IN", louisville:"KY",
  "des moines":"IA", omaha:"NE", "bedford park":"IL", evanston:"IL", cicero:"IL",
};

const COUNTRIES: Record<string, string> = {
  "united states":"US", "united states of america":"US", usa:"US", us:"US", "u.s.":"US", "u.s.a.":"US",
  canada:"CA", "united kingdom":"UK", uk:"UK", england:"UK", scotland:"UK", ireland:"IE",
  india:"IN", australia:"AU", germany:"DE", france:"FR", spain:"ES", netherlands:"NL",
  poland:"PL", romania:"RO", japan:"JP", china:"CN", singapore:"SG", brazil:"BR",
  mexico:"MX", israel:"IL_COUNTRY", "new zealand":"NZ", portugal:"PT", italy:"IT",
  sweden:"SE", norway:"NO", denmark:"DK", finland:"FI", switzerland:"CH", austria:"AT",
  belgium:"BE", "czech republic":"CZ", czechia:"CZ", hungary:"HU", greece:"GR",
  colombia:"CO_COUNTRY", argentina:"AR", chile:"CL", "costa rica":"CR", philippines:"PH",
  malaysia:"MY", indonesia:"ID_COUNTRY", thailand:"TH", vietnam:"VN", "south korea":"KR",
  "south africa":"ZA", nigeria:"NG", kenya:"KE", "united arab emirates":"AE", uae:"AE",
};

/**
 * Canadian province codes. Without these "Toronto, ON" produced a phantom
 * city called "ON", because the code is neither a US state nor a country.
 */
const CA_PROVINCES: Record<string, string> = {
  on:"Ontario", bc:"British Columbia", qc:"Quebec", ab:"Alberta", mb:"Manitoba",
  sk:"Saskatchewan", ns:"Nova Scotia", nb:"New Brunswick", nl:"Newfoundland and Labrador",
  pe:"Prince Edward Island", yt:"Yukon", nt:"Northwest Territories", nu:"Nunavut",
  ontario:"Ontario", "british columbia":"British Columbia", quebec:"Quebec", alberta:"Alberta",
};

/** Region-shaped values that name no single country. */
const REGION_ONLY = /^(emea|apac|latam|amer|americas|north america|south america|europe|asia|global|worldwide|anywhere|international)$/i;

const PLACEHOLDER = /^(n\/?a|none|null|tbd|to be determined|various|multiple|multiple locations|flexible|other|unspecified|-|—)$/i;

const REMOTE_TOKEN = /\bremote\b|\bwork from home\b|\bwfh\b|\bdistributed\b|\banywhere\b/i;

/** Qualifiers a posting appends to a place, which are not part of the place. */
const QUALIFIER_PARENTHETICAL = /\(\s*(hybrid|remote|onsite|on-site|in-office|optional|preferred|flexible|hq|headquarters)[^)]*\)?/gi;

/** Provider prefixes: "US-Chicago", "USA Remote", "CA-Toronto". */
const PROVIDER_PREFIX = /^(us|usa|u\.s\.|ca|can|uk|gb|in|au|de|fr|nl|pl|jp|sg|br|mx|ie)[-–]\s*/i;

function stateCode(token: string): string | null {
  const t = token.trim().replace(/\.$/, "");
  if (t.length === 2 && STATE_CODES.has(t.toUpperCase())) return t.toUpperCase();
  return US_STATES[t.toLowerCase()] ?? null;
}
function countryCode(token: string): string | null {
  return COUNTRIES[token.trim().toLowerCase().replace(/\.$/, "")] ?? null;
}
function isCityToken(token: string): boolean {
  const t = token.trim().toLowerCase();
  return t.length > 1 && !countryCode(t) && !REGION_ONLY.test(t) && !PLACEHOLDER.test(t);
}

/**
 * Splits on separators that unambiguously divide places.
 *
 * The comma is NOT here. It divides places AND divides a city from its
 * state, and deciding which needs the tokens themselves.
 */
function splitSegments(text: string): string[] {
  return text
    .split(/\s*;\s*|\s*\|\s*|\s+\/\s+|\s+or\s+|\s+and\s+|\s*&\s*/i)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Decides whether a comma-separated run is a list of cities or one
 * city-state-country address.
 *
 * The distinguishing evidence, in order:
 *   - a trailing country ("Chicago, Illinois, United States") means an
 *     address, because nobody ends a list of cities with a country
 *   - a two-letter state code ("Chicago, IL, Atlanta, GA") means pairs
 *   - a known city followed by a state that is NOT its own state
 *     ("Chicago, New York") means two cities
 */
function isCityList(tokens: string[]): boolean {
  if (tokens.length < 2) return false;
  if (tokens.some((t) => t.length === 2 && STATE_CODES.has(t.toUpperCase()))) return false;
  if (countryCode(tokens[tokens.length - 1] ?? "")) return false;

  const first = tokens[0]?.trim().toLowerCase() ?? "";
  const second = tokens[1] ?? "";
  const knownState = KNOWN_CITY_STATE[first];
  const secondAsState = stateCode(second);
  // "Chicago, New York": Chicago is in IL, so New York is not its state.
  if (knownState && secondAsState && secondAsState !== knownState) return true;

  // Three or more tokens, none of them a state code and none a country,
  // with at least two that are not state names at all.
  if (tokens.length >= 3) {
    const nonState = tokens.filter((t) => !stateCode(t)).length;
    if (nonState >= 2) return true;
  }
  return false;
}

function remoteScopeOf(segment: string): string | null {
  const prefix = segment.match(PROVIDER_PREFIX)?.[1];
  if (prefix) return countryCode(prefix) ?? prefix.toUpperCase();
  const m = segment.match(/\bremote\b[\s,-]*(?:in|within|from|across)?\s*(?:the\s+)?([a-z][\w .'-]{1,28})/i);
  if (m?.[1]) {
    const c = countryCode(m[1]);
    if (c) return c;
    if (REGION_ONLY.test(m[1].trim())) return m[1].trim().toUpperCase();
  }
  const trailing = segment.match(/^([a-z. ]{2,20})[-–]?\s*remote\b/i)?.[1];
  if (trailing) {
    const c = countryCode(trailing);
    if (c) return c;
  }
  return null;
}

export function parseLocationSet(
  raw: string | null | undefined,
  opts: { provenance?: LocationProvenance; providerCountry?: string | null } = {},
): LocationSetResult {
  const provenance = opts.provenance ?? "PROVIDER_LOCATION_FIELD";
  const warnings: string[] = [];
  const text = raw?.trim();
  if (!text) return { locations: [], warnings: ["no location string supplied"] };
  if (PLACEHOLDER.test(text)) {
    return { locations: [], warnings: [`location field is a placeholder (${JSON.stringify(text)})`] };
  }

  const locations: NormalizedLocation[] = [];
  const push = (l: Omit<NormalizedLocation, "position">) => {
    locations.push({ ...l, position: locations.length });
  };

  for (const rawSegment of splitSegments(text)) {
    // Qualifiers are not places. Unbalanced parentheses are common enough
    // that "Chicago (Hybrid" has to be handled as well as "Chicago (Hybrid)".
    const cleaned = rawSegment.replace(QUALIFIER_PARENTHETICAL, " ").replace(/[()]/g, " ").trim();
    if (!cleaned) continue;

    // Remote is detected per comma TOKEN, not per segment. The comma is
    // not a segment separator, so "US-Chicago, US-Remote, US-Seattle"
    // arrives here as one segment carrying both a remote option and three
    // cities. Testing the whole segment for the word "remote" swallowed
    // the cities with it.
    const rawTokens = cleaned.split(",").map((t) => t.trim()).filter(Boolean);
    const placeTokens: string[] = [];
    for (const tok of rawTokens) {
      if (!REMOTE_TOKEN.test(tok)) { placeTokens.push(tok); continue; }
      const scope = remoteScopeOf(tok);
      push({
        city: null, state: null, region: null,
        country: scope && scope.length === 2 ? scope : null,
        metro: null, isRemote: true, remoteScope: scope,
        provenance, confidence: scope ? "EXACT" : "PARSED", rawSegment,
      });
      // "Remote - Chicago" carries a place as well as the remote fact.
      const residue = tok.replace(/\b(remote|work from home|wfh|distributed|anywhere)\b/gi, " ")
                         .replace(PROVIDER_PREFIX, " ")
                         .replace(/\b(in|within|from|across|the)\b/gi, " ")
                         .replace(/[-–]/g, " ").replace(/\s+/g, " ").trim();
      if (residue.length > 1 && !countryCode(residue) && !REGION_ONLY.test(residue)) placeTokens.push(residue);
    }

    const tokens = placeTokens
      .map((t) => t.replace(PROVIDER_PREFIX, (m) => (countryCode(m.replace(/[-–\s]+$/, "")) ? "" : m)).trim())
      .filter((t) => t.length > 0 && !PLACEHOLDER.test(t));
    if (tokens.length === 0) continue;

    if (isCityList(tokens)) {
      for (const t of tokens) {
        if (!isCityToken(t)) continue;
        const known = KNOWN_CITY_STATE[t.toLowerCase()] ?? null;
        push({
          city: t, state: known, region: null, country: known ? "US" : null,
          metro: resolveMetro(t, known), isRemote: false, remoteScope: null,
          provenance, confidence: known ? "PARSED" : "AMBIGUOUS", rawSegment,
        });
      }
      continue;
    }

    // One address, read left to right.
    let i = 0;
    while (i < tokens.length) {
      const t = tokens[i]!;
      const asCountry = countryCode(t);
      const asState = stateCode(t);

      if (asCountry && locations.length > 0 && i > 0) {
        const last = locations[locations.length - 1]!;
        if (last.country === null) last.country = asCountry;
        i++; continue;
      }
      if (asCountry) {
        push({ city: null, state: null, region: null, country: asCountry, metro: null,
               isRemote: false, remoteScope: null, provenance, confidence: "EXACT", rawSegment });
        i++; continue;
      }
      if (REGION_ONLY.test(t)) {
        push({ city: null, state: null, region: t, country: null, metro: null,
               isRemote: false, remoteScope: null, provenance, confidence: "AMBIGUOUS", rawSegment });
        i++; continue;
      }

      const next = tokens[i + 1];
      const nextProvince = next ? CA_PROVINCES[next.trim().toLowerCase()] : undefined;
      if (nextProvince) {
        const after2 = tokens[i + 2];
        push({
          city: t, state: null, region: nextProvince, country: (after2 ? countryCode(after2) : null) ?? "CA",
          metro: null, isRemote: false, remoteScope: null,
          provenance, confidence: "EXACT", rawSegment,
        });
        i += (after2 && countryCode(after2)) ? 3 : 2; continue;
      }
      const nextState = next ? stateCode(next) : null;
      const nextCountry = next ? countryCode(next) : null;
      const after = tokens[i + 2];
      const afterCountry = after ? countryCode(after) : null;

      if (nextState) {
        push({
          city: t, state: nextState, region: null, country: afterCountry ?? "US",
          metro: resolveMetro(t, nextState), isRemote: false, remoteScope: null,
          provenance, confidence: "EXACT", rawSegment,
        });
        i += afterCountry ? 3 : 2; continue;
      }
      if (nextCountry) {
        push({
          city: t, state: null, region: null, country: nextCountry, metro: null,
          isRemote: false, remoteScope: null, provenance, confidence: "EXACT", rawSegment,
        });
        i += 2; continue;
      }
      // "Toronto, Ontario, Canada": the middle token is a province, which
      // is neither a US state nor a country. A trailing country is what
      // identifies it as part of this address rather than a place of its own.
      if (next && afterCountry) {
        push({
          city: t, state: null, region: next, country: afterCountry, metro: null,
          isRemote: false, remoteScope: null, provenance, confidence: "EXACT", rawSegment,
        });
        i += 3; continue;
      }
      if (asState && !KNOWN_CITY_STATE[t.toLowerCase()]) {
        push({ city: null, state: asState, region: null, country: "US", metro: null,
               isRemote: false, remoteScope: null, provenance, confidence: "EXACT", rawSegment });
        i++; continue;
      }

      const known = KNOWN_CITY_STATE[t.toLowerCase()] ?? null;
      const trailing = t.match(/^(.*[a-z].*)\s+([A-Z]{2})$/);
      if (trailing?.[2] && STATE_CODES.has(trailing[2])) {
        push({ city: trailing[1]!.trim(), state: trailing[2], region: null, country: "US",
               metro: resolveMetro(trailing[1]!.trim(), trailing[2]), isRemote: false,
               remoteScope: null, provenance, confidence: "EXACT", rawSegment });
        i++; continue;
      }
      push({
        city: t, state: known, region: null, country: known ? "US" : null,
        metro: resolveMetro(t, known), isRemote: false, remoteScope: null,
        provenance, confidence: known ? "PARSED" : "AMBIGUOUS", rawSegment,
      });
      i++;
    }
  }

  if (locations.length === 0) warnings.push(`no locations parsed from ${JSON.stringify(text)}`);
  const ambiguous = locations.filter((l) => l.confidence === "AMBIGUOUS").length;
  if (ambiguous > 0) warnings.push(`${ambiguous} location(s) could not be fully resolved`);
  return { locations, warnings };
}

/** True when any location in the set resolves to one of the target metros. */
export function setTouchesMetro(locations: NormalizedLocation[], metros: string[]): NormalizedLocation | null {
  return locations.find((l) => l.metro !== null && metros.includes(l.metro)) ?? null;
}

export type { RemotePolicy };
