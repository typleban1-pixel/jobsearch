#!/usr/bin/env -S node --env-file=.env.local
/**
 * classifyLeverOutcome: proven-receipt vs ambiguous vs not-submitted, over the
 * failure cases assisted Lever must handle. No browser, no submission.
 *   node scripts/lever-confirm-selftest.ts
 */
import { classifyLeverOutcome, type PageSnapshot } from "../lib/browser/leverConfirm.ts";
let bad = 0;
const ok = (c: boolean, w: string, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${x ? " -- " + x : ""}`); if (!c) bad++; };

const APPLY = "https://jobs.lever.co/acme/1111aaaa-2222-bbbb-3333-cccc4444dddd/apply";
const THANKS = "https://jobs.lever.co/acme/1111aaaa-2222-bbbb-3333-cccc4444dddd/thanks";
const before: PageSnapshot = { url: APPLY, text: "Apply for this job. * indicates a required field. Submit application", controls: 20, formPresent: true, errors: [], captchaVisible: false };
const snap = (o: Partial<PageSnapshot>): PageSnapshot => ({ url: APPLY, text: "", controls: 0, formPresent: false, errors: [], captchaVisible: false, ...o });

// CONFIRMED — Lever thanks URL, form gone.
ok(classifyLeverOutcome(before, snap({ url: THANKS, text: "Thank you for applying! We've received your application.", controls: 0, formPresent: false })).outcome === "CONFIRMED", "thanks URL + form gone -> CONFIRMED");
// CONFIRMED — success text introduced, controls dropped, same-ish URL.
ok(classifyLeverOutcome(before, snap({ url: APPLY, text: "Thank you for applying. Your application was received.", controls: 0, formPresent: false })).outcome === "CONFIRMED", "success text + form gone -> CONFIRMED");
// NOT_SUBMITTED — form still present, unchanged, no nav.
ok(classifyLeverOutcome(before, snap({ url: APPLY, text: before.text, controls: 20, formPresent: true })).outcome === "NOT_SUBMITTED", "unchanged form present -> NOT_SUBMITTED");
// NOT_SUBMITTED — validation error kept the form.
ok(classifyLeverOutcome(before, snap({ url: APPLY, text: before.text + " This field is required.", controls: 20, formPresent: true, errors: ["This field is required"] })).outcome === "NOT_SUBMITTED", "validation error + form present -> NOT_SUBMITTED");
// NOT_SUBMITTED — captcha kept the form (human check not completed).
ok(classifyLeverOutcome(before, snap({ url: APPLY, text: before.text, controls: 20, formPresent: true, captchaVisible: true })).outcome === "NOT_SUBMITTED", "captcha visible + form present -> NOT_SUBMITTED");
// NOT_SUBMITTED — window closed BEFORE leaving the form.
ok(classifyLeverOutcome(before, null, { navigatedAway: false, timedOut: false }).outcome === "NOT_SUBMITTED", "closed before submit (no nav) -> NOT_SUBMITTED");
// AMBIGUOUS — window closed AFTER leaving the form, no confirmation seen.
ok(classifyLeverOutcome(before, null, { navigatedAway: true, timedOut: false }).outcome === "AMBIGUOUS", "closed after leaving form -> AMBIGUOUS");
// AMBIGUOUS — unexpected redirect, form gone, no success/thanks.
ok(classifyLeverOutcome(before, snap({ url: "https://acme.com/careers", text: "Careers at Acme", controls: 0, formPresent: false }), { navigatedAway: true, timedOut: false }).outcome === "AMBIGUOUS", "unexpected redirect, no confirmation -> AMBIGUOUS");
// AMBIGUOUS — timeout with form gone but nothing conclusive.
ok(classifyLeverOutcome(before, snap({ url: APPLY, text: "Loading…", controls: 0, formPresent: false }), { navigatedAway: true, timedOut: true }).outcome === "AMBIGUOUS", "timeout, indeterminate -> AMBIGUOUS");
// Success wording that was ALREADY on the page before is not a confirmation.
ok(classifyLeverOutcome({ ...before, text: before.text + " thank you for your interest" }, snap({ url: APPLY, text: before.text + " thank you for your interest", controls: 20, formPresent: true })).outcome !== "CONFIRMED", "pre-existing 'thank you' text is not a confirmation");
// Duplicate notice is not a confirmation.
ok(classifyLeverOutcome(before, snap({ url: APPLY, text: "You have already applied to this position.", controls: 20, formPresent: true, errors: [] })).outcome !== "CONFIRMED", "duplicate notice -> not CONFIRMED");
// success text but captcha still visible -> not CONFIRMED.
ok(classifyLeverOutcome(before, snap({ url: THANKS, text: "Thank you for applying", controls: 0, formPresent: false, captchaVisible: true })).outcome !== "CONFIRMED", "success + captcha visible -> not CONFIRMED (blocked)");

console.log(bad ? `\n${bad} FAILED` : `\nlever-confirm-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
