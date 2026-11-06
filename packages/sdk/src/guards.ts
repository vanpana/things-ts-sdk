// Runtime guards. A write is only attempted when the world still looks the way it did when the contract was verified.
import type { State } from "./state.ts";

/** The history schema version the write contract was verified against. Any other value => read-only. */
export const KNOWN_SCHEMA = 301;

export const schemaAllowsWrites = (schema: number): boolean => schema === KNOWN_SCHEMA;

/** Ids that are recurrence templates or instances. Writes to them are refused: the app updates the template too. */
export function recurrenceBlockedIds(state: State): Set<string> {
  const blocked = new Set<string>();
  for (const [id, e] of state.tasks) {
    const rt = Array.isArray(e.fields["rt"]) ? (e.fields["rt"] as string[]) : [];
    if (e.fields["rr"] != null || e.fields["rp"] != null || rt.length > 0) {
      blocked.add(id);
      for (const link of rt) blocked.add(link);
    }
  }
  return blocked;
}

/** The SDK's rule: only a task with explicit rr, rp and rt is known to be ordinary. */
export const hasExplicitRecurrenceMarkers = (fields: Record<string, unknown>): boolean => Object.hasOwn(fields, "rr") && Object.hasOwn(fields, "rp") && Object.hasOwn(fields, "rt");
