// Compares the TypeScript fold with the Go SDK on a real, private history. Nothing is written to the repository.
//   THINGS_LOG=/path/to/log.json  GO=/path/to/go  node scripts/real-log-diff.ts
// The log is a JSON array of commits ({ id: { e, t, p } }); scripts/dump-log.ts writes one from your own account.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allAreas, allChecklistItems, allTags, allTasks, applyItems, emptyState, flattenCommits } from "../../packages/sdk/src/index.ts";
import type { Commit } from "../../packages/sdk/src/index.ts";

const logPath = process.env["THINGS_LOG"];
if (!logPath) { console.error("set THINGS_LOG"); process.exit(2); }
const raw = JSON.parse(readFileSync(logPath, "utf8"));
const commits: Commit[] = Array.isArray(raw) ? raw : raw.items ?? raw.commits;
const BATCH = Number(process.env["BATCH"] ?? 500);

const batches = [];
for (let i = 0; i < commits.length; i += BATCH) {
  batches.push(flattenCommits(commits.slice(i, i + BATCH), i).map((x) => ({ uuid: x.uuid, e: x.kind, t: x.action, p: x.payload })));
}
const dir = mkdtempSync(join(tmpdir(), "things-diff-"));
const input = join(dir, "in.json");
writeFileSync(input, JSON.stringify([{ name: "real log", batches }]));
const go = process.env["GO"] ?? "go";
const out = execFileSync(go, ["run", ".", "state"], { cwd: new URL("../go-oracle/", import.meta.url).pathname, input: readFileSync(input), maxBuffer: 1 << 30 });
const want = JSON.parse(out.toString())[0];

const state = emptyState();
let goErrors = 0;
for (const [i, batch] of batches.entries()) {
  let failed = false;
  try { applyItems(state, batch.map((x) => ({ uuid: x.uuid, kind: x.e, action: x.t, payload: x.p })), { mode: "lenient" }); } catch { failed = true; }
  if (failed !== Boolean(want.steps[i].error)) { console.log(`batch ${i}: error ${failed} vs Go ${Boolean(want.steps[i].error)}`); process.exitCode = 1; }
  if (want.steps[i].error) goErrors++;
}
const last = want.steps.at(-1).state;
const secs = (d: Date | null) => (d ? d.getTime() / 1000 : null);
let bad = 0;
const report = (what: string, id: string, field: string, a: unknown, b: unknown) => { if (bad++ < 25) console.log(`${what} ${id} ${field}: ts=${JSON.stringify(a)} go=${JSON.stringify(b)}`); };
const ours = new Map(allTasks(state).map((t) => [t.uuid, t]));
for (const id of new Set([...ours.keys(), ...Object.keys(last.tasks)])) {
  const a = ours.get(id);
  const b = last.tasks[id];
  if (!a || !b) { report("task", id, "presence", !!a, !!b); continue; }
  const mine: Record<string, unknown> = {
    creationDate: secs(a.creationDate), modificationDate: secs(a.modificationDate), status: a.status, title: a.title, note: a.note, scheduledDate: secs(a.scheduledDate),
    completionDate: secs(a.completionDate), deadlineDate: secs(a.deadlineDate), index: a.index, areaIds: a.areaIds, parentTaskIds: a.parentTaskIds,
    actionGroupIds: a.actionGroupIds, inTrash: a.inTrash, schedule: a.schedule, type: a.type, todayIndex: a.todayIndex, dueOrder: a.dueOrder,
    alarmTimeOffset: a.alarmTimeOffset, tagIds: a.tagIds, recurrenceIds: a.recurrenceIds, delegateIds: a.delegateIds,
  };
  for (const k of Object.keys(mine)) {
    const x = mine[k]; const y = b[k];
    const same = typeof x === "number" && typeof y === "number" ? Math.abs(x - y) < 0.002 : JSON.stringify(x) === JSON.stringify(y);
    if (!same) report("task", id, k, x, y);
  }
}
for (const [what, mine, theirs] of [
  ["area", new Map(allAreas(state).map((a) => [a.uuid, { title: a.title }])), last.areas],
  ["tag", new Map(allTags(state).map((t) => [t.uuid, { title: t.title, shortHand: t.shortHand, parentTagIds: t.parentTagIds }])), last.tags],
  ["checklist", new Map(allChecklistItems(state).map((c) => [c.uuid, { title: c.title, status: c.status, index: c.index, taskIds: c.taskIds }])), last.checklist],
] as const) {
  for (const id of new Set([...mine.keys(), ...Object.keys(theirs)])) {
    const a = mine.get(id) as Record<string, unknown> | undefined;
    const b = theirs[id];
    if (!a || !b) { report(what, id, "presence", !!a, !!b); continue; }
    for (const k of Object.keys(a)) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) report(what, id, k, a[k], b[k]);
  }
}
console.log(`commits ${commits.length}, tasks ts=${ours.size} go=${Object.keys(last.tasks).length}, go batch errors ${goErrors}, differences ${bad}`);
if (bad) process.exitCode = 1;
