// The Things lists: Inbox, Today, Upcoming, Anytime, Someday, Logbook and Trash.
//
// Membership follows the community reference implementation thingsapi/things.py (which reads the Mac database), applied
// to the synced state. Against a real account the rules below reproduce things.py exactly (see
// conformance/scripts/verify-views.ts). Every list is computed from the raw wire fields, because the typed Task does not
// carry `rr` (recurrence rule) and `dds` (deadline suppression date).
//
//  - Recurring templates (`rr` set) are in no list; the instances they create are ordinary tasks.
//  - A task whose project, or whose heading's project, is in the trash is hidden from every list but not itself trashed:
//    Trash only holds items that are trashed themselves.
//  - Type is not filtered, as in things.py: projects appear next to to-dos wherever their own fields say so.
//  - "Today" is a calendar day in the caller's time zone (Things stores a date as UTC midnight of the local day).
//
//  Inbox     st 0, open
//  Anytime   st 1, open                                       (includes what is also in Today)
//  Someday   st 2, open, no start date
//  Upcoming  st 2, open, start date after today; ordered by start date (as the app shows it), then `ix`
//  Today     open, and one of: st 1 with a start date; st 2 with a start date up to today (the app confirms these when it
//            is opened, shown with a yellow dot); no start date, a deadline up to today, and the deadline not suppressed
//  Logbook   completed or canceled
//  Trash     `tr` set, any status
//
// Order: ascending `ix` for everything except Today (`ti`, then start date) and Logbook (completion time, newest first).

import { ThingsError } from "./errors.ts";
import { toTask } from "./entities.ts";
import { todayMidnightUtc } from "./builders.ts";
import type { Entity, State } from "./state.ts";
import type { Task } from "./types.ts";

export type ViewName = "inbox" | "today" | "upcoming" | "anytime" | "someday" | "logbook" | "trash";
export const VIEW_NAMES: readonly ViewName[] = ["inbox", "today", "upcoming", "anytime", "someday", "logbook", "trash"];

export interface ViewOptions {
  /** Defaults to the current time. */
  now?: Date;
  /** IANA time zone that defines "today". Required for `today` and `upcoming`. */
  timeZone?: string;
}

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const int = (v: unknown, fallback: number): number => (typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback);
const first = (v: unknown): string | null => (Array.isArray(v) && typeof v[0] === "string" ? v[0] : null);

/** Not a recurring template, and not inside a trashed project (directly or through a heading). */
function reachable(state: State, e: Entity): boolean {
  if (e.fields["rr"] != null) return false;
  const project = first(e.fields["pr"]);
  if (project !== null && state.tasks.get(project)?.fields["tr"] === true) return false;
  const heading = first(e.fields["agr"]);
  if (heading !== null) {
    const parent = first(state.tasks.get(heading)?.fields["pr"]);
    if (parent !== null && state.tasks.get(parent)?.fields["tr"] === true) return false;
  }
  return true;
}

interface Row { id: string; e: Entity }

function rows(state: State, keep: (f: Entity["fields"]) => boolean, openOnly: boolean): Row[] {
  const out: Row[] = [];
  for (const [id, e] of state.tasks) {
    const f = e.fields;
    if (f["tr"] === true) continue;
    if (openOnly && int(f["ss"], 0) !== 0) continue;
    if (keep(f) && reachable(state, e)) out.push({ id, e });
  }
  return out;
}

const byIndex = (a: Row, b: Row): number => int(a.e.fields["ix"], 0) - int(b.e.fields["ix"], 0);
const done = (rs: Row[]): Task[] => rs.map(({ id, e }) => toTask(id, e));

function todayStart(o: ViewOptions): number {
  if (!o.timeZone) throw new ThingsError("timeZone is required to resolve 'today'");
  return todayMidnightUtc(o.now ?? new Date(), o.timeZone);
}

const st = (f: Entity["fields"]): number => int(f["st"], 1); // a task that never said otherwise is Anytime, as in toTask
const sr = (f: Entity["fields"]): number | null => num(f["sr"]);

export const inbox = (state: State): Task[] => done(rows(state, (f) => st(f) === 0, true).sort(byIndex));
export const anytime = (state: State): Task[] => done(rows(state, (f) => st(f) === 1, true).sort(byIndex));
export const someday = (state: State): Task[] => done(rows(state, (f) => st(f) === 2 && sr(f) === null, true).sort(byIndex));

export function upcoming(state: State, o: ViewOptions): Task[] {
  const t = todayStart(o);
  // The app lists Upcoming by start date, soonest first (the reference orders by `ix` only); ties keep `ix` order.
  const rs = rows(state, (f) => st(f) === 2 && (sr(f) ?? -Infinity) > t, true).sort(byIndex);
  return done(rs.sort((a, b) => (sr(a.e.fields) ?? 0) - (sr(b.e.fields) ?? 0)));
}

export function today(state: State, o: ViewOptions): Task[] {
  const t = todayStart(o);
  const regular = rows(state, (f) => st(f) === 1 && sr(f) !== null, true).sort(byIndex);
  const scheduled = rows(state, (f) => st(f) === 2 && sr(f) !== null && sr(f)! <= t, true).sort(byIndex);
  const overdue = rows(state, (f) => sr(f) === null && num(f["dd"]) !== null && num(f["dd"])! <= t && f["dds"] == null, true).sort(byIndex);
  // Array.prototype.sort is stable: ties keep the order above.
  const all = [...regular, ...scheduled, ...overdue];
  all.sort((a, b) => int(a.e.fields["ti"], 0) - int(b.e.fields["ti"], 0) || (sr(a.e.fields) ?? -Infinity) - (sr(b.e.fields) ?? -Infinity) || 0);
  return done(all);
}

export function logbook(state: State): Task[] {
  const status = (s: number) => (r: Row) => int(r.e.fields["ss"], 0) === s;
  const all = rows(state, () => true, false);
  const canceled = all.filter(status(2)).sort(byIndex);
  const completed = all.filter(status(3)).sort(byIndex);
  const stop = (r: Row): number => Math.floor(num(r.e.fields["sp"]) ?? -Infinity);
  // Newest first; ties (same second) keep canceled before completed, then `ix`, as the reference does.
  return done([...canceled, ...completed].sort((a, b) => stop(b) - stop(a) || 0));
}

export function trash(state: State): Task[] {
  const out: Row[] = [];
  for (const [id, e] of state.tasks) if (e.fields["tr"] === true && e.fields["rr"] == null) out.push({ id, e });
  return done(out.sort(byIndex));
}

/** One list by name. `today` and `upcoming` need `timeZone`. */
export function view(state: State, name: ViewName, o: ViewOptions = {}): Task[] {
  switch (name) {
    case "inbox": return inbox(state);
    case "today": return today(state, o);
    case "upcoming": return upcoming(state, o);
    case "anytime": return anytime(state);
    case "someday": return someday(state);
    case "logbook": return logbook(state);
    case "trash": return trash(state);
    default: throw new ThingsError(`unknown view ${JSON.stringify(String(name)).slice(0, 30)}`);
  }
}
