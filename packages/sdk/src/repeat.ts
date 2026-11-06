// Recurrence rules (`rr`). Port of the Go SDK's repeat.go. All dates are UTC; Go's Time.AddDate normalisation is
// reproduced with Date.setUTCFullYear overflow rules. Millisecond precision (Go keeps nanoseconds).
//
// Reading and calculating only: this SDK does not write recurrence configuration.
import { ThingsError } from "./errors.ts";

export const FrequencyUnit = { Daily: 16, Weekly: 256, Monthly: 8, Yearly: 4 } as const;

/** One entry of `of`: which day (monthly/yearly), month (yearly) or weekday a rule fires on. */
export interface RepeaterDetail {
  /** Day of month; -1 = last day. */
  dy?: number;
  /** Month, zero-based. */
  mo?: number;
  /** Weekday, 0 = Sunday. */
  wd?: number;
  /** Which weekday of the month; -1 = last. */
  wdo?: number;
}

/** The `rr` object. Timestamps are unix seconds. */
export interface RepeaterConfiguration {
  /** First scheduled date. */
  ia?: number | null;
  /** Repeat count. */
  rc?: number | null;
  fu: number;
  fa: number;
  of: RepeaterDetail[];
  /** Last scheduled date; year 4001 means "never ends". */
  ed?: number | null;
  rrv?: number;
  tp?: number;
  ts?: number;
  sr?: number | null;
}

const ZERO_YEAR = 1;
const toDate = (seconds: number): Date => new Date(Math.round(seconds * 1000));

/** Go's time.AddDate for UTC times. */
function addDate(t: Date, years: number, months: number, days: number): Date {
  const out = new Date(t.getTime());
  out.setUTCFullYear(t.getUTCFullYear() + years, t.getUTCMonth() + months, t.getUTCDate() + days);
  return out;
}

const zeroTime = (): Date => { const d = new Date(0); d.setUTCFullYear(ZERO_YEAR, 0, 1); d.setUTCHours(0, 0, 0, 0); return d; };
const isZero = (d: Date): boolean => d.getTime() === zeroTime().getTime();
const before = (a: Date, b: Date): boolean => a.getTime() < b.getTime();
const after = (a: Date, b: Date): boolean => a.getTime() > b.getTime();
const need = <T>(v: T | null | undefined, what: string): T => {
  if (v === null || v === undefined) throw new ThingsError(`repeater configuration is missing ${what}`);
  return v;
};

function lastWeekdayOfMonth(t: Date, wdo: number): Date {
  const last = addDate(t, 0, 1, -t.getUTCDate());
  const wd = last.getUTCDay();
  if (wd === wdo) return last;
  if (wd > wdo) return addDate(last, 0, 0, -(wd - wdo));
  return addDate(last, 0, 0, -7 - wd + wdo);
}

function nthWeekdayOfMonth(t: Date, wdo: number, n: number): Date {
  const first = addDate(t, 0, 0, -t.getUTCDate() + 1);
  let nth = first;
  const wd = first.getUTCDay();
  if (wd < wdo) nth = addDate(first, 0, 0, wdo - wd);
  else if (wd > wdo) nth = addDate(first, 0, 0, 7 - wd + wdo);
  return addDate(nth, 0, 0, (n - 1) * 7);
}

const firstDayOfMonth = (t: Date): Date => addDate(t, 0, 0, -t.getUTCDate() + 1);
// The Go SDK subtracts one hour here, not one day. Kept for parity.
const lastDayOfMonth = (t: Date): Date => new Date(addDate(firstDayOfMonth(t), 0, 1, 0).getTime() - 3_600_000);
const nthDayOfMonthOfYear = (t: Date, month: number, day: number): Date =>
  addDate(t, 0, -(t.getUTCMonth() + 1) + month + 1, -t.getUTCDate() + day + 1);

/** Missing numbers read as 0 and null detail entries as empty ones, as when Go decodes the same JSON. */
function normalise(c: RepeaterConfiguration): RepeaterConfiguration {
  return { ...c, fa: c.fa ?? 0, fu: c.fu ?? 0, of: (c.of ?? []).map((d) => d ?? {}) };
}

export function isNeverending(c: RepeaterConfiguration): boolean {
  return c.ed !== null && c.ed !== undefined && toDate(c.ed).getUTCFullYear() === 4001;
}

type DetailStep = (t: Date, dc: RepeaterDetail) => Date;
type AmplitudeStep = (t: Date) => Date;

function nextScheduledAt(c: RepeaterConfiguration, repeat: number, dcF: DetailStep, aF: AmplitudeStep): Date {
  let ia = toDate(need(c.ia, "ia (first scheduled date)"));
  if (c.of.length === 0 && repeat > 0) throw new ThingsError("repeater configuration has no detail entries");
  const neverending = isNeverending(c);
  if (!neverending && need(c.rc, "rc (repeat count)") > 0 && repeat >= c.rc!) return zeroTime();
  for (let i = 0; i < repeat; i += c.of.length) {
    const min = ia;
    if (c.of.length > 1) {
      for (const [j0, dc] of c.of.slice(1).entries()) {
        ia = dcF(ia, dc);
        if (i + j0 + 1 >= repeat) return ia;
      }
    }
    const nt = aF(min);
    if (!neverending && c.ed !== null && c.ed !== undefined && after(nt, toDate(c.ed))) return zeroTime();
    ia = nt;
  }
  return ia;
}

function nextWeekly(c: RepeaterConfiguration, repeat: number): Date {
  return nextScheduledAt(
    c, repeat,
    (t, dc) => addDate(t, 0, 0, need(dc.wd, "wd") - t.getUTCDay()),
    (t) => addDate(t, 0, 0, c.fa * 7),
  );
}

function nextMonthly(c: RepeaterConfiguration, repeat: number): Date {
  return nextScheduledAt(
    c, repeat,
    (t, dc) => {
      if (dc.wdo != null && dc.wd != null) {
        const nt = addDate(t, 0, 0, -t.getUTCDate() + 1);
        return dc.wdo === -1 ? lastWeekdayOfMonth(nt, dc.wd) : nthWeekdayOfMonth(nt, dc.wd, dc.wdo);
      }
      const dy = need(dc.dy, "dy");
      if (dy === -1) return addDate(t, 0, 1, -t.getUTCDate());
      return addDate(t, 0, 0, dy - t.getUTCDate() + 1);
    },
    (t) => {
      let nt = addDate(t, 0, c.fa, 0);
      if (c.of.length === 1) {
        const d0 = c.of[0]!;
        if (d0.dy != null && d0.dy === -1) nt = addDate(nt, 0, 1, -nt.getUTCDate());
        else if (d0.wdo != null) {
          nt = d0.wdo === -1 ? lastWeekdayOfMonth(nt, need(d0.wd, "wd")) : nthWeekdayOfMonth(nt, need(d0.wd, "wd"), d0.wdo);
        }
      }
      return nt;
    },
  );
}

function nextYearly(c: RepeaterConfiguration, repeat: number): Date {
  return nextScheduledAt(
    c, repeat,
    (t, dc) => {
      if (dc.wdo != null && dc.wd != null) {
        const nt = nthDayOfMonthOfYear(t, need(dc.mo, "mo"), 1);
        return dc.wdo === -1 ? lastWeekdayOfMonth(nt, dc.wd) : nthWeekdayOfMonth(nt, dc.wd, dc.wdo);
      }
      const dy = need(dc.dy, "dy");
      if (dy === -1) return lastDayOfMonth(nthDayOfMonthOfYear(t, need(dc.mo, "mo"), 1));
      return nthDayOfMonthOfYear(t, need(dc.mo, "mo"), dy);
    },
    (t) => {
      const nt = addDate(t, c.fa, 0, 0);
      if (c.of.length === 1) {
        const d0 = c.of[0]!;
        if (d0.wdo != null) {
          const base = nthDayOfMonthOfYear(nt, need(d0.mo, "mo"), 1);
          return d0.wdo === -1 ? lastWeekdayOfMonth(base, need(d0.wd, "wd")) : nthWeekdayOfMonth(base, need(d0.wd, "wd"), d0.wdo);
        }
        if (need(d0.dy, "dy") === -1) return addDate(firstDayOfMonth(t), c.fa, 1, -1);
      }
      return nt;
    },
  );
}

function nextDaily(c: RepeaterConfiguration, repeat: number): Date {
  const ia = toDate(need(c.ia, "ia (first scheduled date)"));
  const nt = addDate(ia, 0, 0, c.fa * repeat);
  if (isNeverending(c)) return nt;
  if (c.ed !== null && c.ed !== undefined) {
    if (after(nt, toDate(c.ed))) return zeroTime();
  } else if (repeat >= need(c.rc, "rc (repeat count)")) return zeroTime();
  return nt;
}

/** The Nth (zero-based) date the rule fires on, or `null` when the rule has ended. */
export function nextScheduledDate(config: RepeaterConfiguration, repeat: number): Date | null {
  const c = normalise(config);
  let out: Date;
  switch (c.fu) {
    case FrequencyUnit.Daily: out = nextDaily(c, repeat); break;
    case FrequencyUnit.Weekly: out = nextWeekly(c, repeat); break;
    case FrequencyUnit.Monthly: out = nextMonthly(c, repeat); break;
    case FrequencyUnit.Yearly: out = nextYearly(c, repeat); break;
    default: return null;
  }
  return isZero(out) ? null : out;
}

function firstWeekly(c: RepeaterConfiguration, t: Date): Date {
  if (c.of.length === 0) throw new ThingsError("repeater configuration has no detail entries");
  let d = c.of[0]!;
  for (const dc of c.of) if (need(dc.wd, "wd") < need(d.wd, "wd")) d = dc;
  const target = d.wd!;
  const wd = t.getUTCDay();
  if (wd < target) return addDate(t, 0, 0, target - wd);
  if (wd > target) return addDate(t, 0, 0, 7 - wd + target);
  return t;
}

function firstMonthly(c: RepeaterConfiguration, t: Date): Date {
  let min = addDate(t, 1, 0, 0);
  for (const dc of c.of) {
    let d = zeroTime();
    if (dc.dy != null) {
      d = addDate(t, 0, 0, -t.getUTCDate() + dc.dy + 1);
      if (before(d, t)) d = addDate(t, 0, 1, -t.getUTCDate() + dc.dy + 1);
    }
    if (dc.wd != null) {
      d = need(dc.wdo, "wdo") === -1 ? lastWeekdayOfMonth(t, dc.wd) : nthWeekdayOfMonth(t, dc.wd, dc.wdo!);
    }
    if (before(d, min)) min = d;
  }
  return min;
}

function firstYearly(c: RepeaterConfiguration, t: Date): Date {
  let min = addDate(t, 1, 0, 0);
  for (const dc of c.of) {
    let d = zeroTime();
    if (dc.dy != null) {
      d = nthDayOfMonthOfYear(t, need(dc.mo, "mo"), dc.dy);
      if (before(d, t)) d = nthDayOfMonthOfYear(addDate(t, 1, 0, 0), dc.mo!, dc.dy);
    }
    if (dc.wd != null) {
      const nt = nthDayOfMonthOfYear(t, need(dc.mo, "mo"), 1);
      if (dc.wdo != null && dc.wdo === -1) {
        d = lastWeekdayOfMonth(nt, dc.wd);
        if (before(d, t)) d = lastWeekdayOfMonth(addDate(nt, 1, 0, 0), dc.wd);
      } else {
        const n = need(dc.wdo, "wdo");
        d = nthWeekdayOfMonth(nt, dc.wd, n);
        if (before(d, t)) d = nthWeekdayOfMonth(addDate(nt, 1, 0, 0), dc.wd, n);
      }
    }
    if (before(d, min)) min = d;
  }
  return min;
}

/**
 * The first date matching the rule on or after `t`. Things stores this as `ia`; it is the invariant that
 * {@link nextScheduledDate} relies on. Returns `null` for an unknown frequency unit.
 */
export function computeFirstScheduledDate(config: RepeaterConfiguration, t: Date): Date | null {
  const c = normalise(config);
  let out: Date;
  switch (c.fu) {
    case FrequencyUnit.Daily: out = t; break;
    case FrequencyUnit.Weekly: out = firstWeekly(c, t); break;
    case FrequencyUnit.Monthly: out = firstMonthly(c, t); break;
    case FrequencyUnit.Yearly: out = firstYearly(c, t); break;
    default: return null;
  }
  return isZero(out) ? null : out;
}
