/**
 * Locks the conservative experience-duration resolver against Ty's real
 * VERIFIED timeline: overlaps are not double-counted, specific capabilities
 * come from the role TITLE (never an incidental mention), nothing is rounded
 * up, and a threshold is YES only when definitely reached else UNRESOLVED.
 *   node scripts/experience-duration-selftest.ts
 */
import { experienceFor, resolveYearsQuestion, parseYearsRequirement, monthIndexOf,
  type EmploymentRecord } from "../lib/scoring/experienceDuration.ts";

// Ty's VERIFIED employment (month granularity), as employment_records holds it.
const mk = (title: string, s: string, e: string | null, cur = false): EmploymentRecord => ({
  employer: title, title, startMonth: s, endMonth: e, isCurrent: cur, status: "VERIFIED",
  titleText: title.toLowerCase(),
  evidenceText: title.toLowerCase() + " collaborated with marketing and other teams",
});
const RECS: EmploymentRecord[] = [
  mk("Video Production Lab Instructor", "2016-01-01", "2019-01-01"),
  mk("Digital Marketing, Product & Operations Specialist", "2019-01-01", "2022-01-01"),
  mk("Video Production & Client Solutions Specialist (Contract)", "2019-01-01", "2022-01-01"),
  mk("Videographer & Editor", "2022-01-01", "2024-01-01"),
  mk("Video Production & Client Solutions Specialist (Contract)", "2024-01-01", "2025-01-01"),
  mk("Digital Marketing, Product & Operations Specialist", "2024-03-01", null, true),
];
const ASOF = monthIndexOf("2026-09-01");
let bad = 0;
const ok = (c: boolean, w: string, got?: unknown) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${c ? "" : "  got=" + JSON.stringify(got)}`); if (!c) bad++; };

const gen = experienceFor("", RECS, ASOF);
ok(gen.years === 10, "general professional = 10y (2016->2026 union, overlaps merged not 14y)", gen.years);
ok(gen.object === "GENERAL_PROFESSIONAL", "general classified as GENERAL_PROFESSIONAL");

const mkt = experienceFor("marketing", RECS, ASOF);
ok(mkt.years === 5, "marketing = 5y (two Genius titles; Videographer 'collaborated with marketing' NOT counted)", mkt.years);

const ops = experienceFor("operations", RECS, ASOF);
ok(ops.years === 5, "operations = 5y (Genius titles only; lab-operations instructor not title-matched)", ops.years);

const vid = experienceFor("video production", RECS, ASOF);
ok(vid.years === 7, "video production = 7y (instructor+contracts by title; overlaps merged)", vid.years);

const acct = experienceFor("accounting", RECS, ASOF);
ok(acct.resolution === "UNRESOLVED", "accounting UNRESOLVED (no role title establishes it) -> never zero-asserted");

ok(resolveYearsQuestion("5+ years of marketing experience", RECS, ASOF).kind === "THRESHOLD_YES", "5+ yrs marketing -> YES");
ok(resolveYearsQuestion("7+ years of marketing experience", RECS, ASOF).kind === "UNRESOLVED", "7+ yrs marketing -> UNRESOLVED (not a guessed No)");
ok(resolveYearsQuestion("10+ years of professional experience", RECS, ASOF).kind === "THRESHOLD_YES", "10+ yrs professional -> YES");
ok(resolveYearsQuestion("3+ years of accounting", RECS, ASOF).kind === "UNRESOLVED", "3+ yrs accounting -> UNRESOLVED");
const num = resolveYearsQuestion("How many years of operations experience do you have?", RECS, ASOF);
ok(num.kind === "NUMERIC" && num.years === 5, "open 'years of operations' -> NUMERIC 5", num);

ok(parseYearsRequirement("5+ years of digital marketing experience").object === "digital marketing", "parse object = 'digital marketing'");
ok(parseYearsRequirement("Minimum of 8 years experience").threshold === 8, "parse threshold from 'Minimum of 8'");

console.log(bad ? `\n${bad} FAILED` : `\nexperience-duration-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
