/**
 * Deciding whether two ways of writing a place mean the same place.
 *
 * The profile holds "Cleveland, OH, US". Greenhouse's location
 * autocomplete offers "Cleveland, Ohio, United States". Those are the
 * same city written two ways, and nothing in the fill layer could see
 * that: the typed text never matched an option, so the control was left
 * holding uncommitted text, the form reported "Please enter your
 * location", and the field was blank.
 *
 * What makes this dangerous rather than merely broken is the shape of
 * the option list. Searching "Cleveland" returns, in this order:
 *
 *   City of Cleveland, Ohio, United States
 *   Cleveland, Ohio, United States
 *   Cleveland, Tennessee, United States
 *   Cleveland Heights, Ohio, United States
 *   East Cleveland, Ohio, United States
 *   Cleveland, Mississippi, United States
 *
 * Taking the first result gives a different municipality. Substring
 * matching gives "City of Cleveland", because it contains the answer as
 * a substring -- that mistake was made and observed while writing this.
 * Ignoring the middle component gives Tennessee or Mississippi.
 *
 * So comparison is componentwise and exact after expansion: city,
 * region, country, each equal or no match at all.
 */

export const GEOGRAPHY_VERSION = 1;

/** US states and Canadian provinces by postal abbreviation. */
const REGIONS: Record<string, string> = {
  AL: "alabama", AK: "alaska", AZ: "arizona", AR: "arkansas", CA: "california",
  CO: "colorado", CT: "connecticut", DE: "delaware", DC: "district of columbia",
  FL: "florida", GA: "georgia", HI: "hawaii", ID: "idaho", IL: "illinois",
  IN: "indiana", IA: "iowa", KS: "kansas", KY: "kentucky", LA: "louisiana",
  ME: "maine", MD: "maryland", MA: "massachusetts", MI: "michigan", MN: "minnesota",
  MS: "mississippi", MO: "missouri", MT: "montana", NE: "nebraska", NV: "nevada",
  NH: "new hampshire", NJ: "new jersey", NM: "new mexico", NY: "new york",
  NC: "north carolina", ND: "north dakota", OH: "ohio", OK: "oklahoma", OR: "oregon",
  PA: "pennsylvania", RI: "rhode island", SC: "south carolina", SD: "south dakota",
  TN: "tennessee", TX: "texas", UT: "utah", VT: "vermont", VA: "virginia",
  WA: "washington", WV: "west virginia", WI: "wisconsin", WY: "wyoming",
  PR: "puerto rico", ON: "ontario", QC: "quebec", BC: "british columbia",
  AB: "alberta", MB: "manitoba", NS: "nova scotia", SK: "saskatchewan",
};

const COUNTRIES: Record<string, string> = {
  US: "united states", USA: "united states", "U.S.": "united states",
  "U.S.A.": "united states", UK: "united kingdom", GB: "united kingdom",
  CA_COUNTRY: "canada", CAN: "canada", AU: "australia", DE: "germany",
  FR: "france", IE: "ireland", NL: "netherlands", IN: "india", SG: "singapore",
  UAE: "united arab emirates", AE: "united arab emirates", NZ: "new zealand",
  KR: "south korea", TW: "taiwan", MY: "malaysia", MX: "mexico", BR: "brazil",
  SE: "sweden", CH: "switzerland", PL: "poland", PT: "portugal", RO: "romania",
  ES: "spain", IT: "italy", IL: "israel", JP: "japan", LU: "luxembourg",
  ID: "indonesia", TH: "thailand", BE: "belgium",
};

/**
 * One country, written the many ways a form writes it.
 *
 * Employers do not agree on a spelling: the same list offers "US", "UK"
 * and "UAE" beside "The Netherlands" and "New Zealand". Matching an
 * answer to an option means normalising both, because "United States"
 * and "US" are the same country and neither contains the other.
 */
/**
 * A region written either way: "OH" and "Ohio" are one place.
 *
 * Workday's State dropdown offers full names while the profile records
 * the postal abbreviation, so matching them as text found nothing and
 * the required State field could not be filled at all.
 */
export function normalizeRegionName(s: string): string {
  const raw = String(s ?? "").trim();
  const up = raw.toUpperCase();
  if (REGIONS[up]) return REGIONS[up];
  return clean(raw);
}

export function normalizeCountryName(s: string): string {
  const raw = String(s ?? "").trim();
  const upper = raw.toUpperCase().replace(/\.$/, "");
  if (COUNTRIES[upper]) return COUNTRIES[upper];
  const spelled: Record<string, string> = {
    "united states of america": "united states",
    "the united states": "united states",
    "united states": "united states",
    "america": "united states",
    "great britain": "united kingdom",
    "the netherlands": "netherlands",
    "holland": "netherlands",
    "republic of korea": "south korea",
    "korea, republic of": "south korea",
  };
  const c = clean(raw);
  return spelled[c] ?? c;
}

const clean = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase().replace(/\.$/, "");

/**
 * One place as its comparable components.
 *
 * Abbreviations expand only in the position they belong to: "CA" is
 * California in the region slot and would be Canada in the country slot,
 * and guessing between them from a bare token is how a Californian ends
 * up applying from Canada. The country map deliberately has no "CA".
 */
export function geoParts(place: string): string[] {
  const raw = String(place ?? "").split(",").map((p) => clean(p)).filter(Boolean);
  if (!raw.length) return [];
  return raw.map((part, i) => {
    const upper = part.toUpperCase();
    const isLast = i === raw.length - 1;
    if (isLast && COUNTRIES[upper]) return COUNTRIES[upper]!;
    // Any component after the first may be a region, including the last
    // one. Requiring a following component meant "Cleveland, OH" never
    // expanded to Ohio, so it did not equal "Cleveland, Ohio" and the
    // two-component form of a US address matched nothing at all. The
    // country slot is still tried first, which is what keeps "CA" as
    // California here and Canada only where COUNTRIES says so.
    if (i > 0 && REGIONS[upper]) return REGIONS[upper]!;
    return part;
  });
}

/**
 * Do two written places name the same place?
 *
 * Every component must match. A place written with fewer components than
 * the other is not thereby a match: "Cleveland" and "Cleveland, Ohio,
 * United States" agree on what they both state and disagree on how much
 * they state, and treating that as equal is how "Cleveland" selects
 * Cleveland, Tennessee.
 */
export function sameGeography(a: string, b: string): boolean {
  const x = geoParts(a), y = geoParts(b);
  if (!x.length || !y.length) return false;
  if (x.length !== y.length) return false;
  return x.every((part, i) => part === y[i]);
}

/**
 * The options that name exactly this place.
 *
 * Returns every match rather than the first, because more than one is an
 * ambiguity to report and not a tie to break.
 */
export function exactGeoMatches(options: string[], place: string): string[] {
  return options.filter((o) => sameGeography(o, place));
}

/**
 * What to type to make the autocomplete offer this place.
 *
 * The structured value is not a search term: typing "Cleveland, OH, US"
 * into Greenhouse's location control returns nothing at all, because it
 * expects a place name rather than a formatted address. The first
 * component is the searchable part, and the rest is what the answer is
 * then checked against.
 */
export function geoSearchTerm(place: string): string {
  // The city, extracted from whatever the answer is wrapped in.
  //
  // A location typeahead needs a place name. A human answer to a
  // "Location" question is not always one: "Cleveland - relocating to
  // Chicago" is a true statement and a search term that matches nothing,
  // which stopped a real submission at the location field. The leading
  // place is taken by splitting on a comma first, then trimming any
  // trailing prose introduced by a dash, an en/em dash, a parenthesis,
  // or the words "relocating"/"moving". What survives is searched; if it
  // still does not name an offered place, the fill fails closed exactly
  // as before -- this widens what can be entered, never what is accepted.
  const firstComponent = String(place ?? "").split(",")[0]?.trim() ?? "";
  const beforeProse = firstComponent
    .split(/\s+[-\u2013\u2014]\s+|\s*\(|\s+(?:relocating|moving|currently)\b/i)[0]
    ?.trim() ?? "";
  return beforeProse || firstComponent || String(place ?? "").trim();
}

/**
 * Places that name this place, allowing the answer to state less than the
 * option does — but only where the profile independently supplies the
 * rest.
 *
 * "Cleveland, OH" and "Cleveland, Ohio, United States" are the same place
 * written to different depths. sameGeography rejects that pairing on
 * purpose: bare "Cleveland" against "Cleveland, Ohio, United States" is
 * also a depth difference, and accepting it would select Cleveland,
 * Tennessee for someone who typed a city name.
 *
 * The difference here is where the missing component comes from. It is
 * not inferred from the option — that would be the option telling us what
 * we meant — it is required to equal what the profile already states
 * independently. If the profile says the country is US, an option ending
 * in "United States" states nothing the profile does not already claim,
 * and the components the answer DOES state must still match exactly.
 *
 * So this never approximates the city. "East Cleveland", "Cleveland
 * Heights", "New Cleveland" and "Cleveland, Tennessee" all differ in a
 * component the answer states, and all still fail.
 */
export function qualifiedGeoMatches(
  options: string[], place: string, profile: { state?: string | null; country?: string | null },
): string[] {
  const answer = geoParts(place);
  if (!answer.length) return [];
  // The profile's own words, normalised the way an option would be.
  // Expanded by slot rather than through geoParts: a lone "OH" is the
  // last component of its own string, and geoParts only expands regions
  // in a middle slot, so it would come back as "oh" and never equal the
  // option's "ohio".
  const supplied = [
    profile.state ? (REGIONS[String(profile.state).trim().toUpperCase()] ?? clean(String(profile.state))) : null,
    profile.country ? (COUNTRIES[String(profile.country).trim().toUpperCase()] ?? clean(String(profile.country))) : null,
  ].filter((p): p is string => Boolean(p));

  return options.filter((o) => {
    const opt = geoParts(o);
    if (opt.length < answer.length) return false;
    // Everything the answer states must match, component for component.
    if (!answer.every((part, i) => part === opt[i])) return false;
    if (opt.length === answer.length) return true;
    // Whatever the option adds has to be something the profile already says.
    return opt.slice(answer.length).every((extra) => supplied.includes(extra));
  });
}
