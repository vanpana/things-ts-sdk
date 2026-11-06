import test from "node:test";
import assert from "node:assert/strict";
import { anytime, emptyState, fold, inbox, logbook, newId, someday, ThingsError, today, trash, upcoming, view } from "../src/index.ts";
import type { State } from "../src/index.ts";

const DAY = 86400;
const utc = (y: number, m: number, d: number): number => Date.UTC(y, m - 1, d) / 1000;
const NOW = new Date("2026-11-05T12:00:00Z");
const TZ = "UTC";
const TODAY = utc(2026, 11, 5);
const base = { tp: 0, ss: 0, tr: false, st: 1, ix: 0, ti: 0, rr: null, sr: null, dd: null, dds: null, pr: [], agr: [], ar: [], tt: "t" };

function make(tasks: Record<string, Record<string, unknown>>): State {
  const s = emptyState();
  fold(s, [Object.fromEntries(Object.entries(tasks).map(([id, p]) => [id, { e: "Task7", t: 0, p: { ...base, ...p } }]))]);
  return s;
}
const ids = (ts: { uuid: string }[]): string[] => ts.map((t) => t.uuid);
const id = Object.fromEntries("abcdefghijklmnop".split("").map((c) => [c, newId()])) as Record<string, string>;
const refuse = (re: RegExp) => (e: unknown) => e instanceof ThingsError && re.test(e.message);

test("inbox: open tasks with st 0, in index order; closed, trashed and recurring templates are out, instances are in", () => {
  const s = make({
    [id.a!]: { st: 0, ix: 2 }, [id.b!]: { st: 0, ix: 1 }, [id.c!]: { st: 0, ss: 3 }, [id.d!]: { st: 0, tr: true },
    [id.e!]: { st: 0, rr: { rrv: 4 } }, [id.f!]: { st: 0, rt: [id.e!] }, [id.g!]: { st: 1 },
  });
  assert.deepEqual(ids(inbox(s)), [id.f, id.b, id.a]);
});

test("anytime and someday", () => {
  const s = make({
    [id.a!]: { st: 1, ix: 1 }, [id.b!]: { st: 1, ix: 0, sr: TODAY }, [id.c!]: { st: 2, ix: 3 },
    [id.d!]: { st: 2, sr: TODAY + 9 * DAY }, [id.e!]: { st: 1, ss: 2 },
  });
  assert.deepEqual(ids(anytime(s)), [id.b, id.a]); // what is also in Today stays in Anytime
  assert.deepEqual(ids(someday(s)), [id.c]);       // a dated Someday task is Upcoming, not Someday
});

test("upcoming: Someday with a start date after today; today itself is not upcoming", () => {
  const s = make({ [id.a!]: { st: 2, sr: TODAY + DAY }, [id.b!]: { st: 2, sr: TODAY }, [id.c!]: { st: 2, sr: null }, [id.d!]: { st: 1, sr: TODAY + DAY } });
  assert.deepEqual(ids(upcoming(s, { now: NOW, timeZone: TZ })), [id.a]);
});

test("today: started with a date, scheduled up to today, overdue without a start date; sorted by today index then date", () => {
  const s = make({
    [id.a!]: { st: 1, sr: TODAY - DAY, ti: 2 },               // started
    [id.b!]: { st: 2, sr: TODAY, ti: 1 },                     // scheduled for today, not yet confirmed by the app
    [id.c!]: { st: 2, sr: TODAY + DAY },                      // tomorrow: Upcoming
    [id.d!]: { st: 0, dd: TODAY - DAY, ti: 0 },               // overdue, even from the Inbox
    [id.e!]: { st: 1, dd: TODAY - DAY },                      // no start date and overdue: the rule does not look at st
    [id.f!]: { st: 1, sr: TODAY, ti: 1, ss: 3 },              // completed
    [id.g!]: { st: 0, dd: TODAY - DAY, dds: TODAY },          // deadline suppressed
    [id.h!]: { st: 0, dd: TODAY + DAY },                      // deadline still ahead
    [id.i!]: { st: 1, sr: TODAY - 2 * DAY, ti: 1 },           // same today index as b, earlier date
  });
  const got = ids(today(s, { now: NOW, timeZone: TZ }));
  assert.deepEqual(got.sort(), [id.a, id.b, id.d, id.e, id.i].sort());
  assert.deepEqual(ids(today(s, { now: NOW, timeZone: TZ })).filter((x) => [id.a, id.b, id.i].includes(x)), [id.i, id.b, id.a]);
});

test("today: the time zone decides which calendar day it is", () => {
  const s = make({ [id.a!]: { st: 2, sr: utc(2026, 11, 6) } });
  const late = new Date("2026-11-05T22:30:00Z"); // 00:30 on the 6th in Bucharest, still the 5th in New York
  assert.deepEqual(ids(today(s, { now: late, timeZone: "Europe/Bucharest" })), [id.a]);
  assert.deepEqual(ids(today(s, { now: late, timeZone: "America/New_York" })), []);
  assert.deepEqual(ids(upcoming(s, { now: late, timeZone: "America/New_York" })), [id.a]);
});

test("today and upcoming need a time zone; an unknown view is refused", () => {
  const s = make({});
  assert.throws(() => today(s, {}), refuse(/timeZone is required/));
  assert.throws(() => upcoming(s, {}), refuse(/timeZone is required/));
  assert.throws(() => view(s, "nope" as never), refuse(/unknown view/));
  assert.deepEqual(view(s, "inbox"), []);
});

test("a trashed project hides its tasks, also through a heading; the tasks are not in Trash themselves", () => {
  const s = make({
    [id.a!]: { tp: 1, tr: true }, [id.b!]: { st: 0, pr: [id.a!] },
    [id.c!]: { tp: 1, tr: true }, [id.d!]: { tp: 2, pr: [id.c!] }, [id.e!]: { st: 0, agr: [id.d!] },
    [id.f!]: { tp: 1 }, [id.g!]: { st: 0, pr: [id.f!] },
  });
  assert.deepEqual(ids(inbox(s)), [id.g]);
  assert.deepEqual(ids(trash(s)), [id.a, id.c]);
});

test("a completed or trashed task is not in the working lists; Trash holds any status but no recurring template", () => {
  const s = make({
    [id.a!]: { tr: true, ss: 3, ix: 1 }, [id.b!]: { tr: true, ix: 0 }, [id.c!]: { tr: true, rr: { rrv: 4 } }, [id.d!]: { ss: 3, sp: 5 },
  });
  assert.deepEqual(ids(trash(s)), [id.b, id.a]);
  assert.deepEqual(ids(anytime(s)), []);
});

test("logbook: completed and canceled, newest first, whole seconds; ties keep canceled before completed", () => {
  const s = make({
    [id.a!]: { ss: 3, sp: 100.9 }, [id.b!]: { ss: 2, sp: 200 }, [id.c!]: { ss: 3, sp: 200.4 },
    [id.d!]: { ss: 3, sp: 50, tr: true }, [id.e!]: { ss: 0, sp: null },
  });
  assert.deepEqual(ids(logbook(s)), [id.b, id.c, id.a]);
});

test("order is by ix, and ties keep the log order", () => {
  const s = make({ [id.a!]: { st: 0, ix: 5 }, [id.b!]: { st: 0, ix: 5 }, [id.c!]: { st: 0, ix: -1 } });
  assert.deepEqual(ids(inbox(s)), [id.c, id.a, id.b]);
});

test("upcoming is ordered by start date, then by index", () => {
  const a = newId(), b = newId(), c = newId();
  const s = fold(emptyState(), [{
    [a]: { e: "Task7", t: 0, p: { st: 2, sr: TODAY + 30 * DAY, ss: 0, tr: false, ix: 1, tt: "far" } },
    [b]: { e: "Task7", t: 0, p: { st: 2, sr: TODAY + DAY, ss: 0, tr: false, ix: 5, tt: "soon" } },
    [c]: { e: "Task7", t: 0, p: { st: 2, sr: TODAY + DAY, ss: 0, tr: false, ix: 2, tt: "soon, earlier index" } },
  }]);
  assert.deepEqual(ids(upcoming(s, { now: NOW, timeZone: TZ })), [c, b, a]);
});
