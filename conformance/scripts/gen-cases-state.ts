// Generates conformance inputs for the state fold. Run: node scripts/gen-cases-state.ts
import { writeFileSync } from "node:fs";
import { encodeUuid } from "../../packages/sdk/src/base58.ts";
import { crc32 } from "../../packages/sdk/src/crc32.ts";
import { mulberry32, pick } from "./prng.ts";

type Item = { uuid: string; e: string; t: number; p: unknown };
type Case = { name: string; batches: Item[][] };
const cases: Case[] = [];
const r = mulberry32(777);
const id = (n: number): string => encodeUuid(Uint8Array.from({ length: 16 }, (_, i) => (i === 15 ? n : (n * 31 + i * 7) & 0xff) | (i === 0 ? 1 : 0)));
const A = id(1), B = id(2), C = id(3), D = id(4), AREA = id(50), TAG = id(60), CL = id(70), PROJ = id(80);
const tx = (v: string) => ({ _t: "tx", ch: crc32(v), v, t: 1 });
const item = (uuid: string, e: string, t: number, p: unknown): Item => ({ uuid, e, t, p });
const add = (name: string, ...batches: Item[][]) => cases.push({ name, batches });
const full = (title: string, extra: Record<string, unknown> = {}) => ({
  tp: 0, sr: null, dds: null, rt: [], rmd: null, ss: 0, tr: false, dl: [], icp: false, st: 0, ar: [], tt: title, do: 0, lai: null, tir: null,
  tg: [], agr: [], ix: 5, cd: 1770000000.5, lt: false, icc: 0, md: null, ti: 0, dd: null, ato: null, nt: tx(""), icsd: null, pr: [], rp: null,
  acrd: null, sp: null, sb: 0, rr: null, xx: { sn: {}, _t: "oo" }, ...extra,
});

add("task7 create + sparse modify + complete + trash", [item(A, "Task7", 0, full("one"))], [item(A, "Task7", 1, { tt: "renamed", md: 1770000100.25 })], [item(A, "Task7", 1, { ss: 3, sp: 1770000200, md: 1770000200 })], [item(A, "Task7", 1, { tr: true, md: 1770000300 })], [item(A, "Task7", 2, {})]);
add("task6 create with partial fields", [item(A, "Task6", 0, { tt: "six", st: 1, sr: 1770681600, tir: 1770681600, ix: 3, cd: 1770000000 })]);
add("defaults: task with only a title", [item(A, "Task6", 0, { tt: "bare" })]);
add("explicit nulls clear clearable fields", [item(A, "Task7", 0, full("n", { sr: 1770681600, tir: 1770681600, st: 1, dd: 1771000000, sp: 1771000001, ss: 3, ato: 3600, ar: [AREA], pr: [PROJ], agr: [B], tg: [TAG], rt: [C], dl: [D], md: 1770000500 }))], [item(A, "Task7", 1, { sr: null, tir: null, dd: null, sp: null, md: null, ato: null, ar: null, pr: null, agr: null, tg: null, rt: null, dl: null })]);
add("clear arrays with empty arrays", [item(A, "Task7", 0, full("n", { ar: [AREA], tg: [TAG] }))], [item(A, "Task7", 1, { ar: [], tg: [] })]);
add("note: plain string, null, full text, delta", [item(A, "Task6", 0, { tt: "n", nt: "plain" })], [item(A, "Task6", 1, { nt: tx("full text") })], [item(A, "Task6", 1, { nt: { _t: "tx", t: 2, ps: [{ r: "FULL", p: 0, l: 4, ch: 1 }] } })], [item(A, "Task6", 1, { nt: null })], [item(A, "Task6", 1, { nt: { _t: "tx", t: 2, ps: [{ r: "after clear", p: 0, l: 0, ch: 1 }] } })]);
add("note: unicode delta uses byte offsets", [item(A, "Task7", 0, full("n", { nt: tx("Native Task7 note α 🚀\nSecond line.") }))], [item(A, "Task7", 1, { nt: { _t: "tx", t: 2, ps: [{ r: "Update", p: 26, l: 5, ch: 3672733299 }] }, md: 1 })]);
add("note: full text then delta inside one batch", [item(A, "Task6", 0, { tt: "n", nt: tx("abc") }), item(A, "Task6", 1, { nt: { _t: "tx", t: 2, ps: [{ r: "X", p: 1, l: 1, ch: 1 }] } })]);
add("note: delta that splits a character is rejected and rolls back the batch", [item(A, "Task6", 0, { tt: "ok", nt: tx("α") })], [item(B, "Task6", 0, { tt: "should not appear" }), item(A, "Task6", 1, { nt: { _t: "tx", t: 2, ps: [{ r: "x", p: 1, l: 0, ch: 1 }] } })]);
add("note: unsupported type is rejected", [item(A, "Task6", 0, { tt: "n", nt: { _t: "tx", t: 9, v: "x" } })]);
add("note: number is rejected", [item(A, "Task6", 0, { tt: "n", nt: 5 })]);
add("late malformed payload rolls back the whole batch", [item(A, "Task6", 0, { tt: "first" })], [item(B, "Task6", 0, { tt: "b" }), item(C, "Task6", 0, "not an object")]);
add("task payload types: title number", [item(A, "Task6", 0, { tt: 5 })]);
add("task payload types: fractional index", [item(A, "Task6", 0, { tt: "x", ix: 1.5 })]);
add("task payload types: tags not array", [item(A, "Task6", 0, { tt: "x", tg: "oops" })]);
add("task payload types: tr number", [item(A, "Task6", 0, { tt: "x", tr: 1 })]);
add("unknown task kind is rejected", [item(A, "Task6", 0, { tt: "ok" })], [item(B, "Task8", 0, { tt: "future" })]);
add("unknown non-task kind is skipped (lenient)", [item(A, "Task6", 0, { tt: "ok" }), item(B, "Command", 0, { x: 1 }), item(C, "Settings5", 0, { a: 1 })]);
add("unknown action is skipped", [item(A, "Task6", 0, { tt: "ok" }), item(A, "Task6", 7, { tt: "ignored" })]);
add("orphan modify creates a partial task", [item(A, "Task6", 1, { ss: 3 })]);
add("modify after delete recreates", [item(A, "Task6", 0, { tt: "a" }), item(A, "Task6", 2, {}), item(A, "Task6", 1, { st: 2 })]);
add("tombstone2 removes from every kind", [item(A, "Task6", 0, { tt: "t" }), item(AREA, "Area3", 0, { tt: "area" }), item(TAG, "Tag4", 0, { tt: "tag" }), item(CL, "ChecklistItem3", 0, { tt: "c", ts: [A] })], [item(id(90), "Tombstone2", 0, { dloid: A, dld: 1 }), item(id(91), "Tombstone2", 0, { dloid: AREA, dld: 1 }), item(id(92), "Tombstone2", 0, { dloid: TAG, dld: 1 }), item(id(93), "Tombstone2", 0, { dloid: CL, dld: 1 })]);
add("tombstone without dloid is skipped", [item(A, "Task6", 0, { tt: "t" }), item(id(90), "Tombstone2", 0, { dld: 1 })]);
add("areas, tags and checklist items", [item(AREA, "Area3", 0, { tt: "Home", ix: 1 }), item(TAG, "Tag4", 0, { tt: "urgent", sh: "u", pn: [], ix: 0 }), item(id(61), "Tag4", 0, { tt: "child", sh: "c", pn: [TAG] }), item(CL, "ChecklistItem3", 0, { tt: "step", ss: 0, ts: [A], ix: 2, cd: 1770000000, md: 1770000001, sp: null })], [item(CL, "ChecklistItem3", 1, { ss: 3, sp: 1770000500, tt: "step done" })], [item(AREA, "Area3", 1, { tt: "Home 2" })]);
const L1 = "3F2504E0-4F89-11D3-9A0C-0305E82C3301", L2 = "6BA7B810-9DAD-11D1-80B4-00C04FD430C8", L3 = "A1B2C3D4-0000-4000-8000-000000000001";
add("legacy kinds are keyed by their derived identifiers", [item(L1, "Task3", 0, { tt: "legacy task", ar: [L2], pr: [L3], tg: [L2] }), item(L2, "Area2", 0, { tt: "legacy area" }), item(L3, "Task4", 0, { tt: "legacy project", tp: 1 }), item(L2.toLowerCase(), "Tag3", 0, { tt: "legacy tag", pn: [L1] }), item(L1 + "-X", "ChecklistItem2", 0, { tt: "legacy check", ts: [L1] })]);
add("current-generation edit finds the legacy task", [item(L1, "Task3", 0, { tt: "legacy task", ix: 4 })], [item(encodeUuidFromLegacy(L1), "Task6", 1, { ss: 3, sp: 1770000000 })]);
add("legacy tombstone removes the migrated object", [item(L1, "Task3", 0, { tt: "legacy task" })], [item("TS1", "Tombstone", 0, { dloid: L1, dld: 5 })]);
add("legacy delete", [item(L1, "Task", 0, { tt: "plain legacy" })], [item(L1, "Task", 2, {})]);
add("canonical id under a legacy kind is not re-derived", [item(A, "Task4", 0, { tt: "canonical" })]);
add("recurrence instance legacy id", [item(`${L1}-20260101`, "Task3", 0, { tt: "instance", rt: [L1] })]);
add("settings are stored but not interpreted", [item(id(95), "Settings5", 0, { gp: 1 }), item(id(96), "Settings3", 0, { gp: 1 })]);

add("explicit null on required task fields is ignored", [item(A, "Task6", 0, { tt: "x", ss: 3, st: 2, ix: 4, tr: true, tp: 1, ti: 2, do: 1 })], [item(A, "Task6", 1, { tt: null, ss: null, st: null, ix: null, tr: null, tp: null, ti: null, do: null })]);
add("explicit null on creation date clears it", [item(A, "Task6", 0, { tt: "x", cd: 1770000000 })], [item(A, "Task6", 1, { cd: null })]);
add("rr with wrong types is rejected", [item(A, "Task6", 0, { tt: "x", rr: { fu: "daily" } })]);
add("rr as an array is rejected", [item(A, "Task6", 0, { tt: "x", rr: [1] })]);
add("rr with wrong detail type is rejected", [item(A, "Task6", 0, { tt: "x", rr: { fu: 16, fa: 1, of: [{ dy: "1" }] } })]);
add("rr valid", [item(A, "Task6", 0, { tt: "x", rr: { fu: 16, fa: 1, of: [{}], ia: 1770000000, rc: 5, rrv: 4, extra: true } })]);
add("lai string is rejected", [item(A, "Task6", 0, { tt: "x", lai: "abc" })]);
add("icp number is rejected", [item(A, "Task6", 0, { tt: "x", icp: 1 })]);
add("unknown keys are kept", [item(A, "Task6", 0, { tt: "x", zzz: { a: 1 } })]);

add("cycle in parent links", [item(A, "Task7", 0, full("a", { pr: [B] })), item(B, "Task7", 0, full("b", { pr: [A] }))]);
add("hierarchy for queries", [
  item(AREA, "Area3", 0, { tt: "Work", ix: 1 }), item(id(51), "Area3", 0, { tt: "Home", ix: 2 }),
  item(PROJ, "Task7", 0, full("Project X", { tp: 1, st: 1, ar: [AREA], ix: 1 })),
  item(id(81), "Task7", 0, full("Project loose", { tp: 1, st: 1, ix: 2 })),
  item(B, "Task7", 0, full("Heading", { tp: 2, st: 1, pr: [PROJ], ix: 1 })),
  item(A, "Task7", 0, full("in heading", { st: 1, pr: [PROJ], agr: [B], ix: 1 })),
  item(C, "Task7", 0, full("in project", { st: 1, pr: [PROJ], ix: 2 })),
  item(D, "Task7", 0, full("in area", { st: 1, ar: [AREA], ix: 3 })),
  item(id(5), "Task7", 0, full("loose", { st: 0, ix: 4 })),
  item(id(6), "Task7", 0, full("done in project", { st: 1, pr: [PROJ], ss: 3, sp: 1770000000, ix: 5 })),
  item(id(7), "Task7", 0, full("trashed in area", { st: 1, ar: [AREA], tr: true, ix: 6 })),
  item(id(8), "Task7", 0, full("in loose project", { st: 1, pr: [id(81)], ix: 7 })),
  item(TAG, "Tag4", 0, { tt: "p", sh: "b", pn: [], ix: 0 }), item(id(61), "Tag4", 0, { tt: "c1", sh: "z", pn: [TAG] }), item(id(62), "Tag4", 0, { tt: "c2", sh: "a", pn: [TAG] }),
  item(CL, "ChecklistItem3", 0, { tt: "step 1", ss: 0, ts: [A], ix: 2 }), item(id(71), "ChecklistItem3", 0, { tt: "step 2", ss: 3, ts: [A], ix: 1 }),
]);

// Randomised sequences with realistic payloads.
const pool = [A, B, C, D, PROJ];
const randPayload = (target: string): Record<string, unknown> => {
  const p: Record<string, unknown> = {};
  const set = <T>(k: string, v: T) => { p[k] = v; };
  if (r() < 0.5) set("tt", pick(r, ["alpha", "βeta", "gamma 🚀", ""]));
  if (r() < 0.2) { set("ss", pick(r, [0, 2, 3])); set("sp", r() < 0.5 ? 1771000000 + Math.floor(r() * 1000) : null); }
  if (r() < 0.25) { const d = r() < 0.5 ? null : 1770681600 + Math.floor(r() * 5) * 86400; set("st", pick(r, [0, 1, 2])); set("sr", d); set("tir", d); }
  if (r() < 0.15) set("dd", r() < 0.5 ? null : 1771000000);
  if (r() < 0.15) set("tr", r() < 0.5);
  if (r() < 0.2) set("ix", Math.floor(r() * 100));
  if (r() < 0.15) set("ti", Math.floor(r() * 10));
  if (r() < 0.15) set("do", Math.floor(r() * 3));
  if (r() < 0.2) { set("ar", r() < 0.4 ? [] : [AREA]); }
  if (r() < 0.2) { set("pr", r() < 0.4 || target === PROJ ? [] : [PROJ]); }
  if (r() < 0.1) { set("agr", r() < 0.5 ? [] : [B]); }
  if (r() < 0.15) { set("tg", r() < 0.4 ? [] : [TAG]); }
  if (r() < 0.1) set("md", 1770000000 + Math.floor(r() * 100000) + 0.5);
  if (r() < 0.1) set("tp", pick(r, [0, 1, 2]));
  if (r() < 0.3) set("nt", pick(r, [() => null, () => "plain", () => tx("full " + Math.floor(r() * 9)), () => ({ _t: "tx", t: 2, ps: [{ r: pick(r, ["Q", "", "zz"]), p: Math.floor(r() * 6), l: Math.floor(r() * 4), ch: 1 }] })])());
  return p;
};
for (let c = 0; c < 150; c++) {
  const batches: Item[][] = [];
  const nb = 1 + Math.floor(r() * 4);
  for (let b = 0; b < nb; b++) {
    const batch: Item[] = [];
    const n = 1 + Math.floor(r() * 6);
    for (let i = 0; i < n; i++) {
      const target = pick(r, pool);
      const kind = pick(r, ["Task6", "Task7", "Task6"]);
      const roll = r();
      batch.push(roll < 0.35 ? item(target, kind, 0, randPayload(target)) : roll < 0.9 ? item(target, kind, 1, randPayload(target)) : item(target, kind, 2, {}));
    }
    batches.push(batch);
  }
  cases.push({ name: `random ${c}`, batches });
}

function encodeUuidFromLegacy(legacy: string): string {
  // Filled in by the SDK's own function: the oracle checks that the TS-derived id is the one Go also derives.
  return legacyDerived(legacy);
}
import { encodeLegacyIdentifier } from "../../packages/sdk/src/base58.ts";
function legacyDerived(s: string): string { return encodeLegacyIdentifier(s); }

export { cases };
if (import.meta.main) {
  writeFileSync(new URL("../cases/state.json", import.meta.url), JSON.stringify(cases, null, 1) + "\n");
  console.log("state cases", cases.length);
}
