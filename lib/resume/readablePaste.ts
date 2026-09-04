/**
 * Turn pasted clipboard HTML into readable, structured plain text for the
 * Resume Builder textarea.
 *
 * A native textarea receives the browser's text/plain, which many job
 * boards emit with every block run together ("In-PersonTime Zone",
 * "ResponsibilitiesTeam Workflow"). The clipboard's text/html keeps the
 * structure, so we convert THAT with the shared block-aware htmlToText:
 * headings, paragraphs, and list items each land on their own line.
 *
 * htmlToText bullets every list item; to keep numbered lists numbered we
 * first rewrite each ordered-list item as a numbered paragraph, so the
 * converter preserves the number instead of replacing it with a dash.
 *
 * This produces a normalized, readable representation. It is NOT stored as
 * HTML: the caller keeps this as the plain text (for display + extraction)
 * and sends raw clipboard HTML only to the server, which sanitizes it
 * before persisting. Raw clipboard HTML is never stored.
 */
import { htmlToText } from "../ingest/normalize/text.ts";

export function readablePaste(html: string | null | undefined): string {
  if (!html) return "";
  const numbered = String(html).replace(/<ol\b[^>]*>([\s\S]*?)<\/ol>/gi, (_m, inner: string) => {
    let n = 0;
    return "<ol>" + inner.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_x, item: string) => `<p>${++n}. ${item.trim()}</p>`) + "</ol>";
  });
  return htmlToText(numbered);
}
