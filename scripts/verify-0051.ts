/**
 * Is 0051 actually live, and does the profile hold the confirmed facts?
 *
 * Read-only. Nothing here writes, and nothing re-applies the migration:
 * it checks the columns, the constraints and the values that should
 * already be there.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}\n         ${detail}`); }
};

const { data: p, error } = await db.from("profile")
  .select("profile_version,city,state,relocation_destination_city,relocation_destination_state,relocation_destination_metro,relocation_is_definite,relocation_date,willing_to_relocate,relocation_assistance_required")
  .eq("singleton", true).single();
if (error) { console.error(`the new columns are not present: ${error.message}`); process.exit(1); }

console.log("live profile:");
check("the five 0051 columns exist and are selectable", true, "");
check("current residence is Cleveland, OH", p.city === "Cleveland" && p.state === "OH", `${p.city}, ${p.state}`);
check("destination is Chicago, IL", p.relocation_destination_city === "Chicago" && p.relocation_destination_state === "IL",
  `${p.relocation_destination_city}, ${p.relocation_destination_state}`);
check("destination metro is Chicagoland", p.relocation_destination_metro === "Chicagoland", String(p.relocation_destination_metro));
check("the relocation is definite", p.relocation_is_definite === true, String(p.relocation_is_definite));
check("willing to relocate is true", p.willing_to_relocate === true, String(p.willing_to_relocate));
check("relocation assistance is not required", p.relocation_assistance_required === false, String(p.relocation_assistance_required));
check("the relocation date is null, not a guess", p.relocation_date === null, String(p.relocation_date));

// The constraints are the part that keeps a later edit honest, so they
// are checked as themselves rather than assumed from the values.
const { error: noDest } = await db.from("profile")
  .update({ relocation_is_definite: true, relocation_destination_city: null }).eq("singleton", true);
check("a definite relocation with no destination is rejected by the database",
  Boolean(noDest) && /definite_relocation_names_a_destination/.test(noDest!.message), noDest?.message ?? "the update was ACCEPTED");

const { error: badState } = await db.from("profile")
  .update({ relocation_destination_state: "Illinois" }).eq("singleton", true);
check("a destination state that is not a USPS code is rejected",
  Boolean(badState) && /relocation_state_is_usps/.test(badState!.message), badState?.message ?? "the update was ACCEPTED");

// Neither update above may have taken effect.
const { data: after } = await db.from("profile")
  .select("relocation_destination_city,relocation_destination_state,relocation_is_definite").eq("singleton", true).single();
check("the rejected updates changed nothing",
  after!.relocation_destination_city === "Chicago" && after!.relocation_destination_state === "IL" && after!.relocation_is_definite === true,
  JSON.stringify(after));

// 0051 also re-grants column UPDATE, which 0007 removes for any column
// added later. Without it the first real write fails at permission.
const { error: grantErr } = await db.from("profile")
  .update({ relocation_destination_metro: "Chicagoland" }).eq("singleton", true);
check("service_role can write the new columns (regrant ran)",
  !grantErr, grantErr?.message ?? "");

const { data: log } = await db.from("truth_change_log")
  .select("actor,changed_fields,new_data,profile_version_at_time")
  .eq("source_table", "profile").order("occurred_at", { ascending: false }).limit(5);
// Two rows are expected: the table trigger records the write itself
// with actor "unknown", and the migration records WHY, naming the human
// who confirmed it. The second is the one that matters here.
const relocationEntries = (log ?? []).filter((r) => (r.changed_fields ?? []).includes("relocation_destination_city"));
const confirmed = relocationEntries.find((r) => r.actor === "user:human_confirmed");
check("the change is recorded in truth_change_log with a human actor",
  Boolean(confirmed), JSON.stringify(relocationEntries.map((r) => r.actor)));
check("and the recorded basis says the date was not provided",
  /must not be inferred/i.test(JSON.stringify(confirmed?.new_data ?? {})), JSON.stringify(confirmed?.new_data ?? null).slice(0, 200));

console.log(`\nprofile_version: ${p.profile_version}`);
console.log(`${pass + fails.length} checks, ${pass} passed`);
if (fails.length) { console.log(`${fails.length} FAILED`); process.exit(1); }
console.log("0051 is live");
