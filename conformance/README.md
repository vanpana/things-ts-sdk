# Conformance harness

Golden tests recorded from the Go reference implementation (v0.6.0). The TypeScript code started as a port of it and now
evolves on its own, so the fixtures are a regression suite for the behaviour that was ported. The Go oracle is a local
maintenance tool (no CI job runs it): when the Go SDK releases a new version, bump the pin, regenerate, and the fixture diff shows exactly
what changed upstream, so only the relevant parts need porting.

```
gen-cases-*.ts  --(inputs, deterministic)-->  go-oracle (real Go SDK v0.6.0)  --(answers)-->  fixtures/*.json
                                                                                                   |
packages/sdk/test/conformance-*.test.ts  <--- same inputs, regenerated in memory --- compares ----+
```

- `scripts/gen-cases-*.ts` generate the inputs from a seeded PRNG plus hand-written scenarios.
- `go-oracle/` is a small Go program using only the Go SDK's **exported** API. It prints what the Go code does.
  Sub-commands: `base58`, `notes`, `repeat`, `state` (fold + every hierarchy query), `client` (every HTTP call, with
  the request log of a local server, and every write verdict).
- `fixtures/` holds Go's answers (committed). The TypeScript tests need no Go toolchain.
- `regenerate.sh` rebuilds the fixtures (Go 1.25+). Run it when bumping the pinned Go version, then review the diff:
  a changed fixture is a behaviour change upstream.
- `scripts/real-log-diff.ts` compares the fold with Go on a **private** real history
  (`scripts/dump-log.ts` saves your log; then `THINGS_LOG=... GO=... node scripts/real-log-diff.ts`). Nothing from a real account is ever committed.

## Checking the checker

A passing suite proves little unless it fails when the code is wrong. After changing validation or the corpus, mutate
the code on purpose and confirm the suite fails, for example loosen `ss` to accept `2`, drop the `rt` marker
requirement, or alter a header. `scripts/mutation-check.ts` (`npm run mutation`) automates a set of these.
