import { optional } from "../env.ts";
import { FileStore } from "./fileStore.ts";
import { SupabaseStore } from "./supabaseStore.ts";
import type { Store } from "./store.ts";

/**
 * Picks a store from the environment.
 *
 * Supabase when credentials are present, the file-backed double
 * otherwise. The selection is announced by every script that uses it, so
 * a run can never be mistaken for having written to the real database
 * when it did not.
 */
export function getStore(): Store {
  if (optional("SUPABASE_URL") && optional("SUPABASE_SERVICE_ROLE_KEY")) {
    return new SupabaseStore();
  }
  return new FileStore();
}

export { FileStore, SupabaseStore };
export type { Store };
