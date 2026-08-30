import { greenhouse } from "./greenhouse.ts";
import { lever } from "./lever.ts";
import type { AtsProvider, AtsProviderName } from "./types.ts";

const PROVIDERS: Record<AtsProviderName, AtsProvider> = {
  GREENHOUSE: greenhouse,
  LEVER: lever,
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
      `No provider for "${name}". Phase 2 covers Greenhouse and Lever only; Workday and browser automation are explicitly out of scope.`,
    );
  }
  return p;
}

export { greenhouse, lever, PROVIDERS };
export type { AtsProvider, AtsProviderName };
