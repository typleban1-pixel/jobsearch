"use client";
import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * Keeps /apply current while something is actively being prepared, so a
 * card moves to the right section on its own instead of the reader having
 * to refresh. It calls Next's soft refresh (re-runs the server component,
 * re-reads the board) on an interval, and ONLY while `active` -- when
 * nothing is in flight the interval is torn down, so a settled board makes
 * no requests. It renders nothing and changes no state; it is a poll.
 */
export function AutoRefreshApply({ active, intervalMs = 5000 }: { active: boolean; intervalMs?: number }) {
  const router = useRouter();
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => router.refresh(), intervalMs);
    return () => clearInterval(t);
  }, [active, intervalMs, router]);
  return null;
}
