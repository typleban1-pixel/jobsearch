/**
 * Materializes the Jobs-list cards into job_card_summary.
 *
 *   node --env-file=.env.local --conditions=react-server scripts/materialize-job-cards.ts            # dry run
 *   node --env-file=.env.local --conditions=react-server scripts/materialize-job-cards.ts --commit   # write
 *
 * Runs the SAME loadJobCards() the portal used to run on every request --
 * the authoritative card build, matchScore() and all -- exactly once, and
 * stores each JobCard whole alongside the scalar columns the list sorts
 * and filters on. The portal then reads one bounded query instead of
 * rebuilding 1,618 cards from ~53,000 rows per page view.
 *
 * Idempotent and complete: upserts every current card, then removes rows
 * for jobs that are no longer ranked (closed, rescored away, ruled out),
 * so the table is always exactly the set of currently viable cards.
 *
 * The stored card carries NO user state. interest / activeInterest /
 * applicationStatus are nulled here and overlaid live by the portal from
 * job_interest and applications, so a save or a submission shows at once
 * without waiting for this to run again.
 *
 * Runs in the pipeline after `score` and `candidacy` (both of which change
 * what a card says) and is safe to run by hand any time.
 */
import { createClient } from "@supabase/supabase-js";
import { loadJobCards, page } from "../lib/portal/db.ts";

const COMMIT = process.argv.includes("--commit");
const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

const t0 = performance.now();
const cards = await loadJobCards(db);
const built = performance.now() - t0;

const now = new Date().toISOString();
const rows = cards.map((c) => ({
  job_id: c.id,
  opening_id: c.openingId,
  match_score: c.match.score,
  match_provisional: c.match.provisional,
  candidacy_verdict: c.candidacy?.verdict ?? null,
  fit_score: c.fit,
  credited_count: c.creditedCount,
  title: c.title,
  company: c.company,
  posted_at: c.postedAt,
  first_seen_at: c.firstSeenAt,
  eligibility: c.eligibility,
  // User state is live, never stored (see header).
  card: { ...c, interest: null, activeInterest: null, applicationStatus: null, applicationId: null, applicationState: null },
  computed_at: now,
}));

console.log(`built ${rows.length} cards in ${Math.round(built)}ms (loadJobCards, the old per-request cost)`);
if (!COMMIT) {
  console.log("dry run; re-run with --commit to write job_card_summary");
  process.exit(0);
}

let written = 0;
for (let i = 0; i < rows.length; i += 200) {
  const { error } = await db.from("job_card_summary").upsert(rows.slice(i, i + 200), { onConflict: "job_id" });
  if (error) throw new Error(`upsert: ${error.message}`);
  written += Math.min(200, rows.length - i);
}

// Remove cards for jobs no longer ranked. Diffed in memory: a NOT IN over
// 1,600 uuids overflows the request URL, and the stale set is normally tiny.
const current = new Set(rows.map((r) => r.job_id));
const existing = await page<{ job_id: string }>(db, "job_card_summary", "job_id", (q) => q, "job_id");
const stale = existing.map((r) => r.job_id).filter((id) => !current.has(id));
for (let i = 0; i < stale.length; i += 200) {
  const { error } = await db.from("job_card_summary").delete().in("job_id", stale.slice(i, i + 200));
  if (error) throw new Error(`delete stale: ${error.message}`);
}

console.log(`job_card_summary: upserted ${written}, removed ${stale.length} stale, total ${Math.round(performance.now() - t0)}ms`);
