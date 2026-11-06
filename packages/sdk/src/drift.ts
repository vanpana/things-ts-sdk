// Protocol drift detection. Cultured Code publishes nothing about the sync protocol, so changes can only be noticed,
// not read in advance. This check re-reads the whole log and reports what stopped matching what we know:
//  - a schema number or action we have never seen                    -> critical (writes should go read-only)
//  - a kind we have never seen or a malformed payload                -> critical, reported as `rebuild-failed`
//  - fewer commits than the server's head                            -> critical
//  - a full-text note whose checksum is wrong                         -> critical
//  - the incrementally built state differs from a rebuild            -> critical
//  - payload keys we have never seen on a known kind                 -> warning (new fields are common and often harmless)
// It is pure: give it the commits, the state you serve from and what the server reported. Treat a thrown error as
// critical too: callers should fail closed.

import { crc32 } from "./crc32.ts";
import { KNOWN_SCHEMA } from "./guards.ts";
import { emptyState, exportState, fold } from "./state.ts";
import type { State } from "./state.ts";
import type { Commit } from "./types.ts";

/** Payload keys observed on a real account (Things 3.24.1, schema 301) plus the Go SDK's typed fields. */
export const KNOWN_PAYLOAD_KEYS: Readonly<Record<string, readonly string[]>> = {
  Task6: ["acrd", "agr", "ar", "ato", "cd", "dd", "dds", "dl", "do", "icc", "icp", "icsd", "ix", "lai", "lt", "md", "nt", "pr", "rmd", "rp", "rr", "rt", "sb", "sp", "sr", "ss", "st", "tg", "ti", "tir", "tp", "tr", "tt", "xx"],
  Task7: ["acrd", "agr", "ar", "ato", "cd", "dd", "dds", "dl", "do", "icc", "icp", "icsd", "ix", "lai", "lt", "md", "nt", "pr", "rmd", "rp", "rr", "rt", "sb", "sp", "sr", "ss", "st", "tg", "ti", "tir", "tp", "tr", "tt", "xx"],
  ChecklistItem3: ["cd", "ix", "lt", "md", "sp", "ss", "ts", "tt", "xx"],
  Tag4: ["ix", "pn", "sh", "tt", "xx"],
  Area3: ["ix", "tg", "tt", "xx"],
  Settings5: ["grpt", "ld", "li", "usat", "xx"],
  Tombstone2: ["dld", "dloid"],
};

export type DriftSeverity = "warning" | "critical";
export interface DriftFinding { severity: DriftSeverity; code: string; message: string }
export interface DriftReport {
  /** No critical finding. Warnings do not fail the check. */
  ok: boolean;
  /** True when writes should be switched off until a human has looked. */
  killSwitch: boolean;
  findings: DriftFinding[];
  /** Items per kind and action, e.g. `Task7/0`. */
  counts: Record<string, number>;
  /** The state rebuilt from index 0, when the check could build one. Swap it in if `state-diverged` was reported. */
  rebuilt?: State;
}

export interface DriftInput {
  /** The complete log from index 0. */
  commits: readonly Commit[];
  /** The state you serve from (built incrementally). */
  state: State;
  /** The schema version the server reported. */
  schema: number;
  /** The server's head index (`latest-server-index`). The log and the state must both reach it. */
  head: number;
  /** Override the known-key table (tests, forks). */
  knownKeys?: Readonly<Record<string, readonly string[]>>;
}

/** Insertion order differs between an incremental build and a rebuild, so compare entries sorted by id. */
function canonical(state: State): string {
  const snap = exportState(state);
  const sort = <T>(entries: [string, T][]): [string, T][] => [...entries].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify({ ...snap, tasks: sort(snap.tasks), checklist: sort(snap.checklist), tags: sort(snap.tags), areas: sort(snap.areas), settings: sort(snap.settings) });
}

interface LogScan {
  counts: Record<string, number>;
  unseenKeys: Map<string, Set<string>>;
  badChecksums: number;
  badActions: number;
  malformedPayloads: number;
}

function scanLog(commits: readonly Commit[], known: Readonly<Record<string, readonly string[]>>): LogScan {
  const scan: LogScan = { counts: {}, unseenKeys: new Map(), badChecksums: 0, badActions: 0, malformedPayloads: 0 };
  for (const commit of commits) {
    for (const item of Object.values(commit)) {
      const key = `${item.e}/${item.t}`;
      scan.counts[key] = (scan.counts[key] ?? 0) + 1;
      if (item.t !== 0 && item.t !== 1 && item.t !== 2) scan.badActions++;
      const p = item.p;
      if (typeof p !== "object" || p === null || Array.isArray(p)) {
        if (item.t !== 2) scan.malformedPayloads++; // deletions may carry null
        continue;
      }
      const table = Object.hasOwn(known, item.e) ? known[item.e] : undefined;
      if (table) {
        for (const k of Object.keys(p)) {
          if (table.includes(k)) continue;
          let set = scan.unseenKeys.get(item.e);
          if (!set) scan.unseenKeys.set(item.e, (set = new Set()));
          set.add(k);
        }
      }
      const nt = (p as Record<string, unknown>)["nt"];
      if (typeof nt === "object" && nt !== null && !Array.isArray(nt)) {
        const n = nt as Record<string, unknown>;
        if (n["t"] === 1 && (typeof n["v"] !== "string" || typeof n["ch"] !== "number" || crc32(n["v"]) !== n["ch"])) scan.badChecksums++;
      }
    }
  }
  return scan;
}

export function checkDrift(input: DriftInput): DriftReport {
  const findings: DriftFinding[] = [];
  const add = (severity: DriftSeverity, code: string, message: string): void => { findings.push({ severity, code, message }); };

  if (input.schema !== KNOWN_SCHEMA) add("critical", "schema", `server schema is ${input.schema}, verified schema is ${KNOWN_SCHEMA}`);
  if (input.commits.length !== input.head || input.state.cursor !== input.head) {
    add("critical", "head", `the server is at ${input.head}, the log has ${input.commits.length} commits and the state is at ${input.state.cursor}`);
  }

  let counts: Record<string, number> = {};
  try {
    const scan = scanLog(input.commits, input.knownKeys ?? KNOWN_PAYLOAD_KEYS);
    counts = scan.counts;
    if (scan.malformedPayloads > 0) add("critical", "malformed-payload", `${scan.malformedPayloads} item(s) whose payload is not an object`);
    if (scan.badActions > 0) add("critical", "action", `${scan.badActions} item(s) with an action other than create / modify / delete`);
    if (scan.badChecksums > 0) add("critical", "note-checksum", `${scan.badChecksums} full-text note(s) whose CRC32 is missing or no longer matches`);
    for (const [kind, keys] of scan.unseenKeys) add("warning", "new-keys", `${kind} carries keys we have not seen: ${[...keys].sort().join(", ")}`);
  } catch (e) {
    add("critical", "malformed-commit", `the log contains a malformed commit (${(e as Error).name})`);
  }

  let rebuilt: State | undefined;
  try {
    rebuilt = emptyState();
    fold(rebuilt, input.commits as Commit[]);
  } catch (e) {
    rebuilt = undefined;
    add("critical", "rebuild-failed", `rebuilding the state from index 0 failed (${(e as Error).name}): a new kind or malformed payload`);
  }
  if (rebuilt && canonical(rebuilt) !== canonical(input.state)) {
    add("critical", "state-diverged", "the incrementally built state differs from a rebuild from index 0 (the server may have rewritten history)");
  }

  const ok = !findings.some((f) => f.severity === "critical");
  const report: DriftReport = { ok, killSwitch: !ok, findings, counts };
  if (rebuilt) report.rebuilt = rebuilt;
  return report;
}
