// Runs the probe Worker in the real Workers runtime (workerd via `wrangler dev`) and exercises it.
//   node scripts/run-probe.ts mock                      against a local fake Things server; checks the exact bytes workerd sends
//   THINGS_EMAIL=... THINGS_PASSWORD=... node scripts/run-probe.ts live [task] [other]
//                                                        against your real account (read first; writes only with the flags)
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [mode, ...flags] = process.argv.slice(2);
if (mode !== "mock" && mode !== "live") { console.error("usage: run-probe.ts mock | live [task] [other]"); process.exit(2); }

// ---- fake Things server (mock mode) ---------------------------------------------------------------------------
const log: unknown[] = [];
let conflicts = 0;
const commits: { headers: Record<string, string | string[] | undefined>; body: string; ancestor: number }[] = [];
const fake = createServer((req, res) => {
  const url = new URL(req.url!, "http://x");
  const send = (code: number, v: unknown): void => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
  if (req.method === "GET" && url.pathname.startsWith("/version/1/account/")) return send(200, { "history-key": "HK", status: "SYAccountStatusActive" });
  if (req.method === "GET" && url.pathname === "/version/1/history/HK") return send(200, { "latest-schema-version": 301, "latest-total-content-size": 0, "latest-server-index": log.length });
  if (req.method === "GET" && url.pathname === "/version/1/history/HK/items") {
    const start = Number(url.searchParams.get("start-index"));
    if (start > log.length) return send(500, {});
    return send(200, { items: log.slice(start), schema: 301, "current-item-index": log.length, "latest-total-content-size": 0, "end-total-content-size": 0 });
  }
  if (req.method === "POST" && url.pathname === "/version/1/history/HK/commit") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const ancestor = Number(url.searchParams.get("ancestor-index"));
      commits.push({ headers: req.headers, body, ancestor });
      if (ancestor !== log.length) { conflicts++; return send(409, {}); }
      log.push(JSON.parse(body));
      send(200, { "server-head-index": log.length });
    });
    return;
  }
  send(404, {});
});

const port = 8799;
const token = randomUUID();
let tmp: string | undefined;
const args = ["wrangler", "dev", "--local", "--port", String(port), "--ip", "127.0.0.1"];
if (mode === "mock") {
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", r));
  const fakePort = (fake.address() as { port: number }).port;
  args.push("--var", "THINGS_EMAIL:mock@example.com", "--var", "THINGS_PASSWORD:mock-password", "--var", `THINGS_ENDPOINT:http://127.0.0.1:${fakePort}`, "--var", `PROBE_TOKEN:${token}`);
} else {
  const email = process.env["THINGS_EMAIL"], password = process.env["THINGS_PASSWORD"];
  if (!email || !password) { console.error("set THINGS_EMAIL and THINGS_PASSWORD"); process.exit(2); }
  tmp = mkdtempSync(join(tmpdir(), "probe-"));
  writeFileSync(join(tmp, "env"), `THINGS_EMAIL=${email}\nTHINGS_PASSWORD=${password}\nPROBE_TOKEN=${token}\n`, { mode: 0o600 });
  args.push("--env-file", join(tmp, "env"));
}

const wr = spawn("npx", args, { stdio: ["ignore", "pipe", "pipe"] });
let wlog = "";
wr.stdout.on("data", (d) => (wlog += d));
wr.stderr.on("data", (d) => (wlog += d));
const cleanup = (): void => { wr.kill("SIGTERM"); fake.close(); if (tmp) rmSync(tmp, { recursive: true, force: true }); };
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(130)); // the exit handler removes the credentials file

const base = `http://127.0.0.1:${port}`;
for (let i = 0; ; i++) {
  if (i > 120) { console.error("wrangler did not start:\n" + wlog.slice(-2000)); process.exit(1); }
  try { await fetch(base + "/nope", { headers: { "x-probe-token": token } }); break; } catch { await new Promise((r) => setTimeout(r, 500)); }
}

let failed = false;
const call = async (path: string, method = "GET"): Promise<{ ok?: boolean; [k: string]: unknown }> => {
  const r = await fetch(base + path, { method, headers: { "x-probe-token": token } });
  const v = (await r.json()) as { ok?: boolean };
  console.log(`\n${path} -> HTTP ${r.status}\n${JSON.stringify(v, null, 2)}`);
  return v;
};

const read = await call("/read");
if (read["error"]) failed = true;
if (mode === "mock" || flags.includes("task")) { const v = await call("/write-task", "POST"); if (!v.ok) failed = true; }
if (mode === "mock" || flags.includes("other")) {
  const hold = mode === "live" ? 20 : 0;
  if (hold) console.log(`\nWriting a tag, an area and a checklist item now, then pausing ${hold}s before removing them: look in Things.`);
  const v = await call(`/write-other?hold=${hold}`, "POST");
  if (!v.ok) failed = true;
}

if (mode === "mock") {
  console.log(`\nfake server saw ${commits.length} commit POSTs`);
  const check = (name: string, ok: boolean): void => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}`); if (!ok) failed = true; };
  const first = commits[0];
  check("at least one commit POST reached the server from workerd", !!first);
  if (first) {
    const h = first.headers;
    check("Content-Encoding: UTF-8 arrived intact", String(h["content-encoding"]).toLowerCase() === "utf-8");
    check("Content-Type is application/json; charset=UTF-8", h["content-type"] === "application/json; charset=UTF-8");
    check("Schema: 301 header", h["schema"] === "301");
    check("App-Id and Push-Priority headers", h["app-id"] === "com.culturedcode.ThingsMac" && h["push-priority"] === "5");
    check("body is the JSON commit, byte-for-byte parseable", typeof JSON.parse(first.body) === "object");
    const body = JSON.parse(first.body) as Record<string, { e: string; t: number; p: Record<string, unknown> }>;
    const item = Object.values(body)[0]!;
    check("Task7 create payload has the 34 verified keys", item.e === "Task7" && item.t === 0 && Object.keys(item.p).length === 34);
  }
  check("a stale ancestor got HTTP 409", conflicts > 0);
  const anon = await fetch(base + "/read");
  check("a request without the token is refused", anon.status === 401);
}

cleanup();
console.log(failed ? "\nPROBE FAILED" : "\nPROBE OK");
process.exit(failed ? 1 : 0);
