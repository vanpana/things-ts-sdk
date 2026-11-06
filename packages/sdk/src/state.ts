// Event-sourced state. The log is append-only; state is the fold of every item in order:
//   created / modified: shallow-merge the payload keys (an explicit null clears the field)
//   deleted:            drop the entity
//   nt (note) is special: a plain string, a full-text object, or byte-offset patches against the current text
// Entities keep their raw wire fields, so nothing the server sends is lost; see entities.ts for typed views.
//
// Applying a batch is atomic: the whole batch is validated and computed on a copy-on-write overlay, and the
// real state only changes if every item succeeded.

import { encodeLegacyIdentifier, isValidId } from "./base58.ts";
import { MalformedItemError, NoteError, UnknownKindError, UnsupportedTaskKindError } from "./errors.ts";
import { applyPatchesChecked, NOTE_TYPE_DELTA, NOTE_TYPE_FULL_TEXT } from "./notes.ts";
import type { NotePatch } from "./notes.ts";
import { ItemAction } from "./types.ts";
import type { Commit, Item } from "./types.ts";

/** Bump when the meaning of a folded entity changes; persisted state with another version must be rebuilt. */
export const STATE_VERSION = 1;

export type Fields = Record<string, unknown>;
export interface Entity {
  kind: string;
  fields: Fields;
  note: string;
  /**
   * Set when the log does not say unambiguously what this task is: it was created over a live task, modified without a
   * creation, or touched twice in one commit. Writes to such a task are refused (see preflightFromState). Cleared by a delete.
   */
  ambiguous?: boolean;
}

export interface State {
  stateVersion: number;
  /** Number of commits folded so far; also the next start-index to request. */
  cursor: number;
  tasks: Map<string, Entity>;
  checklist: Map<string, Entity>;
  tags: Map<string, Entity>;
  areas: Map<string, Entity>;
  settings: Map<string, Entity>;
}

export function emptyState(): State {
  return { stateVersion: STATE_VERSION, cursor: 0, tasks: new Map(), checklist: new Map(), tags: new Map(), areas: new Map(), settings: new Map() };
}

/**
 * - `strict` (default): any item kind this SDK does not know is an error, and so is a malformed payload.
 *   Failing closed means a protocol change cannot silently corrupt state.
 * - `lenient`: unknown non-task kinds and malformed non-task payloads are skipped, as the Go SDK does.
 *   Unknown `Task*` kinds are always an error because the result would be incomplete.
 */
export type ApplyMode = "strict" | "lenient";
export interface ApplyOptions { mode?: ApplyMode }

type Bucket = "tasks" | "checklist" | "tags" | "areas" | "settings";
interface KindInfo { bucket: Bucket | "tombstone"; legacy: boolean }

// "legacy" = the pre-migration generation, keyed by raw identifier strings (see encodeLegacyIdentifier).
const KINDS: Record<string, KindInfo> = {
  Task6: { bucket: "tasks", legacy: false }, Task7: { bucket: "tasks", legacy: false },
  Task4: { bucket: "tasks", legacy: true }, Task3: { bucket: "tasks", legacy: true }, Task: { bucket: "tasks", legacy: true },
  ChecklistItem3: { bucket: "checklist", legacy: false },
  ChecklistItem2: { bucket: "checklist", legacy: true }, ChecklistItem: { bucket: "checklist", legacy: true },
  Area3: { bucket: "areas", legacy: false }, Area2: { bucket: "areas", legacy: true }, Area: { bucket: "areas", legacy: true },
  Tag4: { bucket: "tags", legacy: false }, Tag3: { bucket: "tags", legacy: true }, Tag: { bucket: "tags", legacy: true },
  Settings5: { bucket: "settings", legacy: false }, Settings4: { bucket: "settings", legacy: false }, Settings3: { bucket: "settings", legacy: false },
  Tombstone2: { bucket: "tombstone", legacy: false }, Tombstone: { bucket: "tombstone", legacy: true },
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Splits commits into flat items. `startIndex` is the server index of the first commit. */
export function flattenCommits(commits: Commit[], startIndex = 0): Item[] {
  const items: Item[] = [];
  for (const [offset, commit] of commits.entries()) {
    if (!isObject(commit)) throw new MalformedItemError("commit must be an object");
    for (const [uuid, raw] of Object.entries(commit)) {
      if (!isObject(raw) || typeof raw["e"] !== "string" || typeof raw["t"] !== "number") {
        throw new MalformedItemError("item must have a string kind (e) and a numeric action (t)");
      }
      items.push({ uuid, kind: raw["e"], action: raw["t"], payload: raw["p"], serverIndex: startIndex + offset });
    }
  }
  return items;
}

// ---- Payload checks. These mirror what the Go SDK's typed decoder rejects. -------------------------------------

type Shape = "string" | "int" | "num" | "bool" | "strings" | "object" | "any";
const TASK_SHAPES: Record<string, Shape> = {
  ix: "int", cd: "num", md: "num", sr: "num", sp: "num", dd: "num", tir: "num", ss: "int", tp: "int", tt: "string",
  ar: "strings", pr: "strings", tg: "strings", tr: "bool", ti: "int", rt: "strings", st: "int", agr: "strings",
  rr: "object", do: "int", lt: "bool", icp: "bool", icc: "int", icsd: "num", sb: "int", dl: "strings", lai: "num",
  rmd: "num", ato: "int", acrd: "num", dds: "num", xx: "any", nt: "any",
};

function shapeOk(shape: Shape, v: unknown): boolean {
  if (v === null) return true;
  switch (shape) {
    case "string": return typeof v === "string";
    case "int": return typeof v === "number" && Number.isSafeInteger(v);
    case "num": return typeof v === "number" && Number.isFinite(v);
    case "bool": return typeof v === "boolean";
    case "strings": return Array.isArray(v) && v.every((x) => typeof x === "string");
    case "object": return isObject(v);
    default: return true;
  }
}

const optional = (v: unknown, ok: (x: unknown) => boolean): boolean => v === undefined || v === null || ok(v);

/** The type rules of the Go SDK's Note / NotePatch decoder. */
function checkNoteObject(nt: Record<string, unknown>): void {
  const bad = (what: string): never => { throw new MalformedItemError(`task note ${what} has the wrong type`); };
  if (!optional(nt["_t"], (x) => typeof x === "string")) bad("_t");
  if (!optional(nt["ch"], (x) => Number.isSafeInteger(x))) bad("ch");
  if (nt["t"] === NOTE_TYPE_FULL_TEXT) {
    if (!optional(nt["v"], (x) => typeof x === "string")) bad("v");
    return;
  }
  const ps = nt["ps"];
  if (!optional(ps, Array.isArray)) bad("ps");
  for (const p of (ps as unknown[] | undefined | null) ?? []) {
    if (p === null) continue;
    if (!isObject(p)) bad("patch");
    const q = p as Record<string, unknown>;
    if (!optional(q["r"], (x) => typeof x === "string") || !optional(q["p"], (x) => Number.isSafeInteger(x)) || !optional(q["l"], (x) => Number.isSafeInteger(x)) || !optional(q["ch"], (x) => Number.isSafeInteger(x))) bad("patch");
  }
}

const REPEATER_SHAPES: Record<string, Shape> = { ia: "num", rc: "int", fu: "int", fa: "int", ed: "num", rrv: "int", tp: "int", ts: "int", sr: "num" };
const REPEATER_DETAIL_SHAPES: Record<string, Shape> = { dy: "int", mo: "int", wd: "int", wdo: "int" };

/** Same type rules as the Go SDK's RepeaterConfiguration decoder. Unknown keys are allowed. */
function repeaterOk(rr: unknown): boolean {
  if (rr === null) return true;
  if (!isObject(rr)) return false;
  for (const [k, shape] of Object.entries(REPEATER_SHAPES)) if (k in rr && !shapeOk(shape, rr[k])) return false;
  const of = rr["of"];
  if (of === undefined || of === null) return true;
  if (!Array.isArray(of)) return false;
  return of.every((d) => d === null || (isObject(d) && Object.entries(REPEATER_DETAIL_SHAPES).every(([k, shape]) => !(k in d) || shapeOk(shape, d[k]))));
}

/**
 * Required task fields. An explicit null for one of these is ignored rather than stored, as in the Go SDK: a task
 * never loses its title, status, start state, order, trash flag or type. Every other null clears the field.
 */
const NEVER_NULL = new Set(["tt", "ss", "st", "ix", "tr", "tp", "ti", "do"]);

function checkTaskPayload(payload: unknown): Record<string, unknown> {
  if (!isObject(payload)) throw new MalformedItemError("task payload must be a JSON object");
  if ("rr" in payload && !repeaterOk(payload["rr"])) throw new MalformedItemError("task payload field rr has the wrong type");
  for (const [key, shape] of Object.entries(TASK_SHAPES)) {
    if (key in payload && !shapeOk(shape, payload[key])) throw new MalformedItemError(`task payload field ${key} has the wrong type`);
  }
  const nt = payload["nt"];
  if (nt !== undefined && nt !== null && typeof nt !== "string") {
    if (!isObject(nt)) throw new MalformedItemError("task note must be text, null, or a supported structured note");
    if (nt["t"] !== NOTE_TYPE_FULL_TEXT && nt["t"] !== NOTE_TYPE_DELTA) throw new MalformedItemError(`unsupported task note type ${String(nt["t"])}`);
    checkNoteObject(nt);
  }
  return payload;
}

function resolveNote(current: string, nt: unknown): string {
  if (nt === null) return "";
  if (typeof nt === "string") return nt;
  const note = nt as { t: number; v?: unknown; ps?: unknown };
  if (note.t === NOTE_TYPE_FULL_TEXT) return typeof note.v === "string" ? note.v : "";
  const patches = (Array.isArray(note.ps) ? (note.ps as (Partial<NotePatch> | null)[]) : []).map(
    (p): NotePatch => ({ r: p?.r ?? "", p: p?.p ?? 0, l: p?.l ?? 0, ch: p?.ch ?? 0 }),
  );
  try { return applyPatchesChecked(current, patches); }
  catch (e) { throw new NoteError(`applying task note delta: ${(e as Error).message}`, { cause: e }); }
}

// ---- Legacy identifier remapping --------------------------------------------------------------------------------

const remapId = (id: string): string => (isValidId(id) ? id : encodeLegacyIdentifier(id));

/** Copies `payload`, rewriting identifier-valued reference fields. Never mutates the caller's object. */
function remapReferences(payload: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  let out: Record<string, unknown> | null = null;
  for (const key of keys) {
    const v = payload[key];
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
      out ??= { ...payload };
      out[key] = (v as string[]).map(remapId);
    }
  }
  return out ?? payload;
}
const TASK_REFS = ["ar", "pr", "agr", "tg", "rt", "dl"] as const;

// ---- Apply ---------------------------------------------------------------------------------------------------------

type Overlay = Record<Bucket, Map<string, Entity | null>>;

/**
 * Applies items in order to `state`. Throws without changing `state` if any item is unsupported or malformed.
 * Does not touch `state.cursor`; see {@link fold}.
 */
export function applyItems(state: State, items: Item[], opts: ApplyOptions = {}): State {
  const strict = (opts.mode ?? "strict") === "strict";
  for (const item of items) {
    if (Object.hasOwn(KINDS, item.kind)) continue;
    if (item.kind.startsWith("Task")) throw new UnsupportedTaskKindError(item.kind, item.serverIndex ?? -1);
    if (strict) throw new UnknownKindError(item.kind);
  }

  const overlay: Overlay = { tasks: new Map(), checklist: new Map(), tags: new Map(), areas: new Map(), settings: new Map() };
  const touch = (b: Bucket, id: string, kind: string): Entity => {
    const have = overlay[b].get(id);
    if (have) { have.kind = kind; return have; }
    const base = state[b].get(id);
    // Null-prototype maps: a server key such as "__proto__" must stay an ordinary key.
    const ent: Entity = base && overlay[b].get(id) !== null
      ? { kind, fields: Object.assign(Object.create(null), base.fields), note: base.note, ...(base.ambiguous ? { ambiguous: true } : {}) }
      : { kind, fields: Object.create(null), note: "" };
    overlay[b].set(id, ent);
    return ent;
  };

  // Ambiguity bookkeeping for tasks (what the Go preflight infers by rescanning the log).
  const lastIndex = new Map<string, number>();
  const sameIndex = new Set<string>();
  const seen = (id: string, index: number | undefined): void => {
    if (index === undefined) return;
    if (lastIndex.get(id) === index) sameIndex.add(id);
    lastIndex.set(id, index);
  };

  for (const item of items) {
    const info = Object.hasOwn(KINDS, item.kind) ? KINDS[item.kind] : undefined;
    if (!info) continue; // lenient mode: unknown non-task kind
    const id = info.legacy && info.bucket !== "tombstone" ? remapId(item.uuid) : item.uuid;

    if (info.bucket === "tombstone") {
      const p = item.payload;
      if (!isObject(p) || typeof p["dloid"] !== "string" || p["dloid"] === "") {
        if (strict) throw new MalformedItemError("tombstone needs a dloid");
        continue;
      }
      const oid = info.legacy ? remapId(p["dloid"]) : p["dloid"];
      seen(oid, item.serverIndex);
      for (const b of ["tasks", "areas", "tags", "checklist"] as const) overlay[b].set(oid, null);
      continue;
    }

    if (info.bucket === "tasks") seen(id, item.serverIndex);
    if (item.action === ItemAction.Deleted) { overlay[info.bucket].set(id, null); continue; }
    if (item.action !== ItemAction.Created && item.action !== ItemAction.Modified) continue; // unsupported action: skip

    let payload: Record<string, unknown>;
    if (info.bucket === "tasks") {
      payload = checkTaskPayload(item.payload);
      if (info.legacy) payload = remapReferences(payload, TASK_REFS);
    } else {
      if (!isObject(item.payload)) {
        if (strict) throw new MalformedItemError(`${item.kind} payload must be a JSON object`);
        continue;
      }
      payload = item.payload;
      if (info.legacy) payload = remapReferences(payload, info.bucket === "checklist" ? ["ts"] : info.bucket === "tags" ? ["pn"] : ["tg"]);
    }
    const live = overlay[info.bucket].has(id) ? overlay[info.bucket].get(id) : state[info.bucket].get(id);
    const ent = touch(info.bucket, id, item.kind);
    if (info.bucket === "tasks") {
      if (item.action === ItemAction.Created ? live : !live) ent.ambiguous = true;
      else if (!live) delete ent.ambiguous;
    }
    for (const [key, value] of Object.entries(payload)) {
      if (key === "nt" && info.bucket === "tasks") ent.note = resolveNote(ent.note, value);
      else if (value === null && info.bucket === "tasks" && NEVER_NULL.has(key)) continue;
      else ent.fields[key] = value;
    }
  }

  for (const id of sameIndex) {
    const live = overlay.tasks.has(id) ? overlay.tasks.get(id) : state.tasks.get(id);
    if (live) touch("tasks", id, live.kind).ambiguous = true;
  }

  for (const b of ["tasks", "checklist", "tags", "areas", "settings"] as const) {
    for (const [id, ent] of overlay[b]) {
      if (ent === null) state[b].delete(id);
      else state[b].set(id, ent);
    }
  }
  return state;
}

/** Applies whole commits and advances the cursor by their count. Atomic: on a throw nothing changes. */
export function fold(state: State, commits: Commit[], opts: ApplyOptions = {}): State {
  applyItems(state, flattenCommits(commits, state.cursor), opts);
  state.cursor += commits.length;
  return state;
}

// ---- Persistence helpers (Maps are not JSON) ----------------------------------------------------------------------

export interface StateSnapshot {
  stateVersion: number;
  cursor: number;
  tasks: [string, Entity][];
  checklist: [string, Entity][];
  tags: [string, Entity][];
  areas: [string, Entity][];
  settings: [string, Entity][];
}

export function exportState(state: State): StateSnapshot {
  return {
    stateVersion: state.stateVersion, cursor: state.cursor,
    tasks: [...state.tasks], checklist: [...state.checklist], tags: [...state.tags], areas: [...state.areas], settings: [...state.settings],
  };
}

/** Returns `null` for a snapshot from another {@link STATE_VERSION}: rebuild it from the log instead. */
export function importState(snapshot: StateSnapshot): State | null {
  if (snapshot.stateVersion !== STATE_VERSION) return null;
  return {
    stateVersion: STATE_VERSION, cursor: snapshot.cursor,
    tasks: new Map(snapshot.tasks), checklist: new Map(snapshot.checklist), tags: new Map(snapshot.tags),
    areas: new Map(snapshot.areas), settings: new Map(snapshot.settings),
  };
}
