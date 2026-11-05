import test from "node:test";
import assert from "node:assert/strict";
import { allAreas, allChecklistItems, allTags, allTasks, applyItems, areaByName, checklistItemsByTask, emptyState, headings, projectByName, projects, subTags, subtasks, tasksByArea, tasksByHeading, tasksWithoutArea } from "../src/index.ts";
import type { Item, State } from "../src/index.ts";
import { diff, fixture } from "./helpers.ts";

const secs = (d: Date | null): number | null => (d ? d.getTime() / 1000 : null);

/** The same projection the Go oracle prints. */
export function dump(state: State) {
  const tasks: Record<string, unknown> = {};
  for (const t of allTasks(state)) {
    tasks[t.uuid] = {
      creationDate: secs(t.creationDate), modificationDate: secs(t.modificationDate), status: t.status, title: t.title, note: t.note,
      scheduledDate: secs(t.scheduledDate), completionDate: secs(t.completionDate), deadlineDate: secs(t.deadlineDate), index: t.index,
      areaIds: t.areaIds, parentTaskIds: t.parentTaskIds, actionGroupIds: t.actionGroupIds, inTrash: t.inTrash, schedule: t.schedule,
      type: t.type, todayIndex: t.todayIndex, dueOrder: t.dueOrder, alarmTimeOffset: t.alarmTimeOffset, tagIds: t.tagIds,
      recurrenceIds: t.recurrenceIds, delegateIds: t.delegateIds,
    };
  }
  const areas: Record<string, unknown> = {};
  for (const a of allAreas(state)) areas[a.uuid] = { title: a.title };
  const tags: Record<string, unknown> = {};
  for (const t of allTags(state)) tags[t.uuid] = { title: t.title, shortHand: t.shortHand, parentTagIds: t.parentTagIds };
  const checklist: Record<string, unknown> = {};
  for (const c of allChecklistItems(state)) {
    checklist[c.uuid] = { creationDate: secs(c.creationDate), modificationDate: secs(c.modificationDate), status: c.status, title: c.title, index: c.index, taskIds: c.taskIds };
  }
  return { tasks, areas, tags, checklist };
}

const ids = (xs: { uuid: string }[]): string[] => xs.map((x) => x.uuid).sort();

function hasParentCycle(state: State): boolean {
  const visit = (id: string, path: Set<string>): boolean => {
    const t = state.tasks.get(id);
    if (!t) return false;
    if (path.has(id)) return true;
    path.add(id);
    const parents = Array.isArray(t.fields["pr"]) ? (t.fields["pr"] as string[]) : [];
    const cyc = parents.some((p) => visit(p, path));
    path.delete(id);
    return cyc;
  };
  return [...state.tasks.keys()].some((id) => visit(id, new Set()));
}

/** The same queries the Go oracle runs. */
export function dumpQueries(state: State) {
  const both = { excludeCompleted: true, excludeInTrash: true };
  const perTask: Record<string, unknown> = {};
  for (const t of allTasks(state)) {
    perTask[t.uuid] = {
      subtasksAll: ids(subtasks(state, t.uuid)), subtasksOpen: ids(subtasks(state, t.uuid, both)),
      headings: ids(headings(state, t.uuid)), byHeadingAll: ids(tasksByHeading(state, t.uuid)), byHeadingOpen: ids(tasksByHeading(state, t.uuid, both)),
      checklist: ids(checklistItemsByTask(state, t.uuid)), checklistOpen: ids(checklistItemsByTask(state, t.uuid, both)),
    };
  }
  const perArea: Record<string, unknown> = {};
  for (const a of allAreas(state)) {
    perArea[a.uuid] = { byAreaAll: ids(tasksByArea(state, a.uuid)), byAreaOpen: ids(tasksByArea(state, a.uuid, both)), ...(areaByName(state, a.title) ? { byNameFound: true } : {}) };
  }
  const perTag: Record<string, unknown> = {};
  for (const t of allTags(state)) perTag[t.uuid] = ids(subTags(state, t.uuid));
  const names: Record<string, unknown> = {};
  for (const p of projects(state)) names[p.title] = projectByName(state, p.title) !== undefined;
  // The Go SDK overflows its stack on a cycle in parent links; it is skipped there, and ours must simply terminate.
  const cyclic = hasParentCycle(state);
  const withoutArea = ids(tasksWithoutArea(state));
  return { projects: ids(projects(state)), ...(cyclic ? { cycle: true } : { tasksWithoutArea: withoutArea }), perTask, perArea, subTags: perTag, projectNamesFound: names };
}

test("state: folding matches the Go SDK's memory state on every scenario", () => {
  const { cases, expected } = fixture<{ name: string; batches: { uuid: string; e: string; t: number; p: unknown }[][] }>("state");
  assert.equal(cases.length, expected.length);
  const mismatches: string[] = [];
  let steps = 0;
  let errors = 0;
  for (const [i, c] of cases.entries()) {
    const state = emptyState();
    for (const [b, batch] of c.batches.entries()) {
      const want = expected[i].steps[b];
      const items: Item[] = batch.map((x) => ({ uuid: x.uuid, kind: x.e, action: x.t, payload: x.p }));
      let failed = false;
      try { applyItems(state, items, { mode: "lenient" }); } catch { failed = true; }
      steps++;
      if (failed) errors++;
      const where = `${c.name} (case ${i}, batch ${b})`;
      if (failed !== Boolean(want.error)) { mismatches.push(`${where}: error ${failed} vs Go ${Boolean(want.error)}`); break; }
      const d = diff({ state: dump(state), queries: dumpQueries(state) }, { state: want.state, queries: want.queries });
      if (d) { mismatches.push(`${where}: ${d}`); break; }
    }
  }
  assert.deepEqual(mismatches, [], `${mismatches.length} mismatches`);
  assert.ok(steps > 400 && errors > 5, `${steps} steps, ${errors} errors`);
});
