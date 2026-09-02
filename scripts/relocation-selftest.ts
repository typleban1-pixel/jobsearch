/**
 * Where he is, where he is going, and what a resume may say about it.
 *
 * Five facts that look like one: current residence, intended
 * destination, willingness to move, whether assistance is required, and
 * when the move happens. They were a single prose sentence until now,
 * and prose cannot answer a form question without one fact quietly
 * standing in for another. Each case below is a way that substitution
 * could reach an employer as a false statement.
 *
 * Runs offline. Nothing here touches the database. The employment
 * chronology has its own suite next door.
 */
import { headerLocation, postingIsAtDestination, currentResidence, relocationDestination,
         relocationDate, requiresRelocationAssistance } from "../lib/render/location.ts";
import { matchIntent } from "../lib/applications/intents.ts";

let pass = 0; const fails: string[] = [];
const check = (name: string, cond: boolean, detail = "") => {
  if (cond) pass++; else fails.push(`  ${name}\n      ${detail}`);
};

/** The confirmed facts, as the profile now holds them. */
const NOW = {
  city: "Cleveland", state: "OH",
  destinationCity: "Chicago", destinationState: "IL", destinationMetro: "Chicagoland",
  relocationIsDefinite: true, relocationDate: null,
};
const CHICAGO_ONSITE = { city: "Chicago", state: "IL", metro: "Chicagoland", isRemote: false };
const SUBURB = { city: "Evanston", state: "IL", metro: "Chicagoland", isRemote: false };
const REMOTE = { city: null, state: null, metro: null, isRemote: true };
const ELSEWHERE = { city: "Austin", state: "TX", metro: "Austin", isRemote: false };

// 1. A Chicago posting sees the relocation.
check("a Chicago onsite posting gets the relocating header",
  headerLocation(NOW, CHICAGO_ONSITE) === "Cleveland, OH · Relocating to Chicago, IL",
  headerLocation(NOW, CHICAGO_ONSITE));
check("a Chicagoland suburb counts as the destination market",
  headerLocation(NOW, SUBURB) === "Cleveland, OH · Relocating to Chicago, IL",
  headerLocation(NOW, SUBURB));

// 2. The residence never becomes Chicago before the move.
check("the header still leads with the city he actually lives in",
  headerLocation(NOW, CHICAGO_ONSITE).startsWith("Cleveland, OH"), headerLocation(NOW, CHICAGO_ONSITE));
check("no header anywhere states Chicago as the current residence",
  !/^Chicago/.test(headerLocation(NOW, CHICAGO_ONSITE)) && headerLocation(NOW, ELSEWHERE) === "Cleveland, OH",
  headerLocation(NOW, ELSEWHERE));
check("a current-residence question is answered with Cleveland",
  currentResidence(NOW).known && (currentResidence(NOW) as any).answer === "Cleveland, OH", "");

// 3. A definite relocation is not softened.
{
  const h = headerLocation(NOW, CHICAGO_ONSITE);
  check("the header says he is relocating, not that he is open to it",
    h.includes("Relocating to") && !/open to|willing to|considering/i.test(h), h);
}
check("an indefinite relocation does not produce the claim at all",
  headerLocation({ ...NOW, relocationIsDefinite: false }, CHICAGO_ONSITE) === "Cleveland, OH",
  headerLocation({ ...NOW, relocationIsDefinite: false }, CHICAGO_ONSITE));

// 4. No date is invented, by any route.
{
  const d = relocationDate(NOW);
  check("an unknown relocation date stays unknown", d.known === false, JSON.stringify(d));
  check("a definite move with a named destination still yields no date",
    relocationDate({ ...NOW, relocationIsDefinite: true }).known === false, "");
  check("and no header carries a month, quarter or year",
    !/\b(20\d\d|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|q[1-4]|spring|summer|fall|winter)\b/i
      .test(headerLocation(NOW, CHICAGO_ONSITE)), headerLocation(NOW, CHICAGO_ONSITE));
}

// 5. Assistance stays "not required", and means only that.
{
  const a = requiresRelocationAssistance(false);
  check("relocation assistance is answered No", a.known && (a as any).answer === "No", JSON.stringify(a));
  check("and No is not recorded as refusing assistance if offered",
    a.known && /says nothing about whether it would be accepted/i.test((a as any).because), JSON.stringify(a));
  check("an unrecorded assistance fact blocks rather than defaulting to No",
    requiresRelocationAssistance(null).known === false, "");
  check("no header implies employer-paid assistance",
    !/assistance|package|paid|reimburs/i.test(headerLocation(NOW, CHICAGO_ONSITE)), "");
}

// 6. The destination does not answer a residence question.
check("the destination answer is Chicago and the residence answer is Cleveland, and they are separate calls",
  (relocationDestination(NOW) as any).answer === "Chicago, IL"
  && (currentResidence(NOW) as any).answer === "Cleveland, OH", "");
check("a residence question and a destination question match different intents",
  matchIntent("Current location").intent?.key === "current_location_text"
  && matchIntent("Where are you relocating to?").intent?.key === "relocation_destination",
  `${matchIntent("Current location").intent?.key} / ${matchIntent("Where are you relocating to?").intent?.key}`);

// 7. The residence does not answer where he wants to work.
check("a desired-work-location question is its own intent",
  matchIntent("Desired work location").intent?.key === "desired_work_location",
  String(matchIntent("Desired work location").intent?.key));
check("willingness, destination, date and assistance are four separate intents",
  new Set(["Are you willing to relocate?", "Where are you relocating to?",
           "When are you relocating?", "Do you require relocation assistance?"]
    .map((q) => matchIntent(q).intent?.key)).size === 4,
  JSON.stringify(["Are you willing to relocate?", "Where are you relocating to?",
    "When are you relocating?", "Do you require relocation assistance?"].map((q) => matchIntent(q).intent?.key)));

// 8. A remote posting gains nothing, so it says nothing.
check("a fully remote posting gets the residence alone",
  headerLocation(NOW, REMOTE) === "Cleveland, OH", headerLocation(NOW, REMOTE));
check("a posting in an unrelated market gets the residence alone",
  headerLocation(NOW, ELSEWHERE) === "Cleveland, OH", headerLocation(NOW, ELSEWHERE));
check("only a destination-market posting triggers the line",
  postingIsAtDestination(NOW, CHICAGO_ONSITE) && !postingIsAtDestination(NOW, ELSEWHERE)
  && !postingIsAtDestination(NOW, REMOTE), "");
check("same state is not the same market",
  !postingIsAtDestination(NOW, { city: "Springfield", state: "IL", metro: "Springfield", isRemote: false }), "");

// 9. After the move, the same logic produces the new truth, and nothing
//    reaches back into what was already rendered.
{
  const AFTER = { city: "Chicago", state: "IL", destinationCity: null, destinationState: null,
                  destinationMetro: null, relocationIsDefinite: null, relocationDate: null };
  check("once he lives in Chicago the header is simply Chicago, IL",
    headerLocation(AFTER, CHICAGO_ONSITE) === "Chicago, IL", headerLocation(AFTER, CHICAGO_ONSITE));
  check("and it no longer mentions relocating",
    !/relocat/i.test(headerLocation(AFTER, CHICAGO_ONSITE)), "");
  // The header is computed from facts handed in at preparation time, so
  // an artifact rendered earlier cannot change when the facts do.
  const before = headerLocation(NOW, CHICAGO_ONSITE);
  check("changing the residence fact does not alter a header already produced",
    before === "Cleveland, OH · Relocating to Chicago, IL", before);
}

console.log(`${pass + fails.length} cases, ${pass} passed`);
for (const f of fails) console.log(f);
if (fails.length) { console.log(`\n${fails.length} FAILED`); process.exit(1); }
console.log("all passed");
