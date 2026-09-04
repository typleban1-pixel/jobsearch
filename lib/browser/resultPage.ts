/**
 * Which open page holds the result of a submission.
 *
 * The submitter and the fill watcher used to hard-code
 * `url().includes("greenhouse.io")`, which was right only for Greenhouse.
 * The page that carries the confirmation is the one on the FORM's own
 * origin, whatever the provider. This picks that page, keeps the historical
 * Greenhouse match as a fallback so every validated Greenhouse run takes
 * exactly its old path, and otherwise falls back to the last page opened.
 *
 * Pure: it decides only WHICH page, never what the page means. It encodes
 * no success wording for any provider.
 */
function originOf(url: string): string {
  try { return new URL(url).origin; } catch { return ""; }
}

export function pickResultPageIndex(pageUrls: string[], applyUrl: string): number {
  if (pageUrls.length === 0) return -1;
  const want = originOf(applyUrl);
  if (want) {
    const i = pageUrls.findIndex((u) => originOf(u) === want);
    if (i >= 0) return i;
  }
  const gh = pageUrls.findIndex((u) => u.includes("greenhouse.io"));
  if (gh >= 0) return gh;
  return pageUrls.length - 1;
}
