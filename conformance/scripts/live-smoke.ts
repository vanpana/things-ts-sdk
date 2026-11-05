// Read-only smoke test against a real Things Cloud account. Writes nothing.
//   THINGS_EMAIL=you@example.com THINGS_PASSWORD=... node conformance/scripts/live-smoke.ts
// Prints counts only: no titles, notes or credentials.
import { allTasks, emptyState, KNOWN_SCHEMA, syncState, ThingsClient } from "../../packages/sdk/src/index.ts";

const email = process.env["THINGS_EMAIL"];
const password = process.env["THINGS_PASSWORD"];
if (!email || !password) { console.error("set THINGS_EMAIL and THINGS_PASSWORD"); process.exit(2); }

const client = new ThingsClient(email, password);
const account = await client.verify();
console.log("account status:", account.status);

const history = await client.ownHistory();
const state = emptyState();
const t0 = performance.now();
const { commits, head } = await syncState(history, state);
console.log(`synced ${commits} commits to head ${head} in ${((performance.now() - t0) / 1000).toFixed(1)}s (strict mode: unknown kinds would have thrown)`);
console.log(`schema ${history.latestSchemaVersion} ${history.latestSchemaVersion === KNOWN_SCHEMA ? "(verified)" : "(NOT the verified schema: treat as read-only)"}`);

const tasks = allTasks(state);
const open = tasks.filter((t) => t.status === 0 && !t.inTrash);
console.log(`tasks ${tasks.length} (open ${open.length}: ${open.filter((t) => t.type === 0).length} tasks, ${open.filter((t) => t.type === 1).length} projects), areas ${state.areas.size}, tags ${state.tags.size}, checklist items ${state.checklist.size}`);

// A second sync must be a no-op.
const again = await syncState(history, state);
console.log(`second sync applied ${again.commits} commits (expected 0)`);
if (again.commits !== 0) process.exitCode = 1;
