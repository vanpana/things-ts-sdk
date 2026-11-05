# things-ts-worker

Cloudflare Worker + Durable Object that keeps one Things account's state warm and exposes it as allow-listed tools.
Private package (not published). Runs on the Workers Free plan (SQLite-backed Durable Object).

## Layout

- `src/index.ts`: Worker entry. Refuses everything without `Authorization: Bearer <INTERNAL_TOKEN>` (the private layer in
  front does OAuth, owner checks and rate limits), then forwards to the account's Durable Object.
- `src/account.ts`: the `ThingsAccount` Durable Object. Persisted state, incremental sync, serialised verified writes,
  journal, kill switch, nightly drift check and weekly canary via one self-re-arming alarm.
- `src/store.ts`: SQLite persistence (`entity`, `meta`, `journal`); after a sync only changed entities are written.
- `src/tools.ts`: the tools (`status`, `get_task`, `list_open_tasks`, `create_task`, `edit_task`, `add_checklist_item`),
  transport-agnostic, inputs validated at the boundary. No Inbox / Today / Upcoming views yet (not verified).
- `src/canary.ts`: the canary write sequence. `src/probe.ts` + `scripts/run-probe.ts`: SDK-in-workerd probe.

## Calling a tool

```
curl -X POST "$URL/tool" -H "Authorization: Bearer $INTERNAL_TOKEN" -H "content-type: application/json" \
  -d '{"name":"list_open_tasks","args":{"limit":5}}'
```
`GET /tools` lists the tools and their input schemas. The body takes only `name` and `args`.

## Run the tests

```
npm run probe:mock     # the SDK inside workerd against a fake Things server
npm run do:mock        # the Durable Object: sync, persistence across restart, writes, kill switch, alarm (~15 s)
npm run probe:live -- task other   # your own account; needs THINGS_EMAIL / THINGS_PASSWORD
```

## Configuration

Secrets: `THINGS_EMAIL`, `THINGS_PASSWORD`, `INTERNAL_TOKEN` (16+ characters). Optional: `THINGS_TIME_ZONE` (default UTC; defines
"today"), `SYNC_STALE_MS` (default 10000), `CANARY=off` (disable the weekly canary write). The Durable Object config is
`wrangler.account.jsonc`; `wrangler.jsonc` is the probe.
