/**
 * The Match Score calibration Ty approved, pinned. Pure, offline.
 * Rules: role-defining fit dominates; missing 1-of-3 hurts far more than
 * 1-of-10; direct >> transferable; hard disqualifiers crush; context can
 * never compensate for a role deficit; thin/unassessable/unresolved read
 * provisional; candidacy is NOT an input (never a numeric cap).
 */
import { matchScore, type MatchScoreInput } from "../lib/portal/matchScore.ts";
let n = 0, bad = 0; const ok = (c: boolean, w: string) => { n++; if (!c) { bad++; console.error(`FAIL ${w}`); } };
const base = (o: Partial<MatchScoreInput>): MatchScoreInput => ({
  hardMet: 0, hardTotal: 0, hardDirect: 0, coverage: 0.2, coreGaps: 0, gatingGaps: 0,
  educationGatesUnmet: 0, unresolvedCore: 0, excludedUnknown: 0, seniorityAligned: null,
  salary: null, eligibility: "ELIGIBLE", uncertaintyScore: 5, scorable: true, assessable: true, ...o,
});
const s = (o: Partial<MatchScoreInput>) => matchScore(base(o)).score;

// near-perfect reaches the 90s
ok(s({ hardMet: 5, hardTotal: 5, hardDirect: 5, coverage: 0.4, seniorityAligned: true, salary: 120000 }) >= 90, "5/5 all-direct + aligned reaches 90s");
// depth: 4/6 direct beats thin 1/1
ok(s({ hardMet: 4, hardTotal: 6, hardDirect: 4 }) > s({ hardMet: 1, hardTotal: 1, hardDirect: 1 }), "4/6-direct outscores a thin 1/1");
// missing 1 of 3 hurts more than 1 of 10
ok(s({ hardMet: 2, hardTotal: 3, hardDirect: 2 }) < s({ hardMet: 9, hardTotal: 10, hardDirect: 9 }), "missing 1-of-3 < missing 1-of-10");
// direct >> transferable
ok(s({ hardMet: 4, hardTotal: 4, hardDirect: 4 }) > s({ hardMet: 4, hardTotal: 4, hardDirect: 0 }), "all-direct beats all-transferable");
// disqualifiers crush
ok(s({ hardMet: 5, hardTotal: 5, hardDirect: 5, gatingGaps: 1 }) <= 20, "a gating credential gap crushes the score");
ok(s({ hardMet: 5, hardTotal: 5, hardDirect: 5, educationGatesUnmet: 1 }) <= 20, "an unmet education gate crushes the score");
ok(s({ hardMet: 5, hardTotal: 5, hardDirect: 5, salary: 60000 }) <= 35, "pay below the hard floor caps the score");
// context cannot compensate a role deficit
ok(s({ hardMet: 1, hardTotal: 6, hardDirect: 1, seniorityAligned: true, salary: 130000 }) < 40, "salary+seniority can't lift a weak-fit job");
// provisional flags
ok(matchScore(base({ hardMet: 1, hardTotal: 1, hardDirect: 1 })).provisional, "thin posting (<3 hard) is provisional");
ok(matchScore(base({ hardMet: 3, hardTotal: 5, hardDirect: 3, assessable: false })).provisional, "unassessable is provisional");
ok(matchScore(base({ hardMet: 3, hardTotal: 5, hardDirect: 3, unresolvedCore: 1 })).provisional, "unresolved role-defining req is provisional");
ok(matchScore(base({ hardMet: 4, hardTotal: 5, hardDirect: 4, uncertaintyScore: 80 })).provisional, "high uncertainty is provisional");
ok(!matchScore(base({ hardMet: 4, hardTotal: 5, hardDirect: 4 })).provisional, "a solid assessable posting is NOT provisional");
// bounded 0..100
ok([0,1,50,99,100].every(() => { const v = s({ hardMet: 6, hardTotal: 6, hardDirect: 6, salary: 200000, seniorityAligned: true }); return v >= 0 && v <= 100; }), "score stays within 0..100");
console.log(`${n - bad}/${n} assertions passed`);
process.exit(bad ? 1 : 0);
