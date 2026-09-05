/**
 * Integration: a "years of experience" application question is answered by
 * the conservative resolver through the full answer engine, or blocks when
 * the evidence does not definitely support it. Ty's VERIFIED timeline gives
 * 10y professional / 5y marketing / UNRESOLVED for anything not in a title.
 *   node scripts/experience-answer-selftest.ts
 */
import { resolveField, type ResolveContext, type FormField, type EmploymentRow } from "../lib/applications/answer.ts";
import { monthIndexOf } from "../lib/scoring/experienceDuration.ts";

const emp = (title: string, s: string, e: string | null, cur = false): EmploymentRow => ({
  rowId: title + s, employer: title, title, actualTitle: title, isCurrent: cur, start: s, end: e, status: "VERIFIED",
});
const ctx: ResolveContext = {
  profileRowId: "p", profile: {}, bank: new Map(),
  nowMonthIndex: monthIndexOf("2026-09-01"),
  employment: [
    emp("Digital Marketing, Product & Operations Specialist", "2024-03-01", null, true),
    emp("Videographer & Editor", "2022-01-01", "2024-01-01"),
    emp("Digital Marketing, Product & Operations Specialist", "2019-01-01", "2022-01-01"),
    emp("Video Production Lab Instructor", "2016-01-01", "2019-01-01"),
  ],
};
const ask = (label: string, type: FormField["type"] = "text", options?: string[]): FormField =>
  ({ key: label, label, type, required: true, ...(options ? { options } : {}) });

let bad = 0;
const ok = (c: boolean, w: string, got?: unknown) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${c ? "" : "  got=" + JSON.stringify(got)}`); if (!c) bad++; };

const yesno = ["Yes", "No"];
const r1 = resolveField(ask("Do you have 5+ years of marketing experience?", "select", yesno), ctx);
ok(r1.confidence === "DERIVED" && r1.answer === "Yes", "5+ yrs marketing -> DERIVED Yes", r1);

const r2 = resolveField(ask("Do you have 5+ years of experience in graphic design?", "select", yesno), ctx);
ok(r2.confidence === "BLOCKED", "5+ yrs graphic design (not in any title) -> BLOCKED, not a guessed Yes", { c: r2.confidence, a: r2.answer });

const r3 = resolveField(ask("How many years of professional experience do you have?", "text"), ctx);
ok(r3.confidence === "DERIVED" && r3.answer === "10", "open years professional -> DERIVED 10", r3);

const r4 = resolveField(ask("Do you have 15+ years of marketing experience?", "select", yesno), ctx);
ok(r4.confidence === "BLOCKED", "15+ yrs marketing (beyond evidence) -> BLOCKED, not a guessed No", { c: r4.confidence });

console.log(bad ? `\n${bad} FAILED` : `\nexperience-answer-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
