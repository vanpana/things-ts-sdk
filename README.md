# things-ts-sdk

An unofficial TypeScript client for the **Things Cloud** sync protocol (the service behind Things 3 sync between Mac,
iPhone and iPad). It runs anywhere `fetch` does: Node, Cloudflare Workers, Deno, Bun. Zero runtime dependencies.

> **Unofficial.** Not affiliated with or endorsed by Cultured Code. The protocol is undocumented and was reverse
> engineered by others; it can change without notice, and **a malformed write can crash Things on every device that
> syncs the account, permanently.** Read [docs/GAPS.md](docs/GAPS.md) before writing to an account you care about.

## Packages

| Package | What it is | Status |
|---|---|---|
| [`packages/sdk`](packages/sdk) (`@vanpana/things-ts-sdk`) | Protocol client, event-sourced state, hierarchy queries, write validation, safe builders | Feature parity with the Go SDK's library surface, verified differentially ([docs/PARITY.md](docs/PARITY.md)) |
| [`packages/worker`](packages/worker) (`things-ts-worker`) | Cloudflare Worker / Durable Object that keeps the state warm and exposes an allow-listed tool set | Probe Worker, canary and protocol-drift checks; the Durable Object is in progress |

## Where this comes from

The protocol knowledge and the reference behaviour come from the Go SDK
[arthursoares/things-cloud-sdk](https://github.com/arthursoares/things-cloud-sdk) (MIT), a continuation of
[nicolai86/things-cloud-sdk](https://github.com/nicolai86/things-cloud-sdk) (MIT). This is a re-implementation in
TypeScript, not a copy, built so that the same protocol can be used from JavaScript runtimes (notably Workers, which
cannot run the Go library). Credits are in [NOTICE](NOTICE).

Staying close to the Go SDK is enforced by tests, not by good intentions: `conformance/` runs the real Go SDK on
thousands of generated cases and the TypeScript tests must give the same answers
([conformance/README.md](conformance/README.md)).

## Quick start

```ts
import { ThingsClient, emptyState, syncState, allTasks, buildCreate } from "@vanpana/things-ts-sdk";

const client = new ThingsClient(process.env.THINGS_EMAIL!, process.env.THINGS_PASSWORD!);
const history = await client.ownHistory();

const state = emptyState();
await syncState(history, state);          // pages through the whole log, atomically
console.log(allTasks(state).filter((t) => t.status === 0 && !t.inTrash).length, "open tasks");

// Create an inbox task. Nothing is sent unless every check passes.
await history.write([buildCreate({ title: "Hello from TypeScript", note: "created via things-ts-sdk" })]);
```

Writes are deliberately narrow: only validated `Task7` creates and edits (plus tag, area and checklist-item creates and
deletes) are sent, only on the verified schema, and a create is never sent twice from one `History` object. See [docs/DECISIONS.md](docs/DECISIONS.md).

A write names the history head it was based on. A stale one is rejected by the server with HTTP 409 and writes
nothing; the SDK never retries a write.

Requirements: ESM, a runtime with `fetch`, and `lib` DOM types (or `@types/node`) for the declarations.

## Develop

```bash
npm install
npm test            # unit + conformance tests (no Go needed)
npm run typecheck
npm run build
npm run mutation    # deliberately breaks the code 71 ways; every one must make the tests fail (~10 min)
conformance/regenerate.sh   # only when the pinned Go SDK version changes (needs Go 1.25+)
```

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
