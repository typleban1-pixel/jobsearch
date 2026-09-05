/**
 * Locks the Ashby commit contract encoded in commitVerdict: DOM_VALUE_PRESENT
 * alone never passes, the framework's own state must equal the value AND
 * survive the next render (RERENDER_SURVIVED), and a control with no React
 * props cannot be confirmed committed. Guards the fix for the four Chartis
 * submits that validated empty because a value committed then reverted, or
 * because a fill landed before the form was wired.
 *   node scripts/commit-contract-selftest.ts
 */
import { commitVerdict } from "../lib/browser/actions.ts";
let bad = 0;
const ok = (c: boolean, w: string) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}`); if (!c) bad++; };
const V = "Tyler Pleban";

ok(commitVerdict({ dom: V, react: V, afterReact: V, hasReact: true, invalid: null }, V).ok,
   "committed to framework AND survived rerender -> ok");
ok(!commitVerdict({ dom: V, react: V, afterReact: "", hasReact: true, invalid: null }, V).ok,
   "committed then reverted on next render -> NOT ok (RERENDER_SURVIVED)");
ok(!commitVerdict({ dom: V, react: undefined, afterReact: undefined, hasReact: false, invalid: null }, V).ok,
   "DOM shows value but no React props (unhydrated) -> NOT ok (DOM_VALUE_PRESENT alone)");
ok(!commitVerdict({ dom: V, react: "", afterReact: "", hasReact: true, invalid: null }, V).ok,
   "DOM shows value but framework state empty -> NOT ok (false HANDOFF)");
ok(!commitVerdict({ dom: "", react: "", afterReact: "", hasReact: true, invalid: null }, V).ok,
   "nothing in DOM -> NOT ok");
ok(!commitVerdict({ dom: V, react: V, afterReact: V, hasReact: true, invalid: "true" }, V).ok,
   "committed and survived but still aria-invalid -> NOT ok");
ok(commitVerdict({ dom: ` ${V} `, react: V, afterReact: V, hasReact: true, invalid: null }, V).ok,
   "surrounding whitespace tolerated -> ok");

console.log(bad ? `\n${bad} FAILED` : `\ncommit-contract-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
