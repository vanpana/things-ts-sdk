// Regression tests for hardening: write safety, hostile input, transport failures.
import test from "node:test";
import assert from "node:assert/strict";
import {
  allTasks, applyItems, emptyState, MalformedItemError, newId, nextScheduledDate, textNote, ThingsClient, ThingsError, WriteRefusedError,
} from "../src/index.ts";
import type { FetchLike, WriteItem } from "../src/index.ts";
import { pathSegment } from "../src/path.ts";

const OK_CREATE = (): Record<string, unknown> => ({
  tp: 0, sr: null, dds: null, rt: [], rmd: null, ss: 0, tr: false, dl: [], icp: false, st: 0, ar: [], tt: "t", do: 0, lai: null, tir: null, tg: [],
  agr: [], ix: 0, cd: 1770000000, lt: false, icc: 0, md: null, ti: 0, dd: null, ato: null, nt: textNote(""), icsd: null, pr: [], rp: null, acrd: null,
  sp: null, sb: 0, rr: null, xx: { sn: {}, _t: "oo" },
});

function recorder(): { fetch: FetchLike; sent: { url: string; body?: string }[] } {
  const sent: { url: string; body?: string }[] = [];
  const fetch: FetchLike = async (url, init) => { sent.push({ url, body: init.body as string | undefined }); return Response.json({ "server-head-index": 1 }); };
  return { fetch, sent };
}
/** A history whose schema version is known, as after a sync. */
const ready = <T extends { latestSchemaVersion: number }>(h: T): T => { h.latestSchemaVersion = 301; return h; };
const client = (fetch: FetchLike) => new ThingsClient("a@b.c", "pw", { endpoint: "https://x.invalid", fetch });

test("what is validated is exactly what is sent (no toJSON, inherited or getter tricks)", async () => {
  const rec = recorder();
  const h = ready(client(rec.fetch).historyWithId("H"));
  const tricky = OK_CREATE();
  Object.defineProperty(tricky, "toJSON", { value: () => ({ evil: true }), enumerable: false });
  await assert.rejects(h.write([{ uuid: newId(), kind: "Task7", action: 0, payload: tricky }]), WriteRefusedError);

  const inherited = Object.create({ md: 1770000000 }) as Record<string, unknown>;
  inherited["tt"] = "x";
  await assert.rejects(h.write([{ uuid: newId(), kind: "Task7", action: 1, payload: inherited }], { preflight: () => 0 }), WriteRefusedError);

  const ar: string[] = [];
  Object.defineProperty(ar, "toJSON", { value: () => ["../evil"], enumerable: false });
  await assert.rejects(h.write([{ uuid: newId(), kind: "Task7", action: 0, payload: { ...OK_CREATE(), ar } }]), WriteRefusedError);
  assert.equal(rec.sent.length, 0, "nothing reached the network");

  // A normal write sends precisely the validated text.
  const item: WriteItem = { uuid: newId(), kind: "Task7", action: 0, payload: OK_CREATE() };
  await h.write([item]);
  assert.deepEqual(JSON.parse(rec.sent[0]!.body!), { [item.uuid]: { e: "Task7", t: 0, p: item.payload } });
});

test("latestServerIndex must be sane before it becomes an ancestor index", async () => {
  const h = ready(client(recorder().fetch).historyWithId("H"));
  for (const bad of [-1, 1.5, Number.NaN, 2 ** 60]) {
    h.latestServerIndex = bad;
    await assert.rejects(h.write([{ uuid: newId(), kind: "Task7", action: 0, payload: OK_CREATE() }]), WriteRefusedError, String(bad));
  }
});

const note = (nt: unknown) => applyItems(emptyState(), [{ uuid: newId(), kind: "Task6", action: 0, payload: { tt: "n", nt } }]);

test("malformed note payloads are rejected, tolerated ones are normalised like Go", () => {
  for (const bad of [
    { _t: "tx", t: 1, v: 5 }, { _t: "tx", t: 1, v: [] }, { _t: 5, t: 1, v: "x" }, { _t: "tx", t: 2, ps: {} }, { _t: "tx", t: 2, ps: "x" },
    { _t: "tx", t: 2, ps: [{ r: 1, p: 0, l: 0 }] }, { _t: "tx", t: 2, ps: [{ r: "a", p: "0", l: 0 }] }, { _t: "tx", t: 2, ps: [{ r: "a", p: [], l: 0 }] },
    { _t: "tx", t: 2, ps: [{ r: "a", p: 1e300, l: 0 }] }, { _t: "tx", t: 2, ps: [5] }, { _t: "tx", t: 1, v: "a", ch: "x" },
  ]) assert.throws(() => note(bad), MalformedItemError, JSON.stringify(bad));
  const s = applyItems(emptyState(), [
    { uuid: "A".repeat(22), kind: "Task6", action: 0, payload: { tt: "n", nt: "abc" } },
    { uuid: "A".repeat(22), kind: "Task6", action: 1, payload: { nt: { _t: "tx", t: 2, ps: [null, { r: "X" }, {}] } } },
  ]);
  assert.equal(allTasks(s)[0]!.note, "Xabc", "null and partial patches read as zero values, like Go");
});

test("server responses are validated", async () => {
  const respond = (body: unknown): ThingsClient => client((async () => Response.json(body)) as FetchLike);
  const items = (extra: Record<string, unknown>) => ({ items: [], schema: 301, "latest-total-content-size": 0, "end-total-content-size": 0, ...extra });
  for (const head of [undefined, null, "2", 2.5, -1, 1e30]) {
    await assert.rejects(respond(items({ "current-item-index": head })).historyWithId("H").items(0), ThingsError, String(head));
  }
  await assert.rejects(respond({ "latest-schema-version": 301, "latest-total-content-size": 0, "latest-server-index": "7" }).history("H"), ThingsError);
  await assert.rejects(respond({ nope: 1 }).ownHistory(), ThingsError);
  await assert.rejects(respond({ nope: 1 }).createHistory(), ThingsError);
  await assert.rejects(respond([1, 2]).histories(), ThingsError);
  const h = respond([{}]).historyWithId("H");
  await assert.rejects(h.items(-1), ThingsError);
});

test("a commit response that cannot be understood says the write may have landed", async () => {
  const h = ready(client((async () => Response.json({})) as FetchLike).historyWithId("H"));
  await assert.rejects(h.write([{ uuid: newId(), kind: "Task7", action: 0, payload: OK_CREATE() }]), /re-sync before writing again/);
});

test("path segments: dangerous characters are encoded, ordinary ones are not", () => {
  assert.equal(pathSegment("me+tag@example.com", "email"), "me+tag@example.com");
  assert.equal(pathSegment("café ü", "email"), "café%20ü");
  assert.equal(pathSegment("a#b?c/d\\e%f", "x"), "a%23b%3Fc%2Fd%5Ce%25f");
  assert.equal(pathSegment("a\tb\nc", "x"), "a%09b%0Ac");
  for (const bad of ["", ".", ".."]) assert.throws(() => pathSegment(bad, "x"), ThingsError);
});

test("a history id with '#' keeps its query and stays inside the history path", async () => {
  const rec = recorder();
  const h = ready(client(rec.fetch).historyWithId("evil#id/../x"));
  await h.write([{ uuid: newId(), kind: "Task7", action: 0, payload: OK_CREATE() }]);
  const u = new URL(rec.sent[0]!.url);
  assert.equal(u.hash, "");
  assert.ok(u.pathname.startsWith("/version/1/history/evil%23id%2F..%2Fx/commit"), u.pathname);
  assert.ok(u.searchParams.has("ancestor-index"));
});

test("repeat rules: a missing amplitude reads as 0 like Go, never an invalid date", () => {
  const d = nextScheduledDate({ ia: 1770000000, fu: 16, of: [{}], rc: 5 } as never, 2);
  assert.ok(d && !Number.isNaN(d.getTime()));
});

test("the same task created twice, or modified without a creation, is flagged ambiguous", () => {
  const id = newId();
  const s = emptyState();
  applyItems(s, [{ uuid: id, kind: "Task7", action: 0, payload: { tt: "a" } }]);
  assert.equal(s.tasks.get(id)!.ambiguous, undefined);
  applyItems(s, [{ uuid: id, kind: "Task7", action: 0, payload: { tt: "again" } }]);
  assert.equal(s.tasks.get(id)!.ambiguous, true);
  applyItems(s, [{ uuid: id, kind: "Task7", action: 2, payload: {} }]);
  applyItems(s, [{ uuid: id, kind: "Task7", action: 0, payload: { tt: "fresh" } }]);
  assert.equal(s.tasks.get(id)!.ambiguous, undefined, "a delete clears the doubt");
  const orphan = newId();
  applyItems(s, [{ uuid: orphan, kind: "Task7", action: 1, payload: { tt: "x" } }]);
  assert.equal(s.tasks.get(orphan)!.ambiguous, true);
});

import { scanTask7Targets } from "../src/index.ts";
test("the preflight scan gives up on a server that never reaches its head", async () => {
  let start0 = 0;
  await assert.rejects(
    scanTask7Targets(async (start) => { start0 = start; return { items: [], loadedServerIndex: start + 1, latestServerIndex: 10 ** 12 }; }, [newId()]),
    /gave up after/,
  );
  assert.ok(start0 > 50_000);
});

import { CommitOutcomeUnknownError, ThingsNetworkError, buildCreate, hasExplicitRecurrenceMarkers, preflightFromState, fold, ThingsHttpError } from "../src/index.ts";

test("writes are refused unless the schema is the verified one", async () => {
  const rec = recorder();
  const h = client(rec.fetch).historyWithId("H");
  const item = buildCreate({ title: "x" });
  await assert.rejects(h.write([item]), /schema version is not known/);
  h.latestSchemaVersion = 302;
  await assert.rejects(h.write([item]), /schema 302 is not the verified 301/);
  await h.write([item], { unsafe: { ignoreSchema: true } });
  assert.equal(rec.sent.length, 1);
});

test("only the verified kinds are sent by default; other kinds need an explicit opt-in", async () => {
  const rec = recorder();
  const h = ready(client(rec.fetch).historyWithId("H"));
  for (const kind of ["Tombstone2", "Task6", "Command", "Settings5", "constructor"]) {
    await assert.rejects(h.write([{ uuid: newId(), kind, action: 0, payload: { dloid: "garbage", tt: 123 } }]), /only Task7, Tag4, Area3 and ChecklistItem3 are verified/, kind);
  }
  assert.equal(rec.sent.length, 0);
  await h.write([{ uuid: newId(), kind: "Tag4", action: 0, payload: { tt: "t" } }], { unsafe: { unverifiedKinds: true } });
  assert.equal(rec.sent.length, 1);
});

test("a create is never sent twice from one History, and an unknown outcome blocks the retry", async () => {
  let fail = true;
  const fetch: FetchLike = async () => { if (fail) throw new DOMException("timed out", "TimeoutError"); return Response.json({ "server-head-index": 2 }); };
  const h = ready(client(fetch).historyWithId("H"));
  const item = buildCreate({ title: "once" });
  await assert.rejects(h.write([item]), (e: unknown) => e instanceof CommitOutcomeUnknownError && e instanceof ThingsNetworkError && e instanceof ThingsError);
  fail = false;
  await assert.rejects(h.write([item]), /already committed or its outcome is unknown/);
  h.forgetWrites(item.uuid);
  await h.write([item]);
  await assert.rejects(h.write([item]), /already committed/, "committed creates are remembered too");
});

test("a 5xx may have been applied (blocks a blind retry); a 409 was not", async () => {
  const codes = [409, 503];
  const fetch: FetchLike = async () => new Response(null, { status: codes.shift()! });
  const h = ready(client(fetch).historyWithId("H"));
  const item = buildCreate({ title: "x" });
  await assert.rejects(h.write([item]), (e: unknown) => e instanceof ThingsHttpError && e.status === 409);
  await assert.rejects(h.write([item]), (e: unknown) => e instanceof ThingsHttpError && e.status === 503);
  await assert.rejects(h.write([item]), /outcome is unknown/);
});

test("transport failures are ThingsErrors; redirects are not followed", async () => {
  let seen: RequestInit | undefined;
  const fetch: FetchLike = async (_u, init) => { seen = init; throw new TypeError("fetch failed"); };
  await assert.rejects(client(fetch).verify(), (e: unknown) => e instanceof ThingsNetworkError && !e.message.includes("a@b.c"));
  assert.equal(seen!.redirect, "manual");
  const redirected: FetchLike = async () => new Response(null, { status: 302, headers: { location: "https://evil.invalid/" } });
  await assert.rejects(client(redirected).verify(), (e: unknown) => e instanceof ThingsNetworkError && /redirected/.test(e.message));
  assert.throws(() => new ThingsClient("a@b.c", "pw", { endpoint: "https://user:pw@x.invalid" }), /credentials/);
  assert.throws(() => new ThingsClient("a@b.c", "pw", { endpoint: "not a url" }), ThingsError);
  assert.equal(new ThingsClient("a@b.c", "pw", { endpoint: "HTTPS://X.invalid/base/" }).endpoint, "https://x.invalid/base");
});

test("a request that times out is reported as a ThingsNetworkError", async () => {
  const fetch: FetchLike = (_u, init) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(init.signal!.reason)));
  const c = new ThingsClient("a@b.c", "pw", { endpoint: "https://x.invalid", fetch, timeoutMs: 20 });
  await assert.rejects(c.verify(), ThingsNetworkError);
});

test("hostile keys: __proto__ stays an ordinary key and cannot fake recurrence markers", () => {
  const id = newId();
  const s = emptyState();
  const payload = JSON.parse('{"tt":"x","__proto__":{"rr":null,"rp":null,"rt":[]}}');
  applyItems(s, [{ uuid: id, kind: "Task7", action: 0, payload }]);
  const fields = s.tasks.get(id)!.fields;
  assert.equal(Object.hasOwn(fields, "rr"), false);
  assert.equal("rr" in fields, false);
  assert.equal(hasExplicitRecurrenceMarkers(fields), false);
  assert.throws(() => preflightFromState(s, [id]), /recurrence markers/);
  assert.equal(({} as Record<string, unknown>)["rr"], undefined, "Object.prototype untouched");
});

test("kinds named after Object.prototype members are unknown kinds, not crashes", () => {
  for (const kind of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
    assert.throws(() => applyItems(emptyState(), [{ uuid: newId(), kind, action: 0, payload: {} }]), UnknownKindError, kind);
    assert.doesNotThrow(() => applyItems(emptyState(), [{ uuid: newId(), kind, action: 0, payload: {} }], { mode: "lenient" }), kind);
  }
});

test("a custom preflight must return a real index; huge commits and bad builder inputs are refused", async () => {
  const h = ready(client(recorder().fetch).historyWithId("H"));
  const s = emptyState();
  const id = newId();
  fold(s, [{ [id]: { e: "Task7", t: 0, p: { tp: 0, tt: "t", rr: null, rp: null, rt: [] } } }]);
  await assert.rejects(h.write([buildEditForTest(s, id)], { preflight: () => Number.NaN }), /invalid ancestor index/);
  await assert.rejects(h.write([{ uuid: newId(), kind: "Task7", action: 0, payload: { ...OK_CREATE(), tt: "x".repeat(2_000_000) } }]), /too large/);
  assert.throws(() => buildCreate({ title: "x", when: "tomorrow" as never }), /unknown schedule/);
  assert.throws(() => buildCreate({ title: "x", when: "today" }, { timeZone: "Mars/Olympus" }), WriteRefusedError);
});
import { buildEdit, UnknownKindError } from "../src/index.ts";
const buildEditForTest = (s: ReturnType<typeof emptyState>, id: string): WriteItem => buildEdit(s, id, { title: "y" });

test("getters and proxies are read once: the kind gate, ids and duplicate guard run on what is sent", async () => {
  const rec = recorder();
  const h = ready(client(rec.fetch).historyWithId("H"));
  let reads = 0;
  const flip = { uuid: newId(), action: 0, payload: {}, get kind() { return reads++ === 0 ? "Task7" : "Settings5"; } } as unknown as WriteItem;
  await assert.rejects(h.write([flip]), WriteRefusedError);
  assert.equal(rec.sent.length, 0);
  let idReads = 0;
  const good = newId();
  const idFlip = { kind: "Tag4", action: 0, payload: {}, get uuid() { return idReads++ < 1 ? good : "NOT-AN-ID"; } } as unknown as WriteItem;
  await assert.rejects(h.write([idFlip]), WriteRefusedError);
  assert.equal(rec.sent.length, 0);
});

test("a password that cannot be a header value is refused without echoing it", () => {
  assert.throws(() => new ThingsClient("a@b.c", "pw\nSECRET"), (e: unknown) => e instanceof ThingsError && !e.message.includes("SECRET"));
  assert.throws(() => new ThingsClient("a@b.c", "pässwörd€"), ThingsError);
  new ThingsClient("a@b.c", "plain pass ~!@#");
});

test("authenticated requests never attach the platform error, which could quote the header", async () => {
  const fetch: FetchLike = async () => { throw new TypeError('Headers.append: "Password hunter2" is an invalid header value'); };
  await assert.rejects(client(fetch).verify(), (e: unknown) => e instanceof ThingsNetworkError && e.cause === undefined && !JSON.stringify(e.message).includes("hunter2"));
});
