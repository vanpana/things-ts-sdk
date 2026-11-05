// Typed views over folded entities. The raw fields stay available on the entity; these views follow the Go SDK's
// Task / Area / Tag / CheckListItem so results can be compared one to one.
import type { Entity, State } from "./state.ts";
import type { Area, ChecklistItem, Tag, Task } from "./types.ts";

const date = (v: unknown): Date | null => (typeof v === "number" ? new Date(Math.round(v * 1000)) : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? (v as string[]).slice() : []);
const int = (v: unknown, fallback: number): number => (typeof v === "number" ? v : fallback);

export function toTask(uuid: string, e: Entity): Task {
  const f = e.fields;
  return {
    uuid,
    creationDate: date(f["cd"]),
    modificationDate: date(f["md"]),
    status: int(f["ss"], 0),
    title: typeof f["tt"] === "string" ? f["tt"] : "",
    note: e.note,
    scheduledDate: date(f["sr"]),
    completionDate: date(f["sp"]),
    deadlineDate: date(f["dd"]),
    index: int(f["ix"], 0),
    areaIds: strings(f["ar"]),
    parentTaskIds: strings(f["pr"]),
    actionGroupIds: strings(f["agr"]),
    inTrash: f["tr"] === true,
    // A task that never said otherwise is "started" (Anytime), as in the Go SDK.
    schedule: int(f["st"], 1),
    type: int(f["tp"], 0),
    todayIndex: int(f["ti"], 0),
    dueOrder: int(f["do"], 0),
    alarmTimeOffset: typeof f["ato"] === "number" ? f["ato"] : null,
    tagIds: strings(f["tg"]),
    recurrenceIds: strings(f["rt"]),
    delegateIds: strings(f["dl"]),
  };
}

export function toArea(uuid: string, e: Entity): Area {
  return { uuid, title: typeof e.fields["tt"] === "string" ? e.fields["tt"] : "" };
}

export function toTag(uuid: string, e: Entity): Tag {
  const f = e.fields;
  return {
    uuid,
    title: typeof f["tt"] === "string" ? f["tt"] : "",
    shortHand: typeof f["sh"] === "string" ? f["sh"] : "",
    parentTagIds: strings(f["pn"]),
  };
}

export function toChecklistItem(uuid: string, e: Entity): ChecklistItem {
  const f = e.fields;
  return {
    uuid,
    creationDate: date(f["cd"]),
    modificationDate: date(f["md"]),
    status: int(f["ss"], 0),
    title: typeof f["tt"] === "string" ? f["tt"] : "",
    index: int(f["ix"], 0),
    completionDate: date(f["sp"]),
    taskIds: strings(f["ts"]),
  };
}

export const getTask = (s: State, id: string): Task | undefined => { const e = s.tasks.get(id); return e && toTask(id, e); };
export const getArea = (s: State, id: string): Area | undefined => { const e = s.areas.get(id); return e && toArea(id, e); };
export const getTag = (s: State, id: string): Tag | undefined => { const e = s.tags.get(id); return e && toTag(id, e); };
export const getChecklistItem = (s: State, id: string): ChecklistItem | undefined => { const e = s.checklist.get(id); return e && toChecklistItem(id, e); };

export const allTasks = (s: State): Task[] => [...s.tasks].map(([id, e]) => toTask(id, e));
export const allAreas = (s: State): Area[] => [...s.areas].map(([id, e]) => toArea(id, e));
export const allTags = (s: State): Tag[] => [...s.tags].map(([id, e]) => toTag(id, e));
export const allChecklistItems = (s: State): ChecklistItem[] => [...s.checklist].map(([id, e]) => toChecklistItem(id, e));
