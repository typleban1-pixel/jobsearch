/**
 * The bulk "Queue N Jobs" button must always tell the reader what happened,
 * including when EVERY selected job is refused (e.g. a MANUAL_REVIEW verdict).
 * That was the "button does nothing" bug: refusals produced an off-screen note
 * and the sticky bar was unchanged. This locks the message content.
 *
 *   node scripts/queue-feedback-selftest.ts
 */
import { summarizeQueue } from "../lib/portal/queueFeedback.ts";

let pass = 0; const fails: string[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}  ${detail}`); }
};

// All refused (the reported case): two MANUAL_REVIEW jobs.
{
  const t = summarizeQueue([
    { jobId: "a", state: "not_a_candidate", message: "needs review before applying" },
    { jobId: "b", state: "not_a_candidate", message: "needs review before applying" },
  ]);
  check("all-refused still produces a message (never empty)", t.note.length > 0, JSON.stringify(t));
  check("it says none were queued and why",
    t.queued === 0 && t.skipped === 2 && /2 not prepared/.test(t.note) && /needs review before applying/.test(t.note),
    t.note);
}

// Mixed outcome.
{
  const t = summarizeQueue([
    { jobId: "a", state: "queued", message: "queued" },
    { jobId: "b", state: "already", message: "already in your applications" },
    { jobId: "c", state: "not_open", message: "posting is no longer open" },
  ]);
  check("mixed counts are all reported",
    t.queued === 1 && t.already === 1 && t.skipped === 1
    && /1 preparing/.test(t.note) && /1 already applied/.test(t.note) && /1 not prepared/.test(t.note),
    t.note);
}

// Distinct reasons are de-duplicated in the summary line.
{
  const t = summarizeQueue([
    { jobId: "a", state: "not_a_candidate", message: "needs review before applying" },
    { jobId: "b", state: "not_a_candidate", message: "needs review before applying" },
    { jobId: "c", state: "not_open", message: "posting is no longer open" },
  ]);
  check("count is total refused, reasons are distinct",
    t.skipped === 3 && /3 not prepared/.test(t.note)
    && /needs review before applying/.test(t.note) && /posting is no longer open/.test(t.note),
    t.note);
}

// All prepared: a clean confirmation, no false "not prepared". (The person
// prepares applications; "queue" stays a backend word.)
{
  const t = summarizeQueue([
    { jobId: "a", state: "queued", message: "queued" },
    { jobId: "b", state: "queued", message: "queued" },
  ]);
  check("all-queued reads as a confirmation with no refusal text",
    t.queued === 2 && t.skipped === 0 && /2 preparing/.test(t.note) && !/not prepared/.test(t.note), t.note);
}

console.log(`\n${pass} passed, ${fails.length} failed`);
if (fails.length) { console.log(fails.map((f) => `  - ${f}`).join("\n")); process.exit(1); }
console.log("queue feedback holds: the button always reports its outcome");
