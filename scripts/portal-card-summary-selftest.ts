/**
 * Parity: the precomputed Jobs list must equal the live one.
 *
 *   node --env-file=.env.local --conditions=react-server scripts/portal-card-summary-selftest.ts
 *
 * The old /jobs path built every card (loadJobCards), then applyFilters() +
 * sortCards("match") in memory. The new path reads job_card_summary with
 * the same gate, tab, search and ordering expressed in SQL. This holds the
 * two to the same ordered ids and the same totals, for every tab, for a
 * search term, for the last page, and for the live overlays (interest and
 * application status) that the summary deliberately does not store.
 *
 * Run right after scripts/materialize-job-cards.ts --commit so both paths
 * read the same snapshot. Any drift here is a bug in the SQL translation,
 * never something to paper over in the loader.
 */
import { createClient } from "@supabase/supabase-js";
import { loadJobCards, loadJobCardPage, loadJobCardById, type InterestTab } from "../lib/portal/db.ts";
import { applyFilters, sortCards, DEFAULT_FILTERS } from "../lib/portal/present.ts";

const db = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

let bad = 0;
const ok = (c: boolean, label: string, extra?: unknown) => {
  if (!c) { bad++; console.log(`  FAIL  ${label}`, extra ?? ""); } else console.log(`  PASS  ${label}`);
};
const ids = (cards: { id: string }[]) => cards.map((c) => c.id);
const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

const all = await loadJobCards(db);
const live = (interest: InterestTab, q = "") =>
  sortCards(applyFilters(all, { ...DEFAULT_FILTERS, q, interest, candidacy: "actionable" }), "match");

for (const tab of ["active", "saved", "dismissed", "all"] as InterestTab[]) {
  const old = live(tab);
  const page1 = await loadJobCardPage(db, { interest: tab, q: "", page: 1 });
  ok(page1.total === old.length, `${tab}: total ${page1.total} == live ${old.length}`);
  ok(same(ids(page1.cards), ids(old.slice(0, 50))), `${tab}: page 1 order identical`,
    same(ids(page1.cards), ids(old.slice(0, 50))) ? undefined : { summary: ids(page1.cards).slice(0, 5), live: ids(old.slice(0, 5)) });
  // Last page, asked for past the end: must clamp and match the live tail.
  if (old.length > 50) {
    const lastNo = Math.ceil(old.length / 50);
    const last = await loadJobCardPage(db, { interest: tab, q: "", page: lastNo + 5 });
    ok(last.page === lastNo && same(ids(last.cards), ids(old.slice((lastNo - 1) * 50))), `${tab}: last page (${lastNo}) clamps and matches`);
  }
  for (const c of page1.cards) {
    const o = old.find((x) => x.id === c.id);
    ok(!!o && o.activeInterest === c.activeInterest && o.applicationStatus === c.applicationStatus,
      `${tab}: overlays match for ${c.id.slice(0, 8)}`, o ? { live: [o.activeInterest, o.applicationStatus], summary: [c.activeInterest, c.applicationStatus] } : "missing live");
  }
}

// Search: the live filter is a substring of "title company"; the SQL is
// title ILIKE or company ILIKE. Identical for a single-field term.
const term = all.find((c) => c.company && c.company.length > 3)?.company.split(/\s+/)[0] ?? "";
if (term) {
  const old = live("all", term);
  const got = await loadJobCardPage(db, { interest: "all", q: term, page: 1 });
  ok(got.total === old.length && same(ids(got.cards), ids(old.slice(0, 50))), `search "${term}": total + order identical (${got.total})`);
}

// Detail: the rank shown on a job page is its position in the live list.
const top = live("all");
const probes = [0, Math.floor(top.length / 2), top.length - 1]
  .map((i) => top[i]).filter((c): c is (typeof top)[number] => c !== undefined);
for (const probe of probes) {
  const d = await loadJobCardById(db, probe.id);
  const livePos = top.findIndex((c) => c.id === probe.id) + 1;
  ok(!!d && d.matchRank === livePos && d.total === top.length, `detail ${probe.id.slice(0, 8)}: rank ${d?.matchRank} == live position ${livePos} of ${top.length}`);
  const liveSibs = ids(all.filter((c) => c.openingId === probe.openingId && c.id !== probe.id)).sort();
  ok(!!d && same(ids(d.siblings).sort(), liveSibs), `detail ${probe.id.slice(0, 8)}: siblings match (${liveSibs.length})`);
}

console.log(bad ? `\n${bad} FAILED` : `\nportal-card-summary-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
