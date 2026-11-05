// Saves your own account's commit log to a file, for scripts/real-log-diff.ts. Read-only. The file contains your
// private data: keep it outside the repository (things-log*.json is git-ignored as a safety net).
//   THINGS_EMAIL=... THINGS_PASSWORD=... node conformance/scripts/dump-log.ts ~/things-log.json
import { writeFileSync } from "node:fs";
import { ThingsClient } from "../../packages/sdk/src/index.ts";

const out = process.argv[2];
const email = process.env["THINGS_EMAIL"], password = process.env["THINGS_PASSWORD"];
if (!out || !email || !password) { console.error("usage: THINGS_EMAIL=... THINGS_PASSWORD=... node dump-log.ts <output.json>"); process.exit(2); }

const history = await new ThingsClient(email, password).ownHistory();
const head = (await history.client.history(history.id)).latestServerIndex;
const commits = [];
while (commits.length < head) {
  const page = await history.items(commits.length);
  if (page.commits.length === 0) throw new Error(`server returned no commits at index ${commits.length}`);
  commits.push(...page.commits);
}
writeFileSync(out, JSON.stringify(commits), { mode: 0o600 });
console.log(`wrote ${commits.length} commits`);
