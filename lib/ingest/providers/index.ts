import { greenhouse } from "./greenhouse.ts";
import { lever } from "./lever.ts";
import { ashby } from "./ashby.ts";
import { workday } from "./workday.ts";
import { smartrecruiters } from "./smartrecruiters.ts";
import type { AtsProvider, AtsProviderName } from "./types.ts";

const PROVIDERS: Record<AtsProviderName, AtsProvider> = {
  ASHBY: ashby,
  GREENHOUSE: greenhouse,
  LEVER: lever,
  WORKDAY: workday,
  SMARTRECRUITERS: smartrecruiters,
};

/**
 * Overrides a provider implementation. Exists so the verification
 * harness can drive the real orchestrator with controlled payloads: the
 * scenarios that matter most (a job disappearing, a board erroring, a
 * salary appearing) cannot be triggered on demand against a live board.
 */
export function registerProvider(name: AtsProviderName, provider: AtsProvider): void {
  PROVIDERS[name] = provider;
}

export function getProvider(name: string): AtsProvider {
  const p = PROVIDERS[name as AtsProviderName];
  if (!p) {
    throw new Error(
      `No provider for "${name}". Ingest covers Greenhouse, Lever, Ashby, Workday and SmartRecruiters.`,
    );
  }
  return p;
}

export { greenhouse, lever, ashby, workday, smartrecruiters, PROVIDERS };
export type { AtsProvider, AtsProviderName };
