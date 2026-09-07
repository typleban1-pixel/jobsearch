/**
 * The numbers on the navigation: how many applications need the person,
 * and how many are batched for the next run.
 *
 * Not totals. Twenty applications with three waiting on a person is "3".
 * They are the same numbers the Applications and Batched pages put over
 * their lists, computed by the same loader, so a badge and its page can
 * never disagree. A page that already holds the board passes its counts
 * in; every other page streams them after rendering. One board load per
 * request: React's cache() dedupes the two badges.
 */
import { cache } from "react";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadApplyBoard } from "./applyBoard.ts";

export interface NavCounts { needsYou: number; batched: number }

export const loadNavCounts = cache(async (db: SupabaseClient): Promise<NavCounts> => {
  const board = await loadApplyBoard(db);
  return { needsYou: board.needsYou.length, batched: board.ready.length };
});

export async function loadAttentionCount(db: SupabaseClient): Promise<number> {
  return (await loadNavCounts(db)).needsYou;
}
