/**
 * The Cleveland minefield. Searching "Cleveland" on Greenhouse returns a
 * list of real municipalities, and picking the wrong one states something
 * untrue about where a person lives.
 */
import { qualifiedGeoMatches, sameGeography, geoSearchTerm, geoParts } from "../lib/browser/geography.ts";

let n = 0, bad = 0;
const ok = (c: boolean, what: string) => { n++; if (!c) { bad++; console.error(`FAIL ${what}`); } };

const PROFILE = { state: "OH", country: "US" };
// The options Greenhouse actually offered, plus the neighbours named as traps.
const OFFERED = [
  "Cleveland, Ohio, United States",
  "East Cleveland, Ohio, United States",
  "New Cleveland, Ohio, United States",
  "Cleveland Heights, Ohio, United States",
  "Cleveland, Tennessee, United States",
  "Cleveland, Mississippi, United States",
  "City of Cleveland, Ohio, United States",
  "Cleveland, Queensland, Australia",
];

// ---- 1. exactly one match, and it is the right one -------------------
{
  const hits = qualifiedGeoMatches(OFFERED, "Cleveland, OH", PROFILE);
  ok(hits.length === 1, `exactly one match (got ${hits.length}: ${hits.join(" | ")})`);
  ok(hits[0] === "Cleveland, Ohio, United States", `it is the real Cleveland (got ${hits[0]})`);
}

// ---- 2. every neighbour is rejected individually ---------------------
for (const trap of ["East Cleveland, Ohio, United States", "New Cleveland, Ohio, United States",
                    "Cleveland Heights, Ohio, United States", "City of Cleveland, Ohio, United States"]) {
  ok(qualifiedGeoMatches([trap], "Cleveland, OH", PROFILE).length === 0,
     `never substitutes ${trap}`);
}
for (const wrongState of ["Cleveland, Tennessee, United States", "Cleveland, Mississippi, United States",
                          "Cleveland, Queensland, Australia"]) {
  ok(qualifiedGeoMatches([wrongState], "Cleveland, OH", PROFILE).length === 0,
     `never substitutes ${wrongState}`);
}

// ---- 3. the option may not add anything the profile does not say -----
{
  ok(qualifiedGeoMatches(["Cleveland, Ohio, Canada"], "Cleveland, OH", PROFILE).length === 0,
     "a country the profile does not claim is not supplied by the option");
  ok(qualifiedGeoMatches(["Cleveland, Ohio, United States"], "Cleveland, OH", { state: "OH", country: null }).length === 0,
     "with no country in the profile, the extra component is not assumed");
  ok(qualifiedGeoMatches(["Cleveland, Ohio"], "Cleveland, OH", PROFILE).length === 1,
     "an equal-depth option still matches on its own");
}

// ---- 4. an under-specified answer stays under-specified --------------
{
  const hits = qualifiedGeoMatches(OFFERED, "Cleveland", PROFILE);
  ok(hits.length !== 1 || hits[0] === "Cleveland, Ohio, United States",
     "a bare city name never silently picks a different state");
  ok(qualifiedGeoMatches(["Cleveland, Tennessee, United States"], "Cleveland", PROFILE).length === 0,
     "bare 'Cleveland' does not match Cleveland, Tennessee");
}

// ---- 5. the strict matcher is unchanged ------------------------------
ok(!sameGeography("Cleveland, OH", "Cleveland, Ohio, United States"),
   "sameGeography still refuses different depths");
ok(sameGeography("Cleveland, OH", "Cleveland, Ohio"), "sameGeography still expands OH to Ohio");
ok(!sameGeography("Cleveland, OH", "East Cleveland, Ohio"), "sameGeography still rejects East Cleveland");

// ---- 6. the search term is broad enough to surface the list ----------
ok(geoSearchTerm("Cleveland, OH") === "Cleveland", "the search term is the place name alone");
ok(geoSearchTerm("Cleveland, Ohio, United States") === "Cleveland", "a fuller place still searches by name");

// ---- 7. read-back compares against the option, not the answer --------
// The control speaks in full place names; the answer may state less. The
// check is that the control kept exactly the option that was clicked.
{
  const chosen = qualifiedGeoMatches(OFFERED, "Cleveland, OH", PROFILE)[0]!;
  ok(sameGeography("Cleveland, Ohio, United States", chosen),
     "a control holding the chosen option reads back as committed");
  ok(!sameGeography("East Cleveland, Ohio, United States", chosen),
     "a control holding a neighbouring city fails read-back");
  ok(!sameGeography("Cleveland, Tennessee, United States", chosen),
     "a control holding the wrong state fails read-back");
  ok(!sameGeography("", chosen), "an empty control fails read-back");
}

// ---- a prose answer matches on its geography, not its whole string ---
// "Cleveland - relocating to Chicago" is a true answer to "Location".
// geoSearchTerm searched "Cleveland" correctly, but the option match was
// run against the entire raw string, so nothing equalled it and the fill
// stopped at READBACK_MISMATCH. The prose tail must be stripped for the
// match too, while the city (and any state/country stated) is kept.
{
  const PROSE = "Cleveland - relocating to Chicago";
  ok(geoSearchTerm(PROSE) === "Cleveland", "the prose answer still searches the bare city");
  const hits = qualifiedGeoMatches(OFFERED, PROSE, PROFILE);
  ok(hits.length === 1 && hits[0] === "Cleveland, Ohio, United States",
     `the prose answer resolves to exactly Cleveland OH (got ${JSON.stringify(hits)})`);
  // and it still refuses the traps
  ok(!hits.includes("Cleveland, Tennessee, United States") && !hits.includes("East Cleveland, Ohio, United States"),
     "the prose answer never selects a neighbouring city or wrong state");
}
// A prose answer that itself states the state keeps it through the strip.
{
  const hits = qualifiedGeoMatches(OFFERED, "Cleveland, OH (moving soon)", PROFILE);
  ok(hits.length === 1 && hits[0] === "Cleveland, Ohio, United States",
     `"Cleveland, OH (moving soon)" keeps its state and resolves once (got ${JSON.stringify(hits)})`);
}
// A hyphenated real place name is not mistaken for prose.
ok(geoSearchTerm("Winston-Salem, NC") === "Winston-Salem", "a hyphenated place name is preserved");
ok(sameGeography("Winston-Salem, North Carolina", "Winston-Salem, NC"), "Winston-Salem matches across region spellings");

// ---- 8. "City ST" written with NO comma (the Chartis case) ----------
// The live Ashby city combobox answer was "Cleveland OH" (no comma). It must
// resolve exactly like "Cleveland, OH": split on the trailing recognised
// region abbreviation, expand, and match UNIQUELY -- never among the
// Texas/Tennessee/East Clevelands.
{
  ok(geoParts("Cleveland OH").join("|") === "cleveland|ohio",
     "'Cleveland OH' splits into city + expanded region");
  const oh = qualifiedGeoMatches(OFFERED, "Cleveland OH", PROFILE);
  ok(oh.length === 1 && oh[0] === "Cleveland, Ohio, United States",
     `"Cleveland OH" (no comma) resolves to exactly Cleveland OH (got ${JSON.stringify(oh)})`);
  ok(sameGeography("Cleveland OH", "Cleveland, Ohio"), "comma-less 'City ST' expands OH to Ohio");
  ok(qualifiedGeoMatches(["Cleveland, Tennessee, United States"], "Cleveland OH", PROFILE).length === 0,
     "'Cleveland OH' never matches Cleveland, Tennessee");
  ok(qualifiedGeoMatches(["East Cleveland, Ohio, United States"], "Cleveland OH", PROFILE).length === 0,
     "'Cleveland OH' never matches East Cleveland");
  // the split is region-generic and honours the abbreviation the answer states,
  // never defaulting to the profile's state (OH): with both offered, "Cleveland
  // TX" picks Texas and rejects Ohio.
  const tx = qualifiedGeoMatches(
    ["Cleveland, Ohio, United States", "Cleveland, Texas, United States"], "Cleveland TX", { state: "OH", country: "US" });
  ok(tx.length === 1 && tx[0] === "Cleveland, Texas, United States",
     `"Cleveland TX" resolves uniquely to Texas by its stated abbreviation, not the profile's Ohio (got ${JSON.stringify(tx)})`);
  // a genuine two-word city is never mis-split by the trailing-token rule
  ok(geoParts("San Antonio").join("|") === "san antonio",
     "a real two-word city ('San Antonio') is not split into city+region");
  ok(geoParts("New York").join("|") === "new york",
     "'New York' (no state) stays one component, never split");
}

console.log(`${n - bad}/${n} assertions passed`);
process.exit(bad ? 1 : 0);
