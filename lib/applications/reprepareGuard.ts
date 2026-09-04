/**
 * Whether a parked application may be handed back to the worker to prepare.
 *
 * Pure, so the route and its self-test agree on exactly one rule. Only a
 * genuinely parked live-form DRAFT of a provider the worker can open in a
 * browser is re-preparable: a submitted row, a row already moving
 * (PREPARING, or a held claim), a row that is not parked, and a provider
 * with no browser path are all refused. Clearing the park is the entire
 * re-enqueue; nothing here submits or changes status.
 */
export const LIVE_PROVIDERS = new Set(["ASHBY", "LEVER"]);

export interface RepreparableApp {
  status: string;
  blocked_reason: string | null;
  prepare_started_at: string | null;
  submitted_at: string | null;
}

export type GuardResult = { ok: true } | { ok: false; status: number; error: string };

export function reprepareGuard(app: RepreparableApp, source: string | null): GuardResult {
  if (app.submitted_at) return { ok: false, status: 409, error: "already submitted" };
  if (app.status !== "DRAFT") return { ok: false, status: 409, error: `not a draft (status ${app.status})` };
  if (app.prepare_started_at) return { ok: false, status: 409, error: "already being prepared" };
  if (!app.blocked_reason) return { ok: false, status: 409, error: "not parked; nothing to re-prepare" };
  if (!source || !LIVE_PROVIDERS.has(source)) {
    return { ok: false, status: 409, error: `no live snapshot path for ${source ?? "this provider"}` };
  }
  return { ok: true };
}
