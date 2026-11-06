import test from "node:test";
import assert from "node:assert/strict";
import { allTasks, emptyState, newId, syncState, ThingsClient, ThingsHttpError } from "../src/index.ts";
import type { Commit, State } from "../src/index.ts";

/** A server whose history can be extended and whose failures can be scripted. */
function server(commits: Commit[], opts: { pageSize?: number; failItems?: number[]; failHead?: number[]; badProgress?: boolean } = {}) {
  const calls: string[] = [];
  const failItems = [...(opts.failItems ?? [])];
  const failHead = [...(opts.failHead ?? [])];
  const fetch = async (input: string): Promise<Response> => {
    const url = new URL(input);
    calls.push(url.pathname + url.search);
    if (url.pathname.endsWith("/items")) {
      const status = failItems.shift();
      if (status) return new Response(null, { status });
      const start = Number(url.searchParams.get("start-index"));
      if (start > commits.length) return new Response(null, { status: 500 });
      const end = Math.min(commits.length, start + (opts.pageSize ?? 1000));
      const items = opts.badProgress ? [] : commits.slice(start, end);
      return Response.json({ items, "current-item-index": commits.length, schema: 301, "latest-total-content-size": 0, "end-total-content-size": 0 });
    }
    const status = failHead.shift();
    if (status) return new Response(null, { status });
    return Response.json({ "latest-schema-version": 301, "latest-total-content-size": 0, "is-empty": false, "latest-server-index": commits.length });
  };
  return { fetch, calls };
}
const mk = (n: number): Commit[] => Array.from({ length: n }, (_, i) => ({ [newId()]: { e: "Task6", t: 0, p: { tt: `task ${i}`, ix: i } } }));
const noSleep = async () => {};

async function run(commits: Commit[], state: State, opts: Parameters<typeof server>[1] = {}, sync: Parameters<typeof syncState>[2] = {}) {
  const s = server(commits, opts);
  const client = new ThingsClient("a@b.c", "pw", { endpoint: "http://x.invalid", allowInsecure: true, fetch: s.fetch });
  const result = await syncState(client.historyWithId("H"), state, { sleep: noSleep, ...sync });
  return { result, calls: s.calls };
}

test("sync pages through the whole log and lands on the head", async () => {
  const state = emptyState();
  const { result, calls } = await run(mk(25), state, { pageSize: 10 });
  assert.deepEqual(result, { commits: 25, head: 25 });
  assert.equal(state.cursor, 25);
  assert.equal(allTasks(state).length, 25);
  assert.deepEqual(calls.filter((c) => c.includes("/items")).map((c) => c.split("start-index=")[1]), ["0", "10", "20"]);
});

test("sync from a cursor only fetches what is new, and does nothing when caught up", async () => {
  const log = mk(12);
  const state = emptyState();
  await run(log.slice(0, 5), state);
  const { result, calls } = await run(log, state, { pageSize: 100 });
  assert.equal(result.commits, 7);
  assert.ok(calls.some((c) => c.endsWith("start-index=5")));
  const again = await run(log, state);
  assert.equal(again.result.commits, 0);
  assert.equal(again.calls.filter((c) => c.includes("/items")).length, 0, "caught up: no items request (the server answers 500 above its head)");
});

test("transient server errors are retried with backoff; others are not", async () => {
  const delays: number[] = [];
  const sleep = async (ms: number) => { delays.push(ms); };
  const state = emptyState();
  await run(mk(3), state, { failItems: [503, 500] }, { sleep, retryBaseMs: 10 });
  assert.deepEqual(delays, [10, 20]);
  assert.equal(state.cursor, 3);

  await assert.rejects(run(mk(3), emptyState(), { failItems: [403] }), (e: unknown) => e instanceof ThingsHttpError && e.status === 403);
  await assert.rejects(run(mk(3), emptyState(), { failItems: [500, 500, 500] }, { maxRetries: 3 }), (e: unknown) => e instanceof ThingsHttpError && e.status === 500);
});

test("a state that is ahead of the server must be rebuilt", async () => {
  const state = emptyState();
  state.cursor = 50;
  await assert.rejects(run(mk(3), state), /ahead of the server/);
});

test("a page that makes no progress is an error, not an endless loop", async () => {
  await assert.rejects(run(mk(3), emptyState(), { badProgress: true }), /invalid sync progress/);
});

test("a bad page leaves the state at the last good page", async () => {
  const log = mk(20);
  (log[15] as Commit)[newId()] = { e: "Task6", t: 0, p: "not an object" };
  const state = emptyState();
  await assert.rejects(run(log, state, { pageSize: 10 }));
  assert.equal(state.cursor, 10, "first page applied, second rejected atomically");
  assert.equal(allTasks(state).length, 10);
});

test("syncing teaches the history its schema version, so a write can follow", async () => {
  // An empty log: no page is ever fetched, so only the head lookup can tell the history its schema.
  const s = server([]);
  const client = new ThingsClient("a@b.c", "pw", { endpoint: "http://x.invalid", allowInsecure: true, fetch: s.fetch });
  const h = client.historyWithId("H");
  await syncState(h, emptyState(), { sleep: noSleep });
  assert.equal(h.latestSchemaVersion, 301);
  assert.equal(h.latestServerIndex, 0);
});
