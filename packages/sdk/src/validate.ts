// Write-side validation. Port of the Go SDK's task_write.go (the "Task7 write contract").
//
// Everything outside the verified scope is refused before any request is made, because a bad write to the
// sync history is permanent: Things.app crashes on it on every sync and the item cannot be removed.
//
// Differences from the Go SDK that follow from taking objects instead of raw JSON text:
//  - duplicate JSON keys cannot occur in an object, so they are not checked;
//  - invalid UTF-8 cannot occur in a JS string; a lone surrogate (which would serialise to an invalid escape) is refused.

import { encodeLegacyIdentifier, isValidId, validateId } from "./base58.ts";
import { crc32 } from "./crc32.ts";
import { WriteRefusedError } from "./errors.ts";
import { diagnosticTaskKind } from "./errors.ts";
import type { WriteItem } from "./types.ts";

export interface WritePlan {
  modificationTargets: Set<string>;
  creationTargets: Set<string>;
  tombstoneTargets: Set<string>;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const fail: (msg: string) => never = (msg) => { throw new WriteRefusedError(msg); };

const isInt = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);

const MIN_TS = -62135596800;
const MAX_TS = 253402300799;

function requiredTimestamp(v: unknown, positive: boolean): string | null {
  if (typeof v !== "number" || !Number.isFinite(v)) return "must be a finite timestamp";
  if (v < MIN_TS || v > MAX_TS || (positive && v <= 0)) return "must be a valid timestamp";
  return null;
}
const nullableTimestamp = (v: unknown): string | null => (v === null ? null : requiredTimestamp(v, false));

function exactKeys(values: Obj, want: ReadonlySet<string>): string | null {
  const keys = Object.keys(values);
  if (keys.length !== want.size) return "must contain exactly the verified properties";
  for (const k of keys) if (!want.has(k)) return `contains unsupported property ${JSON.stringify(k)}`;
  return null;
}

/** True when every string and key reachable from `v` is well formed UTF-16 (no lone surrogates). */
export function isWellFormedDeep(v: unknown): boolean {
  if (typeof v === "string") return v.isWellFormed();
  if (Array.isArray(v)) return v.every(isWellFormedDeep);
  if (isObj(v)) return Object.entries(v).every(([k, x]) => k.isWellFormed() && isWellFormedDeep(x));
  return true;
}

const CREATE_KEYS: ReadonlySet<string> = new Set([
  "tp", "sr", "dds", "rt", "rmd", "ss", "tr", "dl", "icp", "st", "ar", "tt", "do", "lai", "tir", "tg", "agr", "ix", "cd",
  "lt", "icc", "md", "ti", "dd", "ato", "nt", "icsd", "pr", "rp", "acrd", "sp", "sb", "rr", "xx",
]);
const MODIFY_KEYS: ReadonlySet<string> = new Set(["md", "tt", "nt", "st", "sr", "tir", "dd", "ar", "pr", "agr", "tg", "ss", "sp", "tr", "ix", "ti", "do"]);

function validateFullTextNote(v: unknown): string | null {
  if (!isObj(v)) return "must be an object";
  const e = exactKeys(v, new Set(["_t", "ch", "v", "t"]));
  if (e) return e;
  const ch = v["ch"];
  if (v["_t"] !== "tx" || v["t"] !== 1 || !isStr(v["v"]) || !isInt(ch) || ch < 0 || ch > 0xffffffff) {
    return "must be a tx full-text note with string value and CRC32 checksum";
  }
  if (ch !== crc32(v["v"])) return "has a checksum that does not match its full text";
  return null;
}

function validateDefaultExtension(v: unknown): string | null {
  if (!isObj(v)) return "must be an object";
  const e = exactKeys(v, new Set(["sn", "_t"]));
  if (e) return e;
  if (v["_t"] !== "oo") return "must have _t oo";
  if (!isObj(v["sn"]) || Object.keys(v["sn"] as Obj).length !== 0) return "must have an empty sn object";
  return null;
}

function validateReferenceArray(v: unknown): string | null {
  if (!isStringArray(v)) return "must be an array of identifiers";
  for (const id of v) if (!isValidId(id)) return "contains an invalid identifier";
  return null;
}

function validateTask7Create(p: Obj): void {
  let e = exactKeys(p, CREATE_KEYS);
  if (e) fail(`create payload ${e}`);
  const tp = p["tp"];
  if (!isInt(tp) || tp < 0 || tp > 2) fail("create tp must be 0, 1, or 2");
  const st = p["st"];
  if (!isInt(st) || st < 0 || st > 2 || (tp !== 0 && st !== 1)) fail("create st is invalid for task type");
  if (p["ss"] !== 0 || !isInt(p["ss"])) fail("create ss must be 0");
  if (p["tr"] !== false) fail("create tr must be false");
  for (const k of ["icp", "lt"]) if (p[k] !== false) fail(`create ${k} must be false`);
  for (const k of ["do", "ix", "icc", "ti", "sb"]) if (!isInt(p[k]) || p[k] !== 0) fail(`create ${k} must be 0`);
  if (!isStr(p["tt"])) fail("create tt must be a string");
  e = requiredTimestamp(p["cd"], true);
  if (e) fail(`create cd ${e}`);
  for (const k of ["sr", "tir", "dd"]) { e = nullableTimestamp(p[k]); if (e) fail(`create ${k} ${e}`); }
  const srNull = p["sr"] === null;
  const tirNull = p["tir"] === null;
  if (srNull !== tirNull) fail("create sr and tir must have the same date");
  if (st === 0 && !srNull) fail("create st 0 requires null sr and tir");
  if (!srNull && p["sr"] !== p["tir"]) fail("create sr and tir must have the same date");
  for (const k of ["dds", "rmd", "lai", "md", "ato", "icsd", "rp", "acrd", "sp", "rr"]) if (p[k] !== null) fail(`create ${k} must be null`);
  for (const k of ["rt", "dl"]) if (!isStringArray(p[k]) || (p[k] as string[]).length !== 0) fail(`create ${k} must be an empty array`);
  for (const k of ["ar", "pr", "agr", "tg"]) {
    e = validateReferenceArray(p[k]);
    if (e) fail(`create ${k} ${e}`);
    if (k !== "tg" && (p[k] as string[]).length > 1) fail(`create ${k} supports at most one parent identifier`);
  }
  e = validateFullTextNote(p["nt"]);
  if (e) fail(`create nt ${e}`);
  e = validateDefaultExtension(p["xx"]);
  if (e) fail(`create xx ${e}`);
}

function validateTask7Modification(p: Obj): void {
  for (const k of Object.keys(p)) if (!MODIFY_KEYS.has(k)) fail("modification contains a property outside the verified write scope");
  let e = requiredTimestamp(p["md"], true);
  if (e) fail(`modification md ${e}`);
  if ("tt" in p && !isStr(p["tt"])) fail("modification tt must be a string");
  if ("nt" in p) { e = validateFullTextNote(p["nt"]); if (e) fail(`modification nt ${e}`); }
  if ("st" in p && (!isInt(p["st"]) || p["st"] < 0 || p["st"] > 2)) fail("modification st must be 0, 1, or 2");
  if ("ss" in p && (!isInt(p["ss"]) || (p["ss"] !== 0 && p["ss"] !== 3))) fail("modification ss must be 0 or 3");
  const hasStatus = "ss" in p;
  const hasStop = "sp" in p;
  if (hasStatus !== hasStop) fail("modification ss and sp must be written together");
  if (hasStatus) {
    if (p["ss"] === 0 && p["sp"] !== null) fail("modification ss 0 requires null sp");
    if (p["ss"] === 3 && (p["sp"] === null || requiredTimestamp(p["sp"], true) !== null)) fail("modification ss 3 requires a positive sp timestamp");
  }
  const sched = ["st", "sr", "tir"].filter((k) => k in p).length;
  if (sched !== 0) {
    if (sched !== 3) fail("modification st, sr, and tir must be written together");
    const srNull = p["sr"] === null;
    if (srNull !== (p["tir"] === null)) fail("modification sr and tir must have the same date");
    if (p["st"] === 0 && !srNull) fail("modification st 0 requires null sr and tir");
    if (!srNull && p["sr"] !== p["tir"]) fail("modification sr and tir must have the same date");
  }
  for (const k of ["sr", "tir", "dd", "sp"]) if (k in p) { e = nullableTimestamp(p[k]); if (e) fail(`modification ${k} ${e}`); }
  for (const k of ["ar", "pr", "agr", "tg"]) if (k in p) { e = validateReferenceArray(p[k]); if (e) fail(`modification ${k} ${e}`); }
  if ("tr" in p && !isBool(p["tr"])) fail("modification tr must be a boolean");
  for (const k of ["ix", "ti", "do"]) if (k in p && !isInt(p[k])) fail(`modification ${k} must be an integer`);
}

function validateTombstoneCompanion(item: WriteItem): string {
  if (!isWellFormedDeep(item.payload)) fail("invalid tombstone envelope");
  if (item.action !== 0) fail("invalid tombstone action");
  const p = item.payload;
  if (!isObj(p) || exactKeys(p, new Set(["dloid", "dld"]))) fail("invalid tombstone payload");
  let target = (p as Obj)["dloid"];
  if (!isStr(target) || target === "" || requiredTimestamp((p as Obj)["dld"], true)) fail("invalid tombstone payload");
  if (item.kind === "Tombstone2") {
    if (!isValidId(target as string)) fail("invalid tombstone target");
  } else if (!isValidId(target as string)) target = encodeLegacyIdentifier(target as string);
  return target as string;
}

/**
 * Validates a batch of changes and classifies the Task7 ones. Throws {@link WriteRefusedError} on the first problem.
 * Items of other kinds (tags, areas, checklists, Task6, ...) pass through unvalidated, as in the Go SDK.
 */
export function validateWrites(items: readonly WriteItem[]): WritePlan {
  const plan: WritePlan = { modificationTargets: new Set(), creationTargets: new Set(), tombstoneTargets: new Set() };
  const tombstones: WriteItem[] = [];
  for (const item of items) {
    if (!isStr(item.kind) || !isInt(item.action)) fail("refusing to write an invalid item envelope");
    switch (item.kind) {
      case "Task7": {
        if (!isWellFormedDeep(item) || !isObj(item.payload)) fail("refusing to write invalid Task7 envelope");
        try {
          if (item.action === 0) { validateTask7Create(item.payload); plan.creationTargets.add(item.uuid); }
          else if (item.action === 1) { validateTask7Modification(item.payload); plan.modificationTargets.add(item.uuid); }
          else fail(`Task7 action ${item.action} is outside the verified write scope`);
        } catch (e) {
          if (e instanceof WriteRefusedError) throw new WriteRefusedError(`refusing to write Task7: ${e.message}`, { cause: e });
          throw e;
        }
        break;
      }
      case "Task6": case "Task4": case "Task3": case "Task":
        break; // existing write kinds keep their behaviour
      case "Tombstone2": case "Tombstone":
        tombstones.push(item);
        break;
      default:
        if (item.kind.startsWith("Task")) fail(`refusing to write unverified task kind ${diagnosticTaskKind(item.kind)}`);
    }
  }
  if (plan.creationTargets.size + plan.modificationTargets.size !== 0) {
    for (const t of tombstones) {
      try { plan.tombstoneTargets.add(validateTombstoneCompanion(t)); }
      catch { fail("refusing to write Task7 batch: invalid tombstone companion"); }
    }
  }
  for (const targets of [plan.creationTargets, plan.modificationTargets]) {
    for (const target of targets) {
      if (plan.tombstoneTargets.has(target)) fail(`refusing to write Task7: target ${target} is both changed and deleted in one commit`);
    }
  }
  return plan;
}

/** Wraps {@link validateId} with the message the writer uses. */
export function assertWritableId(id: string): void {
  try { validateId(id); } catch (e) { throw new WriteRefusedError(`refusing to write item: ${(e as Error).message}`, { cause: e }); }
}
