/**
 * The live-form snapshot for providers that publish no form.
 *
 * Injected into prepareApplication so that module stays free of Playwright.
 * Dispatched by source: Lever and Ashby forms exist only as rendered HTML,
 * so preparation opens a browser and snapshots what actually renders; every
 * other provider either publishes its form (Greenhouse) or has no browser
 * path yet, and refuses here rather than guessing. Loaded lazily so the pure
 * helpers around it can be imported without pulling in a browser.
 *
 * One definition, used by the prepare listener AND by prepare-application
 * (which the worker runs). They used to differ: the script knew only Lever,
 * so every Ashby job the worker selected ended "no live snapshot path for
 * ASHBY" while the listener prepared the same job without complaint.
 */
export async function liveSnapshot(
  job: { source: string; applyUrl: string | null; reviewedOffice: string | null },
): Promise<{ ok: boolean; reason?: string; snapshot?: unknown; hash?: string }> {
  if (!job.applyUrl) return { ok: false, reason: `no apply URL is recorded for this ${job.source} job` };
  if (job.source === "LEVER") {
    const { snapshotLeverLive } = await import("./leverPrepare.ts");
    return snapshotLeverLive({ applyUrl: job.applyUrl, reviewedOffice: job.reviewedOffice });
  }
  if (job.source === "ASHBY") {
    const { snapshotAshbyLive } = await import("./ashbyPrepare.ts");
    return snapshotAshbyLive({ applyUrl: job.applyUrl, reviewedOffice: job.reviewedOffice });
  }
  return { ok: false, reason: `no live snapshot path for ${job.source}` };
}
