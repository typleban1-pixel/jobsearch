/**
 * The reprepare banner shows a fresh "Preparing on Ashby" entry and drops
 * it once the preparation window has passed, so the confirmation is present
 * exactly while it is useful and never sticks around stale.
 */
import { partitionEntries, type BannerEntry } from "../app/apply/reprepareBanner.ts";
let bad = 0;
const ok = (c: boolean, w: string) => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}`); if (!c) bad++; };
const now = 1_000_000;
const e = (id: string, ageMs: number): BannerEntry => ({ id, title: id, at: now - ageMs });
const { live, expired } = partitionEntries([e("fresh", 0), e("mid", 45_000), e("old", 91_000)], now, 90_000);
ok(live.map((x) => x.id).sort().join(",") === "fresh,mid", "entries within the window stay live");
ok(expired.map((x) => x.id).join(",") === "old", "entries past the window are dropped");
ok(partitionEntries([], now).live.length === 0, "no entries -> nothing shown");
console.log(bad ? `\n${bad} FAILED` : `\nreprepare-banner-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
