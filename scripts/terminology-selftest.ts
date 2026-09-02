/**
 * NO_TARGET_TERMINOLOGY, and what it must and must not permit.
 *
 * The guard now compares against the whole frozen profile rather than
 * only the cited rows, because a word the candidate verifiably uses
 * about their own work is theirs wherever it sits. The danger in that
 * change is obvious and is what most of this file tests: a wider
 * vocabulary must not become a wider set of FACTS. Terminology may
 * travel between rows; accomplishments, scope, numbers, entities,
 * credentials and role intensity may not.
 */
import { checkGrounding, importedPhrases } from "../lib/render/grounding.ts";

let pass = 0; const fails: string[] = [];
const check = (n: string, c: boolean, d = "") => {
  if (c) { pass++; console.log(`  ok   ${n}`); } else { fails.push(n); console.log(`  FAIL ${n}\n         ${d}`); }
};
const term = (r: ReturnType<typeof checkGrounding>) => r.checks.find((c) => c.check === "NO_TARGET_TERMINOLOGY")!;
const failed = (r: ReturnType<typeof checkGrounding>, name: string) => r.checks.find((c) => c.check === name)?.ok === false;

// The real shape of the situation: one cited row, a wider profile, a posting.
const CITED = "Detected changes are connected to delivery: a scheduled job recomputes obligation statuses and then "
  + "sends deadline notifications, watchlist reminders, status-change alerts and a periodic digest.";
const PROFILE = "Design, prototype, test, and refine physical products using FDM 3D printing. "
  + "Led hands-on production and post-production across video editing and graphic design. "
  + "Taught and mentored 250+ students. Coordinated cross-department projects. "
  + "Genius One, Inc. Holley Performance Lorain County Community College. "
  + "Bachelor of Science Health Science Western Governors University.";
const POSTING = "Legal Operations Specialist. design systems, e-billing systems, contract lifecycle management, "
  + "OneTrust, Ironclad, Carta, matter management, outside counsel guidelines.";
const base = { evidenceIds: ["e1"], sourceText: CITED, targetJobText: POSTING, profileVocabulary: PROFILE };

// ---- 1. profile-established vocabulary survives -----------------------
{
  const r = checkGrounding({ ...base, original: CITED,
    claim: "Designed a scheduled process that recomputes obligation statuses and sends deadline notifications and reminders." });
  check("a word the profile establishes is not treated as imported", term(r).ok, term(r).detail);
  check("and the detail says so when nothing is imported", /evidence's own terms/.test(term(r).detail));
}
{
  // Same claim, same posting, but the profile does not contain "design".
  const r = checkGrounding({ ...base, profileVocabulary: "Taught and mentored students. Coordinated projects.", original: CITED,
    claim: "Designed a scheduled process that recomputes obligation statuses and sends deadline notifications." });
  check("the same word IS refused when the profile does not establish it", !term(r).ok, term(r).detail);
  check("and the message now says profile, not evidence", /appears nowhere in the profile/.test(term(r).detail));
}

// ---- 2. employer terminology absent from the profile is still refused --
for (const [word, claim] of [
  ["ironclad", "Managed contract lifecycle in Ironclad across the matter portfolio."],
  ["onetrust", "Administered OneTrust workflows for the operations team."],
  ["e-billing", "Ran e-billing reconciliation for outside counsel."],
] as const) {
  const r = checkGrounding({ ...base, original: CITED, claim });
  check(`"${word}" from the posting is refused`, !term(r).ok, `${term(r).ok} :: ${term(r).detail}`);
}
{
  const r = checkGrounding({ ...base, original: CITED,
    claim: "Supported outside counsel guidelines and matter management for the department." });
  check("a multi-word posting phrase is refused", !term(r).ok, term(r).detail);
}
{
  // A phrase whose individual words all sit in the profile, but which
  // the profile never says as a phrase, is still the posting's.
  const r = importedPhrases("Coordinated contract lifecycle management across teams.",
    "Coordinated across teams.", "contract lifecycle management", "contract projects lifecycle students management");
  check("scattered words do not excuse a posting phrase", r.length > 0, JSON.stringify(r));
  const ok = importedPhrases("Coordinated contract lifecycle management across teams.",
    "Coordinated across teams.", "contract lifecycle management", "the candidate ran contract lifecycle management before");
  check("the same phrase IS excused when the profile says it", ok.length === 0, JSON.stringify(ok));
}

// ---- 3. vocabulary must not carry the accomplishment ------------------
//
// "design" is now permitted as a word. It must not let a claim assert
// designing something the CITED row does not say was designed.
{
  const r = checkGrounding({ ...base, original: CITED,
    claim: "Designed and built the physical product line using FDM 3D printing and parametric CAD." });
  check("terminology cannot import another role's accomplishment",
    !r.ok, `ok=${r.ok} failed=${r.failedCheck}`);
  check("and it is a grounding check that catches it, not the terminology one",
    failed(r, "NO_SCOPE_ESCALATION") || failed(r, "NO_PREDICATE_DRIFT") || failed(r, "CITES_EVIDENCE")
    || failed(r, "NO_NEW_ENTITIES") || r.failedCheck !== "NO_TARGET_TERMINOLOGY", String(r.failedCheck));
}
{
  const r = checkGrounding({ ...base, original: CITED,
    claim: "Designed a scheduled job and taught 250+ students to operate it." });
  check("a metric from another row cannot ride in on shared vocabulary", !r.ok, String(r.failedCheck));
  check("the number guard is what stops it",
    failed(r, "NO_NEW_NUMBERS") || failed(r, "METRICS_VERBATIM") || failed(r, "NO_SCOPE_ESCALATION"), String(r.failedCheck));
}
{
  const r = checkGrounding({ ...base, original: CITED, knownEntities: ["Genius One, Inc."],
    claim: "Designed a scheduled job for Holley Performance that sends deadline notifications." });
  check("an entity from another row cannot ride in", !r.ok, String(r.failedCheck));
}
{
  const r = checkGrounding({ ...base, original: CITED,
    claim: "As a Bachelor of Science holder, designed a scheduled job that sends deadline notifications." });
  check("a credential cannot ride in on shared vocabulary", !r.ok, String(r.failedCheck));
}
{
  const r = checkGrounding({ ...base, original: CITED,
    claim: "Led and owned the scheduled job that recomputes obligation statuses and sends deadline notifications." });
  check("role intensity is still checked", failed(r, "NO_ROLE_ESCALATION") || !r.ok, String(r.failedCheck));
}
{
  const r = checkGrounding({ ...base, original: "Personally edited portions of the show.",
    sourceText: "Personally edited portions of the show.", claim: "Edited the show." });
  check("a dropped qualifier is still caught", failed(r, "NO_QUALIFIER_LOSS"), String(r.failedCheck));
}

// ---- 4. the change is narrow ------------------------------------------
{
  const withProfile = importedPhrases("Designed a scheduled process.", CITED, POSTING, PROFILE);
  const without = importedPhrases("Designed a scheduled process.", CITED, POSTING, "");
  check("omitting the profile keeps the older, stricter behaviour",
    without.length > 0 && withProfile.length === 0, `${JSON.stringify(without)} vs ${JSON.stringify(withProfile)}`);
}
{
  const r = checkGrounding({ evidenceIds: ["e1"], sourceText: CITED, original: CITED,
    claim: "Designed a scheduled process that sends deadline notifications." });
  check("with no posting supplied the check is skipped, not passed silently",
    term(r).ok && /no target posting supplied/.test(term(r).detail), term(r).detail);
}

console.log(`\n${pass + fails.length} cases, ${pass} passed`);
for (const f of fails) console.log(f);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
