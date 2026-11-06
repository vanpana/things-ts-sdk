# Parity with the Go SDK

Reference: [`arthursoares/things-cloud-sdk`](https://github.com/arthursoares/things-cloud-sdk) **v0.6.0**
(commit `6919edc`, pinned in `conformance/go-oracle/go.mod`).

The library surface (client, histories, identifiers, notes, recurrence rules, in-memory state and queries, the Task7
write contract and the generic sync loop) is covered by differential tests: the real Go code and this code are given the
same generated inputs and must agree. The expected answers are in `conformance/fixtures/`, produced by
`conformance/go-oracle`. `npm test` runs them; `npm run mutation` checks that the tests catch deliberate bugs.

## Where it is not at parity

- Out of scope by decision: account management, the SQLite sync engine with change detection, `syncutil`, the CLI and
  stress tools, and the Go SDK's view queries (ours follow thingsapi/things.py and are checked against a real database
  with `conformance/scripts/verify-views.ts`). See [GAPS.md](GAPS.md).
- Deliberate differences (stricter writes, strict fold by default, millisecond dates, ...): [GAPS.md](GAPS.md).
- Not differential, covered by unit tests only: `syncState` (the Go loop is welded to SQLite), the builders,
  `preflightFromState`, `checkDrift`, and the tag / area / checklist write contract (Go has none).
- Parity of writes is measured with the SDK's extra safety checks switched off (`unsafe` options).
