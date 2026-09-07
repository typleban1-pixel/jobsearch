/**
 * Why one form question resolves the way it does.
 *
 *   node --env-file=.env.local scripts/explain-field.ts "<question label>" [--type text|select|boolean|textarea] [--options "A|B|C"] [--required] [--job <job_id>]
 *
 * Runs the same resolver preparation runs, against the frozen profile,
 * the bank and the learned answers, scoped to a job when one is given, and
 * prints the intent it matched, the answer, its confidence, what it was
 * matched by and everything it considered. For the moment a prepared
 * answer looks wrong and the question is "where did THAT come from".
 * Reads only.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { loadContext, applicationScope } from "../lib/applications/prepare.ts";
import { resolveField, type FormField } from "../lib/applications/answer.ts";
import { matchIntent } from "../lib/applications/intents.ts";

const label = process.argv[2];
if (!label) { console.error("usage: explain-field.ts \"<label>\" [--type t] [--options \"A|B\"] [--required] [--job id]"); process.exit(2); }
const arg = (k: string): string | null => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? (process.argv[i + 1] ?? null) : null; };
const type = (arg("type") ?? "text") as FormField["type"];
const options = arg("options")?.split("|").map((s) => s.trim()).filter(Boolean);
const field: FormField = { key: label, label, type, required: process.argv.includes("--required"), ...(options?.length ? { options } : {}) };

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const ctx = await loadContext(db);
const job = arg("job");
if (job) ctx.application = await applicationScope(db, job).catch(() => undefined);

const m = matchIntent(label);
console.log(`intent match: ${m?.intent ? `${m.intent.key} (${m.intent.category}) by ${m.matchedBy}` : m ? `ambiguous (${m.matchedBy})` : "none"}`);
const r = resolveField(field, ctx);
console.log(`resolved:     ${r.confidence}${r.refused ? " REFUSED" : ""}  intent=${r.intentKey ?? "-"}`);
console.log(`answer:       ${JSON.stringify(r.answer)}`);
console.log(`matched by:   ${r.matchedBy}`);
if (r.blockedReason) console.log(`blocked:      ${r.blockedReason}`);
if (r.evidenceIds?.length) console.log(`evidence:     ${r.evidenceIds.join(", ")}`);
for (const c of r.considered ?? []) console.log(`  considered: ${c.what.slice(0, 160)}${c.whyRejected ? ` -- ${c.whyRejected.slice(0, 120)}` : ""}`);
