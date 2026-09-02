/**
 * Points a manual submission's confirmation_reference at real stored
 * evidence instead of a synthetic marker.
 *
 * Changes the pointer and nothing else. The submission stays MANUAL with
 * HUMAN_CONFIRMED provenance: a screenshot the applicant supplied is
 * better evidence than a bare assertion, and it is still not machine
 * verification. Nothing here reclassifies how the submission happened.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const [applicationId, reference] = process.argv.slice(2);
if (!applicationId || !reference) {
  console.error("usage: link-manual-evidence.ts <application_id> <fill-run:dirname>"); process.exit(2);
}
const dir = `.fill-runs/${reference.replace(/^fill-run:/, "")}`;
if (!existsSync(dir)) { console.error(`no such evidence directory: ${dir}`); process.exit(1); }

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"),
  { auth: { persistSession: false } });

const { data: before } = await db.from("applications")
  .select("status,submitted_at,submission_mode,confirmation_reference,confirmation_email_received")
  .eq("id", applicationId).single();
if (!before || before.status !== "SUBMITTED") { console.error("not a submitted application"); process.exit(1); }
console.log("before:", JSON.stringify(before));

const shots = readdirSync(dir).filter((f) => /\.(png|jpg|jpeg)$/i.test(f));
const hashes = shots.map((f) =>
  `${f} sha256 ${createHash("sha256").update(readFileSync(`${dir}/${f}`)).digest("hex")}`);

// Only the pointer moves.
const { error } = await db.from("applications")
  .update({ confirmation_reference: reference }).eq("id", applicationId);
if (error) { console.error(error.message); process.exit(1); }

await db.from("application_events").insert({
  application_id: applicationId, event: "CONFIRMATION_EVIDENCE_LINKED",
  actor: "user:plebantyler@gmail.com",
  detail: [
    "confirmation_reference repointed from the synthetic human-confirmed: marker to real stored evidence.",
    "",
    `Evidence: ${dir}`,
    ...hashes.map((h) => `  ${h}`),
    "  Included Health branded page showing the role title and \"Application submitted!\".",
    "  Copied byte-identical from the applicant's Desktop; the original is unchanged.",
    "",
    "This changes nothing about how the submission is classified. It remains submission_mode MANUAL",
    "with HUMAN_CONFIRMED provenance: the screenshot was supplied by the applicant, not captured by",
    "the system, and it is NOT machine-verified evidence. No browser was driven, no submit click was",
    "made by the system, and no fill run exists. The submission history and the original",
    "SUBMISSION_CONFIRMED_BY_USER event are unchanged.",
  ].join("\n"),
});

const { data: after } = await db.from("applications")
  .select("status,submitted_at,submission_mode,confirmation_reference,confirmation_email_received")
  .eq("id", applicationId).single();
console.log("after: ", JSON.stringify(after));
console.log(`\nresolves on disk: ${existsSync(dir)}`);
console.log(`contents: ${readdirSync(dir).join(", ")}`);
