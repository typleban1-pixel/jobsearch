/**
 * Changes what the system may do on one ATS, in the open.
 *
 *   node --env-file=.env.local scripts/set-ats-policy.ts <PROVIDER> [--capability NONE|ASSISTED_SUBMIT|PRODUCTION] [--pause|--unpause] [--reason "<why>"] [--note "<capability note>"] [--commit]
 *
 * ats_policy is what the worker, the submit listener and the portal read to
 * decide whether a provider's applications are prepared, submitted by the
 * listener, or handed to the person. It was only ever edited by hand in the
 * SQL editor, which left no record of why; this prints the row before and
 * after and requires --commit.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const provider = (process.argv[2] ?? "").toUpperCase();
const arg = (k: string): string | null => { const i = process.argv.indexOf(`--${k}`); return i >= 0 ? (process.argv[i + 1] ?? null) : null; };
if (!provider) { console.error("usage: set-ats-policy.ts <PROVIDER> [--capability X] [--pause|--unpause] [--reason ...] [--note ...] [--commit]"); process.exit(2); }
const capability = arg("capability");
if (capability && !["NONE", "ASSISTED_SUBMIT", "PRODUCTION"].includes(capability)) { console.error("capability must be NONE, ASSISTED_SUBMIT or PRODUCTION"); process.exit(2); }
const pause = process.argv.includes("--pause") ? true : process.argv.includes("--unpause") ? false : null;
const commit = process.argv.includes("--commit");

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
const { data: before } = await db.from("ats_policy").select("*").eq("provider", provider).maybeSingle();
console.log(`before: ${before ? JSON.stringify(before) : "(no row)"}`);
const patch: Record<string, unknown> = { updated_at: new Date().toISOString() };
if (capability) patch.capability = capability;
if (pause !== null) { patch.paused = pause; patch.paused_reason = pause ? (arg("reason") ?? "paused") : null; }
if (arg("note")) patch.capability_note = arg("note");
console.log(`patch:  ${JSON.stringify(patch)}`);
if (!commit) { console.log("\ndry run; pass --commit to write"); process.exit(0); }
const { data: after, error } = before
  ? await db.from("ats_policy").update(patch).eq("provider", provider).select("*").single()
  : await db.from("ats_policy").insert({ provider, paused: pause ?? true, capability: capability ?? "NONE", ...patch }).select("*").single();
if (error) { console.error(`could not write: ${error.message}`); process.exit(1); }
console.log(`after:  ${JSON.stringify(after)}`);
