// The state-based preflight (cheap, for a Worker holding folded state) must agree with the Go-style full-log scan
// on every case the state can represent.
import test from "node:test";
import assert from "node:assert/strict";
import { emptyState, encodeLegacyIdentifier, flattenCommits, fold, newId, preflightFromState, scanTask7Targets } from "../src/index.ts";
import type { Commit } from "../src/index.ts";

const LEGACY = "3F2504E0-4F89-11D3-9A0C-0305E82C3301";
const base = { tp: 0, tt: "t", ss: 0, tr: false };
const ids = { ord: newId(), tpl: newId(), inst: newId(), noRt: newId(), noRr: newId(), noRp: newId(), rtNull: newId(), acrd: newId(), icsd: newId(), rpSet: newId(), missing: newId(), gone: newId(), sparse: newId(), twice: newId(), tombCreate: newId(), orphanMarkers: newId(), sameIdx: encodeLegacyIdentifier(LEGACY) };
const log: Commit[] = [
  { [ids.ord]: { e: "Task7", t: 0, p: { ...base, rr: null, rp: null, rt: [] } } },
  { [ids.tpl]: { e: "Task7", t: 0, p: { ...base, rr: { fu: 256 }, rp: null, rt: [] } } },
  { [ids.inst]: { e: "Task7", t: 0, p: { ...base, rr: null, rp: null, rt: [ids.tpl] } } },
  { [ids.noRt]: { e: "Task7", t: 0, p: { ...base, rr: null, rp: null } } },
  { [ids.noRr]: { e: "Task7", t: 0, p: { ...base, rp: null, rt: [] } } },
  { [ids.noRp]: { e: "Task7", t: 0, p: { ...base, rr: null, rt: [] } } },
  { [ids.rtNull]: { e: "Task6", t: 0, p: { ...base, rr: null, rp: null, rt: null } } },
  { [ids.acrd]: { e: "Task7", t: 0, p: { ...base, rr: null, rp: null, rt: [], acrd: 1770000000 } } },
  { [ids.icsd]: { e: "Task7", t: 0, p: { ...base, rr: null, rp: null, rt: [], icsd: 1770000000 } } },
  { [ids.rpSet]: { e: "Task7", t: 0, p: { ...base, rr: null, rp: { x: 1 }, rt: [] } } },
  { [ids.gone]: { e: "Task7", t: 0, p: { ...base, rr: null, rp: null, rt: [] } } },
  { [newId()]: { e: "Tombstone2", t: 0, p: { dloid: ids.gone, dld: 1 } } },
  { [ids.sparse]: { e: "Task6", t: 0, p: { tt: "sparse" } } },
  { [ids.sparse]: { e: "Task6", t: 1, p: { rr: null, rp: null, rt: [], md: 1 } } },
  { [ids.twice]: { e: "Task7", t: 0, p: { ...base, rr: null, rp: null, rt: [] } } },
  { [ids.twice]: { e: "Task7", t: 0, p: { ...base, rr: null, rp: null, rt: [] } } },
  { [ids.orphanMarkers]: { e: "Task7", t: 1, p: { rr: null, rp: null, rt: [], md: 1 } } },
  { [ids.tombCreate]: { e: "Task7", t: 0, p: { ...base, rr: null, rp: null, rt: [] } } },
  { [newId()]: { e: "Tombstone2", t: 0, p: { dloid: ids.tombCreate, dld: 1 } }, [ids.tombCreate]: { e: "Task7", t: 0, p: { ...base, rr: null, rp: null, rt: [] } } },
  { [LEGACY]: { e: "Task3", t: 0, p: { tt: "legacy", rr: null, rp: null, rt: [] } }, [ids.sameIdx]: { e: "Task6", t: 1, p: { tt: "same commit", md: 1 } } },
];

const scan = async (target: string): Promise<number | Error> => {
  try {
    return await scanTask7Targets(async (start) => {
      const commits = log.slice(start, start + 4);
      return { items: flattenCommits(commits, start), loadedServerIndex: start + commits.length, latestServerIndex: log.length };
    }, [target]);
  } catch (e) { return e as Error; }
};

test("state-based preflight agrees with the full scan", async () => {
  const state = emptyState();
  fold(state, log);
  for (const [name, id] of Object.entries(ids)) {
    const scanned = await scan(id);
    let viaState: number | Error;
    try { viaState = preflightFromState(state, [id]); } catch (e) { viaState = e as Error; }
    assert.equal(scanned instanceof Error, viaState instanceof Error, `${name}: scan ${scanned instanceof Error ? scanned.message : "ok"} vs state ${viaState instanceof Error ? viaState.message : "ok"}`);
    if (typeof scanned === "number") assert.equal(viaState, scanned, `${name}: both anchor at the head`);
  }
});

test("which targets pass", async () => {
  const ok = [];
  for (const [name, id] of Object.entries(ids)) if (typeof (await scan(id)) === "number") ok.push(name);
  assert.deepEqual(ok.sort(), ["ord", "rtNull", "sparse"], "created twice, orphan modify, same-commit delete+create and legacy collisions are all refused");
});
