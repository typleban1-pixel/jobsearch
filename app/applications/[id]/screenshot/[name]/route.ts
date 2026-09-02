import { readFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { userClient } from "../../../../../lib/portal/supabase.ts";

/**
 * Serves one fill screenshot, from disk, to the signed-in owner.
 *
 * These images show a filled application form, which means a home
 * address and a phone number, so they stay on this machine. Nothing is
 * uploaded anywhere.
 *
 * The name in the URL is never trusted as a path. It is reduced to a
 * basename, checked against a fixed filename shape, and then joined onto
 * a directory that came from the database row for THIS application, and
 * the result must still resolve inside the run directory. A caller
 * cannot reach a file that no fill run of theirs produced, and the raw
 * filesystem path is never returned to the browser.
 */
const NAME = /^[0-9a-z][0-9a-z-]{0,60}\.png$/i;

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ id: string; name: string }> },
): Promise<Response> {
  const { id, name } = await ctx.params;

  const store = await cookies();
  const db = userClient({
    getAll: () => store.getAll().map((c) => ({ name: c.name, value: c.value })),
    set: (n, v, o) => store.set(n, v, o as any),
  });
  const { data: auth } = await db.auth.getUser();
  if (!auth.user) return new NextResponse("not signed in", { status: 401 });

  const safeName = basename(name);
  if (!NAME.test(safeName)) return new NextResponse("not found", { status: 404 });

  // The directory comes from the run row, so it is only ever a directory
  // this application actually wrote to. RLS decides whether the row is
  // visible at all.
  const { data: runs } = await db.from("application_fill_runs")
    .select("screenshot_dir").eq("application_id", id);
  const dirs = (runs ?? []).map((r) => r.screenshot_dir).filter(Boolean) as string[];
  if (!dirs.length) return new NextResponse("not found", { status: 404 });

  const root = resolve(process.cwd(), ".fill-runs");
  for (const dir of dirs) {
    const candidate = resolve(join(process.cwd(), dir, safeName));
    // Belt and braces: even with a database-sourced directory, the final
    // path has to sit inside the run root.
    if (candidate !== root && !candidate.startsWith(root + sep)) continue;
    try {
      const bytes = await readFile(candidate);
      return new NextResponse(new Uint8Array(bytes), {
        status: 200,
        headers: {
          "content-type": "image/png",
          "cache-control": "private, no-store",
          "content-disposition": `inline; filename="${safeName}"`,
        },
      });
    } catch { /* try the next run directory */ }
  }
  return new NextResponse("not found", { status: 404 });
}
