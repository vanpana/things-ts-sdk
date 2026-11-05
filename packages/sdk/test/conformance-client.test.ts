// The HTTP client and the write path, driven through the same scripts as the Go SDK. Compares the requests that
// reach the server (method, path, query, headers, body) and whether each call succeeded.
import test from "node:test";
import assert from "node:assert/strict";
import { ThingsClient } from "../src/index.ts";
import type { History, WriteItem } from "../src/index.ts";
import { diff, fixture } from "./helpers.ts";

interface Case {
  name: string; email: string; password: string;
  history: { id: string; commits: unknown[]; pageSize: number; headSeq?: number[] };
  responses: Record<string, { status: number; body: unknown }>;
  ops: Record<string, any>[];
}
interface Recorded { method: string; path: string; query: Record<string, string>; headers: Record<string, string>; body: unknown }

/** The same canned server the Go oracle uses. */
function mockFetch(c: Case, log: Recorded[]) {
  const hid = c.history.id;
  const head = c.history.commits.length;
  let itemsCalls = 0;
  const json = (status: number, body: unknown) => new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  return async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(input);
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries((init.headers ?? {}) as Record<string, string>)) headers[k.toLowerCase()] = v;
    const rec: Recorded = { method: init.method ?? "GET", path: url.pathname, query: Object.fromEntries(url.searchParams), headers, body: undefined };
    if (typeof init.body === "string" && init.body.length > 0) { try { rec.body = JSON.parse(init.body); } catch { rec.body = init.body; } }
    log.push(rec);
    const canned = c.responses[`${rec.method} ${rec.path}`];
    if (canned) return new Response(canned.body === null || canned.body === undefined ? null : typeof canned.body === "string" ? canned.body : JSON.stringify(canned.body), { status: canned.status });
    const p = rec.path;
    if (rec.method === "GET" && p.endsWith("/items")) {
      const start = Number(rec.query["start-index"]);
      if (start > head) return json(500, undefined);
      let end = head;
      if (c.history.pageSize > 0 && start + c.history.pageSize < end) end = start + c.history.pageSize;
      const seq = c.history.headSeq;
      const reported = seq && seq.length > 0 ? seq[Math.min(itemsCalls, seq.length - 1)]! : head;
      itemsCalls++;
      return json(200, { items: c.history.commits.slice(start, end), "current-item-index": reported, schema: 301, "latest-total-content-size": 10, "start-total-content-size": 0, "end-total-content-size": 5 });
    }
    if (rec.method === "GET" && p === `/version/1/history/${hid}`) return json(200, { "latest-schema-version": 301, "latest-total-content-size": 10, "is-empty": head === 0, "latest-server-index": head });
    if (rec.method === "POST" && p.endsWith("/commit")) return json(200, { "server-head-index": head + 1 });
    if (rec.method === "GET" && p.endsWith("/own-history-keys")) return json(200, [hid, "OTHER"]);
    if (rec.method === "POST" && p.endsWith("/own-history-keys")) return json(200, { "new-history-key": "NEWKEY" });
    if (rec.method === "DELETE") return new Response(null, { status: 202 });
    if (rec.method === "PUT" && p.includes("/app-instance/")) return new Response(null, { status: 200 });
    if (rec.method === "GET" && p.includes("/account/")) return json(200, { "SLA-version-accepted": "v1", issues: [], email: c.email, "maildrop-email": "m@x", status: "SYAccountStatusActive", "history-key": hid });
    return json(404, undefined);
  };
}

async function runOps(c: Case) {
  const log: Recorded[] = [];
  const client = new ThingsClient(c.email, c.password, { endpoint: "http://mock.invalid", allowInsecure: true, fetch: mockFetch(c, log) });
  const h: History = client.historyWithId(c.history.id);
  const results: Record<string, unknown>[] = [];
  for (const op of c.ops) {
    const res: Record<string, unknown> = { op: op["op"] };
    let error = false;
    try {
      switch (op["op"]) {
        case "verify": { const v = await client.verify(); res["historyKey"] = v["history-key"]; res["status"] = v.status; break; }
        case "ownHistory": res["id"] = (await client.ownHistory()).id; break;
        case "history": { const x = await client.history(c.history.id); res["latestServerIndex"] = x.latestServerIndex; res["latestSchemaVersion"] = x.latestSchemaVersion; break; }
        case "histories": res["ids"] = (await client.histories()).map((x) => x.id); break;
        case "createHistory": res["id"] = (await client.createHistory()).id; break;
        case "items": {
          const page = await h.items(op["start"]);
          res["count"] = page.items.length; res["hasMore"] = page.hasMore; res["loaded"] = h.loadedServerIndex; res["latest"] = h.latestServerIndex;
          res["serverIndexes"] = page.items.map((i) => i.serverIndex).sort((a, b) => a! - b!);
          break;
        }
        case "sync": await h.sync(); res["latest"] = h.latestServerIndex; res["schema"] = h.latestSchemaVersion; break;
        case "delete": await h.delete(); break;
        case "registerAppInstance": await client.registerAppInstance({ appInstanceId: op["appInstanceId"], historyKey: op["historyKey"], apnsToken: op["apnsToken"], appId: op["appId"], dev: op["dev"] }); break;
        case "write": {
          if (op["setLatest"] !== undefined) h.latestServerIndex = op["setLatest"];
          // The Go SDK has neither the schema guard nor the duplicate-create memory, and passes every kind through.
          // Parity is measured with those safety extras switched off (they are covered by their own tests).
          h.latestSchemaVersion = 301;
          h.forgetWrites();
          try { await h.write(op["items"].map((i: any): WriteItem => ({ uuid: i.uuid, kind: i.e, action: i.t, payload: i.p })), { unsafe: { unverifiedKinds: true } }); }
          catch (e) { error = true; void e; }
          res["latest"] = h.latestServerIndex;
          break;
        }
      }
    } catch { error = true; }
    res["error"] = error;
    results.push(res);
  }
  return { results, log };
}

const SKIP_RESULT_KEYS = new Set<string>();

test("client: requests and outcomes match the Go SDK, including every write verdict", async () => {
  const { cases, expected } = fixture<Case>("client");
  const problems: string[] = [];
  let ops = 0;
  let accepted = 0;
  let refused = 0;
  for (const [i, c] of cases.entries()) {
    const want = expected[i];
    want.requests ??= [];
    const { results, log } = await runOps(c);
    ops += results.length;
    // Compare each result.
    for (const [k, got] of results.entries()) {
      const w = want.results[k];
      if (w.op === "items" && !w.error) w.serverIndexes ??= [];
      const copy = { ...got }; const wcopy = { ...w };
      for (const key of SKIP_RESULT_KEYS) { delete copy[key]; delete wcopy[key]; }
      const d = diff(copy, wcopy);
      if (d) { problems.push(`${c.name} op ${k} ${JSON.stringify(c.ops[k]).slice(0, 300)}: ${d}`); break; }
      if (c.ops[k]!["op"] === "write") (got["error"] ? refused++ : accepted++);
    }
    // Compare the request log.
    if (log.length !== want.requests.length) { problems.push(`${c.name}: ${log.length} requests vs Go ${want.requests.length}`); continue; }
    for (const [k, req] of log.entries()) {
      const w = want.requests[k];
      const d = diff({ method: req.method, path: req.path, query: req.query, headers: req.headers, body: req.body ?? null }, { method: w.method, path: w.path, query: w.query, headers: want.headerSets[w.h], body: w.body ?? null });
      if (d) { problems.push(`${c.name} request ${k} ${req.method} ${req.path}: ${d}`); break; }
    }
  }
  assert.deepEqual(problems.slice(0, 15), [], `${problems.length} problems`);
  assert.ok(ops > 2000 && accepted > 100 && refused > 500, `${ops} ops, ${accepted} accepted, ${refused} refused writes`);
});
