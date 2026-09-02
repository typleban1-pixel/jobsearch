import type { DiscoveredCompany, DiscoverySource } from "../types.ts";
import { normalizeDomain } from "../types.ts";

/**
 * Wikidata, for employers the accelerator directories never mention.
 *
 * The universe was 2,688 Y Combinator companies out of 2,716, which
 * meant a company effectively qualified by having been a startup. That
 * is close to the opposite of a Chicago employer list, and it is why the
 * large employers in this market -- the hospital systems, the exchanges,
 * the manufacturers, the insurers -- were entirely absent.
 *
 * Wikidata is used rather than a scraped directory because it is a
 * public SPARQL endpoint intended for exactly this, it carries the
 * official website (which is what the ATS resolver actually needs), and
 * nothing about reading it is ambiguous.
 *
 * Two populations, deliberately:
 *
 *   CHICAGO   organisations headquartered in the metro, at any size
 *   NATIONAL  large US employers anywhere, because a company in Seattle
 *             with 40,000 staff very likely has Chicago openings and
 *             almost certainly runs an ATS we want to reach
 *
 * Neither query filters on industry. A hospital network and a commodities
 * exchange are both employers, and deciding relevance here would be
 * deciding it before eligibility and candidacy ever see the job.
 */

const ENDPOINT = "https://query.wikidata.org/sparql";
const UA = "jobsearch-personal/0.1 (single-user job search; contact via board owner)";

/**
 * Chicago and Cook County as HQ.
 *
 * Deliberately NOT a transitive P131 walk over the whole metro: that
 * version ran long enough for the endpoint to give up. Two explicit
 * anchors return in a couple of seconds and cover the city and county.
 */
const CHICAGO = `
SELECT ?c ?cLabel ?site ?emp WHERE {
  VALUES ?hq { wd:Q1297 wd:Q108418 }
  ?c wdt:P159 ?hq ; wdt:P856 ?site .
  OPTIONAL { ?c wdt:P1128 ?emp }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
}
ORDER BY ?c
LIMIT %LIMIT% OFFSET %OFFSET%`;

/**
 * US employers above a headcount floor: the cohort that runs Workday.
 *
 * Deliberately plain. The first version walked P31/P279* to business
 * enterprise and sorted by headcount descending, and the endpoint
 * returned 504: a subclass closure plus a global sort over every
 * employer in the United States is not a query a shared service owes
 * anybody. Filtering on the headcount property alone is a couple of
 * seconds, and anything carrying that property is an organisation.
 */
const NATIONAL = `
SELECT ?c ?cLabel ?site ?emp WHERE {
  ?c wdt:P1128 ?emp ; wdt:P17 wd:Q30 ; wdt:P856 ?site .
  FILTER(?emp >= 2000)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en" }
}
ORDER BY ?c
LIMIT %LIMIT% OFFSET %OFFSET%`;

interface Row {
  cLabel?: { value: string };
  site?: { value: string };
  emp?: { value: string };
}

async function ask(query: string, limit: number, offset: number, signal?: AbortSignal): Promise<Row[]> {
  const q = query.replace("%LIMIT%", String(limit)).replace("%OFFSET%", String(offset));
  const url = `${ENDPOINT}?query=${encodeURIComponent(q)}`;
  const res = await fetch(url, {
    headers: { accept: "application/sparql-results+json", "user-agent": UA },
    signal: signal ?? AbortSignal.timeout(90_000),
  });
  if (!res.ok) throw new Error(`wikidata ${res.status}`);
  const body = await res.json() as { results?: { bindings?: Row[] } };
  return body.results?.bindings ?? [];
}

/** Organisations that are not places anyone applies to work. */
const NOT_AN_EMPLOYER =
  /\b(wikiproject|category|list of|album|film|song|band|magazine|newspaper of record)\b/i;

function toCompany(r: Row, label: string, method: DiscoveredCompany["method"],
                   chicago: boolean): DiscoveredCompany | null {
  const name = r.cLabel?.value?.trim();
  const site = r.site?.value?.trim();
  if (!name || !site) return null;
  if (NOT_AN_EMPLOYER.test(name)) return null;
  if (/^Q\d+$/.test(name)) return null;            // an unlabelled entity
  const domain = normalizeDomain(site);
  if (!domain) return null;

  const emp = r.emp ? Number(r.emp.value) : null;
  return {
    name,
    domain,
    sourceLabel: label,
    sourceUrl: site,
    method,
    industries: [],
    // Ordering only, and it never removes anyone. Chicago employers go
    // first because that is the market; size breaks ties after that,
    // since a bigger employer has more openings to find.
    priorityScore: Math.min(95, (chicago ? 70 : 45) + (emp && emp >= 10_000 ? 15 : emp && emp >= 2_000 ? 8 : 0)),
    priorityReason: chicago
      ? "headquartered in Chicago or Cook County"
      : `US employer with ${emp ? emp.toLocaleString() : "unrecorded"} staff`,
    sizeMin: emp && Number.isFinite(emp) ? Math.round(emp) : null,
    sizeMax: null,
    notes: null,
  };
}

function build(
  label: string, coverage: string, query: string,
  method: DiscoveredCompany["method"], chicago: boolean, pageSize: number,
): DiscoverySource {
  return {
    label, method, coverage,
    async fetch({ maxPages = 6, startPage = 1, signal } = {}) {
      const companies: DiscoveredCompany[] = [];
      const warnings: string[] = [];
      let pagesFetched = 0;
      for (let p = 0; p < maxPages; p++) {
        const offset = (startPage - 1 + p) * pageSize;
        let rows: Row[];
        try {
          rows = await ask(query, pageSize, offset, signal);
        } catch (err) {
          warnings.push(`page at offset ${offset}: ${(err as Error).message}`);
          break;
        }
        pagesFetched++;
        for (const r of rows) {
          const c = toCompany(r, label, method, chicago);
          if (c) companies.push(c);
        }
        if (rows.length < pageSize) break;
        // The endpoint is free and shared. One request a second.
        await new Promise((r) => setTimeout(r, 1100));
      }
      return { companies, pagesFetched, warnings };
    },
  };
}

export const wikidataChicago = build(
  "Wikidata: Chicago and Cook County employers",
  "Organisations recorded in Wikidata as headquartered in Chicago or Cook County, at any size, "
  + "with an official website. Misses employers with no Wikidata entry and, by design, national "
  + "employers whose Chicago presence is an office rather than a headquarters.",
  CHICAGO, "PUBLIC_DIRECTORY", true, 400,
);

export const wikidataLargeUs = build(
  "Wikidata: large US employers",
  "US companies with 2,000 or more recorded staff, largest first. These are the employers most "
  + "likely to have Chicago offices and to run Workday, iCIMS or SuccessFactors, none of which "
  + "the accelerator directory surfaces.",
  NATIONAL, "PUBLIC_DIRECTORY", false, 300,
);
