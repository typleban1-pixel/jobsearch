/**
 * What version 7 froze, and what it left alone.
 *
 * The frozen snapshot is what the answer resolver reads, so a fact that
 * is live in `profile` but absent from the snapshot answers nothing.
 * Read-only.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
import { headerLocation, currentResidence, relocationDestination, relocationDate,
         requiresRelocationAssistance } from "../lib/render/location.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}\n         ${detail}`); }
};

const { data: live } = await db.from("profile").select("profile_version").eq("singleton", true).single();
check("the live profile is at version 7", live!.profile_version === 7, String(live!.profile_version));

const { data: rows } = await db.from("profile_version_rows")
  .select("row_id,row_data").eq("profile_version", 7).eq("source_table", "profile");
check("version 7 froze exactly one profile row", (rows ?? []).length === 1, String((rows ?? []).length));
const p: any = rows![0]!.row_data;

check("frozen current residence is Cleveland, OH", p.city === "Cleveland" && p.state === "OH", `${p.city}, ${p.state}`);
check("frozen destination is Chicago, IL",
  p.relocation_destination_city === "Chicago" && p.relocation_destination_state === "IL",
  `${p.relocation_destination_city}, ${p.relocation_destination_state}`);
check("frozen destination metro is Chicagoland", p.relocation_destination_metro === "Chicagoland", String(p.relocation_destination_metro));
check("frozen relocation is definite", p.relocation_is_definite === true, String(p.relocation_is_definite));
check("frozen willing to relocate is true", p.willing_to_relocate === true, String(p.willing_to_relocate));
check("frozen relocation assistance is not required", p.relocation_assistance_required === false, String(p.relocation_assistance_required));
check("frozen relocation date is null", p.relocation_date === null || p.relocation_date === undefined, String(p.relocation_date));

// The answers a future application would derive from THIS snapshot.
const facts = {
  city: p.city, state: p.state,
  destinationCity: p.relocation_destination_city, destinationState: p.relocation_destination_state,
  destinationMetro: p.relocation_destination_metro,
  relocationIsDefinite: p.relocation_is_definite, relocationDate: p.relocation_date ?? null,
};
const chicagoOnsite = { city: "Chicago", state: "IL", metro: "Chicagoland", isRemote: false };
const chicagoHybrid = { city: "Chicago", state: "IL", metro: null, isRemote: false };
const suburb = { city: "Naperville", state: "IL", metro: "Chicagoland", isRemote: false };
const remote = { city: null, state: null, metro: null, isRemote: true };

check("a Chicago onsite posting renders the relocating header",
  headerLocation(facts, chicagoOnsite) === "Cleveland, OH · Relocating to Chicago, IL", headerLocation(facts, chicagoOnsite));
check("a Chicago hybrid posting with no metro recorded renders it too",
  headerLocation(facts, chicagoHybrid) === "Cleveland, OH · Relocating to Chicago, IL", headerLocation(facts, chicagoHybrid));
check("a Chicagoland suburb renders it as well",
  headerLocation(facts, suburb) === "Cleveland, OH · Relocating to Chicago, IL", headerLocation(facts, suburb));
check("a fully remote posting renders the residence alone",
  headerLocation(facts, remote) === "Cleveland, OH", headerLocation(facts, remote));
check("the residence answer stays Cleveland", (currentResidence(facts) as any).answer === "Cleveland, OH", "");
check("the destination answer is Chicago, IL", (relocationDestination(facts) as any).answer === "Chicago, IL", "");
check("the relocation date is still unknown", relocationDate(facts).known === false, "");
check("relocation assistance answers No",
  (requiresRelocationAssistance(p.relocation_assistance_required) as any).answer === "No", "");

// Earlier versions are frozen history and must not have moved.
for (const v of [4, 5, 6]) {
  const { data: pv } = await db.from("profile_versions").select("version,row_count,truth_hash").eq("version", v).single();
  console.log(`  version ${v}: ${pv?.row_count} rows, hash ${pv?.truth_hash?.slice(0, 12)}`);
}
const { data: v6rows } = await db.from("profile_version_rows")
  .select("row_data").eq("profile_version", 6).eq("source_table", "profile");
check("version 6 never gained the new columns retroactively",
  (v6rows ?? []).length === 1 && (v6rows![0]!.row_data as any).relocation_destination_city === undefined,
  JSON.stringify(Object.keys((v6rows?.[0]?.row_data ?? {}) as any).filter((k) => k.startsWith("relocation"))));

console.log(`\n${pass + fails.length} checks, ${pass} passed`);
if (fails.length) { console.log(`${fails.length} FAILED`); process.exit(1); }
console.log("version 7 carries the confirmed relocation facts");
