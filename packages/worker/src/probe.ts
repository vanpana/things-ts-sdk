// Probe Worker: proves the SDK works inside the Workers runtime (workerd), including the commit POST.
// It is a test fixture, not the product Worker. Secrets come from .dev.vars (gitignored) or `wrangler secret`.
//   GET  /read         sync and print counts (read-only)
//   POST /write-task   create -> edit -> complete -> trash a clearly labelled throwaway task, verifying each step
//   POST /write-other  tag, area and checklist item on the verified (safe) path, pausing between create and delete
// Every route needs the `x-probe-token` header to equal PROBE_TOKEN: this Worker writes to a real account, so it must
// not be reachable by anyone else (`workers_dev` is off; do not deploy it publicly). Output never contains titles,
// notes or credentials.
import {
  buildAddChecklistItem, buildCreate, buildCreateArea, buildCreateTag, buildDelete, buildEdit, emptyState, preflightFromState, syncState, ThingsClient,
} from "../../sdk/src/index.ts";
import type { History, State } from "../../sdk/src/index.ts";
import { runCanary } from "./canary.ts";
import type { Step } from "./canary.ts";

interface Env { THINGS_EMAIL: string; THINGS_PASSWORD: string; PROBE_TOKEN: string; THINGS_ENDPOINT?: string; PROBE_TIMEZONE?: string }

const json = (v: unknown, status = 200): Response => new Response(JSON.stringify(v, null, 2), { status, headers: { "content-type": "application/json" } });

const MAX_HOLD_SECONDS = 60;
const ctx = { timeZone: "UTC" };

function makeClient(env: Env): ThingsClient {
  return new ThingsClient(env.THINGS_EMAIL, env.THINGS_PASSWORD, env.THINGS_ENDPOINT ? { endpoint: env.THINGS_ENDPOINT, allowInsecure: true } : {});
}

async function connect(env: Env): Promise<{ history: History; state: State }> {
  const history = await makeClient(env).ownHistory();
  const state = emptyState();
  await syncState(history, state, { retryBaseMs: 200 });
  return { history, state };
}

const viaState = (state: State) => (targets: ReadonlySet<string>): number => preflightFromState(state, targets);

async function writeTask(env: Env): Promise<Step[]> {
  const { history, state } = await connect(env);
  const r = await runCanary({ history, state, reconnect: () => connect(env), timeZone: env.PROBE_TIMEZONE ?? "UTC" });
  if (r.taskId) r.steps.push({ step: "probe task id", ok: true, detail: r.taskId });
  return r.steps;
}

type Cleanup = { name: string; run: () => Promise<boolean> };

async function writeOther(env: Env, holdSeconds: number): Promise<Step[]> {
  const steps: Step[] = [];
  const rec = (step: string, ok: boolean, detail?: string): void => { steps.push(detail === undefined ? { step, ok } : { step, ok, detail }); };
  const { history, state } = await connect(env);
  const sync = (): Promise<unknown> => syncState(history, state, { retryBaseMs: 200 });
  const cleanups: Cleanup[] = [];
  const remove = (name: string, kind: "tag" | "area" | "checklistItem", id: string, map: "tags" | "areas" | "checklist"): Cleanup => ({
    name,
    run: async () => { await sync(); await history.write([buildDelete(state, kind, id)]); await sync(); return !state[map].has(id); },
  });
  const trash = (name: string, id: string): Cleanup => ({
    name,
    run: async () => { await sync(); await history.write([buildEdit(state, id, { trash: true }, ctx)], { preflight: viaState(state) }); await sync(); return state.tasks.get(id)?.fields["tr"] === true; },
  });
  const runCleanups = async (): Promise<void> => {
    while (cleanups.length > 0) {
      const c = cleanups.pop()!;
      try { rec(`remove ${c.name}`, await c.run()); } catch (e) { rec(`remove ${c.name}`, false, (e as Error).name); }
    }
  };
  try {
    // The verified path: no `unsafe` options.
    const host = buildCreate({ title: "zz-sdk-probe checklist host" }, ctx);
    await history.write([host]);
    cleanups.push(trash("checklist host task", host.uuid));
    const tag = buildCreateTag(state, { title: "zz-sdk-probe-tag" });
    await history.write([tag]);
    cleanups.push(remove("tag", "tag", tag.uuid, "tags"));
    const area = buildCreateArea({ title: "zz-sdk-probe-area" });
    await history.write([area]);
    cleanups.push(remove("area", "area", area.uuid, "areas"));
    await sync();
    const item = buildAddChecklistItem(state, { taskId: host.uuid, title: "zz-probe checklist item" });
    await history.write([item]);
    cleanups.push(remove("checklist item", "checklistItem", item.uuid, "checklist"));
    await sync();
    rec("create tag (safe path)", state.tags.has(tag.uuid));
    rec("create area (safe path)", state.areas.has(area.uuid));
    rec("create checklist item (safe path)", state.checklist.has(item.uuid));
    if (holdSeconds > 0) await new Promise((r) => setTimeout(r, holdSeconds * 1000));
    rec(`held ${holdSeconds}s for inspection`, true);
    await runCleanups();

    // unsafe.ignoreSchema: a history that never learned its schema is refused by default and writable on request.
    await sync();
    const blind = makeClient(env).historyWithId(history.id);
    blind.latestServerIndex = state.cursor;
    const t2 = buildCreate({ title: "zz-sdk-probe ignoreSchema" }, ctx);
    let refused = false;
    try { await blind.write([t2]); } catch (e) { refused = (e as Error).name === "WriteRefusedError"; }
    rec("schema unknown: refused by default", refused);
    await blind.write([t2], { unsafe: { ignoreSchema: true } });
    cleanups.push(trash("ignoreSchema task", t2.uuid));
    await sync();
    rec("schema unknown: written with unsafe.ignoreSchema", state.tasks.has(t2.uuid));
    await runCleanups();
  } catch (e) {
    rec("aborted", false, `${(e as Error).name}: ${(e as Error).message.slice(0, 160)}`);
  } finally {
    await runCleanups(); // anything still pending after a failure is removed again
  }
  return steps;
}

const enc = new TextEncoder();
function authorized(req: Request, env: Env): boolean {
  const given = req.headers.get("x-probe-token") ?? "";
  if (!env.PROBE_TOKEN || env.PROBE_TOKEN.length < 16 || given.length !== env.PROBE_TOKEN.length) return false;
  const a = enc.encode(given), b = enc.encode(env.PROBE_TOKEN);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!authorized(req, env)) return json({ error: "unauthorized" }, 401);
    const url = new URL(req.url);
    const t0 = Date.now();
    try {
      if (url.pathname === "/read" && req.method === "GET") {
        const { history, state } = await connect(env);
        return json({ head: state.cursor, schema: history.latestSchemaVersion, tasks: state.tasks.size, areas: state.areas.size, tags: state.tags.size, checklist: state.checklist.size, ms: Date.now() - t0 });
      }
      if (url.pathname === "/write-task" && req.method === "POST") {
        const steps = await writeTask(env);
        return json({ ok: steps.every((s) => s.ok), steps, ms: Date.now() - t0 });
      }
      if (url.pathname === "/write-other" && req.method === "POST") {
        const hold = Math.min(Math.max(Number(url.searchParams.get("hold") ?? 0) || 0, 0), MAX_HOLD_SECONDS);
        const steps = await writeOther(env, hold);
        return json({ ok: steps.every((s) => s.ok), steps, ms: Date.now() - t0 });
      }
      return json({ routes: ["GET /read", "POST /write-task", "POST /write-other"] }, 404);
    } catch (e) {
      const err = e as Error & { status?: number };
      return json({ ok: false, error: err.name, message: err.message.slice(0, 200), status: err.status }, 500);
    }
  },
};
