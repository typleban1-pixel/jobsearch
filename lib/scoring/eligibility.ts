/**
 * The deterministic eligibility gate.
 *
 * Its only job is to withhold jobs that could never be taken, so that
 * paid extraction is not spent on them. It excludes on TWO things and
 * nothing else: geography and work arrangement.
 *
 * It deliberately does NOT exclude on fit, title, seniority, unknown
 * salary, company size, or any other soft signal. A cheap filter that
 * quietly drops good roles costs far more than the tokens it saves, and
 * the whole point of this system is to surface employers that would never
 * have been searched for by hand.
 *
 * Three verdicts. ELIGIBLE and UNCERTAIN both proceed. Only INELIGIBLE is
 * withheld, and only on evidence the posting itself states.
 */

export const ELIGIBILITY_VERSION = 1;

export type EligibilityStatus = "ELIGIBLE" | "UNCERTAIN" | "INELIGIBLE";

export type EligibilityReason =
  // eligible
  | "REMOTE_US_ELIGIBLE"
  | "IN_TARGET_METRO"
  // uncertain
  | "LOCATION_UNKNOWN"
  | "US_LOCATION_POLICY_UNSTATED"
  | "REMOTE_SCOPE_UNSTATED"
  | "REMOTE_STATE_RESTRICTED_UNVERIFIED"
  | "MULTI_LOCATION_PARTIAL_MATCH"
  // ineligible
  | "NON_US_LOCATION"
  | "REMOTE_RESTRICTED_TO_OTHER_REGION"
  | "ONSITE_OUTSIDE_TARGET_METRO"
  | "HYBRID_OUTSIDE_TARGET_METRO";

export interface EligibilityVerdict {
  status: EligibilityStatus;
  reason: EligibilityReason;
  detail: string;
}

export interface EligibilityInput {
  city: string | null;
  state: string | null;
  country: string | null;
  metro: string | null;
  remotePolicy: string | null;
  remoteRestriction: string | null;
  locationRaw: string | null;
}

/**
 * Rules, as configuration rather than constants baked into the branches.
 * These mirror what is stored in location_preferences; the gate reads
 * that table in production and falls back to nothing, never to a guess.
 */
export interface EligibilityRules {
  targetMetros: string[];
  /**
   * States the target metro spans, used ONLY to judge remote roles whose
   * scope names specific states. Not used for metro resolution, which has
   * its own guard against same-named cities elsewhere.
   */
  targetStates: string[];
  remoteCountry: string;
  acceptOnsiteInTargetMetro: boolean;
  acceptHybridInTargetMetro: boolean;
}

export const PROPOSED_RULES: EligibilityRules = {
  targetMetros: ["Chicagoland"],
  // IL and IN only.
  //
  // targetStates is used for one thing: judging a remote role whose scope
  // names specific US states. Living in Chicagoland means a role
  // restricted to Illinois works, and one restricted to northwest Indiana
  // plausibly does too, since seven Indiana municipalities are in the
  // Chicagoland list and are commutable. Wisconsin was in here by
  // symmetry with nothing: the municipality list contains no Wisconsin
  // city at all, so WI could only ever admit a role in a state the user
  // would not be living in.
  targetStates: ["IL", "IN"],
  remoteCountry: "US",
  acceptOnsiteInTargetMetro: true,
  acceptHybridInTargetMetro: true,
};

const US_NAMES = /\b(u\.?s\.?a?\.?|united states|usa|us-remote|remote us|americas|north america|nationwide)\b/i;

// Named explicitly rather than inferred from "not a US state", because a
// posting with an unparsed location is unknown, not foreign.
const NON_US_MARKERS = new RegExp(
  "\\b(" + [
    "india","bengaluru","bangalore","chennai","hyderabad","pune","mumbai","delhi","gurgaon","noida",
    "canada","toronto","vancouver","montreal","ottawa","calgary",
    "united kingdom","uk","england","london","manchester","edinburgh","dublin","ireland",
    "germany","berlin","munich","hamburg","france","paris","spain","madrid","barcelona",
    "portugal","lisbon","porto","netherlands","amsterdam","belgium","brussels",
    "poland","warsaw","krakow","kraków","wroclaw","romania","bucharest","cluj",
    "czech","prague","hungary","budapest","bulgaria","sofia","serbia","belgrade",
    "sweden","stockholm","norway","oslo","denmark","copenhagen","finland","helsinki",
    "switzerland","zurich","geneva","austria","vienna","italy","milan","rome",
    "israel","tel aviv","turkey","istanbul","uae","dubai","abu dhabi",
    "singapore","japan","tokyo","china","shanghai","beijing","hong kong","korea","seoul",
    "australia","sydney","melbourne","new zealand","auckland",
    "brazil","sao paulo","são paulo","mexico","mexico city","guadalajara","argentina",
    "colombia","bogota","bogotá","chile","santiago","costa rica","peru","lima",
    "philippines","manila","indonesia","jakarta","vietnam","thailand","bangkok","malaysia",
    "south africa","cape town","johannesburg","nigeria","lagos","kenya","nairobi","egypt","cairo",
    "emea","apac","latam","anz",
  ].join("|") + ")\\b",
  "i",
);

export function assessEligibility(
  job: EligibilityInput,
  rules: EligibilityRules = PROPOSED_RULES,
): EligibilityVerdict {
  const haystack = [job.locationRaw, job.remoteRestriction, job.city, job.state, job.country]
    .filter(Boolean).join(" | ");
  const inTargetMetro = job.metro !== null && rules.targetMetros.includes(job.metro);
  const countryIsUs = isUsCountry(job.country);
  const countryIsForeign = job.country !== null && !countryIsUs && !US_NAMES.test(job.country);
  const mentionsNonUs = NON_US_MARKERS.test(haystack);
  const mentionsUs = US_NAMES.test(haystack) || job.state !== null || countryIsUs;
  const policy = (job.remotePolicy ?? "UNCLEAR").toUpperCase();

  // A multi-location posting that names the target metro among others is
  // eligible on the strength of that one, whatever else it lists.
  if (inTargetMetro && (policy === "ONSITE" || policy === "HYBRID" || policy === "UNCLEAR")) {
    const ok = policy === "ONSITE" ? rules.acceptOnsiteInTargetMetro
             : policy === "HYBRID" ? rules.acceptHybridInTargetMetro
             : true;
    if (ok) {
      return { status: "ELIGIBLE", reason: "IN_TARGET_METRO",
               detail: `${policy} in ${job.city ?? "target metro"} (${job.metro})` };
    }
  }

  if (policy === "FULLY_REMOTE" || policy === "REMOTE_WITH_TRAVEL") {
    if (inTargetMetro) {
      return { status: "ELIGIBLE", reason: "IN_TARGET_METRO",
               detail: `remote, anchored in ${job.metro}` };
    }
    // "Remote" that names a foreign region is not remote for this person.
    // Checked before the US test because postings routinely say
    // "Remote - India" while the company is American.
    if (mentionsNonUs && !mentionsUs) {
      return { status: "INELIGIBLE", reason: "REMOTE_RESTRICTED_TO_OTHER_REGION",
               detail: `remote but scoped to: ${truncate(job.remoteRestriction ?? haystack)}` };
    }
    if (countryIsForeign && !mentionsUs) {
      return { status: "INELIGIBLE", reason: "NON_US_LOCATION",
               detail: `remote, country ${job.country}` };
    }
    if (mentionsUs) {
      // A remote role whose scope names specific US states, none of them
      // in the target metro's states, is not eligible on its face. But it
      // is not cleanly ineligible either: the state is as often an anchor
      // office as a residency requirement, which is the exact ambiguity
      // the normalizer already flags as "provider reports remote but
      // posting names a location". Ambiguity survives as UNCERTAIN and
      // extraction resolves it from the description body.
      const scoped = usStatesIn(job.remoteRestriction ?? "");
      if (scoped.length > 0 && !scoped.some((st) => rules.targetStates.includes(st))) {
        return { status: "UNCERTAIN", reason: "REMOTE_STATE_RESTRICTED_UNVERIFIED",
                 detail: `remote but scope names ${scoped.join(", ")}; residency requirement vs anchor office unresolved` };
      }
      return { status: "ELIGIBLE", reason: "REMOTE_US_ELIGIBLE",
               detail: job.remoteRestriction ? `remote, scope: ${truncate(job.remoteRestriction)}` : "remote, US" };
    }
    // Says remote, names no geography at all. Common, and genuinely
    // unresolvable from the structured fields.
    return { status: "UNCERTAIN", reason: "REMOTE_SCOPE_UNSTATED",
             detail: "remote with no stated geographic scope" };
  }

  if (policy === "ONSITE" || policy === "HYBRID") {
    if (mentionsNonUs || countryIsForeign) {
      return { status: "INELIGIBLE", reason: "NON_US_LOCATION",
               detail: `${policy} at ${truncate(haystack) || "unstated location"}` };
    }
    if (job.city === null && job.state === null && job.metro === null) {
      return { status: "UNCERTAIN", reason: "LOCATION_UNKNOWN",
               detail: `${policy} but no location resolved` };
    }
    // A stated onsite or hybrid requirement outside the target metro is
    // the one clean work-arrangement exclusion: the posting itself says
    // you must be somewhere you will not be.
    return {
      status: "INELIGIBLE",
      reason: policy === "ONSITE" ? "ONSITE_OUTSIDE_TARGET_METRO" : "HYBRID_OUTSIDE_TARGET_METRO",
      detail: `${policy} in ${truncate(job.locationRaw ?? haystack)}`,
    };
  }

  // policy === UNCLEAR
  if (mentionsNonUs && !mentionsUs) {
    return { status: "INELIGIBLE", reason: "NON_US_LOCATION",
             detail: `no remote language, location ${truncate(haystack)}` };
  }
  if (countryIsForeign) {
    return { status: "INELIGIBLE", reason: "NON_US_LOCATION",
             detail: `no remote language, country ${job.country}` };
  }
  if (job.city === null && job.state === null) {
    return { status: "UNCERTAIN", reason: "LOCATION_UNKNOWN",
             detail: "no location and no work-arrangement language" };
  }
  // A US city with no remote, hybrid or onsite language anywhere. This is
  // the largest uncertain bucket and it must stay uncertain: the posting
  // may well be remote and simply never says so in a field we parse.
  // Extraction resolves it from the description body.
  return { status: "UNCERTAIN", reason: "US_LOCATION_POLICY_UNSTATED",
           detail: `US location ${truncate(job.locationRaw ?? haystack)}, work arrangement unstated` };
}

const US_STATE_CODES = new Set(
  ("AL AK AZ AR CA CO CT DE FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE " +
   "NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY DC").split(" "),
);

/**
 * State codes appearing in a scope string.
 *
 * Uppercase tokens only. Lowercase "or" is the English conjunction far
 * more often than it is Oregon, and "in" is a preposition before it is
 * Indiana; matching case-insensitively here would read "London or Dublin"
 * as an Oregon-scoped role.
 */
function usStatesIn(text: string): string[] {
  const out = new Set<string>();
  for (const tok of text.split(/[\s,()\/|]+/)) {
    if (tok.length === 2 && tok === tok.toUpperCase() && US_STATE_CODES.has(tok)) out.add(tok);
  }
  return [...out];
}

function isUsCountry(country: string | null): boolean {
  if (!country) return false;
  return /^(us|usa|u\.s\.|u\.s\.a\.|united states)$/i.test(country.trim());
}

function truncate(s: string | null, n = 90): string {
  if (!s) return "";
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
