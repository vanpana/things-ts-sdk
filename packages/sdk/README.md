# @vanpana/things-ts-sdk

Unofficial TypeScript client for the Things Cloud sync protocol. Runs on any runtime with `fetch` (Node >= 22, Cloudflare
Workers, Deno, Bun). Zero runtime dependencies, ESM only. Not affiliated with Cultured Code.

> The protocol is undocumented and can change without notice, and a malformed write can crash Things on every device
> that syncs the account. Read [GAPS](../../docs/GAPS.md) before writing to an account you care about.

```sh
npm install @vanpana/things-ts-sdk
```

```ts
import { ThingsClient, emptyState, syncState, allTasks, buildCreate, buildEdit } from "@vanpana/things-ts-sdk";

const client = new ThingsClient(process.env.THINGS_EMAIL!, process.env.THINGS_PASSWORD!);
const history = await client.ownHistory();

const state = emptyState();
await syncState(history, state); // pages through the log; also records the server's schema version

const open = allTasks(state).filter((t) => t.status === 0 && !t.inTrash);
console.log(open.length, "open tasks");

await history.write([buildCreate({ title: "Hello from TypeScript" })]);
// To edit, sync first, then:
// await history.write([buildEdit(state, id, { complete: true })], { preflight: (t) => preflightFromState(state, t) });
```

See the [repository README](../../README.md) for the overview and [PARITY](../../docs/PARITY.md) for how the behaviour is
checked against the Go SDK.

## Modules (all re-exported from the package root)

| Area | Exports |
|---|---|
| Client | `ThingsClient`, `History`, `ThingsHttpError`, `UnauthorizedError` |
| Sync | `syncState` (generic loop, storage-agnostic), `fold`, `applyItems`, `flattenCommits`, `exportState` / `importState` |
| State views | `allTasks`, `getTask`, `allAreas`, `allTags`, `allChecklistItems`, and the hierarchy queries (`projects`, `subtasks`, `tasksByArea`, `headings`, ...) |
| Writes | `History.write`, `buildCreate`, `buildEdit`, `buildCreateTag`, `buildCreateArea`, `buildAddChecklistItem`, `buildDelete`, `validateWrites`, `validateOrganiserWrites`, `scanTask7Targets`, `preflightFromState` |
| Health | `checkDrift` (protocol drift report for a full log and the state built from it) |
| Errors | `ThingsError` and its subclasses: `ThingsHttpError`, `UnauthorizedError`, `ThingsNetworkError`, `WriteRefusedError`, `CommitOutcomeUnknownError`, ... |
| Identifiers | `newId`, `isValidId`, `encodeUuid`, `decodeUuid`, `encodeLegacyIdentifier` |
| Notes | `textNote`, `applyPatches`, `applyPatchesChecked`, `crc32` |
| Recurrence rules | `nextScheduledDate`, `computeFirstScheduledDate`, `isNeverending` |

## Design notes

- **State is data.** `State` is plain maps of entities that keep their raw wire fields; typed `Task` / `Area` / `Tag` /
  `ChecklistItem` views are projected on demand. `exportState` / `importState` make it storable anywhere (SQLite, a
  Durable Object, a file) and `syncState` does not care where.
- **Atomic batches.** `applyItems` and `fold` compute on an overlay and only change the state if every item was
  accepted. The cursor moves only after a page was applied.
- **Strict by default.** An unknown item kind or a malformed payload is an error (`mode: "strict"`), so a protocol
  change cannot silently corrupt state. `mode: "lenient"` skips unknown non-task kinds and malformed non-task
  payloads as the Go SDK does; unknown `Task*` kinds are always an error.
- **Writes are validated before they are sent.** `History.write` runs the Go SDK's Task7 validation, a strict contract for
  tag / area / checklist-item creates and deletes, and, for modifications, a preflight that proves the target exists exactly
  once and is not part of a recurrence. Pass `preflight: (targets) => number` to
  answer from a synced `State` (`preflightFromState`) instead of re-reading the whole log.
- **No hidden clock or zone.** Builders take `now` and `timeZone`; `when: "today"` requires an explicit IANA time zone.
