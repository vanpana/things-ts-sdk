// Persistence for one account in Durable Object SQLite storage.
//   entity(bucket, id, kind, json)   one row per task / checklist item / tag / area / setting
//   meta(key, value)                 cursor, state version, kill switch, check results, timestamps
//   journal(...)                     every write attempt: tool, ids, outcome, error name. Never titles, notes or credentials.
// After a sync only the entities that changed are written (the fold replaces an entity's object when it touches it, so a
// reference comparison finds exactly those), together with the cursor in one transaction. Rows are tiny, far below the
// 2 MB row limit, and a sync of N new commits writes about N rows instead of the whole state.

import { emptyState, STATE_VERSION } from "../../sdk/src/index.ts";
import type { Entity, State } from "../../sdk/src/index.ts";
import type { DurableObjectStorage } from "./cf.ts";

export const BUCKETS = ["tasks", "checklist", "tags", "areas", "settings"] as const;
export type Bucket = (typeof BUCKETS)[number];
export type Refs = Record<Bucket, Map<string, Entity>>;

const JOURNAL_KEEP = 1000;

/** The entity objects currently in `state`, to diff against after a sync. */
export const snapshotRefs = (s: State): Refs => ({
  tasks: new Map(s.tasks), checklist: new Map(s.checklist), tags: new Map(s.tags), areas: new Map(s.areas), settings: new Map(s.settings),
});

export interface JournalRow { id: number; ts: number; tool: string; ids: string; outcome: string; error: string | null }

export class Store {
  readonly #storage: DurableObjectStorage;
  constructor(storage: DurableObjectStorage) { this.#storage = storage; }
  get #sql() { return this.#storage.sql; }

  init(): void {
    this.#sql.exec("CREATE TABLE IF NOT EXISTS entity (bucket TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (bucket, id)) WITHOUT ROWID");
    this.#sql.exec("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) WITHOUT ROWID");
    this.#sql.exec("CREATE TABLE IF NOT EXISTS journal (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, tool TEXT NOT NULL, ids TEXT NOT NULL, outcome TEXT NOT NULL, error TEXT)");
  }

  getMeta(key: string): string | undefined {
    const rows = this.#sql.exec<{ value: string }>("SELECT value FROM meta WHERE key = ?", key).toArray();
    return rows[0]?.value;
  }
  getJson<T>(key: string): T | undefined {
    const v = this.getMeta(key);
    if (v === undefined) return undefined;
    try { return JSON.parse(v) as T; } catch { return undefined; }
  }
  setMeta(key: string, value: string): void {
    this.#sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }
  setJson(key: string, value: unknown): void { this.setMeta(key, JSON.stringify(value)); }
  deleteMeta(key: string): void { this.#sql.exec("DELETE FROM meta WHERE key = ?", key); }

  /** The persisted state, or null when there is none or it was folded by another STATE_VERSION (rebuild it). */
  load(): State | null {
    const cursor = this.getMeta("cursor");
    if (cursor === undefined || this.getMeta("stateVersion") !== String(STATE_VERSION)) return null;
    const state = emptyState();
    state.cursor = Number(cursor);
    if (!Number.isSafeInteger(state.cursor) || state.cursor < 0) return null;
    for (const r of this.#sql.exec<{ bucket: string; id: string; kind: string; json: string }>("SELECT bucket, id, kind, json FROM entity")) {
      if (!(BUCKETS as readonly string[]).includes(r.bucket)) return null;
      const p = JSON.parse(r.json) as { f: Record<string, unknown>; n: string; a?: 1 };
      // Null prototype, as the fold builds them: a server key such as "__proto__" must stay an ordinary key.
      const ent: Entity = { kind: r.kind, fields: Object.assign(Object.create(null), p.f), note: p.n };
      if (p.a) ent.ambiguous = true;
      state[r.bucket as Bucket].set(r.id, ent);
    }
    return state;
  }

  /** Writes what changed since `before` plus the cursor, atomically. */
  persist(before: Refs, state: State): { upserts: number; deletes: number } {
    let upserts = 0, deletes = 0;
    this.#storage.transactionSync(() => {
      for (const b of BUCKETS) {
        for (const [id, e] of state[b]) {
          if (before[b].get(id) === e) continue;
          this.#sql.exec(
            "INSERT INTO entity (bucket, id, kind, json) VALUES (?, ?, ?, ?) ON CONFLICT(bucket, id) DO UPDATE SET kind = excluded.kind, json = excluded.json",
            b, id, e.kind, JSON.stringify({ f: e.fields, n: e.note, ...(e.ambiguous ? { a: 1 } : {}) }),
          );
          upserts++;
        }
        for (const id of before[b].keys()) {
          if (state[b].has(id)) continue;
          this.#sql.exec("DELETE FROM entity WHERE bucket = ? AND id = ?", b, id);
          deletes++;
        }
      }
      this.setMeta("cursor", String(state.cursor));
      this.setMeta("stateVersion", String(STATE_VERSION));
    });
    return { upserts, deletes };
  }

  /** Forgets the persisted state (keeps the journal, the kill switch and the check history). */
  wipeState(): void {
    this.#storage.transactionSync(() => {
      this.#sql.exec("DELETE FROM entity");
      this.deleteMeta("cursor");
      this.deleteMeta("stateVersion");
    });
  }

  journal(tool: string, ids: readonly string[], outcome: string, error?: string): void {
    this.#storage.transactionSync(() => {
      this.#sql.exec("INSERT INTO journal (ts, tool, ids, outcome, error) VALUES (?, ?, ?, ?, ?)", Date.now(), tool, JSON.stringify(ids), outcome, error ?? null);
      this.#sql.exec("DELETE FROM journal WHERE id <= (SELECT MAX(id) FROM journal) - ?", JOURNAL_KEEP);
    });
  }
  recentJournal(limit: number): JournalRow[] {
    return this.#sql.exec<JournalRow>("SELECT id, ts, tool, ids, outcome, error FROM journal ORDER BY id DESC LIMIT ?", limit).toArray();
  }
}
