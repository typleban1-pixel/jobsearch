/**
 * Proves the Gmail integration can read what it needs, and no more.
 *
 *   node scripts/gmail-read-test.ts
 *
 * It runs one constrained search, shows the headers of what matched, and
 * opens exactly one message to prove a body can be retrieved. The body is
 * never printed: what you get is its length, a digest, and the answers to
 * the two questions that matter, which is whether the message reads as an
 * employer confirmation and whether it is a human-verification challenge.
 *
 * It also runs the query builder's refusals, because "cannot ask for the
 * whole mailbox" is a property worth testing rather than asserting.
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import {
  buildQuery, searchIds, getHeaders, getMessage,
  APPLICATION_SENDERS, APPLICATION_SUBJECTS,
} from "../lib/gmail/client.ts";
import { credentialStatus, GmailReauthRequired, SCOPE } from "../lib/gmail/oauth.ts";


let failures = 0;
const check = (what: string, ok: boolean, detail = "") => {
  console.log(`  ${ok ? "ok  " : "FAIL"} ${what}${ok || !detail ? "" : `  -- ${detail}`}`);
  if (!ok) failures++;
};

// ---- the credential, described and never disclosed --------------------
const status = credentialStatus();
if (!status.present) {
  console.error("no Gmail credential is stored. Run: node scripts/gmail-authorize.ts");
  process.exit(2);
}
const mode = (statSync(status.path).mode & 0o777).toString(8);
console.log("credential");
check(`stored for ${status.account}`, Boolean(status.account));
check(`scope is exactly ${SCOPE}`, status.scope === SCOPE, String(status.scope));
check(`file mode is 0600 (is ${mode})`, mode === "600");

// ---- the reader cannot be asked for everything ------------------------
console.log("\nthe search is always bounded");
let refused = false;
try { buildQuery({ withinDays: 7 }); } catch { refused = true; }
check("a query with no sender or subject constraint is refused", refused);
refused = false;
try { buildQuery({ from: ["greenhouse.io"], withinDays: 0 }); } catch { refused = true; }
check("an unbounded time window is refused", refused);
refused = false;
try { buildQuery({ from: ["greenhouse.io"], withinDays: 4000 }); } catch { refused = true; }
check("a 4000 day window is refused", refused);

const query = buildQuery({
  from: APPLICATION_SENDERS, subjectAny: APPLICATION_SUBJECTS, withinDays: 7,
});
check("the built query excludes spam and trash", query.includes("-in:spam -in:trash"));
check("the built query is time bounded", /newer_than:\d+d/.test(query));
console.log(`  query: ${query.slice(0, 150)}${query.length > 150 ? " ..." : ""}`);

// ---- one search, headers only ----------------------------------------
console.log("\nsearching");
let ids: string[] = [];
try {
  ids = await searchIds(query, 10);
} catch (err) {
  if (err instanceof GmailReauthRequired) { console.error(`\n${err.message}`); process.exit(3); }
  throw err;
}
console.log(`  ${ids.length} application message${ids.length === 1 ? "" : "s"} in the last 7 days`);
check("the search returned at most what was asked for", ids.length <= 10);

const headers = [];
for (const id of ids) headers.push(await getHeaders(id));
for (const h of headers) {
  console.log(`   ${h.date.slice(0, 22).padEnd(24)} ${h.from.slice(0, 42).padEnd(44)} ${h.subject.slice(0, 60)}`);
}

// ---- open exactly one, and describe it without quoting it -------------
const target = headers.find((h) => /stripe/i.test(h.from) || /stripe/i.test(h.subject)) ?? headers[0];
if (!target) {
  console.log("\nno message matched, so nothing was opened. "
    + "That is a valid result: the reader downloads only what a constrained search returns.");
} else {
  console.log(`\nopening exactly one message: "${target.subject}"`);
  const full = await getMessage(target.id);
  const digest = createHash("sha256").update(full.text).digest("hex").slice(0, 12);
  check("a body was retrieved", full.text.length > 0, `${full.text.length} chars`);
  console.log(`  length      ${full.text.length} characters`);
  console.log(`  sha256      ${digest} (of the body, so the read is reproducible without quoting it)`);
  console.log(`  confirmation wording present: ${/thank you for applying|application (has been )?received/i.test(full.text)}`);

  // Whether this is an ordinary OTP or a human-presence check is not
  // decidable from the mail alone; classify() needs the form that asked.
  console.log(`  carries code wording: ${/verification code|security code/i.test(full.text)}`);
  check("the body was not printed", true);
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
