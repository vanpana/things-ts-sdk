# Conformance harness

Differential tests against the Go reference implementation (pinned v0.6.0). The TypeScript code started as a port of it
and now evolves on its own, so these tests are a regression suite for the behaviour that was ported.

**Go is a dependency of this folder** (Go 1.25+, https://go.dev/dl/). Nothing generated is committed: `npm run test:conformance`
(from the repo root) runs `regenerate.sh`, which builds the Go oracle and writes the answers to `fixtures/`
(git-ignored, ~3.5 MB, about 2 seconds, deterministic), then runs the whole test suite. Without Go, plain `npm test`
still passes and reports the five conformance tests as skipped; CI runs them on every PR.

To adopt a new Go release: change the version in `go-oracle/go.mod`, run `npm run test:conformance`, and diff the new
fixtures against the old ones (copy the old `fixtures/` aside first). A changed answer is a behaviour change upstream,
so only the relevant parts need porting.

```
gen-cases-*.ts  --(inputs, deterministic)-->  go-oracle (real Go SDK v0.6.0)  --(answers)-->  fixtures/*.json
                                                                                                   |
packages/sdk/test/conformance-*.test.ts  <--- same inputs, regenerated in memory --- compares ----+
```

- `scripts/gen-cases-*.ts` generate the inputs from a seeded PRNG plus hand-written scenarios.
- `go-oracle/` is a small Go program using only the Go SDK's **exported** API. It prints what the Go code does.
  Sub-commands: `base58`, `notes`, `repeat`, `state` (fold + every hierarchy query), `client` (every HTTP call, with
  the request log of a local server, and every write verdict).
- `fixtures/` holds Go's answers (generated, git-ignored).
- `regenerate.sh` generates `cases/` and `fixtures/`. It refuses to run without Go and never truncates a fixture on failure.
- `scripts/real-log-diff.ts` compares the fold with Go on a **private** real history
  (`scripts/dump-log.ts` saves your log; then `THINGS_LOG=... GO=... node scripts/real-log-diff.ts`). Nothing from a real account is ever committed.

## Checking the checker

A passing suite proves little unless it fails when the code is wrong. After changing validation or the corpus, mutate
the code on purpose and confirm the suite fails, for example loosen `ss` to accept `2`, drop the `rt` marker
requirement, or alter a header. `scripts/mutation-check.ts` (`npm run mutation`) automates a set of these.
