/**
 * HTML to plain text.
 *
 * Greenhouse returns HTML-entity-encoded markup in `content`. Lever gives
 * us `descriptionPlain` but splits the rest of the posting across `lists`
 * and `additionalPlain`, so both providers need assembling before the
 * text can be hashed or compared.
 *
 * Normalization here is deliberately aggressive about whitespace: a board
 * that reflows its own HTML must not read as a content change.
 */

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  ldquo: "“", rdquo: "”", lsquo: "‘", rsquo: "’",
  mdash: "—", ndash: "–", hellip: "…", bull: "•",
};

export function decodeEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => safeChar(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => safeChar(parseInt(d, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

function safeChar(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : "";
}

export function htmlToText(html: string): string {
  // Decode first: Greenhouse double-encodes, so the markup is still
  // entities at this point and stripping tags before decoding does nothing.
  let s = decodeEntities(html);
  if (/&(amp|lt|gt|quot|#\d+);/.test(s)) s = decodeEntities(s);

  s = s
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
    .replace(/<\s*(br|\/p|\/div|\/li|\/tr|\/h[1-6])\s*\/?>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n- ")
    .replace(/<[^>]+>/g, " ");

  return normalizeWhitespace(decodeEntities(s));
}

export function normalizeWhitespace(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/ /g, " ")
    .split("\n")
    .map((l) => l.replace(/[ \t]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
