import type { DiscoveredCompany, DiscoverySource } from "../types.ts";
import { normalizeDomain } from "../types.ts";

/**
 * Y Combinator's public company directory.
 *
 * api.ycombinator.com is a public JSON API and is not the path
 * www.ycombinator.com/robots.txt disallows, which covers the HTML
 * /companies pages. 248 pages at time of writing.
 *
 * Heavy ATS adoption and a strong tilt toward companies that would never
 * appear in a Chicago-focused list, which is the point: the system exists
 * partly to surface employers that would not have been searched for.
 */
const BASE = "https://api.ycombinator.com/v0.1/companies";

interface YcCompany {
  name?: string; website?: string; oneLiner?: string; teamSize?: number | null;
  batch?: string; status?: string; industries?: string[]; regions?: string[]; tags?: string[];
  url?: string;
}

export const ycombinator: DiscoverySource = {
  label: "Y Combinator company directory",
  method: "PUBLIC_DIRECTORY",
  coverage:
    "Every YC company with a public profile. Skews early-stage and technical. " +
    "Filtered to active companies with a website; dead and acquired ones are skipped " +
    "because they cannot be hiring.",

  async fetch({ maxPages = 40, signal, startPage = 1 } = {} as any) {
    const companies: DiscoveredCompany[] = [];
    const warnings: string[] = [];
    const seen = new Set<string>();
    let page = startPage;
    let pagesFetched = 0;
    const lastPage = startPage + maxPages - 1;

    while (page <= lastPage) {
      const url = `${BASE}?page=${page}`;
      let payload: { companies?: YcCompany[]; totalPages?: number; nextPage?: number | null };
      try {
        const res = await fetch(url, {
          signal: signal ?? AbortSignal.timeout(45_000),
          headers: { accept: "application/json", "user-agent": "jobsearch-personal/0.1 (single-user job search)" },
        });
        if (!res.ok) { warnings.push(`page ${page}: HTTP ${res.status}`); break; }
        payload = await res.json();
      } catch (e) {
        warnings.push(`page ${page}: ${e instanceof Error ? e.message : String(e)}`);
        break;
      }
      pagesFetched++;

      for (const c of payload.companies ?? []) {
        const name = (c.name ?? "").trim();
        const domain = normalizeDomain(c.website);
        if (!name || !domain) continue;
        // Dead and acquired companies are not hiring. Skipped at the
        // source rather than carried as rows that can never resolve.
        if (c.status && !/active/i.test(c.status)) continue;
        const key = domain;
        if (seen.has(key)) continue;
        seen.add(key);

        // Priority orders the resolution queue and nothing else. US and
        // remote-friendly companies are looked at first because they are
        // likelier to be eligible, not because others are excluded.
        const regions = (c.regions ?? []).join(" ").toLowerCase();
        const usish = /united states|america|remote/.test(regions);
        const chicagoish = /chicago|illinois|midwest/.test(regions);

        // Team size dominates the ordering, because it is the best
        // available proxy for "has an applicant tracking system at all".
        //
        // Measured: the API paginates newest-first. Page 1 is batch F26
        // with a median team of 2 and no company over 25 staff; page 200
        // is W17 with a median of 20 and 11 of 25 over 25 staff. A first
        // sweep of pages 1-30 resolved 1 company in 60, not because the
        // resolver was wrong but because a ten-person company three
        // months old has no board to find.
        const size = typeof c.teamSize === "number" ? c.teamSize : 0;
        const sizeScore = size >= 200 ? 40 : size >= 50 ? 32 : size >= 25 ? 24 : size >= 11 ? 12 : 0;
        companies.push({
          name,
          domain,
          sourceLabel: this.label,
          sourceUrl: c.url ?? `https://www.ycombinator.com/companies`,
          method: this.method,
          industries: (c.industries ?? []).slice(0, 6),
          priorityScore: Math.min(99, (chicagoish ? 50 : usish ? 40 : 20) + sizeScore),
          priorityReason: `${chicagoish ? "target region" : usish ? "US or remote" : "outside the US"}, team ${size || "unknown"}`,
          sizeMin: typeof c.teamSize === "number" ? c.teamSize : null,
          sizeMax: typeof c.teamSize === "number" ? c.teamSize : null,
          notes: [c.batch ? `YC ${c.batch}` : null, c.oneLiner?.slice(0, 180)].filter(Boolean).join(" — ") || null,
        });
      }

      const total = payload.totalPages ?? 0;
      if (!payload.nextPage || (total && page >= total)) break;
      page++;
      // The API is public and free; the courtesy is deliberate.
      await new Promise((r) => setTimeout(r, 250));
    }

    return { companies, pagesFetched, warnings };
  },
};
