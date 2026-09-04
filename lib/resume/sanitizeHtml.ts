/**
 * Making pasted clipboard HTML safe to store.
 *
 * Runs on the server before insert, so raw clipboard HTML never lands in
 * the database. It keeps enough structure to be a faithful record of the
 * posting (headings, lists, emphasis) and strips everything executable or
 * external. The stored HTML is a record, not something the portal renders
 * as live markup -- the plain text drives extraction and display -- so
 * this is defence in depth rather than the only guard, but it removes the
 * dangerous shapes outright either way.
 */

const MAX = 200_000; // a posting, not a web page

/** Tags whose entire contents are dropped, not just the tag. */
const DROP_WITH_CONTENT = /<(script|style|noscript|template|svg|math|iframe|object|embed|form|button|input|select|textarea)\b[\s\S]*?<\/\1\s*>/gi;
/** Self-closing / unpaired dangerous or external tags. */
const DROP_TAGS = /<\/?(script|style|noscript|template|svg|math|iframe|object|embed|form|button|input|select|textarea|link|meta|base|frame|frameset|applet|param|source|track|audio|video|canvas|img|picture)\b[^>]*>/gi;

export function sanitizeClipboardHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  let s = String(html).slice(0, MAX);

  s = s.replace(/<!--[\s\S]*?-->/g, " ");        // comments (can hide markup)
  s = s.replace(DROP_WITH_CONTENT, " ");
  s = s.replace(DROP_TAGS, " ");
  s = s.replace(/\son\w+\s*=\s*"[^"]*"/gi, "");   // event handlers
  s = s.replace(/\son\w+\s*=\s*'[^']*'/gi, "");
  s = s.replace(/\son\w+\s*=\s*[^\s>]+/gi, "");
  s = s.replace(/\s(href|src|xlink:href)\s*=\s*"(?:javascript|data|vbscript):[^"]*"/gi, "");
  s = s.replace(/\s(href|src|xlink:href)\s*=\s*'(?:javascript|data|vbscript):[^']*'/gi, "");
  s = s.replace(/\sstyle\s*=\s*"[^"]*"/gi, "");   // inline styles (can load/position)
  s = s.replace(/\sstyle\s*=\s*'[^']*'/gi, "");
  s = s.replace(/\s(class|id|data-[\w-]+|aria-[\w-]+)\s*=\s*"[^"]*"/gi, ""); // source-page cruft
  s = s.replace(/\s(class|id|data-[\w-]+|aria-[\w-]+)\s*=\s*'[^']*'/gi, "");

  // Collapse the whitespace the removals leave behind.
  s = s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  return s || null;
}
