// Task7 modification preflight. Port of the Go SDK's raw-history scan.
//
// Before modifying an existing task, prove from the log that it exists exactly once, is not part of a recurrence,
// and that its recurrence markers (rr, rp, rt) are all explicit. Anything unclear is refused.
//
// Two ways to run it:
//  - scanTask7Targets: reads the whole log through a page fetcher (what the Go SDK does on every modifying write);
//  - preflightFromState: answers from an up-to-date folded State (cheap; the caller guarantees it is current).

import { encodeLegacyIdentifier, isValidId } from "./base58.ts";
import { ThingsError } from "./errors.ts";
import { isWellFormedDeep } from "./validate.ts";
import type { Entity, State } from "./state.ts";
import type { Item } from "./types.ts";

export class PreflightError extends ThingsError {}
const fail: (msg: string) => never = (msg) => { throw new PreflightError(`Task7 write preflight: ${msg}`); };

interface TargetState {
  exists: boolean;
  ambiguous: boolean;
  future: boolean;
  lastAffectedIndex: number;
  sameIndexAmbiguous: boolean;
  rrKnown: boolean; rrActive: boolean;
  rpKnown: boolean; rpActive: boolean;
  rtKnown: boolean; rtActive: boolean;
  icsd: boolean;
  acrd: boolean;
}

const fresh = (): TargetState => ({
  exists: false, ambiguous: false, future: false, lastAffectedIndex: -1, sameIndexAmbiguous: false,
  rrKnown: false, rrActive: false, rpKnown: false, rpActive: false, rtKnown: false, rtActive: false, icsd: false, acrd: false,
});

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const LEGACY_TASK_KINDS = new Set(["Task4", "Task3", "Task"]);
const TASK_KINDS = new Set(["Task6", "Task7", "Task4", "Task3", "Task"]);

function markAffected(s: TargetState, serverIndex: number): void {
  if (s.lastAffectedIndex === serverIndex) s.sameIndexAmbiguous = true;
  s.lastAffectedIndex = serverIndex;
}

function resetSemantic(s: TargetState, exists: boolean): void {
  const { lastAffectedIndex, sameIndexAmbiguous } = s;
  Object.assign(s, fresh(), { exists, lastAffectedIndex, sameIndexAmbiguous });
}

function applyItem(states: Map<string, TargetState>, item: Item): void {
  const serverIndex = item.serverIndex ?? -1;
  if (item.kind === "Tombstone2" || item.kind === "Tombstone") {
    const p = item.payload;
    if (!isWellFormedDeep(p) || !isObj(p) || typeof p["dloid"] !== "string" || p["dloid"] === "") fail("malformed tombstone in raw history");
    let target = p["dloid"] as string;
    if (item.kind === "Tombstone" && !isValidId(target)) target = encodeLegacyIdentifier(target);
    const s = states.get(target);
    if (s) { markAffected(s, serverIndex); resetSemantic(s, false); }
    return;
  }

  let id = item.uuid;
  if (LEGACY_TASK_KINDS.has(item.kind) && !isValidId(id)) id = encodeLegacyIdentifier(id);
  const s = states.get(id);
  if (!s) return;
  markAffected(s, serverIndex);

  if (!TASK_KINDS.has(item.kind)) {
    if (item.kind.startsWith("Task")) s.future = true;
    s.ambiguous = true;
    return;
  }

  switch (item.action) {
    case 0: {
      const ambiguous = s.ambiguous || s.future || s.exists;
      resetSemantic(s, true);
      s.ambiguous = ambiguous;
      break;
    }
    case 1:
      if (!s.exists) s.ambiguous = true;
      break;
    case 2:
      resetSemantic(s, false);
      return;
    default:
      s.ambiguous = true;
      return;
  }

  const p = item.payload;
  if (!isWellFormedDeep(p) || !isObj(p)) { s.ambiguous = true; return; }
  if ("rr" in p) { s.rrKnown = true; s.rrActive = p["rr"] !== null; }
  if ("rp" in p) { s.rpKnown = true; s.rpActive = p["rp"] !== null; }
  if ("rt" in p) {
    s.rtKnown = true;
    const rt = p["rt"];
    if (rt === null) s.rtActive = false;
    else if (Array.isArray(rt) && rt.every((x) => typeof x === "string")) s.rtActive = rt.length !== 0;
    else s.ambiguous = true;
  }
  if ("icsd" in p) s.icsd = p["icsd"] !== null;
  if ("acrd" in p) s.acrd = p["acrd"] !== null;
}

function classify(states: Map<string, TargetState>): void {
  for (const [id, s] of states) {
    if (s.future) fail(`target ${id} has an unsupported future task kind`);
    if (!s.exists || s.ambiguous || s.sameIndexAmbiguous) fail(`target ${id} is missing or ambiguous`);
    if (!s.rrKnown || !s.rpKnown || !s.rtKnown) fail(`target ${id} lacks complete recurrence markers`);
    if (s.rrActive || s.rpActive || s.rtActive || s.icsd || s.acrd) fail(`target ${id} is recurring`);
  }
}

const MAX_PAGES = 100_000;

/** One page of the log, as returned by `History.items`. */
export interface PreflightPage { items: Item[]; loadedServerIndex: number; latestServerIndex: number }

/**
 * Scans the log from index 0 up to the head observed on the first page and classifies every target.
 * Returns that head: use it as the commit's ancestor index so the write only lands if nothing changed since.
 */
export async function scanTask7Targets(fetchPage: (startIndex: number) => Promise<PreflightPage>, targets: Iterable<string>): Promise<number> {
  const states = new Map<string, TargetState>();
  for (const id of targets) states.set(id, fresh());
  let start = 0;
  let checkedHead = -1;
  for (let pages = 0; ; pages++) {
    if (pages >= MAX_PAGES) fail(`gave up after ${MAX_PAGES} pages`);
    const page = await fetchPage(start);
    if (checkedHead < 0) {
      checkedHead = page.latestServerIndex;
      if (checkedHead < 0) fail("invalid history head");
    } else if (page.latestServerIndex < checkedHead) fail("history head regressed");
    for (const item of page.items) {
      if (item.serverIndex === undefined || item.serverIndex >= checkedHead) continue;
      applyItem(states, item);
    }
    if (page.loadedServerIndex >= checkedHead) break;
    if (page.loadedServerIndex <= start) fail(`history ended before checked head ${checkedHead}`);
    start = page.loadedServerIndex;
  }
  classify(states);
  return checkedHead;
}

function stateOf(e: Entity | undefined): TargetState {
  const s = fresh();
  if (!e) return s;
  const f = e.fields;
  s.exists = true;
  s.ambiguous = e.ambiguous === true;
  s.rrKnown = Object.hasOwn(f, "rr"); s.rrActive = f["rr"] != null;
  s.rpKnown = Object.hasOwn(f, "rp"); s.rpActive = f["rp"] != null;
  s.rtKnown = Object.hasOwn(f, "rt"); s.rtActive = Array.isArray(f["rt"]) && f["rt"].length > 0;
  s.icsd = f["icsd"] != null;
  s.acrd = f["acrd"] != null;
  return s;
}

/**
 * Same rules as the scan, answered from a folded state (`Entity.ambiguous` carries what the scan infers from the log). The caller must have synced `state` to the current head;
 * the commit's ancestor index then protects against anything that changed since.
 */
export function preflightFromState(state: State, targets: Iterable<string>): number {
  const states = new Map<string, TargetState>();
  for (const id of targets) states.set(id, stateOf(state.tasks.get(id)));
  classify(states);
  return state.cursor;
}
