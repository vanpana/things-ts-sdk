import test from "node:test";
import assert from "node:assert/strict";
import { checkDrift, crc32, emptyState, fold, newId, textNote } from "../src/index.ts";
import type { Commit } from "../src/index.ts";

const ord = { tp: 0, rr: null, rp: null, rt: [], ss: 0, tr: false, tt: "t" };
const log = (): Commit[] => [{ [newId()]: { e: "Task7", t: 0, p: { ...ord, nt: textNote("hello") } } }, { [newId()]: { e: "Tag4", t: 0, p: { tt: "x", ix: 0, sh: null, pn: [] } } }];
const state = (commits: Commit[]) => fold(emptyState(), commits);
const codes = (r: ReturnType<typeof checkDrift>) => r.findings.map((f) => f.code);

test("a healthy log passes and counts its items", () => {
  const c = log();
  const r = checkDrift({ commits: c, state: state(c), schema: 301, head: c.length });
  assert.equal(r.ok, true); assert.equal(r.killSwitch, false); assert.deepEqual(r.findings, []);
  assert.equal(r.counts["Task7/0"], 1);
});

test("a new schema, an unknown kind, a bad action and a bad checksum are critical", () => {
  const c = log();
  assert.deepEqual(codes(checkDrift({ commits: c, state: state(c), schema: 302, head: c.length })), ["schema"]);
  const unknown = [...c, { [newId()]: { e: "Task8", t: 0, p: {} } }];
  const r = checkDrift({ commits: unknown, state: state(c), schema: 301, head: unknown.length });
  assert.ok(codes(r).includes("rebuild-failed")); assert.equal(r.killSwitch, true);
  const act = [...c, { [newId()]: { e: "Tag4", t: 7, p: {} } }];
  assert.ok(codes(checkDrift({ commits: act, state: state(c), schema: 301, head: act.length })).includes("action"));
  const bad = [{ [newId()]: { e: "Task7", t: 0, p: { ...ord, nt: { _t: "tx", t: 1, v: "abc", ch: crc32("abc") ^ 1 } } } }];
  assert.ok(codes(checkDrift({ commits: bad, state: emptyState(), schema: 301, head: bad.length })).includes("note-checksum"));
});

test("unseen payload keys are warnings, not failures", () => {
  const c = [...log(), { [newId()]: { e: "Task7", t: 0, p: { ...ord, brandNew: 1 } } }];
  const r = checkDrift({ commits: c, state: state(c), schema: 301, head: c.length });
  assert.equal(r.ok, true);
  assert.deepEqual(r.findings.map((f) => [f.severity, f.code]), [["warning", "new-keys"]]);
  assert.match(r.findings[0]!.message, /brandNew/);
});

test("a memoized state that differs from a rebuild is critical and the rebuild is returned", () => {
  const c = log();
  const stale = state(c.slice(0, 1));
  stale.cursor = c.length;
  const r = checkDrift({ commits: c, state: stale, schema: 301, head: c.length });
  assert.ok(codes(r).includes("state-diverged"));
  assert.equal(r.rebuilt?.tags.size, 1);
});

test("a log shorter than the server's head is critical, even when the state agrees with the short log", () => {
  const c = log();
  const r = checkDrift({ commits: c.slice(0, 1), state: state(c.slice(0, 1)), schema: 301, head: c.length });
  assert.ok(codes(r).includes("head")); assert.equal(r.killSwitch, true);
});

test("delete-and-recreate across batches is not a false divergence", () => {
  const a = newId(), b = newId();
  const c: Commit[] = [
    { [a]: { e: "Tag4", t: 0, p: { tt: "a", ix: 0, sh: null, pn: [] } } },
    { [b]: { e: "Tag4", t: 0, p: { tt: "b", ix: 0, sh: null, pn: [] } } },
    { [a]: { e: "Tag4", t: 2, p: null } },
    { [a]: { e: "Tag4", t: 0, p: { tt: "a", ix: 0, sh: null, pn: [] } } },
  ];
  const incremental = emptyState();
  for (const x of c) fold(incremental, [x]);
  const r = checkDrift({ commits: c, state: incremental, schema: 301, head: c.length });
  assert.deepEqual(r.findings, []);
});

test("damaged logs are reported, never thrown", () => {
  const st = emptyState();
  const r = checkDrift({ commits: [null as unknown as Commit], state: st, schema: 301, head: 1 });
  assert.ok(codes(r).includes("malformed-commit")); assert.equal(r.killSwitch, true);
  const noChecksum = [{ [newId()]: { e: "Task7", t: 0, p: { ...ord, nt: { _t: "tx", t: 1, v: "abc" } } } }];
  assert.ok(codes(checkDrift({ commits: noChecksum, state: emptyState(), schema: 301, head: 1 })).includes("note-checksum"));
  const scalar = [{ [newId()]: { e: "Task7", t: 0, p: 5 as unknown as Record<string, unknown> } }];
  assert.ok(codes(checkDrift({ commits: scalar, state: emptyState(), schema: 301, head: 1 })).includes("malformed-payload"));
});
