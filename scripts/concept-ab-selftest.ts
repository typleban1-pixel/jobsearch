/**
 * A (concept relations) + B1 (family de-dup): the hardening rules and every
 * synthetic case, without a browser or the database.
 */
import { relationResolve, type Resolution } from "../lib/scoring/conceptRelations.ts";
import { dedupeForVoting, familyOf } from "../lib/scoring/conceptFamily.ts";
let bad = 0;
const ok = (c: boolean, w: string, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${x ? " -- " + x : ""}`); if (!c) bad++; };
const mkHas = (skills: string[]) => (n: string) => skills.some((s) => s === n || s.includes(n) || n.includes(s));
const MKT = mkHas(["seo", "paid advertising", "email marketing", "campaign execution", "marketing funnel design", "microsoft excel", "microsoft powerpoint", "cross-department collaboration", "product ideation", "iterative product development", "requirements definition", "product launch"]);
const NONE = mkHas([]);
const R = (c: string, cur: Resolution, has = MKT) => relationResolve(c, cur, has).resolution;

console.log("A — hardening (additive / fail-safe / never manufacture):");
ok(R("financial planning and analysis", "DIRECT") === "DIRECT", "an existing DIRECT is never downgraded");
ok(relationResolve("salesforce", "ABSENT", MKT).resolution === "ABSENT", "an unmapped concept stays as it was (no erase, no manufacture)");
ok(relationResolve("salesforce", "ABSENT", MKT).basis === null, "  ...and reports no basis (nothing changed)");
ok(R("some novel skill xyz", "TRANSFERABLE") === "TRANSFERABLE", "adjacency/unknown never becomes DIRECT on its own");

console.log("\nA — equivalents / narrower / umbrella:");
ok(R("paid search", "ABSENT") === "DIRECT", "paid search -> DIRECT via verified Paid advertising (broader entails narrower)");
ok(R("paid search", "ABSENT", NONE) === "ABSENT", "  ...but ABSENT when Paid advertising is not held");
ok(R("cross-functional collaboration", "TRANSFERABLE") === "DIRECT", "cross-functional -> DIRECT via verified cross-department collaboration");
ok(R("microsoft office", "ABSENT") === "DIRECT", "microsoft office -> DIRECT (>=2 verified components: excel, powerpoint)");
ok(R("microsoft office", "ABSENT", mkHas(["microsoft excel"])) === "ABSENT", "  ...but not with only ONE component (below threshold)");
ok(R("digital marketing", "TRANSFERABLE") === "DIRECT", "digital marketing -> DIRECT with >=3 verified components");
ok(R("digital marketing", "TRANSFERABLE", mkHas(["seo", "email marketing"])) === "TRANSFERABLE", "  ...stays TRANSFERABLE with only 2 components (insufficient)");

console.log("\nA — product management must NOT auto-become DIRECT from lifecycle tasks:");
ok(R("product management", "ABSENT") === "TRANSFERABLE", "product management -> at most TRANSFERABLE from lifecycle evidence, never DIRECT");
ok(relationResolve("product management", "ABSENT", MKT).via!.length >= 3, "  ...and cites the >=3 component skills as provenance");
ok(R("product management", "ABSENT", mkHas(["product launch"])) === "ABSENT", "  ...one lifecycle task alone establishes nothing");

console.log("\nprovenance:");
const p = relationResolve("digital marketing", "TRANSFERABLE", MKT);
ok(p.via !== null && p.via.length >= 3 && /umbrella/.test(p.basis ?? ""), "an upgrade cites the exact frozen evidence and the rule");

console.log("\nB1 — family de-dup (one vote, strongest resolution, nothing dropped):");
const votes = dedupeForVoting([{ concept: "excel", resolution: "DIRECT" }, { concept: "google sheets", resolution: "DIRECT" }, { concept: "financial planning and analysis", resolution: "ABSENT" }]);
ok((votes?.length ?? 0) === 2, "Excel + Sheets + FP&A -> 2 votes (spreadsheet family + FP&A)", `${votes.length}`);
const sv = votes.find((v) => v.key === "spreadsheet")!;
ok(sv.members.length === 2 && sv.resolution === "DIRECT", "  ...spreadsheet vote folds both members, keeps DIRECT (originals preserved)");
ok(dedupeForVoting([{ concept: "excel", resolution: "DIRECT" }]).length === 1, "Excel alone -> one spreadsheet vote");
ok(dedupeForVoting([{ concept: "google sheets", resolution: "DIRECT" }])[0]!.key === "spreadsheet", "Google Sheets alone -> spreadsheet vote");
const both = dedupeForVoting([{ concept: "excel", resolution: "DIRECT" }, { concept: "google sheets", resolution: "TRANSFERABLE" }]);
ok(both.length === 1 && both[0]!.resolution === "DIRECT" && both[0]!.members.length === 2, "Excel+Sheets both required -> ONE vote (strongest=DIRECT), both retained as members");
ok(familyOf("financial planning and analysis") === null && familyOf("seo") === null, "a distinct capability is not swept into any family");

console.log(bad ? `\n${bad} FAILED` : `\nconcept-ab-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
