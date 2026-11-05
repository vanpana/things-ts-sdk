// Generates conformance inputs for base58, notes and repeat. Run: node scripts/gen-cases-basic.ts
import { writeFileSync } from "node:fs";
import { mulberry32, pick, randHex } from "./prng.ts";

export const generated: Record<string, unknown[]> = {};
const out = (name: string, v: unknown[]) => { generated[name] = v; };
const r = mulberry32(20260105);

// ---- base58 ----
const b58: { op: string; input: string }[] = [];
const hexes = ["00".repeat(16), "ff".repeat(16), "00" + "ab".repeat(15), "0000" + "cd".repeat(14), "000000" + "12".repeat(13), "00000000" + "7f".repeat(12), "01" + "00".repeat(15)];
for (let i = 0; i < 400; i++) {
  const bytes = randHex(r, 16);
  hexes.push(i % 5 === 0 ? "00" + bytes.slice(2) : i % 17 === 0 ? "0000" + bytes.slice(4) : bytes);
}
for (const h of hexes) b58.push({ op: "encode", input: h });
const ALPHA = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const sample: string[] = ["Q9sihFX2SsvGaz6vv4J2Hf", "VJ1edXTP9q3PmFDUuy8EQh", "FQxaqvLBkbR5q2Q5oRoknc", "BVU8qZ9dNjrdxLvDHPvfDS", "1111111111111111", "11111111111111111", "1", "", "0", "O0Il", "abc", "é", "1é", "z".repeat(22), "z".repeat(23), "2".repeat(21), "1" + "2".repeat(22), "11" + "2".repeat(21), " " + "A".repeat(21), "A".repeat(21) + "\n"];
for (let i = 0; i < 200; i++) sample.push(Array.from({ length: 18 + Math.floor(r() * 7) }, () => pick(r, ALPHA.split(""))).join(""));
for (let i = 0; i < 60; i++) sample.push(Array.from({ length: 20 + Math.floor(r() * 4) }, () => pick(r, (ALPHA + "0OIl-_ ").split(""))).join(""));
for (const s of sample) { b58.push({ op: "decode", input: s }); b58.push({ op: "validate", input: s }); }
const uuids = ["3F2504E0-4F89-11D3-9A0C-0305E82C3301", "3f2504e0-4f89-11d3-9a0c-0305e82c3301", "00000000-0000-0000-0000-000000000000", "6BA7B810-9DAD-11D1-80B4-00C04FD430C8"];
const legacy: string[] = [...uuids, "", "x", "task-1", "ÄÖÜ", "😀", "A".repeat(100), "Q9sihFX2SsvGaz6vv4J2Hf"];
for (const u of uuids) for (const d of ["20260101", "19991231", "00000000", "2026010", "202601011", "2026010a", "２０２６０１０１"]) legacy.push(`${u}-${d}`);
legacy.push(uuids[0] + "-20260101-", uuids[0]!.slice(1) + "-20260101", "3F2504E0-4F89-11D3-9A0C-0305E82C330Z-20260101", uuids[0]! + "_20260101");
for (let i = 0; i < 120; i++) {
  const h = randHex(r, 16);
  const u = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  const cased = i % 2 ? u.toUpperCase() : u;
  legacy.push(cased);
  legacy.push(`${cased}-2026${String(1 + (i % 12)).padStart(2, "0")}${String(1 + (i % 28)).padStart(2, "0")}`);
}
for (const l of legacy) b58.push({ op: "legacy", input: l });
out("base58", b58);

// ---- notes ----
type P = { r: string; p: number; l: number };
const notes: { original: string; patches: P[] }[] = [];
const originals = ["", "hello world", "Native Task7 note α 🚀\nSecond line.", "日本語のノート", "a\nb\nc", "x".repeat(50)];
const patchSets: P[][] = [
  [], [{ r: "X", p: 0, l: 0 }], [{ r: "X", p: 3, l: 2 }], [{ r: "Update", p: 26, l: 5 }], [{ r: "", p: 0, l: 5 }],
  [{ r: "Z", p: 999, l: 0 }], [{ r: "Z", p: -5, l: 2 }], [{ r: "Z", p: 2, l: -3 }], [{ r: "Z", p: 2, l: 9999 }],
  [{ r: "A", p: 1, l: 1 }, { r: "B", p: 1, l: 0 }, { r: "C", p: 0, l: 1 }],
  [{ r: "é", p: 4, l: 1 }, { r: "😀", p: 0, l: 0 }],
  [{ r: "x", p: 22, l: 0 }], [{ r: "x", p: 23, l: 0 }], [{ r: "x", p: 24, l: 0 }], [{ r: "x", p: 25, l: 0 }], // inside multi-byte sequences
];
for (const o of originals) for (const ps of patchSets) notes.push({ original: o, patches: ps });
for (let i = 0; i < 150; i++) {
  const o = pick(r, originals);
  const n = 1 + Math.floor(r() * 4);
  notes.push({ original: o, patches: Array.from({ length: n }, () => ({ r: pick(r, ["", "a", "bc", "é", "😀", "日本"]), p: Math.floor(r() * 40) - 3, l: Math.floor(r() * 12) - 2 })) });
}
out("notes", notes);

// ---- repeat ----
const day = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 1000;
type Cfg = Record<string, unknown>;
const cases: { config: Cfg; first: number | null; repeats: number[] }[] = [];
const FOREVER = day(4001, 1, 1);
const ends = (): Partial<Cfg> => pick(r, [{ rc: 6 }, { rc: 0, ed: FOREVER }, { ed: day(2027, 12, 31), rc: 0 }, { ed: FOREVER }, { rc: 3, ed: day(2026, 6, 1) }]);
const starts = [day(2026, 1, 1), day(2026, 1, 31), day(2026, 2, 28), day(2026, 3, 15), day(2026, 5, 31), day(2026, 11, 30), day(2026, 12, 31), day(2028, 2, 29)];
const detailSets: Record<string, Cfg[][]> = {
  16: [[{}]],
  256: [[{ wd: 1 }], [{ wd: 1 }, { wd: 3 }], [{ wd: 0 }, { wd: 6 }], [{ wd: 2 }, { wd: 4 }, { wd: 5 }], [{ wd: 6 }]],
  8: [[{ dy: 15 }], [{ dy: -1 }], [{ dy: 31 }], [{ dy: 1 }], [{ wd: 2, wdo: 1 }], [{ wd: 5, wdo: -1 }], [{ dy: 1 }, { dy: 15 }], [{ wd: 1, wdo: 2 }, { wd: 4, wdo: -1 }], [{ dy: 1 }, { dy: -1 }], [{ dy: 10 }, { dy: -1 }, { dy: 20 }]],
  4: [[{ dy: 25, mo: 11 }], [{ dy: -1, mo: 1 }], [{ wd: 4, wdo: 4, mo: 10 }], [{ wd: 1, wdo: -1, mo: 5 }], [{ dy: 29, mo: 1 }], [{ dy: 1, mo: 0 }, { dy: 1, mo: 6 }], [{ dy: 10, mo: 2 }, { dy: -1, mo: 2 }], [{ wd: 1, wdo: 2, mo: 3 }, { dy: -1, mo: 8 }], [{ dy: -1, mo: 0 }, { dy: -1, mo: 6 }]],
};
for (const fu of [16, 256, 8, 4]) {
  for (const detail of detailSets[fu]!) {
    for (let i = 0; i < 5; i++) {
      const ia = pick(r, starts);
      const config: Cfg = { ia, fu, fa: pick(r, [1, 1, 2, 3]), of: detail, rrv: 4, tp: 0, ts: 0, ...ends() };
      cases.push({ config, first: pick(r, starts), repeats: [0, 1, 2, 3, 4, 5, 6, 7, 12] });
    }
  }
}
cases.push({ config: { ia: day(2026, 1, 1), fu: 99, fa: 1, of: [{}] }, first: day(2026, 1, 1), repeats: [0, 1] });
out("repeat", cases);
if (import.meta.main) {
  for (const [name, v] of Object.entries(generated)) writeFileSync(new URL(`../cases/${name}.json`, import.meta.url), JSON.stringify(v, null, 1) + "\n");
  console.log("base58", b58.length, "notes", notes.length, "repeat", cases.length);
}
