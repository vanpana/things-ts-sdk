# things-ts-worker

Cloudflare Worker + Durable Object that keeps one Things account's state warm and exposes it as allow-listed tools.
Private package (not published). Runs on the Workers Free plan (SQLite-backed Durable Object).

## Layout

- `src/index.ts`: Worker entry. Refuses everything without `Authorization: Bearer <INTERNAL_TOKEN>` (the private layer in
  front does OAuth, owner checks and rate limits), then forwards to the account's Durable Object.
- `src/account.ts`: the `ThingsAccount` Durable Object. Persisted state, incremental sync, serialised verified writes,
  journal, kill switch, nightly drift check and weekly canary via one self-re-arming alarm.
- `src/store.ts`: SQLite persistence (`entity`, `meta`, `journal`); after a sync only changed entities are written.
- `src/tools.ts`: the tools (`status`, `get_task`, `list_open_tasks`, `list_view`, `create_task`, `edit_task`,
  `add_checklist_item`), transport-agnostic, inputs validated at the boundary. `list_view` serves Inbox, Today, Upcoming,
  Anytime, Someday, Logbook and Trash (rules in `packages/sdk/src/views.ts`; Today and Upcoming need `THINGS_TIME_ZONE`).
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
"today"), `SYNC_STALE_MS` (default 10000), `CANARY=off` (disable the weekly canary write, which is on by default). The Durable Object config is
`wrangler.account.jsonc`; `wrangler.jsonc` is the probe.

## The `INTERNAL_TOKEN`

Every route requires `Authorization: Bearer <INTERNAL_TOKEN>`. If the secret is unset or shorter than 16
characters the Worker refuses everything, so deleting it switches the Worker off.

Generate one (any random string of 16+ characters works):

```
openssl rand -base64 40 | sed -E 's/(.)\1+/\1/g'    # base64, with repeated characters collapsed
npx wrangler secret put INTERNAL_TOKEN -c wrangler.account.jsonc
```

Keep it in a password manager; Cloudflare never shows a secret again, so a lost token is simply replaced. Pass it to
`curl` through a shell variable (`export INTERNAL_TOKEN=...`), not on the command line or in a chat.

### Short-lived tokens for an agent

An AI agent that has `wrangler` access to your account can operate the Worker without you handing it a long-lived
secret: it generates a token, sets it, does the task, and removes it.

```
TOKEN=$(openssl rand -base64 40 | sed -E 's/(.)\1+/\1/g')
printf %s "$TOKEN" | npx wrangler secret put INTERNAL_TOKEN -c wrangler.account.jsonc
# ... call /tool and /admin/* with it ...
npx wrangler secret delete INTERNAL_TOKEN -c wrangler.account.jsonc    # asks to confirm; the Worker then refuses everything
```

This replaces whatever token was set before, so only use it on a Worker that nothing else depends on at that moment
(for example before a private layer is connected), and give the agent only the operations you want it to perform.
