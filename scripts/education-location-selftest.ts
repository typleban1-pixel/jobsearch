import { matchIntent } from "../lib/applications/intents.ts";
let bad = 0; const ok = (c: boolean, w: string, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${x ? " -- " + x : ""}`); if (!c) bad++; };
const k = (l: string) => matchIntent(l).intent?.key ?? "(none)";
ok(k("School") === "education_school", "School -> education_school", k("School"));
ok(k("University") === "education_school", "University -> education_school");
ok(k("Degree") === "education_degree", "Degree -> education_degree", k("Degree"));
ok(k("Highest level of education") === "education_degree", "Highest level of education -> education_degree", k("Highest level of education"));
ok(k("Location") === "current_location_text", "bare Location -> current_location_text", k("Location"));
ok(k("Candidate Location") === "current_location_text", "Candidate Location -> current_location_text", k("Candidate Location"));
ok(k("Desired work location") === "desired_work_location", "Desired work location -> desired_work_location (NOT current)", k("Desired work location"));
// A question naming a single sub-field as its head noun resolves to that
// specific field, not blocked as ambiguous vs current_location_text
// (Chartis' required "Please list the city of your current residence").
ok(k("Please list the city of your current residence.") === "city", "city of current residence -> city (not AMBIGUOUS)", k("Please list the city of your current residence."));
ok(k("City of residence") === "city", "City of residence -> city", k("City of residence"));
ok(k("State of residence") === "state", "State of residence -> state", k("State of residence"));
ok(k("Where are you currently located?") === "current_location_text", "where are you located -> current_location_text (unchanged)", k("Where are you currently located?"));
ok(k("Company Name") !== "education_school", "Company Name is not education_school", k("Company Name"));
console.log(bad ? `\n${bad} FAILED` : `\neducation-location-selftest: ALL PASS`); process.exit(bad ? 1 : 0);
