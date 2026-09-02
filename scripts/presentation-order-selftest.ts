/**
 * The lead-employer presentation rule.
 *
 * Ty asked that Genius One appear first because it is his current
 * relationship. The danger in any such rule is that it stops being about
 * ORDER and starts being about content: a lead employer that quietly
 * earns more space, or a relevance score that moves an employer up the
 * page. This file holds the line between the two.
 */
import { orderForPresentation, orderForRecruiter, LEAD_EMPLOYER } from "../lib/render/relationships.ts";
import { composeResume, type FrozenRow } from "../lib/render/resume.ts";
import { assembleTailoredDoc, DEFAULT_BUDGET, documentLines } from "../lib/render/tailoredDoc.ts";
import { profileFor, scoreClaim } from "../lib/render/relevance.ts";
import { readFileSync } from "node:fs";

let pass = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n}\n         ${d}`); }
};
const e = (employer: string, start: string, end: string | null, isFullTime = false) => ({ employer, start, end, isFullTime });

// The real shape of the profile.
const G1 = e("Genius One, Inc.", "2019-01-01", null);
const HOLLEY = e("Holley Performance", "2022-01-01", "2024-01-01", true);
const AP = e("Anytime Picture LLC", "2019-01-01", "2025-01-01");
const LCCC = e("Lorain County Community College", "2016-01-01", "2019-01-01", true);
const ALL = [LCCC, AP, HOLLEY, G1];

// ---- 1. the rule itself ------------------------------------------------
{
  const out = orderForPresentation(ALL);
  check("Genius One renders first", out[0]!.employer === "Genius One, Inc.", out.map((x) => x.employer).join(" | "));
  check("Holley is second, ahead of Anytime and the college",
    out[1]!.employer === "Holley Performance", out.map((x) => x.employer).join(" | "));
  check("the remaining order is exactly what chronology produced",
    JSON.stringify(out.slice(1).map((x) => x.employer))
    === JSON.stringify(orderForRecruiter(ALL).filter((x) => x.employer !== LEAD_EMPLOYER).map((x) => x.employer)),
    out.map((x) => x.employer).join(" | "));
  check("the expected full order for this profile",
    out.map((x) => x.employer).join(" | ")
    === "Genius One, Inc. | Holley Performance | Anytime Picture LLC | Lorain County Community College",
    out.map((x) => x.employer).join(" | "));
}
// ---- 2. determinism and independence from input order ------------------
{
  const shuffles = [[G1, HOLLEY, AP, LCCC], [LCCC, G1, HOLLEY, AP], [AP, LCCC, HOLLEY, G1], [HOLLEY, AP, G1, LCCC]];
  const first = orderForPresentation(shuffles[0]!).map((x) => x.employer).join("|");
  check("the order does not depend on the order rows arrive in",
    shuffles.every((s) => orderForPresentation(s).map((x) => x.employer).join("|") === first), first);
  check("repeated calls agree",
    orderForPresentation(ALL).map((x) => x.employer).join("|") === first, first);
}
// ---- 3. no dates or types were touched ---------------------------------
{
  const out = orderForPresentation(ALL);
  for (const original of ALL) {
    const moved = out.find((x) => x.employer === original.employer)!;
    check(`${original.employer.slice(0, 20)} keeps its dates and type`,
      moved.start === original.start && moved.end === original.end && moved.isFullTime === original.isFullTime, "");
  }
  check("the lead employer is still not marked full-time",
    out[0]!.isFullTime === false, String(out[0]!.isFullTime));
}
// ---- 4. an absent lead employer changes nothing -------------------------
{
  const without = [LCCC, AP, HOLLEY];
  check("no lead employer present leaves chronology alone",
    JSON.stringify(orderForPresentation(without).map((x) => x.employer))
    === JSON.stringify(orderForRecruiter(without).map((x) => x.employer)), "");
}
// ---- 5. it is order only, over the real document ------------------------
{
  const rows: FrozenRow[] = JSON.parse(readFileSync(".runs/v11-rows.json", "utf8"));
  const doc = composeResume(rows as any, { first: "Ty", last: "Pleban" } as any, "Ty Pleban");
  check("the composed document leads with Genius One",
    doc.roles[0]!.employer === "Genius One, Inc.", doc.roles.map((r) => r.employer).join(" | "));
  check("and its contract qualifier survives",
    /\(Contract\)/.test(doc.roles[0]!.title), doc.roles[0]!.title);
  check("Holley follows it", doc.roles[1]!.employer === "Holley Performance", doc.roles.map((r) => r.employer).join(" | "));

  // The same document, ordered both ways, selected against the same posting.
  const TERMS = ["process improvement", "project coordination", "operations experience", "legal operations experience"];
  const TITLE = "Legal Operations Specialist";
  const accepted = documentLines(doc).map((t) => ({ original: t, claim: t, evidenceIds: [], generation: "SELECTED" as const }));
  const withLead = assembleTailoredDoc(doc, accepted, TERMS, DEFAULT_BUDGET, TITLE);
  const chronological = { ...doc, roles: orderForRecruiter(doc.roles) };
  const withoutLead = assembleTailoredDoc(chronological, accepted, TERMS, DEFAULT_BUDGET, TITLE);

  const claimsOf = (d: any) => new Set(documentLines(d.doc));
  const a = claimsOf(withLead), b = claimsOf(withoutLead);
  check("reordering selects the identical set of claims",
    a.size === b.size && [...a].every((x) => b.has(x)),
    `${a.size} vs ${b.size}`);
  // Compared as a SORTED mapping. Serializing the object compares key
  // order too, and key order is exactly what this change alters, so the
  // naive comparison fails on the one difference that is intended.
  const countsOf = (d: any) => d.doc.roles.map((r: any) => `${r.employer}=${r.lines.length}`).sort().join(", ");
  check("and gives each employer the identical number of lines",
    countsOf(withLead) === countsOf(withoutLead), `${countsOf(withLead)} vs ${countsOf(withoutLead)}`);
  check("while the printed order genuinely differs",
    withLead.doc.roles[0]!.employer !== withoutLead.doc.roles[0]!.employer,
    `${withLead.doc.roles[0]!.employer} vs ${withoutLead.doc.roles[0]!.employer}`);

  const P = profileFor(TITLE, TERMS);
  const scored = (d: any) => d.doc.roles.flatMap((r: any) => r.lines.map((l: any) => scoreClaim(l.text, P))).sort((x: number, y: number) => y - x);
  check("and the identical scores", JSON.stringify(scored(withLead)) === JSON.stringify(scored(withoutLead)),
    `${JSON.stringify(scored(withLead))}`);
  check("the lead employer did not gain lines by leading",
    countsOf(withLead)["Genius One, Inc."] === countsOf(withoutLead)["Genius One, Inc."], "");
}
// ---- 6. relevance cannot move another employer above the lead ----------
{
  const rows: FrozenRow[] = JSON.parse(readFileSync(".runs/v11-rows.json", "utf8"));
  const doc = composeResume(rows as any, { first: "Ty", last: "Pleban" } as any, "Ty Pleban");
  const accepted = documentLines(doc).map((t) => ({ original: t, claim: t, evidenceIds: [], generation: "SELECTED" as const }));
  // Postings deliberately chosen to favour every OTHER employer in turn.
  const POSTINGS: Array<[string, string[]]> = [
    ["Video Editor", ["video editing", "motion graphics", "adobe creative suite", "post-production"]],
    ["Instructor", ["teaching", "mentoring", "curriculum", "student instruction"]],
    ["Client Services Lead", ["client service", "account management", "prospects", "sales"]],
    ["Brand Producer", ["brand production", "concurrent projects", "deadlines", "creative approaches"]],
    ["Operations Manager", ["process improvement", "workflow", "operations", "project coordination"]],
  ];
  for (const [title, terms] of POSTINGS) {
    const { doc: out } = assembleTailoredDoc(doc, accepted, terms, DEFAULT_BUDGET, title);
    check(`"${title}" cannot displace the lead employer`,
      out.roles[0]!.employer === "Genius One, Inc.", out.roles.map((r) => r.employer).join(" | "));
  }
}

console.log(`\n${pass + fails.length} cases, ${pass} passed`);
for (const f of fails) console.log(f);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
