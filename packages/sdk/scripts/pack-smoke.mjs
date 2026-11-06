// Packs the SDK, installs the tarball into a scratch project and runs the public API under plain Node
// (no type stripping), against a fake fetch. Catches an empty or broken package before it is published.
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const here = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "things-ts-sdk-smoke-"));
const tarball = execFileSync("npm", ["pack", "--silent", "--pack-destination", dir], { cwd: here, encoding: "utf8" }).trim().split("\n").at(-1);
writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "smoke", private: true, type: "module" }));
execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund", join(dir, tarball)], { cwd: dir, stdio: "inherit" });
writeFileSync(join(dir, "smoke.mjs"), `
import { ThingsClient, emptyState, syncState, allTasks, buildCreate } from "@vanpana/things-ts-sdk";
let head = 0;
const fetch = async (url, init) => {
  const u = new URL(url);
  if (u.pathname.endsWith("/items")) return Response.json({ items: [], "current-item-index": head, schema: 301, "latest-total-content-size": 0, "end-total-content-size": 0 });
  if (u.pathname.endsWith("/commit")) { head++; return Response.json({ "server-head-index": head }); }
  if (u.pathname.includes("/history/")) return Response.json({ "latest-schema-version": 301, "latest-total-content-size": 0, "latest-server-index": head });
  return Response.json({ "history-key": "H", status: "SYAccountStatusActive" });
};
const client = new ThingsClient("me@example.com", "pw", { endpoint: "https://fake.invalid", fetch });
const history = await client.ownHistory();
const state = emptyState();
await syncState(history, state);
await history.write([buildCreate({ title: "smoke" })]);
if (head !== 1 || allTasks(state).length !== 0) throw new Error("unexpected result");
console.log("pack smoke ok");
`);
execFileSync("node", ["smoke.mjs"], { cwd: dir, stdio: "inherit" });
