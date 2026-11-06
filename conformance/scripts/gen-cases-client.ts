// Generates conformance inputs for the HTTP client and the write validation. Run: node scripts/gen-cases-client.ts
import { writeFileSync } from "node:fs";
import { encodeLegacyIdentifier, encodeUuid } from "../../packages/sdk/src/base58.ts";
import { crc32 } from "../../packages/sdk/src/crc32.ts";

type Op = Record<string, unknown>;
type Case = { name: string; email: string; password: string; history: { id: string; commits: unknown[]; pageSize: number }; responses: Record<string, unknown>; ops: Op[] };
const cases: Case[] = [];
const id = (n: number): string => encodeUuid(Uint8Array.from({ length: 16 }, (_, i) => (i === 15 ? n : (n * 29 + i * 11) & 0xff) | (i === 0 ? 1 : 0)));
const tx = (v: string) => ({ _t: "tx", ch: crc32(v), v, t: 1 });
const HID = "H1ST0RY-KEY";
const mk = (name: string, ops: Op[], extra: Partial<Case> = {}): Case => ({ name, email: "me@example.com", password: "s3cret", history: { id: HID, commits: [], pageSize: 0 }, responses: {}, ops, ...extra });

const full = (title: string, extra: Record<string, unknown> = {}) => ({
  tp: 0, sr: null, dds: null, rt: [], rmd: null, ss: 0, tr: false, dl: [], icp: false, st: 0, ar: [], tt: title, do: 0, lai: null, tir: null,
  tg: [], agr: [], ix: 0, cd: 1770000000.5, lt: false, icc: 0, md: null, ti: 0, dd: null, ato: null, nt: tx(""), icsd: null, pr: [], rp: null,
  acrd: null, sp: null, sb: 0, rr: null, xx: { sn: {}, _t: "oo" }, ...extra,
});
const DAY = 1770681600;

// ---- history used by modification preflight ----
const T_ORD = id(1), T_TPL = id(2), T_INST = id(3), T_SPARSE = id(4), T_ACRD = id(5), T_DEL = id(6), T_FUT = id(7), T_DUP = id(8), T_ICSD = id(9), T_LEG = id(10), T_AREA = id(11), T_PRJ = id(12);
const commit = (uuid: string, e: string, t: number, p: unknown) => ({ [uuid]: { e, t, p } });
const without = (p: Record<string, unknown>, ...keys: string[]) => { const q = { ...p }; for (const k of keys) delete q[k]; return q; };
const LEGACY_ID = "3F2504E0-4F89-11D3-9A0C-0305E82C3301";
const T_NORT = id(20), T_NORR = id(21), T_NORP = id(22), T_RTNULL = id(23), T_RPSET = id(24), T_ORPHAN = id(25), T_RECREATED = id(26), T_NOTASK = id(27), T_COLLIDE = encodeLegacyIdentifier(LEGACY_ID), T_RREMPTY = id(29), T_RTLINK = id(30), T_MARKERS_LATER = id(31), T_BADPAYLOAD = id(32), T_STR_RT = id(33), LEGACY_ID2 = "6BA7B810-9DAD-11D1-80B4-00C04FD430C8", T_SAMEIDX = encodeLegacyIdentifier(LEGACY_ID2), T_TOMBCREATE = id(34);
const history = [
  commit(T_ORD, "Task7", 0, full("ordinary")),
  commit(T_TPL, "Task6", 0, full("template", { rr: { fu: 256, fa: 1, of: [{ wd: 1 }], ia: DAY, rc: 0, ed: 64092211200, rrv: 4 } })),
  commit(T_INST, "Task6", 0, full("instance", { rt: [T_TPL] })),
  commit(T_SPARSE, "Task6", 0, { tt: "sparse" }),
  commit(T_ACRD, "Task7", 0, full("acrd", { acrd: DAY })),
  commit(T_DEL, "Task7", 0, full("deleted")),
  commit(id(90), "Tombstone2", 0, { dloid: T_DEL, dld: 5 }),
  commit(T_FUT, "Task8", 0, { tt: "future kind" }),
  commit(T_DUP, "Task7", 0, full("dup")),
  commit(T_DUP, "Task7", 0, full("dup again")),
  commit(T_ICSD, "Task7", 0, full("icsd", { icsd: DAY })),
  commit("3F2504E0-4F89-11D3-9A0C-0305E82C3301", "Task3", 0, { tt: "legacy", rr: null, rp: null, rt: [] }),
  { [T_AREA]: { e: "Area3", t: 0, p: { tt: "area" } }, [T_PRJ]: { e: "Task7", t: 0, p: full("project", { tp: 1, st: 1 }) } },
  commit(T_ORD, "Task7", 1, { tt: "ordinary renamed", md: 1770000500 }),
  commit(T_NORT, "Task7", 0, without(full("no rt"), "rt")),
  commit(T_NORR, "Task7", 0, without(full("no rr"), "rr")),
  commit(T_NORP, "Task7", 0, without(full("no rp"), "rp")),
  commit(T_RTNULL, "Task6", 0, full("rt null", { rt: null })),
  commit(T_RPSET, "Task7", 0, full("rp set", { rp: { x: 1 } })),
  commit(T_ORPHAN, "Task7", 1, { tt: "modified before created", md: 1 }),
  commit(T_RECREATED, "Task7", 0, full("first life")),
  commit(T_RECREATED, "Task7", 2, {}),
  commit(T_RECREATED, "Task7", 0, full("second life")),
  commit(T_NOTASK, "Area3", 0, { tt: "area with a task-looking id" }),
  { [LEGACY_ID]: { e: "Task3", t: 0, p: { tt: "legacy", rr: null, rp: null, rt: [] } }, [T_COLLIDE]: { e: "Task7", t: 0, p: full("collides with its legacy id") } },
  commit(T_RREMPTY, "Task7", 0, full("rr empty object", { rr: {} })),
  commit(T_RTLINK, "Task7", 0, full("rt linked", { rt: [id(40)] })),
  commit(T_MARKERS_LATER, "Task6", 0, { tt: "sparse then complete" }),
  commit(T_MARKERS_LATER, "Task6", 1, { rr: null, rp: null, rt: [], md: 1 }),
  commit(T_BADPAYLOAD, "Task7", 0, "not an object"),
  commit(T_STR_RT, "Task7", 0, full("rt string", { rt: "oops" })),
  { [LEGACY_ID2]: { e: "Task3", t: 0, p: { tt: "legacy", rr: null, rp: null, rt: [] } }, [T_SAMEIDX]: { e: "Task6", t: 1, p: { tt: "modified in the same commit", md: 1 } } },
  commit(T_TOMBCREATE, "Task7", 0, full("to be deleted and recreated in one commit")),
  { [id(95)]: { e: "Tombstone2", t: 0, p: { dloid: T_TOMBCREATE, dld: 5 } }, [T_TOMBCREATE]: { e: "Task7", t: 0, p: full("recreated") } },
];

const writeOp = (items: { uuid: string; e: string; t: number; p: unknown }[], setLatest = 14): Op => ({ op: "write", items, setLatest });
const create = (p: unknown, uuid = id(100)) => writeOp([{ uuid, e: "Task7", t: 0, p }], 14);
const modify = (uuid: string, p: unknown) => writeOp([{ uuid, e: "Task7", t: 1, p }]);

// ---- plain client behaviour ----
cases.push(mk("verify, histories and history key", [{ op: "verify" }, { op: "ownHistory" }, { op: "history" }, { op: "histories" }, { op: "createHistory" }]));
cases.push(mk("items paging and head", [{ op: "items", start: 0 }, { op: "items", start: 2 }, { op: "items", start: 14 }, { op: "items", start: 99 }, { op: "sync" }], { history: { id: HID, commits: history, pageSize: 5 } }));
cases.push(mk("items on an empty history", [{ op: "items", start: 0 }, { op: "sync" }]));
cases.push(mk("delete and register app instance", [{ op: "delete" }, { op: "registerAppInstance", appInstanceId: "INST-1", historyKey: HID, apnsToken: "tok", appId: "com.culturedcode.ThingsMac", dev: true }]));
cases.push(mk("unauthorized and server errors", [{ op: "verify" }, { op: "history" }, { op: "histories" }, { op: "items", start: 0 }, { op: "delete" }, { op: "createHistory" }],
  { responses: { [`GET /version/1/account/me@example.com`]: { status: 401, body: null }, [`GET /version/1/history/${HID}`]: { status: 500, body: null }, [`GET /version/1/account/me@example.com/own-history-keys`]: { status: 401, body: null }, [`GET /version/1/history/${HID}/items`]: { status: 503, body: null }, [`DELETE /version/1/account/me@example.com/own-history-keys/${HID}`]: { status: 200, body: null }, [`POST /version/1/account/me@example.com/own-history-keys`]: { status: 500, body: null } } }));
cases.push(mk("malformed bodies", [{ op: "verify" }, { op: "history" }, { op: "histories" }], { responses: { [`GET /version/1/account/me@example.com`]: { status: 200, body: "x" }, [`GET /version/1/history/${HID}`]: { status: 200, body: "x" }, [`GET /version/1/account/me@example.com/own-history-keys`]: { status: 200, body: { not: "array" } } } }));
cases.push(mk("commit failures", [
  writeOp([{ uuid: id(100), e: "Task7", t: 0, p: full("a") }], 3),
], { responses: { [`POST /version/1/history/${HID}/commit`]: { status: 409, body: null } } }));
cases.push(mk("commit success updates the head", [writeOp([{ uuid: id(100), e: "Task7", t: 0, p: full("a") }], 3), writeOp([{ uuid: id(101), e: "Tag4", t: 0, p: { tt: "t" } }], 4)]));

// ---- envelope-level write checks (all must agree on accept/reject) ----
const ok = full("ok");
const envelope: Op[] = [
  writeOp([{ uuid: id(100), e: "Task7", t: 0, p: ok }], 0),
  writeOp([{ uuid: id(100), e: "Task7", t: 0, p: ok }, { uuid: id(100), e: "Task7", t: 0, p: ok }], 0),
  writeOp([{ uuid: "not-base58-0OIl", e: "Task7", t: 0, p: ok }], 0),
  writeOp([{ uuid: "", e: "Task7", t: 0, p: ok }], 0),
  writeOp([{ uuid: id(100), e: "Task7", t: 2, p: {} }], 0),
  writeOp([{ uuid: id(100), e: "Task7", t: 5, p: ok }], 0),
  writeOp([{ uuid: id(100), e: "Task7", t: 0, p: "str" }], 0),
  writeOp([{ uuid: id(100), e: "Task7", t: 0, p: [] }], 0),
  writeOp([{ uuid: id(100), e: "Task7", t: 0, p: null }], 0),
  writeOp([{ uuid: id(100), e: "Task5", t: 0, p: ok }], 0),
  writeOp([{ uuid: id(100), e: "Task8", t: 0, p: ok }], 0),
  writeOp([{ uuid: id(100), e: "TaskX", t: 0, p: ok }], 0),
  writeOp([{ uuid: id(100), e: "Task6", t: 0, p: { tt: "legacy writer" } }], 0),
  writeOp([{ uuid: id(100), e: "Task4", t: 0, p: { tt: "x" } }], 0),
  writeOp([{ uuid: id(100), e: "Tag4", t: 0, p: { tt: "tag", sh: "t", pn: [], ix: 0 } }], 0),
  writeOp([{ uuid: id(100), e: "Area3", t: 0, p: { tt: "area", ix: 0 } }], 0),
  writeOp([{ uuid: id(100), e: "ChecklistItem3", t: 0, p: { tt: "c", ts: [id(1)] } }], 0),
  writeOp([{ uuid: id(100), e: "Whatever", t: 0, p: { a: 1 } }], 0),
  writeOp([{ uuid: id(100), e: "Task7", t: 0, p: ok }, { uuid: id(101), e: "Tag4", t: 0, p: { tt: "x" } }], 0),
  writeOp([{ uuid: id(100), e: "Task7", t: 0, p: ok }, { uuid: id(102), e: "Tombstone2", t: 0, p: { dloid: id(103), dld: 5 } }], 0),
  writeOp([{ uuid: id(100), e: "Task7", t: 0, p: ok }, { uuid: id(102), e: "Tombstone2", t: 0, p: { dloid: id(100), dld: 5 } }], 0),
  writeOp([{ uuid: id(100), e: "Task7", t: 0, p: ok }, { uuid: id(102), e: "Tombstone2", t: 1, p: { dloid: id(103), dld: 5 } }], 0),
  writeOp([{ uuid: id(100), e: "Task7", t: 0, p: ok }, { uuid: id(102), e: "Tombstone2", t: 0, p: { dloid: "bad id", dld: 5 } }], 0),
  writeOp([{ uuid: id(100), e: "Task7", t: 0, p: ok }, { uuid: id(102), e: "Tombstone2", t: 0, p: { dloid: id(103) } }], 0),
  writeOp([{ uuid: id(100), e: "Task7", t: 0, p: ok }, { uuid: id(102), e: "Tombstone2", t: 0, p: { dloid: id(103), dld: 5, extra: 1 } }], 0),
  writeOp([{ uuid: id(100), e: "Task7", t: 0, p: ok }, { uuid: id(102), e: "Tombstone", t: 0, p: { dloid: "3F2504E0-4F89-11D3-9A0C-0305E82C3301", dld: 5 } }], 0),
  writeOp([{ uuid: id(100), e: "Task7", t: 0, p: ok }, { uuid: id(102), e: "Tombstone", t: 0, p: { dloid: "", dld: 5 } }], 0),
  writeOp([{ uuid: id(100), e: "Task7", t: 0, p: ok }, { uuid: id(102), e: "Tombstone2", t: 0, p: { dloid: id(103), dld: 0 } }], 0),
  writeOp([{ uuid: id(102), e: "Tombstone2", t: 0, p: { dloid: "anything goes without a Task7 sibling", dld: 5 } }], 0),
  writeOp([{ uuid: id(100), e: "Task7", t: 0, p: ok }, { uuid: id(101), e: "Task6", t: 0, p: { tt: "x" } }], 0),
  writeOp([{ uuid: id(100), e: "Task7", t: 0, p: ok }, { uuid: id(101), e: "Task8", t: 0, p: { tt: "x" } }], 0),
];
cases.push(mk("write envelope checks", envelope));

// ---- create mutations ----
const VALUES: [string, unknown][] = [["remove", undefined], ["null", null], ["string", "s"], ["zero", 0], ["fraction", 1.5], ["true", true], ["emptyArray", []], ["badIdArray", ["bad id"]], ["object", {}], ["huge", 1e12]];
const EXTRA: Record<string, unknown[]> = {
  ss: [2, 3, 4, -1, 1], st: [3, -1, 2, 1, 0], tp: [-1, 0, 1, 2, 3], sp: [0, -1, 1770000000], md: [0, -1, 1770000000, 253402300799, -62135596800],
  cd: [0, -1, 253402300799], tr: [1, 0, "true"], ix: [-1, 5, 2147483648], ti: [-1, 5], do: [-1, 5], sr: [-62135596801, 0, DAY + 1], tir: [0, DAY + 1], dd: [0, -5],
  ar: [[id(11)], [id(11), id(12)], [""]], pr: [[id(12)], [id(11), id(12)]], agr: [[id(12)], [id(11), id(12)]], tg: [[id(60)], [id(60), id(61)], [""]],
  tt: ["", "x".repeat(10)], nt: [tx("a"), { _t: "tx", ch: 0, v: "", t: 1 }],
};
const extras = (key: string): unknown[] => EXTRA[key] ?? [];
const mutate = (base: Record<string, unknown>, key: string, value: unknown): Record<string, unknown> => {
  const p = { ...base };
  if (value === undefined) delete p[key]; else p[key] = value;
  return p;
};
const chunk = <T>(xs: T[], n: number): T[][] => Array.from({ length: Math.ceil(xs.length / n) }, (_, i) => xs.slice(i * n, i * n + n));

const createVariants: Record<string, Record<string, unknown>> = {
  inbox: full("inbox"),
  today: full("today", { st: 1, sr: DAY, tir: DAY }),
  someday: full("someday", { st: 2 }),
  project: full("project", { tp: 1, st: 1 }),
  heading: full("heading", { tp: 2, st: 1 }),
  withNote: full("note", { nt: tx("héllo 🚀") }),
  inArea: full("in area", { ar: [id(11)], st: 1 }),
  inProject: full("in project", { pr: [id(12)], st: 1 }),
  badNoteChecksum: full("bad crc", { nt: { _t: "tx", ch: 1, v: "x", t: 1 } }),
  inboxWithDate: full("inbox dated", { sr: DAY, tir: DAY }),
  srTirMismatch: full("mismatch", { st: 1, sr: DAY, tir: DAY + 86400 }),
  twoParents: full("two", { ar: [id(11), id(12)] }),
  stNotOneForProject: full("p", { tp: 1, st: 0 }),
  tpThree: full("p", { tp: 3 }),
};
const createOps: Op[] = [];
for (const [vname, base] of Object.entries(createVariants)) {
  createOps.push(create(base));
  if (["inbox", "today", "withNote"].includes(vname)) {
    for (const key of Object.keys(base)) {
      for (const [, value] of VALUES) createOps.push(create(mutate(base, key, value)));
      for (const value of extras(key)) createOps.push(create(mutate(base, key, value)));
    }
  } else {
    for (const key of ["nt", "xx", "ar", "pr", "agr", "tg", "tp", "st", "sr", "tir", "cd", "md"]) for (const [, value] of VALUES.slice(0, 7)) createOps.push(create(mutate(base, key, value)));
  }
}
createOps.push(create({ ...full("extra key"), unknownKey: 1 }));
createOps.push(create({ ...full("nt extra"), nt: { ...tx("x"), extra: 1 } }));
createOps.push(create({ ...full("xx extra"), xx: { sn: { a: 1 }, _t: "oo" } }));
createOps.push(create({ ...full("xx tag"), xx: { sn: {}, _t: "zz" } }));
createOps.push(create({ ...full("nt type"), nt: { ...tx("x"), t: 2 } }));
createOps.push(create({ ...full("nt tag"), nt: { ...tx("x"), _t: "ty" } }));
createOps.push(create({ ...full("nt ch float"), nt: { ...tx("x"), ch: crc32("x") + 0.5 } }));
createOps.push(create({ ...full("nt ch big"), nt: { ...tx("x"), ch: 4294967296 } }));
createOps.push(create({ ...full("nt ch neg"), nt: { ...tx("x"), ch: -1 } }));
for (const [i, ch] of chunk(createOps, 60).entries()) cases.push(mk(`create validation ${i}`, ch, { history: { id: HID, commits: [], pageSize: 0 } }));

// ---- modification mutations (with preflight against `history`) ----
const MODS: Record<string, Record<string, unknown>> = {
  title: { md: 1770000600, tt: "new" },
  note: { md: 1770000600, nt: tx("a note") },
  complete: { md: 1770000600, ss: 3, sp: 1770000600 },
  reopen: { md: 1770000600, ss: 0, sp: null },
  today: { md: 1770000600, st: 1, sr: DAY, tir: DAY },
  inbox: { md: 1770000600, st: 0, sr: null, tir: null },
  someday: { md: 1770000600, st: 2, sr: null, tir: null },
  upcoming: { md: 1770000600, st: 2, sr: DAY + 864000, tir: DAY + 864000, dd: DAY + 900000 },
  moveArea: { md: 1770000600, ar: [T_AREA], pr: [], agr: [] },
  moveProject: { md: 1770000600, pr: [T_PRJ], ar: [], agr: [] },
  moveTwo: { md: 1770000600, pr: [T_PRJ], ar: [T_AREA] },
  trash: { md: 1770000600, tr: true },
  restore: { md: 1770000600, tr: false },
  order: { md: 1770000600, ix: 5, ti: 2, do: 1 },
  tags: { md: 1770000600, tg: [id(60)] },
  everything: { md: 1770000600, tt: "x", nt: tx("y"), st: 1, sr: DAY, tir: DAY, dd: null, ar: [], pr: [], agr: [], tg: [], ss: 0, sp: null, tr: false, ix: 1, ti: 1, do: 1 },
  forbiddenKey: { md: 1770000600, rr: null },
  forbiddenCd: { md: 1770000600, cd: 5 },
  noMd: { tt: "x" },
};
const modOps: Op[] = [];
for (const target of [T_ORD, T_TPL, T_INST, T_SPARSE, T_ACRD, T_DEL, T_FUT, T_DUP, T_ICSD, T_LEG, id(777), LEGACY_ID, T_NORT, T_NORR, T_NORP, T_RTNULL, T_RPSET, T_ORPHAN, T_RECREATED, T_NOTASK, T_COLLIDE, T_RREMPTY, T_RTLINK, T_MARKERS_LATER, T_BADPAYLOAD, T_STR_RT, T_SAMEIDX, T_TOMBCREATE, LEGACY_ID2]) {
  for (const base of Object.values(MODS)) modOps.push(modify(target, base));
}
for (const [mname, base] of Object.entries(MODS)) {
  if (!["title", "note", "complete", "reopen", "today", "moveArea", "moveProject", "trash", "order", "tags", "everything"].includes(mname)) continue;
  for (const key of Object.keys(base)) {
    for (const [, value] of VALUES) modOps.push(modify(T_ORD, mutate(base, key, value)));
    for (const value of extras(key)) modOps.push(modify(T_ORD, mutate(base, key, value)));
  }
}
// Batches mixing creates, modifications and companions.
modOps.push(writeOp([{ uuid: T_ORD, e: "Task7", t: 1, p: MODS["title"] }, { uuid: T_INST, e: "Task7", t: 1, p: MODS["title"] }]));
modOps.push(writeOp([{ uuid: T_ORD, e: "Task7", t: 1, p: MODS["title"] }, { uuid: id(100), e: "Task7", t: 0, p: full("n") }]));
modOps.push(writeOp([{ uuid: T_ORD, e: "Task7", t: 1, p: MODS["title"] }, { uuid: id(102), e: "Tombstone2", t: 0, p: { dloid: T_ORD, dld: 5 } }]));
modOps.push(writeOp([{ uuid: T_ORD, e: "Task7", t: 1, p: MODS["title"] }, { uuid: id(101), e: "Tag4", t: 1, p: { tt: "t" } }]));
modOps.push(writeOp([{ uuid: T_ORD, e: "Task6", t: 1, p: { tt: "task6 edit", md: 1 } }]));
modOps.push(writeOp([{ uuid: T_TPL, e: "Task6", t: 1, p: { tt: "task6 template edit", md: 1 } }]));
for (const [i, ch] of chunk(modOps, 60).entries()) cases.push(mk(`modify validation ${i}`, ch, { history: { id: HID, commits: history, pageSize: 4 } }));

// Servers that misreport their head between pages.
const shortHistory = history.slice(0, 10);
cases.push(mk("preflight: head regresses between pages", [modify(T_ORD, MODS["title"]!)], { history: { id: HID, commits: shortHistory, pageSize: 4, headSeq: [10, 8] } as never }));
cases.push(mk("preflight: head grows between pages", [modify(T_ORD, MODS["title"]!)], { history: { id: HID, commits: shortHistory, pageSize: 4, headSeq: [10, 12] } as never }));
cases.push(mk("preflight: negative head", [modify(T_ORD, MODS["title"]!)], { history: { id: HID, commits: shortHistory, pageSize: 4, headSeq: [-1] } as never }));
cases.push(mk("preflight: log shorter than its head", [modify(T_ORD, MODS["title"]!)], { history: { id: HID, commits: shortHistory.slice(0, 4), pageSize: 100, headSeq: [10] } as never }));
cases.push(mk("preflight: head says empty", [modify(T_ORD, MODS["title"]!)], { history: { id: HID, commits: [], pageSize: 100, headSeq: [0] } as never }));

// Paged preflight with head changes: the scan must fix the ancestor at the first page's head.
cases.push(mk("preflight paging", [modify(T_ORD, MODS["title"]!)], { history: { id: HID, commits: history, pageSize: 1 } }));
cases.push(mk("preflight on history shorter than page", [modify(T_ORD, MODS["title"]!)], { history: { id: HID, commits: history.slice(0, 1), pageSize: 100 } }));

export { cases };
if (import.meta.main) {
  writeFileSync(new URL("../cases/client.json", import.meta.url), JSON.stringify(cases, null, 1) + "\n");
  console.log("client cases", cases.length, "ops", cases.reduce((n, c) => n + c.ops.length, 0));
}
