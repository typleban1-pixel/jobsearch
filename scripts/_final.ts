import { createClient } from "@supabase/supabase-js";
import { required } from "../lib/env.ts";
const db = createClient(required("SUPABASE_URL"), required("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false } });
for (const [l,id] of [["Samsara","1c9dcf5e-1992-405c-bf83-8dfe483f3947"],["Stripe","e5e06a2d-66a1-452e-a054-4d9e62939abd"]] as [string,string][]){
  const { data:a } = await db.from("applications").select("status,submitted_at,submit_click_attempted_at,submit_outcome").eq("id",id).single();
  console.log(`${l}: status=${(a as any).status} submitted=${(a as any).submitted_at??"NULL"} click=${(a as any).submit_click_attempted_at??"NULL"} -> ${(a as any).submitted_at?"SUBMITTED":"not submitted"}`);
}
const { count } = await db.from("applications").select("id",{count:"exact",head:true}).not("submitted_at","is",null);
const { data:pol } = await db.from("automation_policy").select("max_applications_per_day").limit(1).single();
console.log("submitted total:", count, "| daily cap:", (pol as any).max_applications_per_day);
