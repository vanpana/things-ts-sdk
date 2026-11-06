// Generic sync loop: bring a State up to the server's head. Storage-agnostic: persisting the state (SQLite, a Durable
// Object, a file) is the caller's job; nothing here assumes where state lives.
import { ThingsHttpError } from "./errors.ts";
import { ThingsError } from "./errors.ts";
import type { History } from "./history.ts";
import { fold } from "./state.ts";
import type { ApplyMode, State } from "./state.ts";

export interface SyncOptions {
  /** Attempts per request on a transient server error (HTTP 500-504). Default 3. */
  maxRetries?: number;
  /** First retry delay in ms, doubled each attempt. Default 2000. */
  retryBaseMs?: number;
  mode?: ApplyMode;
  /** Replaceable for tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface SyncResult {
  /** Commits applied in this call. */
  commits: number;
  /** The server head the state was synced to. */
  head: number;
}

const isTransient = (e: unknown): boolean => e instanceof ThingsHttpError && e.status >= 500 && e.status <= 504;

async function withRetry<T>(fn: () => Promise<T>, o: Required<Pick<SyncOptions, "maxRetries" | "retryBaseMs" | "sleep">>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (!isTransient(e) || attempt + 1 >= o.maxRetries) throw e;
      await o.sleep(o.retryBaseMs * 2 ** attempt);
    }
  }
}

/**
 * Applies every commit after `state.cursor`. Each page is applied atomically and the cursor only moves after a page
 * was applied, so an error leaves `state` at the last good page and the call can simply be repeated.
 */
export async function syncState(history: History, state: State, options: SyncOptions = {}): Promise<SyncResult> {
  const retry = { maxRetries: options.maxRetries ?? 3, retryBaseMs: options.retryBaseMs ?? 2000, sleep: options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms))) };
  const applyOpts = options.mode ? { mode: options.mode } : {};
  // The server answers 500 for a start-index above its head, so ask for the head first.
  const fresh = await withRetry(() => history.client.history(history.id), retry);
  const head = fresh.latestServerIndex;
  history.latestServerIndex = head;
  history.latestSchemaVersion = fresh.latestSchemaVersion; // writes are only allowed on the verified schema
  history.latestTotalContentSize = fresh.latestTotalContentSize;
  if (state.cursor > head) throw new ThingsError(`state is ahead of the server (cursor ${state.cursor}, head ${head}): rebuild it from index 0`);
  let commits = 0;
  while (state.cursor < head) {
    const start = state.cursor;
    const page = await withRetry(() => history.items(start), retry);
    if (history.loadedServerIndex <= start || history.latestServerIndex < history.loadedServerIndex || history.latestServerIndex < head) {
      throw new ThingsError(`invalid sync progress: start ${start}, loaded ${history.loadedServerIndex}, latest ${history.latestServerIndex}, target ${head}`);
    }
    fold(state, page.commits, applyOpts);
    commits += page.commits.length;
  }
  return { commits, head: state.cursor };
}
