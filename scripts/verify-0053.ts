/**
 * The five guard-test probe rows 0053 named are gone, and nothing else
 * went with them.
 */
import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";

const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fails.push(name); console.log(`  FAIL ${name}\n         ${detail}`); }
};

const DEBRIS = [
  "84813005-8f44-4149-b40d-c2b0ee05e8ec",
  "d570fe4b-2cf0-4233-885c-420337676f39",
  "4e1e489a-78cb-4972-95eb-c16e532f50f6",
  "34e2bf3e-d90d-473f-8061-d50584d2d5ec",
  "fa001f3d-6c6d-4249-a7dc-fc7b6720501d",
];
const KEEP = {
  spothero: "9af26bee-dd8d-4e8d-b037-a224a5be24aa",
  futureInterest: "b27b7119-0da1-4b06-8f25-abe4038ef529",
};

for (const id of DEBRIS) {
  const { data } = await db.from("applications").select("id,status").eq("id", id).maybeSingle();
  check(`probe row ${id.slice(0, 8)} is gone`, data === null, JSON.stringify(data));
  const { count: ev } = await db.from("application_events").select("*", { count: "exact", head: true }).eq("application_id", id);
  const { count: an } = await db.from("application_answers").select("*", { count: "exact", head: true }).eq("application_id", id);
  check(`  and left no events or answers behind`, ev === 0 && an === 0, `${ev} events, ${an} answers`);
}

for (const [name, id] of Object.entries(KEEP)) {
  const { data } = await db.from("applications").select("id,status,submitted_at").eq("id", id).maybeSingle();
  check(`the ${name} application was not touched`, data !== null, "it is missing");
  if (data) console.log(`         ${data.status}, submitted_at ${data.submitted_at ?? "null"}`);
}

const { data: all } = await db.from("applications").select("id,status,is_test");
check("only the two real applications remain", (all ?? []).length === 2, JSON.stringify(all));
check("and neither is marked is_test", (all ?? []).every((a) => a.is_test === false), JSON.stringify(all));

console.log(`\n${pass + fails.length} checks, ${pass} passed`);
if (fails.length) { console.log(`${fails.length} FAILED`); process.exit(1); }
console.log("0053 is live");
