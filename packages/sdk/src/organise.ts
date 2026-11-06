// Tags, areas and checklist items: the strict write contract and builders.
//
// Not in the Go SDK's validation (it passes these kinds through unchecked). The shapes here are the ones the Go CLI
// sends, which were accepted by the real service and read back correctly in a live run. Only creation and deletion
// are supported; modifications of these kinds still need `unsafe.unverifiedKinds`.

import { isValidId, newId } from "./base58.ts";
import { WriteRefusedError } from "./errors.ts";
import { hasExplicitRecurrenceMarkers, recurrenceBlockedIds } from "./guards.ts";
import type { State } from "./state.ts";
import { ItemAction, TaskStatus, TaskType } from "./types.ts";
import type { WriteItem } from "./types.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const fail: (msg: string) => never = (m) => { throw new WriteRefusedError(m); };
const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const MAX_TITLE = 1000;

/** Kinds that `History.write` accepts without `unsafe.unverifiedKinds` (beside `Task7`, which has its own contract). */
export const ORGANISER_KINDS: readonly string[] = ["Tag4", "Area3", "ChecklistItem3"];

function exactKeys(p: Obj, want: readonly string[], what: string): void {
  const got = Object.keys(p);
  if (got.length !== want.length || !got.every((k) => want.includes(k))) fail(`${what}: must contain exactly ${want.join(", ")}`);
}
function title(v: unknown, what: string): void {
  if (typeof v !== "string" || v.trim() === "" || v.length > MAX_TITLE || !v.isWellFormed()) fail(`${what}: invalid title`);
}
function ext(v: unknown, what: string): void {
  if (!isObj(v) || Object.keys(v).length !== 2 || v["_t"] !== "oo" || !isObj(v["sn"]) || Object.keys(v["sn"]).length !== 0) fail(`${what}: invalid extension`);
}
function ids(v: unknown, max: number, what: string): void {
  if (!Array.isArray(v) || v.length > max || !v.every((x) => typeof x === "string" && isValidId(x))) fail(`${what}: invalid identifier list`);
}

/** Throws {@link WriteRefusedError} unless every Tag4 / Area3 / ChecklistItem3 item is a verified create or delete. */
export function validateOrganiserWrites(items: readonly WriteItem[]): void {
  for (const item of items) {
    if (!ORGANISER_KINDS.includes(item.kind)) continue;
    const what = `refusing to write ${item.kind}`;
    if (item.action === ItemAction.Deleted) {
      if (!isObj(item.payload) || Object.keys(item.payload).length !== 0) fail(`${what}: a deletion carries an empty payload`);
      continue;
    }
    if (item.action !== ItemAction.Created) fail(`${what}: only creation and deletion are verified (modifications need unsafe.unverifiedKinds)`);
    const p = item.payload;
    if (!isObj(p)) fail(`${what}: payload must be an object`);
    const o = p as Obj;
    if (item.kind === "Tag4") {
      exactKeys(o, ["tt", "ix", "sh", "pn", "xx"], what);
      title(o["tt"], what);
      if (!isInt(o["ix"]) || !(o["sh"] === null || (typeof o["sh"] === "string" && (o["sh"] as string).isWellFormed()))) fail(`${what}: invalid ix or sh`);
      ids(o["pn"], 1, what); ext(o["xx"], what);
    } else if (item.kind === "Area3") {
      exactKeys(o, ["tt", "ix", "tg", "xx"], what);
      title(o["tt"], what);
      if (!isInt(o["ix"])) fail(`${what}: invalid ix`);
      ids(o["tg"], 1000, what); ext(o["xx"], what);
    } else {
      exactKeys(o, ["cd", "md", "tt", "ss", "sp", "ix", "ts", "lt", "xx"], what);
      title(o["tt"], what);
      if (typeof o["cd"] !== "number" || !(o["cd"] > 0) || !Number.isFinite(o["cd"]) || o["md"] !== null || o["ss"] !== 0 || o["sp"] !== null || o["lt"] !== false || !isInt(o["ix"])) {
        fail(`${what}: invalid creation fields`);
      }
      ids(o["ts"], 1, what);
      if ((o["ts"] as unknown[]).length !== 1) fail(`${what}: a checklist item belongs to exactly one task`);
      ext(o["xx"], what);
    }
  }
}

/** Things gives tags negative sort indexes; this is the value the Go CLI sends for a new tag. */
const TAG_IX = -1237;
const EXT = (): { sn: Record<string, never>; _t: "oo" } => ({ sn: {}, _t: "oo" });
const nowSeconds = (now?: Date): number => (now ?? new Date()).getTime() / 1000;

export interface CreateTagOptions { title: string; shortcut?: string; parent?: string }
export function buildCreateTag(state: State, o: CreateTagOptions): WriteItem {
  if (o.parent !== undefined && (!isValidId(o.parent) || !state.tags.has(o.parent))) fail("parent tag not found");
  const item: WriteItem = {
    uuid: newId(), kind: "Tag4", action: ItemAction.Created,
    payload: { tt: o.title, ix: TAG_IX, sh: o.shortcut ?? null, pn: o.parent ? [o.parent] : [], xx: EXT() },
  };
  validateOrganiserWrites([item]);
  return item;
}

export function buildCreateArea(o: { title: string }): WriteItem {
  const item: WriteItem = { uuid: newId(), kind: "Area3", action: ItemAction.Created, payload: { tt: o.title, ix: 0, tg: [], xx: EXT() } };
  validateOrganiserWrites([item]);
  return item;
}

export interface AddChecklistItemOptions { taskId: string; title: string; index?: number }
/** A new checklist item on an ordinary, open task that is not part of a recurrence. */
export function buildAddChecklistItem(state: State, o: AddChecklistItemOptions, ctx: { now?: Date } = {}): WriteItem {
  if (!isValidId(o.taskId)) fail("invalid identifier");
  const task = state.tasks.get(o.taskId);
  if (!task) fail("unknown task");
  if (task!.fields["tp"] !== TaskType.Task) fail("checklist items can only be added to ordinary tasks");
  if (task!.fields["tr"] || task!.fields["ss"] !== TaskStatus.Pending) fail("checklist items can only be added to open tasks");
  if (!hasExplicitRecurrenceMarkers(task!.fields)) fail("target lacks explicit recurrence markers");
  if (recurrenceBlockedIds(state).has(o.taskId)) fail("target is part of a recurrence");
  let count = 0;
  for (const e of state.checklist.values()) if ((e.fields["ts"] as unknown[] | undefined)?.[0] === o.taskId) count++;
  const item: WriteItem = {
    uuid: newId(), kind: "ChecklistItem3", action: ItemAction.Created,
    payload: { cd: nowSeconds(ctx.now), md: null, tt: o.title, ss: 0, sp: null, ix: o.index ?? count, ts: [o.taskId], lt: false, xx: EXT() },
  };
  validateOrganiserWrites([item]);
  return item;
}

export type DeletableKind = "tag" | "area" | "checklistItem";
/** Deletes a tag, area or checklist item. A tag or area still referenced elsewhere is refused. */
export function buildDelete(state: State, kind: DeletableKind, id: string): WriteItem {
  if (!isValidId(id)) fail("invalid identifier");
  if (kind !== "tag" && kind !== "area" && kind !== "checklistItem") fail("unknown kind");
  const where = kind === "tag" ? state.tags : kind === "area" ? state.areas : state.checklist;
  if (!where.has(id)) fail(`unknown ${kind}`);
  const uses = (v: unknown): boolean => Array.isArray(v) && v.includes(id);
  if (kind === "tag") {
    for (const m of [state.tasks, state.areas]) for (const e of m.values()) if (uses(e.fields["tg"])) fail("tag is still in use");
    for (const e of state.tags.values()) if (uses(e.fields["pn"])) fail("tag is still in use");
  } else if (kind === "area") {
    for (const e of state.tasks.values()) if (uses(e.fields["ar"])) fail("area is still in use");
  }
  const kindName = kind === "tag" ? "Tag4" : kind === "area" ? "Area3" : "ChecklistItem3";
  const item: WriteItem = { uuid: id, kind: kindName, action: ItemAction.Deleted, payload: {} };
  validateOrganiserWrites([item]);
  return item;
}
