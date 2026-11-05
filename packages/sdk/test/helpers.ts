import { readFileSync } from "node:fs";

const root = new URL("../../../conformance/", import.meta.url);
export const loadJson = <T = any>(rel: string): T => JSON.parse(readFileSync(new URL(rel, root), "utf8")) as T;
import { generated } from "../../../conformance/scripts/gen-cases-basic.ts";
import { cases as stateCases } from "../../../conformance/scripts/gen-cases-state.ts";
import { cases as clientCases } from "../../../conformance/scripts/gen-cases-client.ts";

// Inputs are regenerated in memory (deterministically); only the Go SDK's answers are stored.
const inputs: Record<string, unknown[]> = { ...generated, state: stateCases, client: clientCases };
export const fixture = <T = any>(name: string): { cases: T[]; expected: any[] } => {
  const expected = loadJson<any[]>(`fixtures/${name}.json`);
  const cases = inputs[name] as T[];
  if (cases.length !== expected.length) throw new Error(`fixture ${name} is stale: ${cases.length} cases, ${expected.length} expected. Run conformance/regenerate.sh`);
  return { cases, expected };
};

/** Deep equality that treats numbers within `eps` as equal (timestamps survive float round-trips differently). */
export function diff(a: unknown, b: unknown, path = "", eps = 0.002): string | null {
  if (typeof a === "number" && typeof b === "number") return Math.abs(a - b) <= eps ? null : `${path}: ${a} != ${b}`;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return Object.is(a, b) ? null : `${path}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: array vs object`;
  const ka = Object.keys(a as object).sort();
  const kb = Object.keys(b as object).sort();
  if (ka.join("\0") !== kb.join("\0")) return `${path}: keys ${JSON.stringify(ka)} != ${JSON.stringify(kb)}`;
  for (const k of ka) {
    const d = diff((a as any)[k], (b as any)[k], `${path}/${k}`, eps);
    if (d) return d;
  }
  return null;
}
