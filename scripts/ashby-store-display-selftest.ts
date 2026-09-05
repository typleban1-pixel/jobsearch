/**
 * Locks the value-shape mapping used to read back an Ashby control from its
 * own field state. A react-select place commits an OBJECT with .text and no
 * DOM singleValue node; reading it as a string is what dropped Chartis'
 * required Location. readAshbyCommitted applies these same rules in-page.
 *   node scripts/ashby-store-display-selftest.ts
 */
import { ashbyStoreDisplay } from "../lib/browser/actions.ts";
let bad = 0;
const ok = (c: boolean, w: string) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}`); if (!c) bad++; };
ok(ashbyStoreDisplay("Tyler Pleban") === "Tyler Pleban", "plain string -> itself");
ok(ashbyStoreDisplay({ text: "Cleveland, Ohio, United States", providerLocationId: "united_states/ohio/cleveland" }) === "Cleveland, Ohio, United States", "location object -> its .text");
ok(ashbyStoreDisplay({ label: "Some Option" }) === "Some Option", "object with .label -> label");
ok(ashbyStoreDisplay({ name: "Named" }) === "Named", "object with .name -> name");
ok(ashbyStoreDisplay(null) === null, "null -> null");
ok(ashbyStoreDisplay("") === null, "empty string -> null (no committed value)");
ok(ashbyStoreDisplay({ providerLocationId: "x" }) === null, "object without a display field -> null (never a false read-back)");
console.log(bad ? `\n${bad} FAILED` : `\nashby-store-display-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
