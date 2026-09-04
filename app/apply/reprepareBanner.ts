/**
 * Pure logic for the "Preparing on Ashby" banner, split out so it is
 * testable without the React/DOM component. See ReprepareBanner.tsx.
 */
export interface BannerEntry { id: string; title: string; at: number }

/** Split stored entries into those still worth showing and those past their window. */
export function partitionEntries(entries: BannerEntry[], now: number, ttl = 90_000): { live: BannerEntry[]; expired: BannerEntry[] } {
  const live: BannerEntry[] = [];
  const expired: BannerEntry[] = [];
  for (const e of entries) (now - e.at < ttl ? live : expired).push(e);
  return { live, expired };
}
