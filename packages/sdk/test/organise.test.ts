import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAddChecklistItem, buildCreateArea, buildCreateTag, buildDelete, emptyState, fold, History, ItemAction, newId,
  ThingsClient, validateOrganiserWrites, WriteRefusedError,
} from "../src/index.ts";
import type { FetchLike, State, WriteItem } from "../src/index.ts";

const ord = { tp: 0, rr: null, rp: null, rt: [], ss: 0, tr: false, tt: "t" };
const ID = { done: newId(), task: newId(), proj: newId(), tag: newId(), area: newId(), used: newId(), tpl: newId(), inst: newId() };
function makeState(): State {
  const s = emptyState();
  fold(s, [
    { [ID.task]: { e: "Task7", t: 0, p: ord } },
    { [ID.done]: { e: "Task7", t: 0, p: { ...ord, ss: 3 } } },
    { [ID.proj]: { e: "Task7", t: 0, p: { ...ord, tp: 1 } } },
    { [ID.tpl]: { e: "Task7", t: 0, p: { ...ord, rr: { rrv: 4 }, rt: [ID.inst] } } },
    { [ID.inst]: { e: "Task7", t: 0, p: ord } },
    { [ID.tag]: { e: "Tag4", t: 0, p: { tt: "tag", ix: 0, sh: null, pn: [] } } },
    { [ID.area]: { e: "Area3", t: 0, p: { tt: "area", ix: 0, tg: [] } } },
    { [ID.used]: { e: "Task7", t: 0, p: { ...ord, tg: [ID.tag], ar: [ID.area] } } },
  ]);
  return s;
}
const refuse = (re: RegExp) => (e: unknown) => e instanceof WriteRefusedError && re.test(e.message);

test("builders produce the verified shapes", () => {
  const s = makeState();
  const tag = buildCreateTag(s, { title: "t", parent: ID.tag });
  assert.deepEqual(Object.keys(tag.payload), ["tt", "ix", "sh", "pn", "xx"]);
  assert.deepEqual(tag.payload["pn"], [ID.tag]);
  assert.equal(buildCreateArea({ title: "a" }).kind, "Area3");
  const item = buildAddChecklistItem(s, { taskId: ID.task, title: "step" });
  assert.deepEqual(item.payload["ts"], [ID.task]);
  assert.equal(item.payload["ix"], 0);
});

test("builders refuse bad targets", () => {
  const s = makeState();
  assert.throws(() => buildCreateTag(s, { title: "t", parent: newId() }), refuse(/parent tag not found/));
  assert.throws(() => buildCreateTag(s, { title: "  " }), refuse(/invalid title/));
  assert.throws(() => buildAddChecklistItem(s, { taskId: newId(), title: "x" }), refuse(/unknown task/));
  assert.throws(() => buildAddChecklistItem(s, { taskId: ID.proj, title: "x" }), refuse(/ordinary tasks/));
  assert.throws(() => buildAddChecklistItem(s, { taskId: ID.tpl, title: "x" }), refuse(/recurrence/));
  assert.throws(() => buildAddChecklistItem(s, { taskId: ID.done, title: "x" }), refuse(/open tasks/));
  assert.throws(() => buildAddChecklistItem(s, { taskId: ID.inst, title: "x" }), refuse(/recurrence/));
  assert.throws(() => buildDelete(s, "tag", ID.tag), refuse(/still in use/));
  assert.throws(() => buildDelete(s, "area", ID.area), refuse(/still in use/));
  assert.throws(() => buildDelete(s, "tag", newId()), refuse(/unknown tag/));
});

test("deleting an unreferenced tag, area or checklist item is allowed", () => {
  const s = emptyState();
  const t = newId(), a = newId(), c = newId();
  fold(s, [
    { [t]: { e: "Tag4", t: 0, p: { tt: "x", ix: 0, sh: null, pn: [] } } },
    { [a]: { e: "Area3", t: 0, p: { tt: "x", ix: 0, tg: [] } } },
    { [c]: { e: "ChecklistItem3", t: 0, p: { tt: "x", ix: 0, ts: [newId()] } } },
  ]);
  for (const [k, id] of [["tag", t], ["area", a], ["checklistItem", c]] as const) {
    const d = buildDelete(s, k, id);
    assert.equal(d.action, ItemAction.Deleted);
    assert.deepEqual(d.payload, {});
  }
});

test("the validator rejects extra keys, bad types, modifications and non-empty deletions", () => {
  const ok = buildCreateArea({ title: "a" });
  const bad = (p: Record<string, unknown>, action: ItemAction = ItemAction.Created, kind = "Area3"): WriteItem => ({ uuid: ok.uuid, kind, action, payload: p });
  const base = ok.payload;
  assert.throws(() => validateOrganiserWrites([bad({ ...base, extra: 1 })]), refuse(/exactly/));
  assert.throws(() => validateOrganiserWrites([bad({ ...base, tt: 5 })]), refuse(/title/));
  assert.throws(() => validateOrganiserWrites([bad({ ...base, tg: ["not-an-id"] })]), refuse(/identifier/));
  assert.throws(() => validateOrganiserWrites([bad({ ...base, xx: {} })]), refuse(/extension/));
  assert.throws(() => validateOrganiserWrites([bad({ tt: "x" }, ItemAction.Modified)]), refuse(/only creation and deletion/));
  assert.throws(() => validateOrganiserWrites([bad({ tt: "x" }, ItemAction.Deleted)]), refuse(/empty payload/));
  assert.throws(() => validateOrganiserWrites([bad({ ...base, tt: "\ud800" })]), refuse(/title/));
  const chk = buildAddChecklistItem(makeState(), { taskId: ID.task, title: "s" });
  assert.throws(() => validateOrganiserWrites([{ ...chk, payload: { ...chk.payload, ts: [] } }]), refuse(/identifier|exactly one/));
  assert.throws(() => validateOrganiserWrites([{ ...chk, payload: { ...chk.payload, ss: 3 } }]), refuse(/creation fields/));
});

function fakeHistory(): { h: History; posts: string[] } {
  const posts: string[] = [];
  const fetch: FetchLike = async (u, init) => {
    if (init.method === "POST") { posts.push(String(init.body)); return Response.json({ "server-head-index": 1 }); }
    return Response.json({});
  };
  const h = new ThingsClient("a@b.c", "pw", { endpoint: "https://x.invalid", fetch }).historyWithId("H");
  h.latestSchemaVersion = 301;
  return { h, posts };
}

test("History.write sends verified organiser kinds by default and refuses the rest", async () => {
  const { h, posts } = fakeHistory();
  const s = makeState();
  await h.write([buildCreateTag(s, { title: "t" })]);
  await h.write([buildCreateArea({ title: "a" })]);
  await h.write([buildAddChecklistItem(s, { taskId: ID.task, title: "c" })]);
  assert.equal(posts.length, 3);
  const mod: WriteItem = { uuid: ID.tag, kind: "Tag4", action: ItemAction.Modified, payload: { tt: "renamed" } };
  await assert.rejects(h.write([mod]), refuse(/only creation and deletion/));
  const wrong: WriteItem = { uuid: newId(), kind: "Tag4", action: ItemAction.Created, payload: { tt: "x" } };
  await assert.rejects(h.write([wrong]), refuse(/exactly/));
  await assert.rejects(h.write([{ uuid: newId(), kind: "Settings5", action: ItemAction.Created, payload: {} }]), refuse(/only Task7, Tag4/));
  assert.equal(posts.length, 3);
  await h.write([mod], { unsafe: { unverifiedKinds: true } }); // the escape hatch still works
  assert.equal(posts.length, 4);
});
