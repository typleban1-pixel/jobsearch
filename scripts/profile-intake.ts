/**
 * Writes the parsed resume into the truth profile as SUGGESTED rows.
 *
 * Every insert here is a proposal. record_status is SUGGESTED on
 * everything that has one, verified_at stays null, metrics land with
 * approved_for_use false, and profile_version is NOT bumped: a version
 * exists to freeze VERIFIED truth, and there is none yet.
 *
 *   node scripts/profile-intake.ts            dry run
 *   node scripts/profile-intake.ts --commit   write SUGGESTED rows
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import {
  PROFILE, EMPLOYMENT, PROJECTS, METRICS, EDUCATION, SKILLS as RAW_SKILLS,
  WORK_PREFERENCES, LOCATION_PREFERENCES, POLARITY_EVIDENCE, capInferred,
  GENIUS_ACADEMY_EVIDENCE,
} from "../data/profile/intake-2026-08-30.ts";

// Applied before anything is written. A skill whose interest or
// importance I inferred from the evidence cannot reach ACTIVELY_SEEK or
// CORE, no matter how strong that evidence is.
const SKILLS = (RAW_SKILLS as any[]).map(capInferred);

const commit = process.argv.includes("--commit");
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });

const plan = {
  profile_fields: Object.keys(PROFILE).length,
  employment: EMPLOYMENT.length,
  projects: PROJECTS.length,
  metrics: METRICS.length,
  education: EDUCATION.length,
  skills: SKILLS.length,
  work_preferences: WORK_PREFERENCES.length,
  location_preferences: LOCATION_PREFERENCES.length,
  polarity_evidence: POLARITY_EVIDENCE.length,
};
console.log("intake plan (all SUGGESTED):");
for (const [k, v] of Object.entries(plan)) console.log(`  ${k.padEnd(22)} ${v}`);

const levels: Record<string, number> = {};
const interests: Record<string, number> = {};
for (const s of SKILLS) {
  levels[s.level] = (levels[s.level] ?? 0) + 1;
  interests[s.interest] = (interests[s.interest] ?? 0) + 1;
}
console.log(`\n  skill levels    ${JSON.stringify(levels)}`);
console.log(`  skill interest  ${JSON.stringify(interests)}`);

if (!commit) { console.log("\ndry run: nothing written. Pass --commit."); process.exit(0); }

// Profile: the singleton already exists from the Phase 1 seed, so this
// fills in what the resume establishes and leaves everything else null.
const { data: prof, error: pe } = await db.from("profile")
  .update({
    legal_first_name: PROFILE.legal_first_name, legal_last_name: PROFILE.legal_last_name,
    preferred_name: PROFILE.preferred_name, email_job_search: PROFILE.email_job_search,
    city: PROFILE.city, state: PROFILE.state, country: PROFILE.country,
    // Confirmed, not inferred. The user is deliberately relocating to
    // Chicagoland, so current Cleveland residence must never count
    // against a Chicago role.
    willing_to_relocate: true,
    salary_hard_floor: PROFILE.salary_hard_floor,
    salary_target_min: PROFILE.salary_target_min,
    salary_target_ideal: PROFILE.salary_target_ideal,
    work_authorization: PROFILE.work_authorization,
    requires_sponsorship: PROFILE.requires_sponsorship,
  })
  .eq("singleton", true).select("id,profile_version").single();
if (pe) throw new Error(`profile: ${pe.message}`);
console.log(`profile updated (still version ${prof.profile_version}; not bumped, nothing is verified yet)`);

// Idempotent. The first attempt failed partway on a constraint, and a
// half-written profile is worse than none: re-running would have doubled
// every employment record. SUGGESTED rows are proposals, so clearing them
// is safe; VERIFIED rows are never touched here.
if (process.argv.includes("--reset")) {
  await db.from("metrics").delete().eq("approved_for_use", false);
  await db.from("skill_evidence").delete().neq("skill_id", "00000000-0000-0000-0000-000000000000");
  await db.from("employment_records").delete().eq("status", "SUGGESTED");
  await db.from("projects").delete().eq("status", "SUGGESTED");
  await db.from("education").delete().eq("status", "SUGGESTED");
  await db.from("skills").delete().eq("status", "SUGGESTED");
  await db.from("work_preferences").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await db.from("location_preferences").delete().neq("id", "00000000-0000-0000-0000-000000000000");
  await db.from("evidence").delete().eq("origin", "PROFILE");
  console.log("cleared prior SUGGESTED intake rows");
}

const evidenceIdFor = new Map<string, string>();
const addEvidence = async (summary: string, detail: string | null, polarity = "POSITIVE") => {
  const { data, error } = await db.from("evidence").insert({
    polarity, summary: summary.slice(0, 900), detail,
    confidence: "SELF_REPORTED", origin: "PROFILE", classification: "NORMAL_PERSONAL",
  }).select("id").single();
  if (error) throw new Error(`evidence: ${error.message}`);
  evidenceIdFor.set(summary, data.id);
  return data.id as string;
};

const employmentIds = new Map<string, string>();
for (const e of EMPLOYMENT) {
  const { data, error } = await db.from("employment_records").insert({
    status: "SUGGESTED", employer: e.employer, actual_title: e.actual_title,
    display_title: null, start_month: e.start_month, end_month: e.end_month,
    is_current: e.is_current, location: e.location,
    employment_type: e.employment_type, responsibilities: e.responsibilities,
    accomplishments: e.accomplishments, notes: e.notes, verified_at: null,
    // YEAR precision throughout: the stored day and month are padding.
    start_precision: (e as any).start_precision ?? "MONTH",
    end_precision: (e as any).end_precision ?? null,
    stint: (e as any).stint ?? 1,
    stint_note: (e as any).stint_note ?? null,
    departure_reason: (e as any).departure_reason ?? null,
  }).select("id").single();
  if (error) throw new Error(`employment: ${error.message}`);
  // Keyed by employer AND stint: two rows for one employer is correct
  // data here, so the plain employer name would collide.
  employmentIds.set(`${e.employer}#${(e as any).stint ?? 1}`, data.id);
  if (!employmentIds.has(e.employer)) employmentIds.set(e.employer, data.id);
  for (const r of [...e.responsibilities, ...e.accomplishments]) {
    await addEvidence(r, `${e.employer}: ${e.actual_title}`);
  }
  console.log(`  employment SUGGESTED: ${e.employer} (stint ${(e as any).stint ?? 1}, ${String(e.start_month).slice(0,4)} to ${e.end_month ? String(e.end_month).slice(0,4) : "present"})`);
}

const projectIds = new Map<string, string>();
for (const p of PROJECTS) {
  const { data, error } = await db.from("projects").insert({
    status: "SUGGESTED", name: p.name, kind: p.kind,
    start_month: p.start_month, end_month: p.end_month,
    description: p.description, my_contribution: p.my_contribution,
    tools: p.tools, results: p.results, current_status: p.current_status,
    revenue_note: null, verified_at: null,
  }).select("id").single();
  if (error) throw new Error(`project ${p.name}: ${error.message}`);
  projectIds.set(p.name, data.id);
  await addEvidence(p.my_contribution, `Project: ${p.name}. ${p.notes}`);
  console.log(`  project SUGGESTED: ${p.name}`);
}

for (const m of METRICS) {
  const evId = await addEvidence(m.approved_wording, `Metric source: ${m.employer}`);
  const { error } = await db.from("metrics").insert({
    label: m.label, approved_wording: m.approved_wording,
    numeric_value: m.numeric_value, unit: m.unit,
    evidence_id: evId, confidence: "SELF_REPORTED",
    // Approval is an explicit act with a timestamp. Nothing automated
    // sets this; it is true here only because the user said so in
    // writing, and only for the wording he wrote.
    approved_for_use: (m as any).approved === true,
    approved_at: (m as any).approved === true ? new Date().toISOString() : null,
    period_start: (m as any).period_start ?? null,
    period_end: (m as any).period_end ?? null,
    context_note: m.context_note,
    // metric_belongs_somewhere requires one of these. Genius Academy has
    // a project row of its own; everything else attaches to the job it
    // came from.
    project_id: m.label.startsWith("Genius Academy") ? projectIds.get("Genius Academy") ?? null : null,
    employment_id: m.label.startsWith("Genius Academy") ? null : employmentIds.get(m.employer) ?? null,
  });
  if (error) throw new Error(`metric: ${error.message}`);
  console.log(`  metric SUGGESTED (unapproved): ${m.label}`);
}

// Recorded against the Genius One employment record, since that is where
// the work happened, and linked to the Genius Academy project too.
for (const line of GENIUS_ACADEMY_EVIDENCE) {
  await addEvidence(line, "Genius One, Inc. / Genius Academy. Confirmed by the user 30 Aug 2026.");
}
console.log(`  Genius Academy evidence: ${GENIUS_ACADEMY_EVIDENCE.length}`);

for (const e of EDUCATION) {
  const { error } = await db.from("education").insert({
    status: "SUGGESTED", institution: e.institution, credential: e.credential,
    field_of_study: e.field_of_study, end_month: e.end_month,
    completed: e.completed, notes: e.notes, verified_at: null,
  });
  if (error) throw new Error(`education: ${error.message}`);
}
console.log(`  education SUGGESTED: ${EDUCATION.length}`);

for (const s of SKILLS as any[]) {
  const { error } = await db.from("skills").insert({
    name: s.name, category: s.category, status: "SUGGESTED",
    level: s.level, interest: s.interest, importance: s.importance,
    restrictions: s.restrictions ?? [], related_terms: s.related ?? [],
    evidence_confidence: "SELF_REPORTED",
    suggested_rationale: s.provenance === "STATED"
      ? "Level from resume evidence. Interest and importance proposed from something the user stated directly."
      : "Level from resume evidence. Interest and importance are MY INFERENCE and are capped below ACTIVELY_SEEK and CORE until confirmed.",
    suggested_at: new Date().toISOString(), verified_at: null,
  });
  if (error) throw new Error(`skill ${s.name}: ${error.message}`);
}
console.log(`  skills SUGGESTED: ${SKILLS.length}`);

for (const w of WORK_PREFERENCES) {
  const { error } = await db.from("work_preferences").insert({
    kind: w.kind, statement: w.statement, weight: w.weight,
    notes: "Proposed from the user's interpretation notes; not yet confirmed",
  });
  if (error) throw new Error(`work_preference: ${error.message}`);
}
for (const l of LOCATION_PREFERENCES as any[]) {
  const { error } = await db.from("location_preferences").insert({
    label: l.label, stance: l.stance, country: l.country ?? null,
    state: l.state ?? null, metro: l.metro ?? null,
    max_onsite_days_per_week: l.max_onsite_days_per_week ?? null,
    applies_to_remote: l.applies_to_remote, notes: l.notes,
  });
  if (error) throw new Error(`location_preference: ${error.message}`);
}
console.log(`  preferences: ${WORK_PREFERENCES.length} work, ${LOCATION_PREFERENCES.length} location`);

for (const p of POLARITY_EVIDENCE) await addEvidence(p.summary, p.detail, p.polarity);
console.log(`  polarity evidence: ${POLARITY_EVIDENCE.length}`);

console.log(`\nwritten. Nothing is VERIFIED; profile_version unchanged at ${prof.profile_version}.`);
