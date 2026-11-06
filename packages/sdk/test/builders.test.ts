import test from "node:test";
import assert from "node:assert/strict";
import { buildCreate, buildEdit, emptyState, fold, isValidId, newId, todayMidnightUtc, validateWrites, WriteRefusedError } from "../src/index.ts";
import type { State } from "../src/index.ts";

const ord = { tp: 0, rr: null, rp: null, rt: [], ss: 0, tr: false, tt: "t" };
const ID = { ordinary: newId(), tpl: newId(), inst: newId(), proj: newId(), sparse: newId(), missing: newId(), area: newId(), closed: newId(), rp: newId() };
function makeState(): State {
  const s = emptyState();
  fold(s, [
    { [ID.ordinary]: { e: "Task7", t: 0, p: ord } },
    { [ID.tpl]: { e: "Task7", t: 0, p: { ...ord, rr: { rrv: 4 }, rt: [ID.inst] } } },
    { [ID.inst]: { e: "Task7", t: 0, p: ord } },
    { [ID.proj]: { e: "Task7", t: 0, p: { ...ord, tp: 1 } } },
    { [ID.closed]: { e: "Task7", t: 0, p: { ...ord, tp: 1, ss: 3 } } },
    { [ID.sparse]: { e: "Task7", t: 0, p: { tp: 0, tt: "x" } } },
    { [ID.rp]: { e: "Task7", t: 0, p: { ...ord, rp: { modern: true } } } },
    { [ID.area]: { e: "Area3", t: 0, p: { tt: "A", tg: [], ix: 0 } } },
  ]);
  return s;
}
const refusal = (re: RegExp) => (e: unknown) => e instanceof WriteRefusedError && re.test(e.message);
const NOW = new Date("2026-11-05T22:30:00Z"); // 00:30 on 6 Nov in Bucharest, still 5 Nov in New York

test("create is an inbox Task7 with the verified 34-key shape", () => {
  const item = buildCreate({ title: "a", note: "n" }, { now: NOW });
  assert.ok(isValidId(item.uuid));
  assert.equal(Object.keys(item.payload).length, 34);
  assert.equal(item.payload["st"], 0);
  assert.equal(item.payload["md"], null);
  assert.equal(item.payload["cd"], NOW.getTime() / 1000);
});

test("'today' needs an explicit time zone and uses the zone's calendar day", () => {
  assert.throws(() => buildCreate({ title: "a", when: "today" }, { now: NOW }), refusal(/timeZone is required/));
  const bucharest = buildCreate({ title: "a", when: "today" }, { now: NOW, timeZone: "Europe/Bucharest" });
  const newYork = buildCreate({ title: "a", when: "today" }, { now: NOW, timeZone: "America/New_York" });
  assert.equal(bucharest.payload["sr"], Date.UTC(2026, 10, 6) / 1000);
  assert.equal(newYork.payload["sr"], Date.UTC(2026, 10, 5) / 1000);
  assert.equal(bucharest.payload["sr"], bucharest.payload["tir"]);
  assert.equal(bucharest.payload["st"], 1);
  assert.equal(todayMidnightUtc(NOW, "UTC"), Date.UTC(2026, 10, 5) / 1000);
});

test("someday and anytime carry no date", () => {
  for (const [when, st] of [["someday", 2], ["anytime", 1], ["inbox", 0]] as const) {
    const p = buildCreate({ title: "a", when }).payload;
    assert.equal(p["st"], st); assert.equal(p["sr"], null); assert.equal(p["tir"], null);
  }
});

test("edit works on an ordinary task and sets md", () => {
  const item = buildEdit(makeState(), ID.ordinary, { title: "new", note: "hello", complete: true }, { now: NOW });
  assert.equal(item.payload["tt"], "new");
  assert.equal(item.payload["ss"], 3);
  assert.equal(item.payload["sp"], NOW.getTime() / 1000);
  assert.equal(item.payload["md"], NOW.getTime() / 1000);
  assert.doesNotThrow(() => validateWrites([item]));
});

test("edit refuses recurrence, projects, sparse and unknown tasks, each for its own reason", () => {
  const s = makeState();
  assert.throws(() => buildEdit(s, ID.tpl, { title: "x" }), refusal(/recurrence/));
  assert.throws(() => buildEdit(s, ID.inst, { title: "x" }), refusal(/recurrence/));
  assert.throws(() => buildEdit(s, ID.proj, { title: "x" }), refusal(/ordinary tasks/));
  assert.throws(() => buildEdit(s, ID.sparse, { title: "x" }), refusal(/markers/));
  assert.throws(() => buildEdit(s, ID.rp, { title: "x" }), refusal(/recurrence/));
  assert.throws(() => buildEdit(s, ID.missing, { title: "x" }), refusal(/unknown task/));
  assert.throws(() => buildEdit(s, "not an id", { title: "x" }), refusal(/identifier/));
  assert.throws(() => buildEdit(s, ID.ordinary, { complete: true, reopen: true }), refusal(/complete and reopen/));
  assert.throws(() => buildEdit(s, ID.ordinary, { trash: true, restore: true }), refusal(/trash and restore/));
});

test("reopen and restore clear the stop date / trash flag", () => {
  const p = buildEdit(makeState(), ID.ordinary, { reopen: true, restore: true }).payload;
  assert.equal(p["ss"], 0); assert.equal(p["sp"], null); assert.equal(p["tr"], false);
});

test("moves: to area, to project, to nowhere; bad targets are refused", () => {
  const s = makeState();
  let p = buildEdit(s, ID.ordinary, { move: { area: ID.area } }).payload;
  assert.deepEqual([p["ar"], p["pr"], p["agr"]], [[ID.area], [], []]);
  p = buildEdit(s, ID.ordinary, { move: { project: ID.proj } }).payload;
  assert.deepEqual([p["ar"], p["pr"], p["agr"]], [[], [ID.proj], []]);
  p = buildEdit(s, ID.ordinary, { move: "none" }).payload;
  assert.deepEqual([p["ar"], p["pr"], p["agr"]], [[], [], []]);
  assert.throws(() => buildEdit(s, ID.ordinary, { move: { area: newId() } }), refusal(/area not found/));
  assert.throws(() => buildEdit(s, ID.ordinary, { move: { project: ID.ordinary } }), refusal(/project not found/));
  assert.throws(() => buildEdit(s, ID.ordinary, { move: { project: ID.tpl } }), refusal(/project not found/));
  assert.throws(() => buildEdit(s, ID.ordinary, { move: { project: ID.closed } }), refusal(/not open/));
});

test("scheduling edits write st, sr and tir together", () => {
  const p = buildEdit(makeState(), ID.ordinary, { when: "today" }, { now: NOW, timeZone: "UTC" }).payload;
  assert.deepEqual([p["st"], p["sr"], p["tir"]], [1, Date.UTC(2026, 10, 5) / 1000, Date.UTC(2026, 10, 5) / 1000]);
  assert.throws(() => buildEdit(makeState(), ID.ordinary, { when: "today" }, { now: NOW }), refusal(/timeZone/));
});
