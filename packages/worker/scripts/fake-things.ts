// A stand-in for the Things Cloud service: one history ("HK"), paged items, commits with the stale-ancestor rule.
// Knobs let a test play the awkward cases: another device writing at the wrong moment, a dropped connection, a new schema.
import { createServer } from "node:http";
import type { Server } from "node:http";
import { newId } from "../../sdk/src/index.ts";
import type { Commit } from "../../sdk/src/index.ts";

export interface Fake {
  port: number;
  log: Commit[];
  /** Every request received, newest last. `start` is the start-index of an items request. */
  requests: { method: string; path: string; start?: number }[];
  /** Headers of every commit POST, to check what the Workers runtime actually puts on the wire. */
  commitHeaders: Record<string, string | string[] | undefined>[];
  schema: number;
  /** The next commit POST is preceded by another device's commit, so its ancestor is stale (HTTP 409). */
  raceNextCommit: boolean;
  /** The next commit is applied, then the connection is cut before the answer. */
  dropNextCommitResponse: boolean;
  /** Appends a harmless commit, as if another device had written. */
  foreignCommit(): void;
  close(): Promise<void>;
}

const PAGE = 2000;

export async function startFake(log: Commit[]): Promise<Fake> {
  const fake: Fake = {
    port: 0, log, requests: [], commitHeaders: [], schema: 301, raceNextCommit: false, dropNextCommitResponse: false,
    foreignCommit() { this.log.push({ [newId()]: { e: "Tag4", t: 0, p: { tt: "from-another-device", ix: 0, sh: null, pn: [], xx: { sn: {}, _t: "oo" } } } }); },
    close: () => new Promise((r) => server.close(() => r())),
  };
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url!, "http://x");
    const send = (code: number, v: unknown): void => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(v)); };
    const start = url.searchParams.get("start-index");
    fake.requests.push({ method: req.method!, path: url.pathname, ...(start !== null ? { start: Number(start) } : {}) });
    if (req.method === "GET" && url.pathname.startsWith("/version/1/account/")) return send(200, { "history-key": "HK", status: "SYAccountStatusActive" });
    if (req.method === "GET" && url.pathname === "/version/1/history/HK") return send(200, { "latest-schema-version": fake.schema, "latest-total-content-size": 0, "latest-server-index": fake.log.length });
    if (req.method === "GET" && url.pathname === "/version/1/history/HK/items") {
      const s = Number(start);
      if (!Number.isSafeInteger(s) || s < 0 || s > fake.log.length) return send(500, {});
      return send(200, { items: fake.log.slice(s, s + PAGE), schema: fake.schema, "current-item-index": fake.log.length, "latest-total-content-size": 0, "end-total-content-size": 0 });
    }
    if (req.method === "POST" && url.pathname === "/version/1/history/HK/commit") {
      fake.commitHeaders.push(req.headers);
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        if (fake.raceNextCommit) { fake.raceNextCommit = false; fake.foreignCommit(); }
        if (Number(url.searchParams.get("ancestor-index")) !== fake.log.length) return send(409, {});
        fake.log.push(JSON.parse(body) as Commit);
        if (fake.dropNextCommitResponse) { fake.dropNextCommitResponse = false; req.socket.destroy(); return; }
        send(200, { "server-head-index": fake.log.length });
      });
      return;
    }
    send(404, {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  fake.port = (server.address() as { port: number }).port;
  return fake;
}
