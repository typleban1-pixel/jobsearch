/** Hardness by requirement kind: is the HARD rate concentrated in concrete requirements or inflated by traits? */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { classOfKind, type KindClass } from "../lib/scoring/kinds.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });

const reqs: any[] = [];
for (let f = 0; ; f += 1000) {
  const { data, error } = await db.from("job_requirements")
    .select("kind,is_hard_requirement,extraction_version,match_method,extraction_confidence")
    .order("id", { ascending: true }).range(f, f + 999);
  if (error) throw new Error(error.message);
  reqs.push(...data); if (data.length < 1000) break;
}
if (reqs.length === 0) { console.log("no requirements extracted yet"); process.exit(0); }

const versions = [...new Set(reqs.map((r) => r.extraction_version))].sort();
console.log(`requirements ${reqs.length}  extraction versions present: ${versions.join(", ")}\n`);

const HARDNESS = ["HARD", "PREFERRED", "UNCLEAR"] as const;
const pad = (s: any, n: number) => String(s).padEnd(n);
const num = (s: any, n: number) => String(s).padStart(n);

for (const v of versions) {
  const rows = reqs.filter((r) => r.extraction_version === v);
  console.log(`extraction_version ${v}  (${rows.length} requirements)`);
  console.log(`  ${pad("kind", 18)}${pad("class", 17)}${HARDNESS.map((h) => num(h, 11)).join("")}${num("total", 8)}${num("%HARD", 8)}`);
  const kinds = [...new Set(rows.map((r) => r.kind))].sort();
  const classTotals: Record<string, { t: number; h: number }> = {};
  for (const k of kinds) {
    const kr = rows.filter((r) => r.kind === k);
    const cls = classOfKind(k);
    const counts = HARDNESS.map((h) => kr.filter((r) => r.is_hard_requirement === h).length);
    const hard = counts[0]!;
    const ct = (classTotals[cls] ??= { t: 0, h: 0 });
    ct.t += kr.length; ct.h += hard;
    console.log(`  ${pad(k, 18)}${pad(cls, 17)}${counts.map((c) => num(c, 11)).join("")}${num(kr.length, 8)}${num(`${((hard * 100) / kr.length).toFixed(0)}%`, 8)}`);
  }
  const total = rows.length;
  const hardTotal = rows.filter((r) => r.is_hard_requirement === "HARD").length;
  console.log(`  ${pad("ALL", 35)}${HARDNESS.map((h) => num(rows.filter((r) => r.is_hard_requirement === h).length, 11)).join("")}${num(total, 8)}${num(`${((hardTotal * 100) / total).toFixed(0)}%`, 8)}`);

  console.log(`\n  by class:`);
  for (const [cls, ct] of Object.entries(classTotals).sort((a, b) => b[1].t - a[1].t)) {
    console.log(`    ${pad(cls, 18)}${num(ct.t, 6)} requirements  ${num(`${((ct.t * 100) / total).toFixed(0)}%`, 6)} of all   ${num(`${((ct.h * 100) / ct.t).toFixed(0)}%`, 6)} HARD`);
  }
  // The number that actually matters: the HARD rate among things that can
  // affect fit at all.
  const scorable = rows.filter((r) => classOfKind(r.kind) === "SKILL_MATCHABLE");
  const scorableHard = scorable.filter((r) => r.is_hard_requirement === "HARD").length;
  console.log(`\n  HARD rate among skill-matchable requirements only: ${((scorableHard * 100) / Math.max(1, scorable.length)).toFixed(0)}%  (${scorableHard}/${scorable.length})`);
  console.log(`  HARD rate including traits and constraints:        ${((hardTotal * 100) / total).toFixed(0)}%  (${hardTotal}/${total})\n`);
}
