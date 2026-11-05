import type { ThingsClient } from "./client.ts";
import { CommitOutcomeUnknownError, ThingsError, ThingsHttpError, WriteRefusedError } from "./errors.ts";
import { KNOWN_SCHEMA } from "./guards.ts";
import { pathSegment, serverIndex } from "./path.ts";
import { ORGANISER_KINDS, validateOrganiserWrites } from "./organise.ts";
import { scanTask7Targets } from "./preflight.ts";
import { flattenCommits } from "./state.ts";
import { assertWritableId, validateWrites } from "./validate.ts";
import { ItemAction } from "./types.ts";
import type { Commit, Item, WriteItem } from "./types.ts";

/** Headers the Mac client sends with a commit. */
const COMMIT_HEADERS: Record<string, string> = {
  Schema: "301",
  "Push-Priority": "5",
  "App-Instance-Id": "0".repeat(63) + "-com.culturedcode.ThingsMac-" + "0".repeat(63),
  "App-Id": "com.culturedcode.ThingsMac",
};

export interface ItemsPage {
  /** Flat items; each carries the index of its commit. */
  items: Item[];
  /** The commits as the server sent them (`items` is these, unwrapped). */
  commits: Commit[];
  hasMore: boolean;
}

export interface WriteOptions {
  /**
   * Checks the modification targets before sending and returns the ancestor index to commit against.
   * Default: scan the whole log (like the Go SDK). Pass a function to answer from synced state instead.
   */
  preflight?: (targets: ReadonlySet<string>) => Promise<number> | number;
  /** Escape hatches. Both widen what can be sent beyond the verified contract; leave them off. */
  unsafe?: {
    /**
     * Send kinds beyond the verified set (`Task7` and creates / deletes of `Tag4`, `Area3`, `ChecklistItem3`), such as
     * tombstones, `Task6` or modifications of tags and areas, and skip the tag / area / checklist contract entirely
     * (even malformed creates pass), as the Go SDK does.
     */
    unverifiedKinds?: boolean;
    /** Send even when the history's schema version is unknown or not the verified one. */
    ignoreSchema?: boolean;
  };
}

/** Upper bound for one commit body. Real commits are a few KB. */
const MAX_COMMIT_BYTES = 1_000_000;

/** A sync stream. Items are append-only; every write names the head it was based on. */
export class History {
  readonly id: string;
  /** The id as it appears in URL paths. */
  private get seg(): string { return pathSegment(this.id, "history id"); }
  readonly client: ThingsClient;
  latestServerIndex = 0;
  loadedServerIndex = 0;
  /** The server's schema version as last seen (0 = not seen yet). Writes are refused unless it is {@link KNOWN_SCHEMA}. */
  latestSchemaVersion = 0;
  endTotalContentSize = 0;
  latestTotalContentSize = 0;

  constructor(client: ThingsClient, id: string) {
    this.client = client;
    this.id = id;
  }

  /**
   * Fetches one page of the log from `startIndex`. A server index is the position of a commit; a commit can hold
   * several entities. Never pass a `startIndex` above the head: the server answers 500.
   */
  async items(startIndex = 0): Promise<ItemsPage> {
    if (!Number.isSafeInteger(startIndex) || startIndex < 0) throw new ThingsError("startIndex must be a non-negative integer");
    const v = await this.client.json<{
      items: Commit[]; "latest-total-content-size": number; "end-total-content-size": number; schema: number; "current-item-index": number;
    }>({ method: "GET", path: `/version/1/history/${this.seg}/items`, query: { "start-index": String(startIndex) } });
    if (!Array.isArray(v.items)) throw new ThingsError("decoding items: expected an array");
    const head = serverIndex(v["current-item-index"], "current-item-index");
    const items = flattenCommits(v.items, startIndex);
    this.loadedServerIndex = startIndex + v.items.length;
    this.latestServerIndex = head;
    this.endTotalContentSize = serverIndex(v["end-total-content-size"], "end-total-content-size");
    this.latestTotalContentSize = serverIndex(v["latest-total-content-size"], "latest-total-content-size");
    if (typeof v.schema === "number") this.latestSchemaVersion = v.schema;
    return { items, commits: v.items, hasMore: this.loadedServerIndex < this.latestServerIndex };
  }

  #uncertain = new Set<string>();
  #committed = new Set<string>();

  /**
   * Forgets which creates this object has sent. Until then a create of the same uuid is refused, because it was either
   * committed or its outcome is unknown. Call it only after re-syncing and confirming the log does not contain the uuid.
   */
  forgetWrites(uuid?: string): void {
    if (uuid === undefined) { this.#uncertain.clear(); this.#committed.clear(); }
    else { this.#uncertain.delete(uuid); this.#committed.delete(uuid); }
  }

  /** Refreshes the head and schema version from the server (`latestServerIndex`). */
  async sync(): Promise<void> {
    const v = await this.client.json<{ "current-item-index": number; schema: number; "latest-total-content-size": number }>(
      { method: "GET", path: `/version/1/history/${this.seg}/items`, query: { "start-index": String(this.latestServerIndex) } },
    );
    this.latestServerIndex = serverIndex(v["current-item-index"], "current-item-index");
    this.latestSchemaVersion = serverIndex(v.schema, "schema");
    this.latestTotalContentSize = serverIndex(v["latest-total-content-size"], "latest-total-content-size");
  }

  /** Deletes this history. The server answers 202 even for unknown keys. Destroys sync data: never call casually. */
  async delete(): Promise<void> {
    const res = await this.client.request({ method: "DELETE", path: `/version/1/account/${pathSegment(this.client.email, "email")}/own-history-keys/${this.seg}`, authorized: true });
    await res.body?.cancel();
    if (res.status !== 202) throw new ThingsHttpError(res.status, res.statusText);
  }

  /**
   * Validates and commits `items` in one request. Nothing is sent unless every item passes validation.
   * The commit names the head it was based on: a stale one gets HTTP 409 (a {@link ThingsHttpError}) and writes
   * nothing. This method never retries.
   */
  async write(items: readonly WriteItem[], options: WriteOptions = {}): Promise<void> {
    if (!options.unsafe?.ignoreSchema && this.latestSchemaVersion !== KNOWN_SCHEMA) {
      throw new WriteRefusedError(this.latestSchemaVersion === 0
        ? "refusing to write: the history's schema version is not known yet (sync first)"
        : `refusing to write: schema ${this.latestSchemaVersion} is not the verified ${KNOWN_SCHEMA}`);
    }
    // Read every property exactly once, so getters and proxies cannot answer differently later.
    const snap = items.map((i) => ({ uuid: i.uuid, kind: i.kind, action: i.action, payload: i.payload }));
    const seen = new Set<string>();
    const raw: Commit = {};
    for (const it of snap) {
      if (typeof it.uuid !== "string") throw new WriteRefusedError("refusing to write item: invalid identifier");
      if (seen.has(it.uuid)) {
        throw new WriteRefusedError(`refusing to write items: duplicate UUID ${it.uuid} in one commit — split into separate write calls`);
      }
      seen.add(it.uuid);
      raw[it.uuid] = { e: it.kind, t: it.action, p: it.payload };
    }
    // Validate exactly what will be sent: serialise once, parse that text back and check the copy. Every check below
    // (identifiers, kind gate, duplicate creates, contracts) runs on that copy.
    const bodyText = JSON.stringify(raw);
    if (new TextEncoder().encode(bodyText).length > MAX_COMMIT_BYTES) throw new WriteRefusedError("refusing to write: commit body is too large");
    const sent = JSON.parse(bodyText) as Record<string, { e: unknown; t: unknown; p: unknown }>;
    if (Object.keys(sent).length !== items.length) throw new WriteRefusedError("refusing to write: items changed when serialised");
    const sentItems = Object.entries(sent).map(([uuid, x]) => ({ uuid, kind: x.e as string, action: x.t as ItemAction, payload: x.p as Record<string, unknown> }));
    for (const item of sentItems) {
      assertWritableId(item.uuid);
      if (typeof item.kind !== "string") throw new WriteRefusedError("refusing to write an invalid item envelope");
      if (!options.unsafe?.unverifiedKinds && item.kind !== "Task7" && !ORGANISER_KINDS.includes(item.kind)) {
        throw new WriteRefusedError(`refusing to write kind ${JSON.stringify(item.kind).slice(0, 40)}: only Task7, Tag4, Area3 and ChecklistItem3 are verified (opt in with unsafe.unverifiedKinds)`);
      }
      if (item.action === ItemAction.Created && (this.#committed.has(item.uuid) || this.#uncertain.has(item.uuid))) {
        throw new WriteRefusedError(`refusing to create ${item.uuid} again: it was already committed or its outcome is unknown (re-sync, then forgetWrites)`);
      }
    }
    const plan = validateWrites(sentItems);
    if (!options.unsafe?.unverifiedKinds) validateOrganiserWrites(sentItems);
    if (!Number.isSafeInteger(this.latestServerIndex) || this.latestServerIndex < 0) throw new WriteRefusedError("latestServerIndex must be a non-negative integer");
    let ancestorIndex = this.latestServerIndex;
    if (plan.modificationTargets.size !== 0) {
      if (options.preflight) {
        ancestorIndex = await options.preflight(plan.modificationTargets);
        if (!Number.isSafeInteger(ancestorIndex) || ancestorIndex < 0) throw new WriteRefusedError("the preflight returned an invalid ancestor index");
      } else {
        // Scan through a copy so a failed or incomplete preflight leaves this object untouched.
        const scan = new History(this.client, this.id);
        ancestorIndex = await scanTask7Targets(async (start) => {
          const page = await scan.items(start);
          return { items: page.items, loadedServerIndex: scan.loadedServerIndex, latestServerIndex: scan.latestServerIndex };
        }, plan.modificationTargets);
      }
      this.latestServerIndex = ancestorIndex;
    }
    const created = sentItems.filter((i) => i.action === ItemAction.Created).map((i) => i.uuid);
    let res: Response;
    try {
      res = await this.client.request({
        method: "POST",
        path: `/version/1/history/${this.seg}/commit`,
        query: { "ancestor-index": String(ancestorIndex), _cnt: "1" },
        headers: COMMIT_HEADERS,
        body: bodyText,
        authorized: false,
      });
    } catch (e) {
      for (const u of created) this.#uncertain.add(u);
      throw new CommitOutcomeUnknownError("the commit may or may not have been applied: re-sync before writing again", { cause: e });
    }
    if (res.status !== 200) {
      await res.body?.cancel();
      // 409 and other 4xx mean it was not applied; a 5xx may have been.
      if (res.status >= 500) for (const u of created) this.#uncertain.add(u);
      throw new ThingsHttpError(res.status, res.statusText, `Write failed: ${res.status}`);
    }
    let head: number;
    try { head = serverIndex(((await res.json()) as { "server-head-index": unknown })["server-head-index"], "server-head-index"); }
    catch (e) {
      for (const u of created) this.#uncertain.add(u);
      throw new CommitOutcomeUnknownError("the commit was sent but the response was not understood: re-sync before writing again", { cause: e });
    }
    for (const u of created) this.#committed.add(u);
    this.latestServerIndex = head;
  }
}
