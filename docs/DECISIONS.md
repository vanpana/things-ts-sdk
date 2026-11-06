# Design decisions

Why the SDK behaves the way it does. If you want to change one of these, open an issue first and say how the new
behaviour was verified.

## Reading

- **Strict by default.** An unknown item kind or a malformed payload is an error (`mode: "strict"`), so a protocol change
  cannot silently corrupt state. `mode: "lenient"` reproduces the Go SDK (skips unknown non-task kinds). Unknown `Task*`
  kinds are always an error.
- **State keeps the raw wire fields.** Typed `Task` / `Area` / `Tag` / `ChecklistItem` are projections, so nothing the
  server sends is dropped. The typed views follow the Go SDK's field set.
- **Required task fields are never nulled** (`tt`, `ss`, `st`, `ix`, `tr`, `tp`, `ti`, `do`): an explicit null is ignored,
  as in Go. All other nulls clear the field. This is a rule, not an observation of what Things does.
- **Sync is storage-agnostic.** `syncState` only needs a `History` and a `State`; persistence (`exportState` /
  `importState`) belongs to the caller.
- **Batches are atomic.** A batch is applied on an overlay and committed only if every item was accepted; the cursor moves
  only after a page was applied.

## Writing

- **Writes are stricter than the Go SDK by default.** A bad write to the history is permanent and can crash Things on every
  device, so:
  - only `Task7` items and strictly validated creates / deletes of `Tag4`, `Area3` and `ChecklistItem3` are sent; every
    other item is refused unless `write(items, { unsafe: { unverifiedKinds: true } })` (Go passes everything through);
  - writes are refused unless the history's schema version was seen and equals 301 (`unsafe.ignoreSchema` to override);
    `syncState` records it, so the normal flow just works;
  - a create is never sent twice from one `History` object (committed, or outcome unknown after a timeout, dropped
    connection, 5xx or unreadable response); call `forgetWrites()` after re-syncing and checking the log;
  - a commit body over 1 MB is refused; an unknown outcome raises `CommitOutcomeUnknownError`.
  The differential tests run with the first two switched off, so parity is still measured against Go.
- **No retries on writes, ever.** A 409 surfaces as `ThingsHttpError` (`status === 409`). Reads retry 500-504 in
  `syncState`.
- **Validation runs on what is sent.** The batch is serialised once, parsed back, and the copy is validated.
- **Preflight.** The default is the Go-style full-log scan; a long-lived process passes `preflightFromState` to avoid
  re-reading the log.
- **`when: "today"` requires an explicit IANA `timeZone`.** A Worker's own zone is UTC and would silently schedule "today"
  on the wrong day.
- **Commit and `/items` carry no `Authorization` header**, like Go. The history key is the credential.

## Security

- The password lives in a true private field (`#password`) and is sent only as the `Authorization` header on the account
  endpoints. Plain `http://` endpoints are refused unless `allowInsecure: true` (tests). Error messages redact the account
  email and the history key (which is itself a credential).
- Redirects are not followed (`redirect: "manual"`, any 3xx is refused). `"error"` is not implemented by Cloudflare Workers.
- `ThingsClient.request` / `.json` are `@internal` (stripped from the type declarations); `History` needs them.

## Packaging

- **ESM only, Node >= 22 (or any runtime with `fetch`).** ES2022 output; uses `String.prototype.isWellFormed`. Type
  declarations use the DOM-style `RequestInit` / `Response` types: add `"lib": ["ES2022", "DOM"]` or `@types/node`.
  Source uses only erasable TypeScript so Node can run it unbuilt.
- **Zero runtime dependencies** and no Node-only APIs in `packages/sdk/src`, so it runs on Workers, Deno and Bun.

## Testing

- **Nothing from the Go comparison is committed.** Inputs are generated in memory; Go's answers are generated on demand by
  `conformance/regenerate.sh` (about 2 seconds, deterministic for the pinned Go version, `conformance/fixtures` is
  git-ignored). Go 1.25+ is therefore a dependency for the conformance tests and the mutation check; plain `npm test`
  skips the conformance tests without it, CI runs them. Whoever adopts a new Go release changes the pin and compares
  the new answers with the old ones.
