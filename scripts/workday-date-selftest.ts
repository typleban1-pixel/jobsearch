/**
 * A partially typed date is not a short date, it is an invalid one.
 */
import { toMMYYYY, dateKeystrokes, splitMMYYYY, dateMatches } from "../lib/workday/dateControl.ts";
let n=0,bad=0; const ok=(c:boolean,w:string)=>{n++;if(!c){bad++;console.error(`FAIL ${w}`);}};

// ---- the four real dates on this application -------------------------
ok(toMMYYYY("2019-01-01") === "01/2019", "2019-01 becomes 01/2019");
ok(toMMYYYY("2022-01-01") === "01/2022", "2022-01 becomes 01/2022");
ok(toMMYYYY("2024-03-01") === "03/2024", "2024-03 becomes 03/2024");
ok(toMMYYYY("2025-01-01") === "01/2025", "2025-01 becomes 01/2025");

// ---- the month is ALWAYS two digits ----------------------------------
for (let m = 1; m <= 12; m++) {
  const iso = `2024-${String(m).padStart(2, "0")}-01`;
  const v = toMMYYYY(iso);
  ok(v.length === 7, `${iso} is exactly MM/YYYY (got ${v})`);
  ok(/^\d{2}\/\d{4}$/.test(v), `${iso} pads the month (got ${v})`);
}
ok(toMMYYYY("2024-3-01") === "03/2024", "an unpadded source month is padded, not passed through");
ok(dateKeystrokes("2024-03-01") === "032024", "the keystrokes carry no separator");
ok(dateKeystrokes("2019-01") === "012019", "a year-month value works without a day");

// ---- unusable input yields nothing rather than a guess ---------------
for (const bad_ of ["", "2024", "2024-13-01", "2024-00-01", "not a date", "03/2024", null, undefined]) {
  ok(toMMYYYY(bad_ as any) === "", `${JSON.stringify(bad_)} produces no date rather than a wrong one`);
  ok(dateKeystrokes(bad_ as any) === "", `${JSON.stringify(bad_)} produces no keystrokes`);
}

// ---- read-back compares dates, not strings ---------------------------
ok(dateMatches("03", "2024", "2024-03-01"), "a padded read-back matches");
ok(dateMatches("3", "2024", "2024-03-01"), "an unpadded read-back matches the same month");
ok(!dateMatches("12", "", "2024-03-01"), "the broken 12/ state does NOT pass read-back");
ok(!dateMatches("", "", "2024-03-01"), "an empty control does not pass read-back");
ok(!dateMatches("03", "2025", "2024-03-01"), "the wrong year fails");
ok(!dateMatches("04", "2024", "2024-03-01"), "the wrong month fails");
ok(!dateMatches("3", "2024", "bad"), "an unusable target never matches");

// ---- splitting what the control renders ------------------------------
ok(splitMMYYYY("03/2024").year === "2024", "a rendered value splits");
ok(splitMMYYYY("3/2024").month === "03", "a rendered unpadded month is normalised");
ok(splitMMYYYY("12/").year === "", "the broken state splits to nothing");

console.log(`${n-bad}/${n} assertions passed`);
process.exit(bad?1:0);
