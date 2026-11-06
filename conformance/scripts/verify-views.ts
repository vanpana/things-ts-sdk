// Compares the SDK's list views with thingsapi/things.py on a real Things database. Nothing is written to the repository,
// and nothing but counts and identifiers is printed. Needs your own data, so it is not part of CI.
//
//   THINGS_LOG=/path/log.json      the commit log (a JSON array of commits, or { commits }), see scripts/dump-log.ts
//   THINGS_DB=/path/main.sqlite    a Things database that matches the log (copy it with its -wal / -shm files)
//   THINGS_NOW=2026-11-04T12:30:00Z  the moment the database represents (default: now)
//   THINGS_TIME_ZONE=Europe/Copenhagen  the zone the database was used in (default: this machine's)
//   THINGS_PY=/path/to/python      a Python with `pip install things.py`
//
// things.py computes "today" inside SQLite, so the script freezes it to the calendar day of THINGS_NOW in the zone.
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { emptyState, fold, view, VIEW_NAMES } from "../../packages/sdk/src/index.ts";
import type { Commit, ViewName } from "../../packages/sdk/src/index.ts";

const need = (k: string): string => { const v = process.env[k]; if (!v) { console.error(`set ${k} (see the header of this file)`); process.exit(2); } return v; };
const logPath = need("THINGS_LOG"), dbPath = need("THINGS_DB"), py = need("THINGS_PY");
const now = new Date(process.env["THINGS_NOW"] ?? Date.now());
const timeZone = process.env["THINGS_TIME_ZONE"] ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
const isoToday = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

const raw = JSON.parse(readFileSync(logPath, "utf8"));
const commits: Commit[] = Array.isArray(raw) ? raw : raw.commits ?? raw.items;
const state = emptyState();
fold(state, commits);

// Work on a copy: the database may be in use, and its write-ahead log must travel with it.
const dir = mkdtempSync(join(tmpdir(), "views-"));
for (const suffix of ["", "-wal", "-shm"]) if (existsSync(dbPath + suffix)) copyFileSync(dbPath + suffix, join(dir, basename(dbPath) + suffix));
writeFileSync(join(dir, "ref.py"), `
import json, sys
import things, things.database as tdb
db_path, iso_today, out = sys.argv[1:4]
orig = tdb.convert_isodate_sql_expression_to_thingsdate
tdb.convert_isodate_sql_expression_to_thingsdate = lambda e, null_possible=True: orig(e.replace("date('now', 'localtime')", "'" + iso_today + "'"), null_possible)
d = tdb.Database(db_path)
views = {"inbox": things.inbox, "today": things.today, "upcoming": things.upcoming, "anytime": things.anytime,
         "someday": things.someday, "logbook": things.logbook, "trash": things.trash}
ref = {k: [t["uuid"] for t in f(database=d)] for k, f in views.items()}
import sqlite3
ref["_all"] = [r[0] for r in sqlite3.connect("file:" + db_path + "?mode=ro", uri=True).execute("select uuid from TMTask")]
json.dump(ref, open(out, "w"))
`);
execFileSync(py, [join(dir, "ref.py"), join(dir, basename(dbPath)), isoToday, join(dir, "ref.json")], { stdio: ["ignore", "inherit", "inherit"] });
const ref = JSON.parse(readFileSync(join(dir, "ref.json"), "utf8")) as Record<ViewName | "_all", string[]>;
const inDb = new Set(ref._all);

// The log may hold tasks created after the database copy was taken: those are left out of the comparison.
const missing = [...state.tasks.keys()].filter((id) => !inDb.has(id)).length;
console.log(`zone ${timeZone}, today ${isoToday}, ${state.tasks.size} tasks in the log (${missing} not in the database, ignored)`);

// What each list is sorted by, so that order differences between equal keys (which no rule decides) can be told apart.
const key = (name: ViewName, id: string): string => {
  const f = state.tasks.get(id)!.fields;
  switch (name) {
    case "today": return `${f["ti"] ?? 0}|${f["sr"] ?? ""}`;
    case "logbook": return String(Math.floor(Number(f["sp"] ?? 0)));
    default: return String(f["ix"] ?? 0);
  }
};
let differences = 0, orderProblems = 0;
for (const name of VIEW_NAMES) {
  const mine = view(state, name, { now, timeZone }).map((t) => t.uuid).filter((id) => inDb.has(id));
  const theirs = ref[name];
  const a = new Set(mine), b = new Set(theirs);
  const onlyMine = mine.filter((x) => !b.has(x)), onlyTheirs = theirs.filter((x) => !a.has(x));
  const common = mine.filter((x) => b.has(x)), commonRef = theirs.filter((x) => a.has(x));
  const samePositions = common.filter((x, i) => commonRef[i] === x).length;
  const realOrderDiffs = common.filter((x, i) => commonRef[i] !== x && key(name, x) !== key(name, commonRef[i]!)).length;
  differences += onlyMine.length + onlyTheirs.length;
  console.log(`${name.padEnd(9)} sdk ${String(mine.length).padStart(5)}  things.py ${String(theirs.length).padStart(5)}  membership differences ${onlyMine.length + onlyTheirs.length}  order: ${samePositions}/${common.length} positions equal, ${realOrderDiffs} not explained by equal sort keys`);
  if (onlyMine.length) console.log(`   only in sdk:       ${onlyMine.slice(0, 10).join(" ")}${onlyMine.length > 10 ? " ..." : ""}`);
  if (onlyTheirs.length) console.log(`   only in things.py: ${onlyTheirs.slice(0, 10).join(" ")}${onlyTheirs.length > 10 ? " ..." : ""}`);
  orderProblems += realOrderDiffs;
}
process.exitCode = differences === 0 && orderProblems === 0 ? 0 : 1;
