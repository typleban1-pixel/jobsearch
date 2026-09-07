import { NextResponse } from "next/server";
import { currentSession } from "../../../lib/portal/session.ts";

export const dynamic = "force-dynamic";

/**
 * Where a request's time goes, measured from inside the deployed function.
 *
 * Browser-side timing sees one number: time to first byte. This separates
 * the parts that happen on the server -- the Auth round trip getUser()
 * makes, local JWT verification (getClaims), and one PostgREST head
 * request -- so the platform floor can be told apart from the data path.
 * Owner-only, reads nothing but timings.
 */
export async function GET() {
  const t0 = performance.now();
  const session = await currentSession();
  const sessionMs = Math.round(performance.now() - t0);
  if (!session) return NextResponse.json({ error: "not signed in" }, { status: 401 });

  const timed = async <T>(fn: () => PromiseLike<T>): Promise<number> => {
    const t = performance.now(); await fn(); return Math.round(performance.now() - t);
  };
  const db = session.client;
  const [getUser, getClaims, head, headAgain] = [
    await timed(() => db.auth.getUser()),
    await timed(() => db.auth.getClaims()),
    await timed(() => db.from("job_card_summary").select("job_id", { count: "exact", head: true })),
    await timed(() => db.from("job_interest").select("canonical_opening_id", { count: "exact", head: true })),
  ];
  const parallelHeads = await timed(() => Promise.all([
    db.from("job_card_summary").select("job_id", { count: "exact", head: true }),
    db.from("job_interest").select("canonical_opening_id", { count: "exact", head: true }),
    db.from("applications").select("id", { count: "exact", head: true }),
  ]));
  return NextResponse.json({
    region: process.env["VERCEL_REGION"] ?? null,
    ms: { currentSession: sessionMs, getUser, getClaims, postgrestHead: head, postgrestHeadAgain: headAgain, threeHeadsParallel: parallelHeads },
  });
}
