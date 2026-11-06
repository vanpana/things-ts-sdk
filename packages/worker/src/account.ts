// One Durable Object per Things account (SQLite-backed, so it runs on the Workers Free plan).
//  - keeps the folded state warm in memory and persisted per entity (see store.ts), so a restart only syncs the delta
//  - serialises everything: reads and writes go through one queue, so no two syncs or commits ever overlap
//  - every write is: sync to head -> SDK-validated commit against that head -> sync again -> verify the read-back
//  - a persisted kill switch (`readOnly`) turns writes off; reads keep working
//  - one alarm drives the nightly drift check and the weekly canary, and re-arms itself
// Authentication is not here: a layer in front decides who may call the tools.

import {
  checkDrift, CommitOutcomeUnknownError, emptyState, MalformedItemError, NoteError, preflightFromState, syncState, ThingsClient,
  ThingsError, ThingsHttpError, UnknownKindError, UnsupportedTaskKindError, WriteRefusedError,
} from "../../sdk/src/index.ts";
import type { Commit, Entity, History, State, SyncResult, WriteItem } from "../../sdk/src/index.ts";
import { runCanary } from "./canary.ts";
import type { DurableObjectNamespace, DurableObjectState } from "./cf.ts";
import { snapshotRefs, Store } from "./store.ts";
import { callTool, ToolError } from "./tools.ts";
import type { ToolContext } from "./tools.ts";

export interface Env {
  ACCOUNT: DurableObjectNamespace;
  THINGS_EMAIL: string;
  THINGS_PASSWORD: string;
  /** Tests only: point at a fake server. Needs THINGS_ALLOW_INSECURE=1 for plain http. */
  THINGS_ENDPOINT?: string;
  THINGS_ALLOW_INSECURE?: string;
  /** IANA zone that defines "today" (default UTC). */
  THINGS_TIME_ZONE?: string;
  /** Shared secret the private layer presents; the Worker refuses everything without it. */
  INTERNAL_TOKEN?: string;
  /** Milliseconds a synced state counts as fresh for reads (default 10 s). */
  SYNC_STALE_MS?: string;
  /** "off" disables the weekly canary write. */
  CANARY?: string;
  /** "1" enables /__test/* routes. */
  TEST_ROUTES?: string;
}

export const DEFAULT_STALE_MS = 10_000;
export const DRIFT_INTERVAL_MS = 24 * 3600 * 1000;
export const CANARY_INTERVAL_MS = 7 * 24 * 3600 * 1000;

interface ReadOnly { reason: string; since: number }
interface CheckResult { at: number; ok: boolean; summary: string; findings?: { severity: string; code: string; message: string }[]; steps?: { step: string; ok: boolean }[]; inconclusive?: boolean }
interface SyncInfo { mode: "cold" | "incremental"; commits: number; ms: number; upserts: number }

const SYNC_OPTS = { retryBaseMs: 500 };
const errName = (e: unknown): string => (e instanceof Error ? e.name : "Error");
const isProtocolError = (e: unknown): boolean =>
  e instanceof UnknownKindError || e instanceof UnsupportedTaskKindError || e instanceof MalformedItemError || e instanceof NoteError;

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** Does the state show what we just wrote? Returns a description without any user content, or null. */
function readbackMismatch(state: State, items: readonly WriteItem[]): string | null {
  for (const item of items) {
    const bucket = item.kind === "Task7" ? "tasks" : item.kind === "Tag4" ? "tags" : item.kind === "Area3" ? "areas" : item.kind === "ChecklistItem3" ? "checklist" : null;
    if (!bucket) return `unexpected kind ${item.kind}`;
    const ent: Entity | undefined = state[bucket].get(item.uuid);
    if (item.action === 2) { if (ent) return `${item.kind} still present after delete`; continue; }
    if (!ent) return `${item.kind} missing after write`;
    for (const [k, v] of Object.entries(item.payload)) {
      if (k === "md" || k === "xx") continue;
      if (k === "nt") { if (ent.note !== (v as { v: string }).v) return "note differs"; continue; }
      if (!same(ent.fields[k], v)) return `field ${k} differs`;
    }
  }
  return null;
}

export class ThingsAccount {
  readonly #ctx: DurableObjectState;
  readonly #env: Env;
  readonly #store: Store;
  #state: State | null = null;
  #loadedFromStorage = false;
  #loadMs = 0;
  #client: ThingsClient | null = null;
  #history: History | null = null;
  #queue: Promise<unknown> = Promise.resolve();
  #lastSyncAt = 0;
  #lastSync: SyncInfo | null = null;
  #lastSyncError: string | null = null;
  #alarmChecked = false;

  constructor(ctx: DurableObjectState, env: Env) {
    this.#ctx = ctx;
    this.#env = env;
    this.#store = new Store(ctx.storage);
    void ctx.blockConcurrencyWhile(async () => {
      const t0 = Date.now();
      this.#store.init();
      this.#state = this.#store.load();
      this.#loadedFromStorage = this.#state !== null;
      this.#loadMs = Date.now() - t0;
    });
  }

  // ---- plumbing ----------------------------------------------------------------------------------------------------

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#queue.then(() => fn());
    this.#queue = run.catch(() => undefined);
    return run;
  }

  #getClient(): ThingsClient {
    if (!this.#client) {
      const e = this.#env;
      if (!e.THINGS_EMAIL || !e.THINGS_PASSWORD) throw new ToolError(503, "credentials are not configured");
      const opts = e.THINGS_ENDPOINT ? { endpoint: e.THINGS_ENDPOINT, ...(e.THINGS_ALLOW_INSECURE === "1" ? { allowInsecure: true } : {}) } : {};
      this.#client = new ThingsClient(e.THINGS_EMAIL, e.THINGS_PASSWORD, opts);
    }
    return this.#client;
  }
  async #getHistory(): Promise<History> { return (this.#history ??= await this.#getClient().ownHistory()); }

  get #readOnly(): ReadOnly | null { return this.#store.getJson<ReadOnly>("readOnly") ?? null; }
  #setReadOnly(reason: string): void {
    if (this.#readOnly) return; // keep the first cause
    this.#store.setJson("readOnly", { reason, since: Date.now() } satisfies ReadOnly);
    this.#store.journal("system", [], "set-read-only", reason.slice(0, 120));
  }
  clearReadOnly(by: string): boolean {
    const had = this.#readOnly !== null;
    this.#store.deleteMeta("readOnly");
    this.#store.journal("admin", [], "cleared-read-only", by.slice(0, 60));
    return had;
  }

  // ---- sync --------------------------------------------------------------------------------------------------------

  /**
   * Brings the state to the server head and persists what changed. With `required` a failure throws; otherwise, if there
   * is a previous state, it is served and the failure is recorded (returns false). A protocol error (new kind, malformed
   * payload) additionally switches writes off.
   */
  async #sync(required: boolean): Promise<boolean> {
    const t0 = Date.now();
    let state = this.#state ?? emptyState();
    let startCursor = state.cursor;
    let before = snapshotRefs(state);
    let failure: unknown;
    let result: SyncResult | undefined;
    try {
      const history = await this.#getHistory();
      try { result = await syncState(history, state, SYNC_OPTS); }
      catch (e) {
        if (!(e instanceof ThingsError) || !e.message.startsWith("state is ahead of the server")) throw e;
        // The server's log is shorter than ours (history replaced?): throw the cache away and rebuild from index 0.
        this.#store.wipeState();
        state = emptyState(); before = snapshotRefs(state); startCursor = 0;
        result = await syncState(history, state, SYNC_OPTS);
      }
    } catch (e) { failure = e; }

    let upserts = 0;
    if (state.cursor !== startCursor) {
      upserts = this.#store.persist(before, state).upserts; // keeps the progress of a partially successful sync too
      if (this.#history && this.#store.getMeta("schema") !== String(this.#history.latestSchemaVersion)) {
        this.#store.setMeta("schema", String(this.#history.latestSchemaVersion));
      }
    }
    this.#state = state;

    if (failure) {
      this.#lastSyncError = errName(failure);
      if (isProtocolError(failure)) this.#setReadOnly(`protocol: ${errName(failure)} while syncing`);
      if (required || state.cursor === 0) throw failure;
      return false;
    }
    this.#lastSyncError = null;
    this.#lastSyncAt = Date.now();
    this.#lastSync = { mode: startCursor === 0 ? "cold" : "incremental", commits: result?.commits ?? 0, ms: Date.now() - t0, upserts };
    return true;
  }

  async #read(): Promise<{ state: State; stale: boolean }> {
    return this.#serial(async () => {
      const staleMs = this.#env.SYNC_STALE_MS !== undefined ? Number(this.#env.SYNC_STALE_MS) : DEFAULT_STALE_MS;
      if (this.#state && this.#lastSyncAt > 0 && Date.now() - this.#lastSyncAt < staleMs) return { state: this.#state, stale: false };
      const ok = await this.#sync(false);
      return { state: this.#state!, stale: !ok };
    });
  }

  // ---- writes ------------------------------------------------------------------------------------------------------

  #write(tool: string, build: (state: State) => WriteItem[]): Promise<{ ids: string[] }> {
    return this.#serial(async () => {
      const ro = this.#readOnly;
      if (ro) { this.#store.journal(tool, [], "refused-read-only"); throw new ToolError(423, `writes are switched off: ${ro.reason}`); }
      await this.#sync(true);
      const state = this.#state!;
      const history = await this.#getHistory();

      let items: WriteItem[];
      try { items = build(state); }
      catch (e) { this.#store.journal(tool, [], "refused", errName(e)); throw e; }
      const ids = items.map((i) => i.uuid);

      try { await history.write(items, { preflight: (targets) => preflightFromState(state, targets) }); }
      catch (e) {
        if (e instanceof ThingsHttpError && e.status === 409) {
          this.#store.journal(tool, ids, "conflict");
          await this.#sync(false); // pick up what changed; the caller decides whether to try again
          throw new ToolError(409, "the account changed while writing; nothing was written, re-read and try again");
        }
        if (e instanceof CommitOutcomeUnknownError || (e instanceof ThingsHttpError && e.status >= 500)) {
          this.#store.journal(tool, ids, "unknown", errName(e));
          this.#setReadOnly(`commit outcome unknown (${errName(e)})`);
          await this.#sync(false);
          throw new ToolError(502, "the write may or may not have been applied; writes are switched off until a person checks");
        }
        this.#store.journal(tool, ids, e instanceof WriteRefusedError ? "refused" : "error", errName(e));
        throw e;
      }

      try { await this.#sync(true); }
      catch (e) {
        this.#store.journal(tool, ids, "readback-failed", errName(e));
        this.#setReadOnly("could not read back a write");
        throw new ToolError(502, "the write was sent but could not be read back; writes are switched off");
      }
      const mismatch = readbackMismatch(this.#state!, items);
      if (mismatch) {
        this.#store.journal(tool, ids, "readback-mismatch", mismatch);
        this.#setReadOnly(`read-back mismatch: ${mismatch}`);
        throw new ToolError(502, "the write did not read back as sent; writes are switched off");
      }
      this.#store.journal(tool, ids, "ok");
      return { ids };
    });
  }

  // ---- checks ------------------------------------------------------------------------------------------------------

  async #fetchLog(upTo: number): Promise<Commit[]> {
    const h = this.#getClient().historyWithId((await this.#getHistory()).id);
    const commits: Commit[] = [];
    while (commits.length < upTo) {
      const page = await h.items(commits.length);
      if (page.commits.length === 0) break;
      commits.push(...page.commits);
    }
    return commits.slice(0, upTo);
  }

  /** Re-reads the whole log and compares it with what we serve. Critical findings switch writes off. */
  runDrift(): Promise<CheckResult> {
    return this.#serial(async () => {
      let result: CheckResult;
      try {
        await this.#sync(true);
        const state = this.#state!;
        const history = await this.#getHistory();
        const commits = await this.#fetchLog(state.cursor);
        const report = checkDrift({ commits, state, schema: history.latestSchemaVersion, head: history.latestServerIndex });
        const findings = report.findings;
        if (report.rebuilt && findings.some((f) => f.code === "state-diverged")) {
          // Serve the rebuild from now on (writes are switched off below until a person looks).
          this.#store.persist(snapshotRefs(state), report.rebuilt);
          this.#state = report.rebuilt;
        }
        const critical = findings.filter((f) => f.severity === "critical");
        result = { at: Date.now(), ok: critical.length === 0, summary: critical.length ? critical.map((f) => f.code).join(", ") : `${findings.length} warning(s)`, findings };
        if (critical.length) this.#setReadOnly(`drift: ${critical.map((f) => f.code).join(", ")}`);
      } catch (e) {
        // Could not look (network, upstream down): not evidence of drift, so no kill switch.
        result = { at: Date.now(), ok: false, inconclusive: true, summary: `could not run: ${errName(e)}` };
      }
      this.#store.setJson("lastDrift", result);
      if (!result.inconclusive) this.#store.setMeta("lastDriftAt", String(result.at));
      return result;
    });
  }

  /** Runs the canary write sequence on a labelled throwaway task. A failed step switches writes off. */
  runCanaryCheck(): Promise<CheckResult> {
    return this.#serial(async () => {
      let result: CheckResult;
      if (this.#readOnly) result = { at: Date.now(), ok: false, inconclusive: true, summary: "skipped: writes are already switched off" };
      else {
        try {
          await this.#sync(true);
          const state = this.#state!;
          const history = await this.#getHistory();
          const client = this.#getClient();
          const before = snapshotRefs(state);
          const r = await runCanary({
            history, state, timeZone: this.#env.THINGS_TIME_ZONE ?? "UTC", retryBaseMs: 200,
            reconnect: async () => { const h = await client.ownHistory(); const s = emptyState(); await syncState(h, s, SYNC_OPTS); return { state: s }; },
          });
          this.#store.persist(before, state);
          const failed = r.steps.find((s) => !s.ok);
          result = { at: Date.now(), ok: r.ok, summary: failed ? `failed at: ${failed.step}` : "ok", steps: r.steps.map(({ step, ok }) => ({ step, ok })) };
          if (!r.ok) this.#setReadOnly(`canary failed at: ${failed?.step ?? "unknown step"}`);
        } catch (e) {
          result = { at: Date.now(), ok: false, inconclusive: true, summary: `could not run: ${errName(e)}` };
        }
      }
      this.#store.setJson("lastCanary", result);
      if (!result.inconclusive) this.#store.setMeta("lastCanaryAt", String(result.at));
      return result;
    });
  }

  #canaryEnabled(): boolean { return this.#env.CANARY !== "off"; }
  #lastRun(key: string, now: number): number {
    const v = this.#store.getMeta(key);
    if (v !== undefined) return Number(v);
    this.#store.setMeta(key, String(now)); // first use: the first run is due one interval from now
    return now;
  }
  #nextAlarm(now: number): number {
    const due = [this.#lastRun("lastDriftAt", now) + DRIFT_INTERVAL_MS];
    if (this.#canaryEnabled()) due.push(this.#lastRun("lastCanaryAt", now) + CANARY_INTERVAL_MS);
    return Math.max(Math.min(...due), now + 1000);
  }
  async #arm(): Promise<void> { await this.#ctx.storage.setAlarm(this.#nextAlarm(Date.now())); }
  async #ensureAlarm(): Promise<void> {
    if (this.#alarmChecked) return;
    this.#alarmChecked = true;
    if ((await this.#ctx.storage.getAlarm()) === null) await this.#arm();
  }

  /** Cloudflare calls this when the alarm fires. Runs whatever is due, then arms the next alarm. */
  async alarm(): Promise<void> {
    try {
      const now = Date.now();
      if (now >= this.#lastRun("lastDriftAt", now) + DRIFT_INTERVAL_MS) await this.runDrift();
      if (this.#canaryEnabled() && Date.now() >= this.#lastRun("lastCanaryAt", now) + CANARY_INTERVAL_MS) await this.runCanaryCheck();
    } finally {
      await this.#arm();
    }
  }

  // ---- status and HTTP surface -------------------------------------------------------------------------------------

  async #status(): Promise<unknown> {
    const s = this.#state;
    return {
      cursor: s?.cursor ?? 0,
      schema: Number(this.#store.getMeta("schema") ?? 0),
      counts: { tasks: s?.tasks.size ?? 0, checklist: s?.checklist.size ?? 0, tags: s?.tags.size ?? 0, areas: s?.areas.size ?? 0 },
      readOnly: this.#readOnly,
      lastSync: this.#lastSync,
      lastSyncAt: this.#lastSyncAt || null,
      lastSyncError: this.#lastSyncError,
      loadedFromStorage: this.#loadedFromStorage,
      loadMs: this.#loadMs,
      lastDrift: this.#store.getJson("lastDrift") ?? null,
      lastCanary: this.#store.getJson("lastCanary") ?? null,
      canaryEnabled: this.#canaryEnabled(),
      nextAlarmAt: await this.#ctx.storage.getAlarm(),
    };
  }

  #toolContext(): ToolContext {
    return {
      timeZone: this.#env.THINGS_TIME_ZONE ?? "UTC",
      read: () => this.#read(),
      write: (tool, build) => this.#write(tool, build),
      status: () => this.#status(),
    };
  }

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);
    try {
      let out: Response;
      if (req.method === "POST" && url.pathname === "/tool") {
        let body: { name?: unknown; args?: unknown };
        try { body = (await req.json()) as typeof body; } catch { throw new ToolError(400, "the body must be JSON"); }
        if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ToolError(400, "the body must be a JSON object");
        const extra = Object.keys(body).filter((k) => k !== "name" && k !== "args");
        if (extra.length > 0) throw new ToolError(400, 'the body takes only "name" and "args"'); // a misnamed key must not silently drop the arguments
        out = json(200, { ok: true, result: await callTool(body.name, body.args, this.#toolContext()) });
      } else if (req.method === "POST" && url.pathname === "/admin/clear-read-only") {
        const by = ((await req.json().catch(() => ({}))) as { by?: unknown }).by;
        out = json(200, { ok: true, wasReadOnly: this.clearReadOnly(typeof by === "string" ? by : "admin") });
      } else if (req.method === "POST" && url.pathname === "/admin/run-check") {
        const which = url.searchParams.get("which");
        if (which !== "drift" && which !== "canary") throw new ToolError(400, "which must be drift or canary");
        out = json(200, { ok: true, result: which === "drift" ? await this.runDrift() : await this.runCanaryCheck() });
      } else if (req.method === "POST" && url.pathname === "/admin/sync") {
        await this.#serial(() => this.#sync(true));
        out = json(200, { ok: true, result: this.#lastSync });
      } else if (req.method === "GET" && url.pathname === "/admin/journal") {
        const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50) || 50, 1), 500);
        out = json(200, { ok: true, result: this.#store.recentJournal(limit) });
      } else if (this.#env.TEST_ROUTES === "1" && req.method === "POST" && url.pathname === "/__test/alarm") {
        this.#store.setMeta("lastDriftAt", "0"); this.#store.setMeta("lastCanaryAt", "0");
        await this.alarm();
        out = json(200, { ok: true, result: await this.#status() });
      } else out = json(404, { ok: false, error: { name: "NotFound", message: "no such route" } });
      await this.#ensureAlarm();
      return out;
    } catch (e) {
      if (e instanceof ToolError) return json(e.status, { ok: false, error: { name: "ToolError", message: e.message } });
      if (e instanceof WriteRefusedError) return json(422, { ok: false, error: { name: e.name, message: e.message } });
      // SDK error messages never carry credentials or content (they are redacted at the source); anything else is not shown.
      if (e instanceof ThingsError) return json(502, { ok: false, error: { name: e.name, message: e.message } });
      return json(500, { ok: false, error: { name: "InternalError", message: "internal error" } });
    }
  }
}
