/**
 * The Jobs page ranks by the calibrated Match Score. A materially higher
 * Match Score must always rank above a lower one; confidence only breaks
 * ties among equal scores; the evidence-first Formula 3 ordering and Fit
 * break ties beneath that; and a stable id tie-break keeps the order from
 * jumping between loads. matchLabel derives the fit words from the score
 * and never labels a provisional score with a confident band.
 */
import { sortCards } from "../lib/portal/present.ts";
import { matchLabel } from "../lib/portal/matchScore.ts";

let bad = 0;
const ok = (c: boolean, w: string, x = "") => { console.log(`  ${c ? "PASS" : "FAIL"}  ${w}${x ? " -- " + x : ""}`); if (!c) bad++; };

const att = (band: "ASSESSABLE" | "GENERIC_REQUIREMENTS", score: number) => ({ band, score } as any);
const card = (id: string, score: number, provisional: boolean, attBand: any, attScore: number, fit: number) =>
  ({ id, match: { score, provisional }, attention: att(attBand, attScore), fit } as any);
const order = (cards: any[]) => sortCards(cards, "match").map((c) => c.id);

// ---- 1. materially higher score outranks lower, whatever the old ranking says
{
  // Chartis-like: lower score, HIGH attention. Aleph-like: higher score, LOW attention.
  const chartis = card("chartis", 54, false, "ASSESSABLE", 999, 100);
  const aleph = card("aleph", 71, false, "ASSESSABLE", 1, 0);
  ok(order([chartis, aleph]).join(",") === "aleph,chartis", "a 71 ranks above a 54 even with far higher attention (Aleph > Chartis)");
}

// ---- 2. confidence is secondary: only breaks EQUAL scores
{
  const conf = card("conf", 60, false, "ASSESSABLE", 5, 0);
  const prov = card("prov", 60, true, "ASSESSABLE", 999, 100);
  ok(order([prov, conf]).join(",") === "conf,prov", "equal scores: a confident score ranks above a provisional one");
  const higherProv = card("hp", 62, true, "ASSESSABLE", 0, 0);
  const lowerConf = card("lc", 60, false, "ASSESSABLE", 999, 100);
  ok(order([lowerConf, higherProv]).join(",") === "hp,lc", "a higher provisional score still ranks above a lower confident one (score is primary)");
}

// ---- 3. Formula 3 (attention) breaks ties only when score AND provisional match
{
  const hiAtt = card("hi", 50, false, "ASSESSABLE", 500, 0);
  const loAtt = card("lo", 50, false, "ASSESSABLE", 100, 0);
  ok(order([loAtt, hiAtt]).join(",") === "hi,lo", "equal score+confidence: higher attention (Formula 3) breaks the tie");
  const assess = card("as", 50, false, "ASSESSABLE", 1, 0);
  const generic = card("ge", 50, false, "GENERIC_REQUIREMENTS", 999, 0);
  ok(order([generic, assess]).join(",") === "as,ge", "assessable band still beats generic within a tie (compareAttention preserved)");
}

// ---- 4. stable deterministic id tie-break; no jumping between loads
{
  const a = card("aaa", 40, false, "ASSESSABLE", 10, 5);
  const b = card("bbb", 40, false, "ASSESSABLE", 10, 5);
  const c = card("ccc", 40, false, "ASSESSABLE", 10, 5);
  ok(order([c, a, b]).join(",") === "aaa,bbb,ccc", "fully tied cards fall back to a stable id order");
  ok(order([b, c, a]).join(",") === order([a, c, b]).join(","), "the order is identical regardless of input order (deterministic across loads)");
}

// ---- 5. a realistic mixed set is monotonically non-increasing by score
{
  const cards = [
    card("j1", 69, false, "ASSESSABLE", 3, 0), card("j2", 52, false, "ASSESSABLE", 900, 0),
    card("j3", 44, true, "ASSESSABLE", 5, 0), card("j4", 44, false, "ASSESSABLE", 5, 0),
    card("j5", 16, true, "ASSESSABLE", 800, 0), card("j6", 0, false, "GENERIC_REQUIREMENTS", 0, 0),
  ];
  const ranked = sortCards(cards, "match");
  let mono = true; for (let i = 1; i < ranked.length; i++) if (ranked[i]!.match.score > ranked[i - 1]!.match.score) mono = false;
  ok(mono, "ranked set is monotonically non-increasing by Match Score");
  ok(ranked[0]!.id === "j1" && ranked[1]!.id === "j2", "top two are the 69 then the 52");
  ok(ranked[2]!.id === "j4" && ranked[3]!.id === "j3", "equal 44s: the confident one precedes the provisional one");
}

// ---- 6. matchLabel: bands + provisional override + preserves nothing about the number
{
  ok(matchLabel(95, false) === "Exceptional match", "90-100 -> Exceptional");
  ok(matchLabel(84, false) === "Very strong match", "80-89 -> Very strong");
  ok(matchLabel(72, false) === "Strong match", "70-79 -> Strong");
  ok(matchLabel(65, false) === "Good match", "60-69 -> Good (Aleph 69 reads 'Good', not 'Strong')");
  ok(matchLabel(54, false) === "Worth considering", "50-59 -> Worth considering");
  ok(matchLabel(30, false) === "Weak match", "<50 -> Weak match");
  ok(matchLabel(16, true) === "Needs more evaluation", "a provisional ~16 is 'Needs more evaluation', never 'Strong match' (the UChicago contradiction)");
  ok(matchLabel(88, true) === "Needs more evaluation", "provisional overrides even a high band -- confidence gates the label");
}

console.log(bad ? `\n${bad} FAILED` : `\nmatch-ranking-selftest: ALL PASS`);
process.exit(bad ? 1 : 0);
