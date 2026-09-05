/**
 * Locks combined-name resolution: a single "Full Name"/"Name" control maps
 * to full_name (joined first+last, DERIVED), and is not confused with the
 * separate first/last/preferred/company/school name fields.
 *   node scripts/full-name-selftest.ts
 */
import { matchIntent } from "../lib/applications/intents.ts";
let bad = 0;
const ok = (c: boolean, w: string, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${x ? " -- " + x : ""}`); if (!c) bad++; };
ok(matchIntent("Full Name").intent?.key === "full_name", "'Full Name' -> full_name");
ok(matchIntent("Name").intent?.key === "full_name", "'Name' -> full_name");
ok(matchIntent("Legal Name").intent?.key === "full_name", "'Legal Name' -> full_name");
ok(matchIntent("First Name").intent?.key === "legal_first_name", "'First Name' -> legal_first_name", matchIntent("First Name").intent?.key);
ok(matchIntent("Last Name").intent?.key === "legal_last_name", "'Last Name' -> legal_last_name");
ok(matchIntent("Preferred First Name").intent?.key === "preferred_name", "'Preferred First Name' -> preferred_name", matchIntent("Preferred First Name").intent?.key);
ok(matchIntent("Company Name").intent?.key !== "full_name", "'Company Name' is not full_name", matchIntent("Company Name").intent?.key ?? "none");
ok(matchIntent("Name of School").intent?.key !== "full_name", "'Name of School' is not full_name", matchIntent("Name of School").intent?.key ?? "none");
console.log(bad ? `\n${bad} FAILED` : `\nfull-name-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
