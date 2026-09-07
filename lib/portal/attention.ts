/**
 * How many applications need the person right now: the number on the
 * Applications navigation item.
 *
 * Not the total. Twenty applications with three waiting on a person is
 * "3". It is the same number the Applications page puts over its first
 * section, computed by the same loader, so the badge and the page can
 * never disagree about what "needs you" means. The page itself passes its
 * count in; every other page streams this after rendering.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadApplyBoard } from "./applyBoard.ts";

export async function loadAttentionCount(db: SupabaseClient): Promise<number> {
  const board = await loadApplyBoard(db);
  return board.needsYou.length;
}
