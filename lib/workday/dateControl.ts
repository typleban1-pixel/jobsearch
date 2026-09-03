/**
 * Workday's MM/YYYY date control.
 *
 * It looks like two boxes and behaves like one value. Filling the month
 * box with an unpadded "3" produced "12/" and a red "Invalid Date": the
 * widget reads keystrokes into a masked field and re-interprets whatever
 * partial value it holds, so a single digit is not a short month, it is
 * a broken date. The month is always two digits and the year always
 * four, and the two are typed as one sequence so the control advances
 * itself exactly as it would for a person.
 */

/** "2024-03-01" or "2024-03" to "03/2024". Empty for anything unusable. */
export function toMMYYYY(iso: string | null | undefined): string {
  const s = String(iso ?? "").trim();
  const m = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/.exec(s);
  if (!m) return "";
  const year = m[1]!;
  const month = Number(m[2]);
  if (!(month >= 1 && month <= 12)) return "";
  return `${String(month).padStart(2, "0")}/${year}`;
}

/** The digits a person would type, with no separator. */
export function dateKeystrokes(iso: string | null | undefined): string {
  const v = toMMYYYY(iso);
  return v ? v.replace("/", "") : "";
}

/** Month and year as the control reports them, for read-back. */
export function splitMMYYYY(value: string): { month: string; year: string } {
  const m = /^(\d{1,2})\s*\/\s*(\d{4})$/.exec(String(value ?? "").trim());
  return m ? { month: m[1]!.padStart(2, "0"), year: m[2]! } : { month: "", year: "" };
}

/**
 * Whether what the control now holds is the date that was asked for.
 *
 * Compared as a date, not as text: the control may render "3/2024" or
 * "03/2024" and both are the same month.
 */
export function dateMatches(monthRead: string, yearRead: string, iso: string): boolean {
  const want = toMMYYYY(iso);
  if (!want) return false;
  const [wm, wy] = want.split("/");
  const gotMonth = String(monthRead ?? "").trim().replace(/^0+/, "");
  const gotYear = String(yearRead ?? "").trim();
  return gotMonth === String(Number(wm)) && gotYear === wy;
}
