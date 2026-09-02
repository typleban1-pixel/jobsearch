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
};

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
    if (!isLast && i > 0 && REGIONS[upper]) return REGIONS[upper]!;
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
  const parts = String(place ?? "").split(",").map((p) => p.trim()).filter(Boolean);
  return parts[0] ?? String(place ?? "").trim();
}
