// High-level, opinionated builders for the writes this SDK supports: create an ordinary task and edit an existing
// one. They produce items for History.write and add scope rules on top of the generic validation (ordinary tasks
// only, no headings, no recurring targets).
//
// This is beyond the Go library (its CLI has similar code); it is kept in the SDK because every consumer needs it.

import { isValidId, newId } from "./base58.ts";
import { WriteRefusedError } from "./errors.ts";
import { hasExplicitRecurrenceMarkers, recurrenceBlockedIds } from "./guards.ts";
import { textNote } from "./notes.ts";
import type { State } from "./state.ts";
import { ItemAction, TaskStatus, TaskType } from "./types.ts";
import type { WriteItem } from "./types.ts";
import { validateWrites } from "./validate.ts";

const refuse: (m: string) => never = (m) => { throw new WriteRefusedError(m); };

export type When = "inbox" | "anytime" | "today" | "someday";

export interface BuildContext {
  /** Defaults to the current time. */
  now?: Date;
  /**
   * IANA time zone that defines "today" (for example "Europe/Bucharest"). Things stores a date as UTC midnight of the
   * local calendar day, so the zone is part of the data. Required whenever `when: "today"` is used: a Worker's own zone is UTC.
   */
  timeZone?: string;
}

/** The unix timestamp of midnight UTC on the calendar day that `now` falls on in `timeZone`. */
export function todayMidnightUtc(now: Date, timeZone: string): number {
  let parts: Intl.DateTimeFormatPart[];
  try { parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now); }
  catch (e) { throw new WriteRefusedError(`invalid time zone ${JSON.stringify(String(timeZone)).slice(0, 40)}`, { cause: e }); }
  const get = (t: string): number => Number(parts.find((p) => p.type === t)!.value);
  return Date.UTC(get("year"), get("month") - 1, get("day")) / 1000;
}

const WHEN: readonly string[] = ["inbox", "anytime", "today", "someday"];

function schedule(when: When, ctx: BuildContext): { st: number; day: number | null } {
  if (!WHEN.includes(when)) refuse(`unknown schedule ${JSON.stringify(String(when)).slice(0, 30)}`);
  if (when === "today") {
    if (!ctx.timeZone) refuse("timeZone is required to resolve 'today'");
    return { st: 1, day: todayMidnightUtc(ctx.now ?? new Date(), ctx.timeZone!) };
  }
  return { st: when === "inbox" ? 0 : when === "someday" ? 2 : 1, day: null };
}

const nowSeconds = (ctx: BuildContext): number => (ctx.now ?? new Date()).getTime() / 1000;

export interface CreateOptions { title: string; note?: string; when?: When }

/** A new ordinary task (the verified 34-key Task7 shape). */
export function buildCreate(o: CreateOptions, ctx: BuildContext = {}): WriteItem {
  const { st, day } = schedule(o.when ?? "inbox", ctx);
  const item: WriteItem = {
    uuid: newId(),
    kind: "Task7",
    action: ItemAction.Created,
    payload: {
      tp: 0, sr: day, dds: null, rt: [], rmd: null, ss: 0, tr: false, dl: [], icp: false, st, ar: [], tt: o.title, do: 0,
      lai: null, tir: day, tg: [], agr: [], ix: 0, cd: nowSeconds(ctx), lt: false, icc: 0, md: null, ti: 0, dd: null, ato: null,
      nt: textNote(o.note ?? ""), icsd: null, pr: [], rp: null, acrd: null, sp: null, sb: 0, rr: null, xx: { sn: {}, _t: "oo" },
    },
  };
  validateWrites([item]);
  return item;
}

/** Where a task lives. "none" clears every parent. Moving under a heading is not supported. */
export type MoveTarget = { area: string } | { project: string } | "none";

export interface EditOptions {
  title?: string;
  note?: string;
  complete?: boolean;
  reopen?: boolean;
  trash?: boolean;
  restore?: boolean;
  when?: When;
  move?: MoveTarget;
}

/** A sparse modification of an existing, ordinary, non-recurring task. */
export function buildEdit(state: State, id: string, o: EditOptions, ctx: BuildContext = {}): WriteItem {
  if (!isValidId(id)) refuse("invalid identifier");
  const target = state.tasks.get(id);
  if (!target) refuse("unknown task");
  if (target!.fields["tp"] !== TaskType.Task) refuse("only ordinary tasks (not projects or headings) can be edited");
  if (!hasExplicitRecurrenceMarkers(target!.fields)) refuse("target lacks explicit recurrence markers");
  const blocked = recurrenceBlockedIds(state);
  if (blocked.has(id)) refuse("target is part of a recurrence");
  if (o.complete && o.reopen) refuse("cannot complete and reopen in one edit");
  if (o.trash && o.restore) refuse("cannot trash and restore in one edit");

  const p: Record<string, unknown> = { md: nowSeconds(ctx) };
  if (o.title !== undefined) p["tt"] = o.title;
  if (o.note !== undefined) p["nt"] = textNote(o.note);
  if (o.complete) { p["ss"] = TaskStatus.Completed; p["sp"] = nowSeconds(ctx); }
  if (o.reopen) { p["ss"] = TaskStatus.Pending; p["sp"] = null; }
  if (o.trash) p["tr"] = true;
  if (o.restore) p["tr"] = false;
  if (o.when) { const { st, day } = schedule(o.when, ctx); p["st"] = st; p["sr"] = day; p["tir"] = day; }
  if (o.move) {
    if (o.move === "none") { p["ar"] = []; p["pr"] = []; p["agr"] = []; }
    else if ("area" in o.move) {
      if (!isValidId(o.move.area) || !state.areas.has(o.move.area)) refuse("target area not found");
      p["ar"] = [o.move.area]; p["pr"] = []; p["agr"] = [];
    } else {
      const pid = o.move.project;
      const proj = state.tasks.get(pid);
      if (!isValidId(pid) || !proj || proj.fields["tp"] !== TaskType.Project) refuse("target project not found");
      if (proj!.fields["tr"] || proj!.fields["ss"] !== TaskStatus.Pending) refuse("target project is not open");
      if (blocked.has(pid)) refuse("target project is part of a recurrence");
      if (pid === id) refuse("a task cannot contain itself");
      p["pr"] = [pid]; p["ar"] = []; p["agr"] = [];
    }
  }
  const item: WriteItem = { uuid: id, kind: "Task7", action: ItemAction.Modified, payload: p };
  validateWrites([item]);
  return item;
}
