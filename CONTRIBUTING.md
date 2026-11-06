# Contributing

```
npm ci
npm run typecheck && npm test      # SDK unit tests
npm run test:conformance           # optional locally, run by CI: differential tests against the Go SDK; needs Go 1.25+
npm run mutation                   # optional: checks that the tests catch deliberate bugs (needs the conformance fixtures, so Go)
```

## Changesets (every PR that changes published code)

1. `npm run changeset`, pick `@vanpana/things-ts-sdk`, choose patch / minor / major and write a one-line summary
   for the changelog.
2. Commit the generated `.changeset/*.md`.
3. Credit: the release tooling adds the PR link and "Thanks @you!" automatically. To credit someone else, add a line
   `author: @handle` in the changeset summary.

Merging to `main` opens (or updates) a "Version packages" PR. Merging that PR publishes to npm.

## Rules for protocol work

- The protocol is unofficial. Say how a change was verified: the Go conformance tests (`conformance/`), the Mac Things database,
  or the live probe (`packages/worker`, `npm run probe:live`, your own account only).
- Never commit credentials, real task titles or notes. Fixtures must be scrubbed.
- Writes are fail-closed. Do not widen what `History.write` accepts without evidence and a test.

## AI-assisted contributions

AI-assisted pull requests are welcome if they pass CI and review, meet the quality bar, and their author will stay
responsible for maintaining them. Communicate with maintainers in your own words: text that reads as generated (confident
false claims, padded jargon) may get a generated reply.

The author of a PR must be a real human GitHub account. **Names of AI agents or companies must not appear in co-author
trailers, commit messages or code.** Commits that credit an AI suggest the human cannot maintain the change, and
AI co-authorship muddies who owns the code. You are the author of everything you submit.
