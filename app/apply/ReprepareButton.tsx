"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * "Continue on Ashby" that actually continues it.
 *
 * The old button was a plain link to the employer's posting: it opened
 * the page and nothing else happened. This posts to the re-prepare route,
 * which clears the park so the always-on worker claims the DRAFT, opens
 * the live form in a browser, snapshots it, and prepares the application
 * exactly as it does any other -- answering from verified background,
 * surfacing what is left, and NEVER submitting. On success it soft-refreshes
 * the board; the card moves itself to "Preparing" and the board's own poll
 * carries it to review when preparation finishes.
 *
 * The employer's form stays one click away as a secondary escape hatch, so
 * the manual path is never taken away.
 */
export function ReprepareButton(
  { applicationId, title, label, secondary }:
  { applicationId: string; title: string; label: string; secondary?: { label: string; href: string } | null },
) {
  const router = useRouter();
  const [state, setState] = useState<"idle" | "starting" | "started" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);

  const go = async () => {
    setState("starting");
    setMessage(null);
    try {
      const res = await fetch("/api/applications/reprepare", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ applicationId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setState("error");
        setMessage(body?.error ?? "could not start preparation");
        return;
      }
      // Persistent, page-level feedback that survives the board's soft
      // refresh and the card moving to the Preparing section, so clicking
      // never reads as the card vanishing with nothing happening.
      try {
        sessionStorage.setItem(`reprepare:${applicationId}`, JSON.stringify({ title, at: Date.now() }));
        window.dispatchEvent(new Event("reprepare-started"));
      } catch { /* sessionStorage unavailable: the button state below still shows progress */ }
      setState("started");
      router.refresh();
    } catch (e) {
      setState("error");
      setMessage(String((e as Error)?.message ?? e));
    }
  };

  return (
    <div className="reprepare">
      <button
        type="button"
        className="btn-primary"
        onClick={go}
        disabled={state === "starting" || state === "started"}
      >
        {state === "starting" ? "Starting…" : state === "started" ? "Preparing…" : label}
      </button>
      {secondary && (
        <a className="btn-quiet" href={secondary.href} target="_blank" rel="noreferrer">{secondary.label}</a>
      )}
      {state === "error" && message && <p className="reprepare-error" role="alert">{message}</p>}
    </div>
  );
}
