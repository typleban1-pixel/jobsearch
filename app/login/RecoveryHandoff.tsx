"use client";

import { useEffect, useState } from "react";

/**
 * Hands a recovery link's tokens from the URL fragment to the server.
 *
 * Supabase's dashboard-initiated password reset redirects to the project's
 * Site URL with the session in a URL FRAGMENT:
 *
 *   http://localhost:3000/#access_token=...&refresh_token=...&type=recovery
 *
 * A fragment is never sent to the server. That is why the reset landed on
 * the portal and bounced straight back to /login: the tokens were sitting
 * in the address bar and no server-rendered page could see them. The
 * browser preserves the fragment across the redirect, so it arrives here.
 *
 * This component does not talk to Supabase. It reads the fragment, POSTs
 * it same-origin, and lets the server establish the session in httpOnly
 * cookies, which keeps the architecture intact. It then clears the
 * fragment so the tokens do not linger in history.
 */
export function RecoveryHandoff() {
  const [state, setState] = useState<"idle" | "working" | "failed">("idle");

  useEffect(() => {
    const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "";
    if (!hash) return;
    const params = new URLSearchParams(hash);

    const error = params.get("error_description") ?? params.get("error");
    if (error) {
      history.replaceState(null, "", window.location.pathname + "?error=" + encodeURIComponent(error));
      window.location.reload();
      return;
    }

    const accessToken = params.get("access_token");
    const refreshToken = params.get("refresh_token");
    if (!accessToken || !refreshToken) return;

    setState("working");
    // Remove the tokens from the address bar before the network call, so
    // a slow response cannot leave them on screen.
    history.replaceState(null, "", window.location.pathname + window.location.search);

    const body = new URLSearchParams({
      access_token: accessToken,
      refresh_token: refreshToken,
      type: params.get("type") ?? "",
    });
    fetch("/auth/set-session", { method: "POST", body, headers: { "content-type": "application/x-www-form-urlencoded" } })
      .then((r) => {
        if (!r.ok) throw new Error("session handoff failed");
        window.location.replace(params.get("type") === "recovery" ? "/update-password" : "/");
      })
      .catch(() => setState("failed"));
  }, []);

  if (state === "idle") return null;
  if (state === "failed") {
    return <div className="banner" style={{ borderLeftColor: "var(--bad)", background: "var(--bad-soft)" }}>
      That recovery link could not be used. It may have expired. Request a new one below.
    </div>;
  }
  return <div className="banner">Signing you in from your recovery link…</div>;
}
