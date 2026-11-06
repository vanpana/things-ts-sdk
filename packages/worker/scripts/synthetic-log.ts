// A deterministic, made-up Things log the size of a real one (about 7,500 commits, 2,100 tasks): areas, tags, tasks and
// projects, checklist items, and a long tail of edits. Generated from a seeded PRNG; contains no real data.
import { buildCreate, encodeUuid, textNote } from "../../sdk/src/index.ts";
import type { Commit } from "../../sdk/src/index.ts";

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const WORDS = ["plan", "write", "review", "call", "fix", "buy", "send", "read", "clean", "book", "draft", "check", "update", "ship", "tidy", "pay"];
const EXT = { sn: {}, _t: "oo" };

export function syntheticLog(seed = 7, totalCommits = 7500, taskCount = 2100): Commit[] {
  const rnd = prng(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  const id = (): string => encodeUuid(Uint8Array.from({ length: 16 }, () => Math.floor(rnd() * 256) | 1)); // |1: never a leading zero byte
  const title = (): string => `${pick(WORDS)} ${pick(WORDS)} ${Math.floor(rnd() * 1000)}`;
  const base = Date.UTC(2024, 0, 1);
  const log: Commit[] = [];

  const areas = Array.from({ length: 3 }, id), tags = Array.from({ length: 18 }, id);
  areas.forEach((a, i) => log.push({ [a]: { e: "Area3", t: 0, p: { tt: `Area ${i}`, ix: i, tg: [], xx: EXT } } }));
  tags.forEach((g, i) => log.push({ [g]: { e: "Tag4", t: 0, p: { tt: `tag-${i}`, ix: -1237 + i, sh: null, pn: [], xx: EXT } } }));

  const tasks: string[] = [], projects: string[] = [];
  for (let i = 0; i < taskCount; i++) {
    const tid = id();
    const isProject = rnd() < 0.05;
    const p = buildCreate({ title: title(), when: pick(["inbox", "anytime", "anytime", "anytime", "someday"] as const) }, { now: new Date(base + i * 60_000) }).payload;
    p["ix"] = i;
    if (isProject) p["tp"] = 1;
    else {
      if (rnd() < 0.4) p["ar"] = [pick(areas)];
      else if (projects.length > 0 && rnd() < 0.3) p["pr"] = [pick(projects)];
      if (rnd() < 0.3) p["tg"] = [pick(tags)];
    }
    log.push({ [tid]: { e: "Task7", t: 0, p } });
    if (isProject) projects.push(tid); else tasks.push(tid);
    if (rnd() < 0.25) {
      log.push({ [id()]: { e: "ChecklistItem3", t: 0, p: { cd: base / 1000 + i, md: null, tt: title(), ss: 0, sp: null, ix: 0, ts: [tid], lt: false, xx: EXT } } });
    }
  }

  const all = [...tasks, ...projects];
  const edit = (tid: string, ts: number): Commit => {
    const md = ts / 1000;
    const kind = rnd();
    const p: Record<string, unknown> =
      kind < 0.3 ? { md, tt: title() }
      : kind < 0.55 ? { md, ss: 3, sp: md }
      : kind < 0.65 ? { md, ss: 0, sp: null }
      : kind < 0.75 ? { md, tr: true }
      : kind < 0.8 ? { md, tr: false }
      : kind < 0.9 ? { md, nt: textNote(`${title()} ${title()}`) }
      : { md, ar: [pick(areas)], pr: [], agr: [] };
    return { [tid]: { e: "Task7", t: 1, p } };
  };
  for (let n = 0; log.length < totalCommits; n++) {
    const ts = base + 3_600_000 * 24 * 30 + n * 30_000;
    const c = edit(pick(all), ts);
    if (rnd() < 0.1) Object.assign(c, edit(pick(all.filter((t) => !(t in c))), ts + 1));
    log.push(c);
  }
  return log.slice(0, totalCommits);
}
