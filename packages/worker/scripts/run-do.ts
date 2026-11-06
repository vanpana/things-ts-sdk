// Exercises the account Worker + Durable Object in the real Workers runtime (workerd, via `wrangler dev`) against a
// fake Things server holding a synthetic log of ~7,500 commits / 2,100 tasks. No real account, no real data.
//   node scripts/run-do.ts
import { execFileSync, spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { allTasks, emptyState, fold, view, VIEW_NAMES } from "../../sdk/src/index.ts";
import { startFake } from "./fake-things.ts";
import { syntheticLog } from "./synthetic-log.ts";

const PORT = 8798;
const TOKEN = "test-token-0123456789abcdef";
const base = `http://127.0.0.1:${PORT}`;

let failed = false;
const check = (name: string, ok: boolean, detail = ""): void => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok || !detail ? "" : `  (${detail})`}`); if (!ok) failed = true; };

// ---- process helpers --------------------------------------------------------------------------------------------------

/** CPU seconds used so far by a process and all its descendants (wrangler -> workerd), via ps. Null if unavailable. */
function cpuSeconds(root: number): number | null {
  try {
    const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,time="], { encoding: "utf8" }).trim().split("\n").map((l) => l.trim().split(/\s+/));
    const kids = new Map<number, number[]>();
    for (const [pid, ppid] of rows) kids.set(Number(ppid), [...(kids.get(Number(ppid)) ?? []), Number(pid)]);
    const family = new Set<number>([root]);
    for (const p of family) for (const k of kids.get(p) ?? []) family.add(k);
    let total = 0;
    for (const [pid, , time] of rows) {
      if (!family.has(Number(pid))) continue;
      const [dayPart, rest] = time!.includes("-") ? time!.split("-") : ["0", time!];
      const parts = rest!.split(":").map(Number);
      const secs = parts.reduce((acc, x) => acc * 60 + x, 0);
      total += Number(dayPart) * 86400 + secs;
    }
    return total;
  } catch { return null; }
}

async function start(persist: string, fakePort: number): Promise<ChildProcess> {
  const vars = {
    THINGS_EMAIL: "do@example.com", THINGS_PASSWORD: "mock-password", THINGS_ENDPOINT: `http://127.0.0.1:${fakePort}`, THINGS_ALLOW_INSECURE: "1",
    INTERNAL_TOKEN: TOKEN, CANARY: "on", SYNC_STALE_MS: "0", TEST_ROUTES: "1", THINGS_TIME_ZONE: "Europe/Bucharest",
  };
  const args = ["wrangler", "dev", "-c", "wrangler.account.jsonc", "--local", "--port", String(PORT), "--ip", "127.0.0.1", "--persist-to", persist];
  for (const [k, v] of Object.entries(vars)) args.push("--var", `${k}:${v}`);
  const child = spawn("npx", args, { stdio: ["ignore", "pipe", "pipe"], detached: true }); // own process group, so workerd dies with it
  let log = "";
  child.stdout!.on("data", (d) => (log += d));
  child.stderr!.on("data", (d) => (log += d));
  for (let i = 0; ; i++) {
    if (i > 120) { console.error("wrangler did not start:\n" + log.slice(-2000)); process.exit(1); }
    try { if ((await fetch(base + "/tools", { headers: { authorization: `Bearer ${TOKEN}` } })).status === 200) break; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return child;
}
async function stop(child: ChildProcess): Promise<void> {
  const exited = new Promise<void>((r) => child.once("exit", () => r()));
  killGroup(child, "SIGTERM");
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  // workerd may outlive its parent for a moment; wait for the port to free up, or the next start would talk to the old one.
  for (let i = 0; i < 40; i++) {
    try { await fetch(base + "/tools"); } catch { return; }
    if (i === 20) killGroup(child, "SIGKILL");
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("the previous Worker is still running");
}
function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  try { process.kill(-child.pid!, signal); } catch { child.kill(signal); }
}

// ---- request helpers --------------------------------------------------------------------------------------------------

interface Reply { status: number; body: any }
async function http(method: string, path: string, body?: unknown, token: string | null = TOKEN): Promise<Reply> {
  const r = await fetch(base + path, {
    method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, body: await r.json() };
}
const tool = (name: string, args: unknown = {}): Promise<Reply> => http("POST", "/tool", { name, args });
const status = async (): Promise<any> => (await tool("status")).body.result;

interface Timing { label: string; wallMs: number; cpuMs: number | null }
const timings: Timing[] = [];
async function timed<T>(label: string, pid: number, fn: () => Promise<T>): Promise<T> {
  const c0 = cpuSeconds(pid), t0 = Date.now();
  const out = await fn();
  const wallMs = Date.now() - t0, c1 = cpuSeconds(pid);
  timings.push({ label, wallMs, cpuMs: c0 !== null && c1 !== null ? Math.round((c1 - c0) * 1000) : null });
  return out;
}

// ---- the run ----------------------------------------------------------------------------------------------------------

const log = syntheticLog();
const fake = await startFake(log);
const persist = mkdtempSync(join(tmpdir(), "do-state-"));
let child = await start(persist, fake.port);
const cleanup = (): void => { killGroup(child, "SIGTERM"); void fake.close(); rmSync(persist, { recursive: true, force: true }); };
process.on("exit", cleanup);

const openOf = (commits: typeof log) => allTasks(fold(emptyState(), commits)).filter((t) => t.type === 0 && t.status === 0 && !t.inTrash);
const itemStarts = (): number[] => fake.requests.filter((r) => r.path.endsWith("/items")).map((r) => r.start!);

console.log(`synthetic log: ${log.length} commits, ${allTasks(fold(emptyState(), log)).length} tasks, ${openOf(log).length} open\n`);

// access control and the allow-list
{
  check("no token -> 401", (await http("GET", "/tools", undefined, null)).status === 401);
  check("wrong token -> 401", (await http("GET", "/tools", undefined, "wrong-token-0123456789")).status === 401);
  const names = ((await http("GET", "/tools")).body.result as { name: string }[]).map((t) => t.name).sort();
  check("tool allow-list", JSON.stringify(names) === JSON.stringify(["add_checklist_item", "create_task", "edit_task", "get_task", "list_open_tasks", "list_view", "status"]), names.join(","));
  check("unknown tool -> 404", (await tool("delete_everything")).status === 404);
  check("a misnamed body key is rejected, not ignored", (await http("POST", "/tool", { name: "list_open_tasks", input: { limit: 5 } })).status === 400);
  check("unknown argument -> 400", (await tool("list_open_tasks", { limit: 5, evil: 1 })).status === 400);
  check("oversized title -> 400", (await tool("create_task", { title: "x".repeat(5000) })).status === 400);
  check("bad id -> 400", (await tool("get_task", { id: "not-an-id" })).status === 400);
  check("nothing synced yet, nothing fetched", fake.requests.length === 0 && (await status()).cursor === 0);
}

// cold start
const pid = child.pid!;
const expectedOpen = openOf(log);
const cold = await timed("cold full sync (7,500 commits)", pid, () => tool("list_open_tasks", { limit: 200 }));
{
  check("cold sync: tasks listed", cold.status === 200 && cold.body.result.total === expectedOpen.length, `${cold.body.result?.total} vs ${expectedOpen.length}`);
  const st = await status();
  check("cold sync: cursor at head and persisted info", st.cursor === log.length && st.lastSync.mode === "cold" && st.schema === 301);
  console.log(`      cold sync wrote ${st.lastSync.upserts} entity rows (one per entity, once)`);
  check("cold sync: fetched pages 0, 2000, 4000, 6000", JSON.stringify(itemStarts()) === JSON.stringify([0, 2000, 4000, 6000]), JSON.stringify(itemStarts()));
  const filtered = await tool("list_open_tasks", { area: "Area 1", limit: 5 });
  check("filter by area", filtered.status === 200 && filtered.body.result.tasks.length > 0 && filtered.body.result.tasks.length <= 5);
  check("unknown area -> 400", (await tool("list_open_tasks", { area: "nope" })).status === 400);
  // list_view: every list matches the SDK's own computation on the same log (semantics are verified in the SDK against real data)
  const folded = fold(emptyState(), log);
  for (const name of VIEW_NAMES) {
    const want = view(folded, name, { timeZone: "Europe/Bucharest" }).map((t) => t.uuid);
    const got = await tool("list_view", { view: name, limit: 200 });
    const gotIds: string[] = got.body.result?.tasks.map((t: { id: string }) => t.id) ?? [];
    check(`list_view ${name}`, got.status === 200 && got.body.result.total === want.length && JSON.stringify(gotIds) === JSON.stringify(want.slice(0, 200)), `${got.body.result?.total} vs ${want.length}`);
  }
  check("list_view: inbox is not empty in the synthetic log", (await tool("list_view", { view: "inbox" })).body.result.total > 0);
  check("list_view: unknown view -> 400", (await tool("list_view", { view: "nope" })).status === 400);
  check("list_view: view is required -> 400", (await tool("list_view", {})).status === 400);
  check("list_view: bad limit -> 400", (await tool("list_view", { view: "inbox", limit: 0 })).status === 400);
  const one = await tool("get_task", { id: expectedOpen[0]!.uuid });
  check("get_task", one.status === 200 && one.body.result.task.title === expectedOpen[0]!.title);
}

// incremental sync
{
  fake.requests.length = 0;
  const target = expectedOpen[1]!.uuid;
  for (let i = 0; i < 5; i++) log.push({ [target]: { e: "Task7", t: 1, p: { md: 1.7e9 + i, tt: `renamed elsewhere ${i}` } } });
  const r = await timed("incremental sync (5 commits)", pid, () => tool("get_task", { id: target }));
  check("incremental: only the delta was fetched", JSON.stringify(itemStarts()) === JSON.stringify([7500]), JSON.stringify(itemStarts()));
  check("incremental: new title visible", r.body.result.task.title === "renamed elsewhere 4");
  const st = await status();
  check("incremental: reported as incremental", st.lastSync.mode === "incremental" && st.lastSync.commits === 5 && st.lastSync.upserts === 1, JSON.stringify(st.lastSync));
}

// writes, read-back, journal
let createdId = "";
{
  const created = await tool("create_task", { title: "Written by the test ✓", note: "note ünï", when: "today" });
  check("create_task", created.status === 200 && created.body.result.ids.length === 1, JSON.stringify(created.body));
  createdId = created.body.result.ids[0];
  // What the Workers runtime puts on the wire for a commit (the real service is picky about these).
  const h = fake.commitHeaders.at(-1) ?? {};
  check("commit headers: Content-Encoding UTF-8, JSON content type, schema 301, app id",
    String(h["content-encoding"]).toLowerCase() === "utf-8" && h["content-type"] === "application/json; charset=UTF-8" && h["schema"] === "301" && h["app-id"] === "com.culturedcode.ThingsMac" && h["push-priority"] === "5",
    JSON.stringify(h));
  const got = await tool("get_task", { id: createdId });
  check("created task reads back", got.body.result.task.title === "Written by the test ✓" && got.body.result.task.note === "note ünï");
  const edited = await tool("edit_task", { id: createdId, title: "Edited", complete: true });
  check("edit_task", edited.status === 200);
  check("edited task reads back", (await tool("get_task", { id: createdId })).body.result.task.status === 3);
  const item = await tool("add_checklist_item", { task_id: expectedOpen[2]!.uuid, title: "step one" });
  check("add_checklist_item", item.status === 200, JSON.stringify(item.body));
  check("edit_task refuses a project", (await tool("edit_task", { id: log.flatMap((c) => Object.entries(c)).find(([, i]) => i.e === "Task7" && i.t === 0 && (i.p as any).tp === 1)![0], title: "x" })).status === 422);
  const journal = (await http("GET", "/admin/journal?limit=20")).body.result as { tool: string; outcome: string; error: string | null }[];
  check("journal has the writes", journal.filter((j) => j.outcome === "ok").length === 3 && journal.some((j) => j.tool === "edit_task" && j.outcome === "refused"));
  check("journal holds no content", !JSON.stringify(journal).includes("Edited") && !JSON.stringify(journal).includes("step one"));
}

// a write that loses a race: 409, nothing written, not read-only, and the next write works
{
  const before = log.length;
  fake.raceNextCommit = true;
  const r = await tool("edit_task", { id: createdId, title: "lost the race" });
  check("stale ancestor -> 409", r.status === 409, JSON.stringify(r.body));
  check("409 wrote nothing but the other device's commit", log.length === before + 1);
  const st = await status();
  check("409 does not switch writes off", st.readOnly === null);
  check("409 journaled", ((await http("GET", "/admin/journal?limit=3")).body.result as any[]).some((j) => j.outcome === "conflict"));
  check("the next write succeeds", (await tool("edit_task", { id: createdId, title: "after the race" })).status === 200);
}

// unknown commit outcome -> kill switch; reads keep working; clearing is explicit
{
  fake.dropNextCommitResponse = true;
  const r = await tool("edit_task", { id: createdId, title: "dropped" });
  check("dropped connection -> 502", r.status === 502, JSON.stringify(r.body));
  const st = await status();
  check("kill switch is set", st.readOnly?.reason.includes("outcome unknown"), JSON.stringify(st.readOnly));
  const refused = await tool("create_task", { title: "should be refused" });
  check("writes refused while off (423)", refused.status === 423 && refused.body.error.message.includes("switched off"));
  check("reads still work while off", (await tool("list_open_tasks", { limit: 3 })).status === 200 && (await tool("get_task", { id: createdId })).status === 200);
  check("the commit that did land is visible", (await tool("get_task", { id: createdId })).body.result.task.title === "dropped");
  const cleared = await http("POST", "/admin/clear-read-only", { by: "test" });
  check("explicit clear", cleared.body.wasReadOnly === true && (await status()).readOnly === null);
  check("writes work again", (await tool("edit_task", { id: createdId, title: "back" })).status === 200);
  const j = (await http("GET", "/admin/journal?limit=30")).body.result as any[];
  check("kill switch and clear are journaled", j.some((x) => x.outcome === "set-read-only") && j.some((x) => x.outcome === "cleared-read-only"));
}

// the alarm: drift check on a new schema switches writes off, then re-arms
{
  fake.schema = 302;
  const r = await http("POST", "/__test/alarm");
  const st = r.body.result;
  check("alarm ran the drift check", st.lastDrift && st.lastDrift.ok === false && st.lastDrift.findings.some((f: any) => f.code === "schema"), JSON.stringify(st.lastDrift));
  check("critical drift switches writes off", st.readOnly?.reason.startsWith("drift:"), JSON.stringify(st.readOnly));
  check("the alarm re-armed itself", typeof st.nextAlarmAt === "number" && st.nextAlarmAt > Date.now(), String(st.nextAlarmAt));
  check("canary skipped while writes are off", st.lastCanary?.summary.startsWith("skipped"), JSON.stringify(st.lastCanary));
}

// restart: new isolate, same SQLite. The kill switch survives; only the delta is fetched.
await stop(child);
const cursorAtStop = log.length;
for (let i = 0; i < 3; i++) log.push({ [expectedOpen[3]!.uuid]: { e: "Task7", t: 1, p: { md: 1.8e9 + i, tt: `offline edit ${i}` } } });
fake.requests.length = 0;
fake.schema = 301;
child = await start(persist, fake.port);
const pid2 = child.pid!;
{
  const st0 = await status();
  check("restart: state loaded from SQLite", st0.loadedFromStorage === true && st0.cursor === cursorAtStop && st0.counts.tasks > 2000, JSON.stringify({ counts: st0.counts, loadedFromStorage: st0.loadedFromStorage, cursor: st0.cursor, cursorAtStop }));
  check("restart: kill switch persisted", st0.readOnly?.reason.startsWith("drift:") === true);
  check("restart: loading touched no upstream", fake.requests.length === 0);
  const r = await timed("warm start: load from SQLite + 3-commit delta", pid2, () => tool("get_task", { id: expectedOpen[3]!.uuid }));
  check("restart: reads work while off", r.status === 200 && r.body.result.task.title === "offline edit 2");
  check("restart: only the delta was fetched", JSON.stringify(itemStarts()) === JSON.stringify([cursorAtStop]), JSON.stringify(itemStarts()));
  const st = await status();
  check("restart: incremental sync of 3", st.lastSync.mode === "incremental" && st.lastSync.commits === 3);
  const j = (await http("GET", "/admin/journal?limit=5")).body.result as any[];
  check("restart: journal persisted", j.length > 0);
  await http("POST", "/admin/clear-read-only", { by: "test" });
}

// checks run on demand: a clean drift check, then the canary through the real write path
{
  const drift = await http("POST", "/admin/run-check?which=drift");
  check("drift check on a healthy log", drift.body.result.ok === true, JSON.stringify(drift.body.result));
  const before = log.length;
  const canary = await timed("canary (create, edit, complete, trash, 409, read-back)", pid2, () => http("POST", "/admin/run-check?which=canary"));
  check("canary passes", canary.body.result.ok === true, JSON.stringify(canary.body.result));
  check("canary wrote through the commit path", log.length >= before + 4);
  const st = await status();
  check("canary result recorded, writes stay on", st.lastCanary.ok === true && st.readOnly === null);
  check("state follows the canary", st.cursor === log.length);
}

// a different shape of failure: a kind we do not know. Reads keep serving the last good state; writes go off.
{
  log.push({ ["Zz" + "1".repeat(20)]: { e: "Widget9", t: 0, p: { tt: "from the future" } } });
  const r = await tool("list_open_tasks", { limit: 1 });
  check("unknown kind: reads still served (stale)", r.status === 200 && r.body.result.stale === true);
  const st = await status();
  check("unknown kind: writes switched off", st.readOnly?.reason.includes("UnknownKindError") === true && st.lastSyncError === "UnknownKindError", JSON.stringify(st.readOnly));
}

cleanup();
console.log("\ntimings (wall = as seen by the client, includes the fake server; cpu = workerd process tree via ps, 10 ms resolution):");
for (const t of timings) console.log(`  ${t.label.padEnd(62)} wall ${String(t.wallMs).padStart(5)} ms   cpu ${t.cpuMs === null ? "n/a" : String(t.cpuMs).padStart(5) + " ms"}`);
console.log(failed ? "\nDO TESTS FAILED" : "\nDO TESTS OK");
process.exit(failed ? 1 : 0);
