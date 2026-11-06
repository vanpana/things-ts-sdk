import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  allTasks, applyItems, crc32, emptyState, exportState, flattenCommits, fold, importState, MalformedItemError, newId,
  UnknownKindError, UnsupportedTaskKindError,
} from "../src/index.ts";
import { sha1 } from "../src/sha1.ts";

test("crc32 known vectors", () => {
  assert.equal(crc32(""), 0);
  assert.equal(crc32("123456789"), 0xcbf43926);
  assert.equal(crc32("The quick brown fox jumps over the lazy dog"), 0x414fa339);
});

test("sha1 agrees with node:crypto, including padding boundaries", () => {
  for (const n of [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) {
    const data = Uint8Array.from({ length: n }, (_, i) => (i * 7 + n) & 0xff);
    assert.equal(Buffer.from(sha1(data)).toString("hex"), createHash("sha1").update(data).digest("hex"), `length ${n}`);
  }
});

test("fold advances the cursor by the number of commits", () => {
  const s = emptyState();
  const a = newId();
  fold(s, [{ [a]: { e: "Task6", t: 0, p: { tt: "x" } } }, { [a]: { e: "Task6", t: 1, p: { tt: "y" } } }]);
  assert.equal(s.cursor, 2);
  assert.equal(allTasks(s)[0]!.title, "y");
});

test("a failed batch changes nothing, not even the cursor", () => {
  const s = emptyState();
  const a = newId();
  fold(s, [{ [a]: { e: "Task6", t: 0, p: { tt: "keep", nt: "before" } } }]);
  const before = JSON.stringify(exportState(s));
  assert.throws(() => fold(s, [
    { [a]: { e: "Task6", t: 1, p: { tt: "changed", nt: "after" } } },
    { [newId()]: { e: "Task6", t: 0, p: "not an object" } },
  ]), MalformedItemError);
  assert.equal(JSON.stringify(exportState(s)), before);
});

test("strict mode rejects unknown kinds; lenient skips non-task ones; unknown task kinds always fail", () => {
  const a = newId();
  const odd = [{ uuid: a, kind: "Command", action: 0, payload: { x: 1 } }];
  assert.throws(() => applyItems(emptyState(), odd), UnknownKindError);
  assert.doesNotThrow(() => applyItems(emptyState(), odd, { mode: "lenient" }));
  for (const mode of ["strict", "lenient"] as const) {
    assert.throws(() => applyItems(emptyState(), [{ uuid: a, kind: "Task8", action: 0, payload: {}, serverIndex: 41 }], { mode }), (e: unknown) => e instanceof UnsupportedTaskKindError && e.serverIndex === 41 && e.kind === "Task8");
  }
  // The diagnostic never echoes arbitrary server text.
  assert.throws(() => applyItems(emptyState(), [{ uuid: a, kind: "Task\u001b[31mhacked", action: 0, payload: {} }]), (e: unknown) => e instanceof UnsupportedTaskKindError && e.kind === "Task*" && !e.message.includes("hacked"));
});

test("strict mode rejects malformed non-task payloads", () => {
  assert.throws(() => applyItems(emptyState(), [{ uuid: newId(), kind: "Area3", action: 0, payload: "x" }]), MalformedItemError);
  assert.throws(() => applyItems(emptyState(), [{ uuid: newId(), kind: "Tombstone2", action: 0, payload: {} }]), MalformedItemError);
});

test("flattenCommits rejects items without a kind or action", () => {
  assert.throws(() => flattenCommits([{ x: { e: 5, t: 0, p: {} } } as never]), MalformedItemError);
  assert.throws(() => flattenCommits([{ x: { e: "Task6", p: {} } } as never]), MalformedItemError);
  assert.throws(() => flattenCommits([null as never]), MalformedItemError);
});

test("flattenCommits records the server index of each commit", () => {
  const items = flattenCommits([{ a: { e: "Task6", t: 0, p: {} }, b: { e: "Task6", t: 0, p: {} } }, { c: { e: "Task6", t: 0, p: {} } }], 10);
  assert.deepEqual(items.map((i) => [i.uuid, i.serverIndex]), [["a", 10], ["b", 10], ["c", 11]]);
});

test("exportState / importState round-trips and refuses another version", () => {
  const s = emptyState();
  const a = newId();
  fold(s, [{ [a]: { e: "Task6", t: 0, p: { tt: "x", nt: "note" } } }]);
  const snap = JSON.parse(JSON.stringify(exportState(s)));
  const back = importState(snap)!;
  assert.equal(back.cursor, 1);
  assert.equal(allTasks(back)[0]!.note, "note");
  assert.equal(importState({ ...snap, stateVersion: 999 }), null);
});

test("the caller's payload is never mutated, even for legacy remapping", () => {
  const payload = { tt: "legacy", ar: ["3F2504E0-4F89-11D3-9A0C-0305E82C3301"] };
  const copy = JSON.stringify(payload);
  applyItems(emptyState(), [{ uuid: "6BA7B810-9DAD-11D1-80B4-00C04FD430C8", kind: "Task3", action: 0, payload }]);
  assert.equal(JSON.stringify(payload), copy);
});

import { ThingsClient, ThingsError } from "../src/index.ts";

test("the password is not reachable from the client object, and plain http is refused", () => {
  const c = new ThingsClient("a@b.c", "hunter2-secret");
  assert.ok(!JSON.stringify(c).includes("hunter2"));
  assert.ok(!Object.getOwnPropertyNames(c).some((k) => String((c as never)[k]).includes("hunter2")));
  assert.ok(!(require_inspect(c)).includes("hunter2"));
  assert.throws(() => new ThingsClient("a@b.c", "pw", { endpoint: "http://cloud.culturedcode.com" }), ThingsError);
  assert.doesNotThrow(() => new ThingsClient("a@b.c", "pw", { endpoint: "http://localhost:8787", allowInsecure: true }));
});

import { inspect } from "node:util";
function require_inspect(v: unknown): string { return inspect(v, { depth: 5, showHidden: true }); }

test("error messages never contain the history key or the email", async () => {
  const c = new ThingsClient("person@example.com", "pw", { endpoint: "https://x.invalid", fetch: async () => new Response("not json", { status: 200 }) });
  await assert.rejects(c.history("SECRET-HISTORY-KEY"), (e: unknown) => e instanceof ThingsError && !e.message.includes("SECRET") && !e.message.includes("person@"));
  await assert.rejects(c.verify(), (e: unknown) => e instanceof ThingsError && !e.message.includes("person@"));
});
