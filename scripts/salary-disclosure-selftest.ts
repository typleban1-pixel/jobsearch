/**
 * Salary expectation is a strategic employer-facing disclosure, not an ordinary
 * verified fact. It is answered autonomously ONLY when the person has authorized
 * employer-facing salary disclosure (profile.disclose_salary_to_employers). This
 * proves: no authorization -> BLOCKED to review; authorization -> the stored
 * target is stated. Preserves unknown != no and never invents a number.
 */
import { resolveField, type ResolveContext, type FormField } from "../lib/applications/answer.ts";

let bad = 0;
const ok = (c: boolean, label: string, extra?: unknown) => { if (!c) { bad++; console.log(`  FAIL  ${label}`, extra ?? ""); } else console.log(`  PASS  ${label}`); };

const salaryField: FormField = { key: "q_salary", label: "What are your base salary range expectations?", type: "text", required: true, options: null } as any;
const baseProfile = { salary_target_min: 100000, salary_target_ideal: 115000, salary_hard_floor: 85000 };
const ctx = (extra: Record<string, any>): ResolveContext => ({ profileRowId: "p1", profile: { ...baseProfile, ...extra }, bank: new Map() } as any);

// 1. No authorization (flag absent) -> BLOCKED, never the number.
const r1 = resolveField(salaryField, ctx({}));
ok(r1.confidence === "BLOCKED", "salary expectation BLOCKS when disclosure not authorized (flag absent)", r1.confidence + " / " + r1.answer);
ok(!/100,000|115,000/.test(r1.answer ?? ""), "no salary figure leaks in the blocked answer", r1.answer);

// 2. Flag explicitly false -> BLOCKED.
const r2 = resolveField(salaryField, ctx({ disclose_salary_to_employers: false }));
ok(r2.confidence === "BLOCKED", "salary expectation BLOCKS when disclosure explicitly false");

// 3. Flag true -> the stored target is stated.
const r3 = resolveField(salaryField, ctx({ disclose_salary_to_employers: true }));
ok(r3.confidence === "DERIVED" && /100,000 to \$115,000/.test(r3.answer ?? ""), "authorized -> states the stored target range", r3.confidence + " / " + r3.answer);

console.log(bad ? `\n${bad} FAILED` : `\nsalary-disclosure-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
