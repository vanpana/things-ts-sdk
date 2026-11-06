// Checks the checker: applies deliberate bugs to the SDK one at a time and requires the test suite to fail on each.
//   node conformance/scripts/mutation-check.ts
// Every "survived" line is a hole in the tests. Sources are restored afterwards, also on Ctrl-C.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const SRC = new URL("../../packages/sdk/src/", import.meta.url);
const SDK = new URL("../../packages/sdk/", import.meta.url).pathname;

if (!existsSync(new URL("../fixtures/state.json", import.meta.url))) {
  console.error("The conformance fixtures are missing, so most bugs would go unnoticed. Run `npm run test:conformance` first (needs Go 1.25+).");
  process.exit(2);
}

interface Mutation { file: string; from: string; to: string; what: string }
const M: Mutation[] = [
  { file: "validate.ts", from: '(p["ss"] !== 0 && p["ss"] !== 3)', to: '(p["ss"] !== 0 && p["ss"] !== 3 && p["ss"] !== 2)', what: "modification accepts ss=2" },
  { file: "validate.ts", from: 'if (srNull !== tirNull) fail("create sr and tir must have the same date");', to: "", what: "create allows sr without tir" },
  { file: "validate.ts", from: 'e = requiredTimestamp(p["cd"], true);', to: 'e = requiredTimestamp(p["cd"], false);', what: "create accepts cd=0" },
  { file: "validate.ts", from: '"tr", "ix", "ti", "do"]);', to: '"tr", "ix", "ti", "do", "rr"]);', what: "modification may set rr" },
  { file: "validate.ts", from: 'if (hasStatus !== hasStop) fail("modification ss and sp must be written together");', to: "", what: "ss without sp accepted" },
  { file: "validate.ts", from: 'if (ch !== crc32(v["v"])) return "has a checksum that does not match its full text";', to: "", what: "note checksum not verified" },
  { file: "validate.ts", from: 'if (st === 0 && !srNull) fail("create st 0 requires null sr and tir");', to: "", what: "inbox create may carry a date" },
  { file: "validate.ts", from: 'if (k !== "tg" && (p[k] as string[]).length > 1)', to: 'if (false)', what: "create may have two parents" },
  { file: "validate.ts", from: 'if (item.kind.startsWith("Task")) fail(', to: 'if (false) fail(', what: "unverified task kinds may be written" },
  { file: "preflight.ts", from: "if (!s.rrKnown || !s.rpKnown || !s.rtKnown)", to: "if (!s.rrKnown || !s.rpKnown)", what: "rt marker not required" },
  { file: "preflight.ts", from: "|| s.icsd || s.acrd)", to: ")", what: "icsd / acrd not treated as recurring" },
  { file: "preflight.ts", from: "if (s.lastAffectedIndex === serverIndex) s.sameIndexAmbiguous = true;", to: "", what: "same-commit collision ignored" },
  // Not listed: dropping `if (!s.exists) s.ambiguous = true` is an equivalent mutant; the final `!s.exists` check refuses the same targets.
  { file: "preflight.ts", from: "else if (page.latestServerIndex < checkedHead) fail(", to: "else if (false) fail(", what: "head regression ignored" },
  { file: "history.ts", from: '_cnt: "1"', to: '_cnt: "2"', what: "commit query parameter" },
  { file: "history.ts", from: 'Schema: "301"', to: 'Schema: "300"', what: "commit schema header" },
  // Not listed: removing the explicit duplicate-uuid check is an equivalent mutant; the "items changed when serialised" guard refuses the same batches.
  { file: "client.ts", from: 'THINGS_USER_AGENT = "ThingsMac/32209501"', to: 'THINGS_USER_AGENT = "ThingsMac/1"', what: "user agent" },
  { file: "client.ts", from: 'headers["Content-Encoding"] = "UTF-8";', to: "", what: "content-encoding header" },
  { file: "base58.ts", from: 'const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";', to: 'const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxzy";', what: "alphabet" },
  { file: "base58.ts", from: "[0-9a-fA-F]{12})(-[0-9]{8})$", to: "[0-9a-fA-F]{12})(-[0-9]{7})$", what: "recurrence id pattern" },
  { file: "base58.ts", from: "while (zeros < 16 && bytes[zeros] === 0) zeros++;", to: "", what: "leading zero bytes dropped" },
  { file: "notes.ts", from: "const position = Math.min(Math.max(patch.p, 0), text.length);", to: "const position = Math.min(patch.p, text.length);", what: "negative patch position" },
  { file: "notes.ts", from: 'try { strict.decode(text); } catch { throw new NoteError(`note patch ${i} produced invalid UTF-8`); }', to: "", what: "invalid utf-8 not rejected" },
  { file: "repeat.ts", from: "addDate(t, 0, 0, c.fa * 7)", to: "addDate(t, 0, 0, c.fa * 8)", what: "weekly step" },
  { file: "repeat.ts", from: "const lastDayOfMonth = (t: Date): Date => new Date(addDate(firstDayOfMonth(t), 0, 1, 0).getTime() - 3_600_000);", to: "const lastDayOfMonth = (t: Date): Date => new Date(addDate(firstDayOfMonth(t), 0, 1, 0).getTime() - 86_400_000);", what: "last day of month" },
  { file: "state.ts", from: 'const NEVER_NULL = new Set(["tt", "ss", "st", "ix", "tr", "tp", "ti", "do"]);', to: 'const NEVER_NULL = new Set(["ss", "st", "ix", "tr", "tp", "ti", "do"]);', what: "null title clears the title" },
  { file: "state.ts", from: "const id = info.legacy && info.bucket !== \"tombstone\" ? remapId(item.uuid) : item.uuid;", to: "const id = item.uuid;", what: "legacy ids not remapped" },
  { file: "state.ts", from: "if (info.legacy) payload = remapReferences(payload, TASK_REFS);", to: "", what: "legacy references not remapped" },
  { file: "state.ts", from: "for (const b of [\"tasks\", \"areas\", \"tags\", \"checklist\"] as const) overlay[b].set(oid, null);", to: "overlay.tasks.set(oid, null);", what: "tombstone only removes tasks" },
  { file: "state.ts", from: "if (item.kind.startsWith(\"Task\")) throw new UnsupportedTaskKindError", to: "if (false) throw new UnsupportedTaskKindError", what: "unknown task kinds accepted" },
  { file: "entities.ts", from: 'schedule: int(f["st"], 1),', to: 'schedule: int(f["st"], 0),', what: "default schedule" },
  { file: "entities.ts", from: 'inTrash: f["tr"] === true,', to: "inTrash: false,", what: "trash flag ignored" },
  { file: "queries.ts", from: "    && !(o.excludeInTrash && t.inTrash)\n    && t.areaIds.includes(areaId)", to: "    && t.areaIds.includes(areaId)", what: "tasksByArea ignores trash" },
  { file: "queries.ts", from: "t.type === TaskType.Heading && t.parentTaskIds.includes(projectId)", to: "t.parentTaskIds.includes(projectId)", what: "headings include tasks" },
  { file: "sync.ts", from: "o.retryBaseMs * 2 ** attempt", to: "o.retryBaseMs", what: "no exponential backoff" },
  { file: "sync.ts", from: "if (state.cursor > head) throw", to: "if (false) throw", what: "state ahead of the server" },
  { file: "builders.ts", from: 'if (o.reopen) { p["ss"] = TaskStatus.Pending; p["sp"] = null; }', to: 'if (o.reopen) { p["ss"] = TaskStatus.Pending; }', what: "reopen keeps the stop date" },
  { file: "builders.ts", from: 'if (!ctx.timeZone) refuse("timeZone is required to resolve \'today\'");', to: "", what: "today without a time zone" },
  { file: "guards.ts", from: "e.fields[\"rr\"] != null || e.fields[\"rp\"] != null || rt.length > 0", to: 'e.fields["rr"] != null || rt.length > 0', what: "rp ignored by the recurrence guard" },
  { file: "state.ts", from: "if (item.action === ItemAction.Created ? live : !live) ent.ambiguous = true;", to: "if (false) ent.ambiguous = true;", what: "create-over-live / orphan modify not flagged" },
  { file: "state.ts", from: "if (live) touch(\"tasks\", id, live.kind).ambiguous = true;", to: "", what: "same-commit double touch not flagged" },
  { file: "state.ts", from: "if (!optional(nt[\"_t\"], (x) => typeof x === \"string\")) bad(\"_t\");", to: "", what: "note _t type unchecked" },
  { file: "state.ts", from: "if (!optional(q[\"r\"], (x) => typeof x === \"string\")", to: "if (false", what: "patch replacement type unchecked" },
  { file: "preflight.ts", from: "s.ambiguous = e.ambiguous === true;", to: "", what: "state preflight ignores ambiguity" },
  { file: "preflight.ts", from: "if (pages >= MAX_PAGES)", to: "if (false)", what: "preflight page cap" },
  { file: "history.ts", from: "const plan = validateWrites(sentItems);", to: "const plan = validateWrites(items.map((i) => ({ ...i })));", what: "validates the object instead of the serialised text" },
  { file: "history.ts", from: "const head = serverIndex(v[\"current-item-index\"], \"current-item-index\");", to: "const head = v[\"current-item-index\"];", what: "head not validated" },
  { file: "path.ts", from: '.padStart(2, "0")', to: '.padStart(1, "0")', what: "percent-encoding width" },
  { file: "path.ts", from: 'value === "." || value === ".."', to: 'false', what: "dot segments allowed" },
  { file: "repeat.ts", from: "fa: c.fa ?? 0,", to: "fa: c.fa,", what: "missing amplitude" },
  { file: "history.ts", from: "this.latestSchemaVersion !== KNOWN_SCHEMA)", to: "false)", what: "schema guard" },
  { file: "history.ts", from: 'if (!options.unsafe?.unverifiedKinds && item.kind !== "Task7" && !ORGANISER_KINDS.includes(item.kind)) {', to: "if (false) {", what: "unverified kinds sent by default" },
  { file: "history.ts", from: "if (!options.unsafe?.unverifiedKinds) validateOrganiserWrites(sentItems);", to: "", what: "organiser contract not enforced" },
  { file: "organise.ts", from: "o[\"ss\"] !== 0 ||", to: "", what: "checklist item created already completed" },
  { file: "organise.ts", from: "if (item.action !== ItemAction.Created) fail(", to: "if (false) fail(", what: "organiser modifications allowed" },
  { file: "organise.ts", from: 'fail("tag is still in use")', to: "undefined", what: "in-use tag deleted" },
  { file: "organise.ts", from: 'if (recurrenceBlockedIds(state).has(o.taskId)) fail(', to: "if (false) fail(", what: "checklist on recurring task" },
  { file: "client.ts", from: 'if (typeof password !== "string" ||', to: "if (false &&", what: "unsendable password accepted" },
  { file: "client.ts", from: "spec.authorized ? {} : { cause: e }", to: "{ cause: e }", what: "platform error attached to authorized requests" },
  { file: "history.ts", from: "if (item.action === ItemAction.Created && (this.#committed", to: "if (false && (this.#committed", what: "duplicate-create guard on the sent copy" },
  { file: "drift.ts", from: "if (input.commits.length !== input.head || input.state.cursor !== input.head) {", to: "if (false) {", what: "truncated log accepted" },
  { file: "views.ts", from: 'if (e.fields["rr"] != null) return false;', to: "", what: "recurring templates listed in views" },
  { file: "views.ts", from: 'if (project !== null && state.tasks.get(project)?.fields["tr"] === true) return false;', to: "", what: "tasks of a trashed project listed" },
  { file: "views.ts", from: "(sr(f) ?? -Infinity) > t, true)", to: "(sr(f) ?? -Infinity) >= t, true)", what: "upcoming includes today" },
  { file: "views.ts", from: "sr(f)! <= t, true)", to: "sr(f)! < t, true)", what: "today excludes scheduled-for-today" },
  { file: "views.ts", from: 'f["dds"] == null, true)', to: "true, true)", what: "suppressed overdue shown in today" },
  { file: "views.ts", from: "st(f) === 2 && sr(f) === null, true)", to: "st(f) === 2, true)", what: "dated someday tasks in someday" },
  { file: "views.ts", from: 'e.fields["rr"] == null) out.push', to: "true) out.push", what: "recurring templates in trash" },
  { file: "views.ts", from: "all.filter(status(2))", to: "all.filter(status(3))", what: "canceled tasks missing from logbook" },
  { file: "drift.ts", from: "if (input.schema !== KNOWN_SCHEMA)", to: "if (false)", what: "schema drift ignored" },
  { file: "drift.ts", from: "crc32(n[\"v\"]) !== n[\"ch\"]", to: "false", what: "note checksum drift ignored" },
  { file: "drift.ts", from: "canonical(rebuilt) !== canonical(input.state)", to: "false", what: "state divergence ignored" },
  { file: "history.ts", from: "for (const u of created) this.#committed.add(u);", to: "", what: "committed creates not remembered" },
  { file: "history.ts", from: "if (res.status >= 500) for (const u of created) this.#uncertain.add(u);", to: "", what: "5xx not treated as uncertain" },
  { file: "history.ts", from: "if (new TextEncoder().encode(bodyText).length > MAX_COMMIT_BYTES)", to: "if (false)", what: "commit size cap" },
  { file: "client.ts", from: 'redirect: "manual"', to: 'redirect: "follow"', what: "redirects followed" },
  { file: "client.ts", from: 'if (url.username || url.password) throw', to: "if (false) throw", what: "credentials in endpoint" },
  { file: "state.ts", from: "Object.hasOwn(KINDS, item.kind)) continue;", to: "item.kind in KINDS) continue;", what: "prototype member kinds" },
  { file: "state.ts", from: "fields: Object.create(null), note: \"\" };", to: "fields: {}, note: \"\" };", what: "fields with a prototype" },
  { file: "sync.ts", from: "history.latestSchemaVersion = fresh.latestSchemaVersion;", to: "", what: "sync does not teach the schema" },
];

const originals = new Map<string, string>();
const restore = () => { for (const [f, s] of originals) writeFileSync(new URL(f, SRC), s); };
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => { restore(); process.exit(130); });
process.on("exit", restore);

let survived = 0;
for (const m of M) {
  const url = new URL(m.file, SRC);
  const src = originals.get(m.file) ?? readFileSync(url, "utf8");
  originals.set(m.file, src);
  if (!src.includes(m.from)) { console.log(`STALE    ${m.file}: ${m.what} (pattern not found)`); survived++; continue; }
  writeFileSync(url, src.replace(m.from, m.to));
  const r = spawnSync("node", ["--test", "--experimental-strip-types", "test/*.test.ts"], { cwd: SDK, encoding: "utf8", timeout: 90_000 });
  writeFileSync(url, src);
  const killed = r.status !== 0;
  if (!killed) survived++;
  console.log(`${killed ? "killed  " : "SURVIVED"} ${m.file}: ${m.what}`);
}
console.log(`\n${M.length - survived}/${M.length} mutations detected`);
process.exitCode = survived ? 1 : 0;
