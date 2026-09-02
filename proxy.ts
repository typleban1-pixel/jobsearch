import { NextResponse, type NextRequest } from "next/server";
import { createServerClient } from "@supabase/ssr";

/**
 * The gate, and the only place the session is refreshed.
 *
 * Proxy runs before any route renders, so it is where an expired access
 * token gets exchanged and where an unauthenticated request is turned
 * away. Server components cannot write cookies during render, so a
 * refresh that happened there would be discarded.
 *
 * This is a gate, not the authorization boundary. It decides whether a
 * request reaches a page at all; RLS decides what that page can read. A
 * bug here shows someone an empty portal, not someone else's data.
 *
 * Deliberately self-contained: proxy may be deployed to the edge
 * separately from the render code, so it imports no shared module that
 * could drag server-only configuration with it.
 */
// Paths reachable without a session. The recovery routes are here
// because their whole job is to CREATE a session from an email link, and
// /update-password is deliberately NOT here: it needs the recovery
// session, so the ordinary gate is exactly right for it.
const PUBLIC_PATHS = [
  "/login", "/auth/sign-in", "/auth/sign-out",
  "/forgot-password", "/auth/forgot-password",
  "/auth/confirm", "/auth/set-session",
];

/**
 * Paths that are public in full, matched exactly.
 *
 * The root is the public site and must be reachable by anyone. It is
 * kept apart from PUBLIC_PATHS because those are matched with
 * startsWith, and startsWith("/") is every path on the site: putting the
 * root in that list would have unlocked the entire portal.
 */
const PUBLIC_EXACT = new Set(["/", "/index.html"]);

export async function proxy(request: NextRequest) {
  const response = NextResponse.next({ request });
  const url = request.nextUrl.pathname;

  const key = process.env["SUPABASE_PUBLISHABLE_KEY"]
    ?? process.env["NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"]
    ?? process.env["SUPABASE_ANON_KEY"];
  const supabaseUrl = process.env["SUPABASE_URL"] ?? process.env["NEXT_PUBLIC_SUPABASE_URL"];
  if (!key || !supabaseUrl) {
    // Fail closed. A misconfigured deployment must not serve the portal.
    if (PUBLIC_EXACT.has(url) || PUBLIC_PATHS.some((p) => url.startsWith(p))) return response;
    return new NextResponse("Supabase is not configured on this deployment.", { status: 503 });
  }

  const client = createServerClient(supabaseUrl, key, {
    cookieOptions: {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env["NODE_ENV"] === "production",
      path: "/",
    },
    cookies: {
      getAll: () => request.cookies.getAll().map((c) => ({ name: c.name, value: c.value })),
      setAll: (cookies, headers) => {
        for (const { name, value, options } of cookies) response.cookies.set(name, value, options);
        // Supabase supplies no-store headers with refreshed auth cookies.
        // A CDN caching this response would hand one session to another
        // visitor, so they are passed through rather than dropped.
        for (const [k, v] of Object.entries(headers ?? {})) response.headers.set(k, v);
      },
    },
  });

  const { data } = await client.auth.getUser();

  if (!data.user && !PUBLIC_EXACT.has(url) && !PUBLIC_PATHS.some((p) => url.startsWith(p))) {
    const redirect = new URL("/login", request.url);
    if (url !== "/") redirect.searchParams.set("next", url + request.nextUrl.search);
    return NextResponse.redirect(redirect);
  }
  if (data.user && url === "/login") {
    return NextResponse.redirect(new URL("/jobs", request.url));
  }
  return response;
}

export const config = {
  // Everything except Next's own assets. The API route is included on
  // purpose: a mutation must be gated as firmly as a page.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
