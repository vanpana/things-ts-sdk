# Gaps and known limits

What is missing, different, or not verified. Items marked **help wanted** are good first contributions.

## Not implemented

- **Account management**: `SignUp`, `Confirm`, `AcceptSLA`, `ChangePassword`, `Delete`. Destructive or impossible to test
  safely on a real account.
- **SQLite sync engine and semantic change detection** (the Go `sync` package: 40+ change types, change log,
  `ChangesSince`) and **`syncutil`**. Storage-specific; use `exportState` / `importState`. **Help wanted:** a change
  detection layer over two `State` snapshots.
- Request debug logging: wrap the `fetch` you pass in `ClientOptions`.
- Writes of **projects, headings, recurring tasks, tombstones and `Task6`** items, and **modifications** of tags, areas
  and checklist items (creates and deletes are supported). Non-null modern `rp` is not understood.

## Differences from the Go SDK

| Topic | Go | This SDK |
|---|---|---|
| Unknown kinds / malformed non-task payloads | Skipped | Error in `strict` mode (default); `lenient` = Go |
| Explicit `null` in a checklist / tag / area payload | Ignored | Clears the field (untested against Things) |
| Lone UTF-16 surrogate in a write | Replaced by U+FFFD | Refused |
| Duplicate JSON keys / invalid UTF-8 in the server's history | Marks the target ambiguous | Not detectable after `JSON.parse` |
| Cycle in parent links | Stack overflow | Depth-limited, counts as "no area" |
| Dates | `int64` ns, overflows after 2262 (Things' year-4001 "never ends" sentinel breaks it) | Millisecond `Date` |
| `Area3` / `ChecklistItem` with a `null` payload, a tombstone with empty `dloid`, type checks on non-task payloads | Creates an empty entity / accepts | Skipped / refused |
| Writes | Any kind, any schema | Verified kinds only, on schema 301 only (see [DECISIONS](DECISIONS.md#writing)) |
| `Host` header, error message text | Set / Go text | Not settable by `fetch` / different text |

## Known limits of the write guards

- References (`ar`, `pr`, `agr`, `tg`, and a checklist item's `ts`, a tag's `pn`) are checked for shape by `History.write`;
  only the builders check that the target exists, is open and not recurring, and `buildDelete` is the only check that a
  tag or area is unused. A hand-built delete or reference is not checked against the state.
- The duplicate-create memory lives in one `History` object; two processes can both create.
- The server does not deduplicate: after `CommitOutcomeUnknownError`, only re-syncing shows whether it landed.
- Process crash between building and sending a commit.

## Not verified

- **Other accounts and versions.** Writes were checked on one account (Things 3.24.1, macOS, schema 301, Nov 2026).
- **The lists (Inbox, Today, Upcoming, Anytime, Someday, Logbook, Trash)** follow thingsapi/things.py, a community
  reference, not anything published by Cultured Code. On one real account they match it exactly (membership, and order apart from ties) at the database's own date and at
  ten other simulated dates. Upcoming is the one list we order differently: by start date, soonest first, because that is
  how the app shows it. Apart from that observation, nobody has compared the lists with the app's screens. Like things.py they do not predict what a repeating task will create, they leave recurring
  templates out, and a task in a completed (not trashed) project still shows where its own fields say. Order inside
  Trash and between equal sort keys is not specified by Things; ties keep log order. **Help wanted:** a second account.
- **Concurrency.** One stale-ancestor test (HTTP 409). Multi-device conflicts and offline convergence are untested.
- **Legacy identifiers** are checked against the Go derivation only, never a real pre-migration history.
  **Help wanted:** a scrubbed old-history fixture.
- `histories`, `createHistory`, `History.delete`, `registerAppInstance`: request shape matches Go, behaviour not
  exercised. **Never** call `History.delete` casually.
- Server-side changes without a client update are only noticed on the next call (see `checkDrift`, `ops/`).
- `User-Agent` `ThingsMac/32209501` is older than the current app; the server has not objected.

## Unspecified protocol areas

Reminders (`ato`), delegates (`dl`), repeater `rp`, the `xx` map, `Settings*`, `Command` items and Task kinds other than
3, 4, 6, 7 are preserved in raw fields and ignored by the typed views.
