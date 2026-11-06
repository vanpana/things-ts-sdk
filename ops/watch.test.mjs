import test from "node:test";
import assert from "node:assert/strict";
import { compare } from "./watch.mjs";

const baseline = { macApp: { version: "3.24.1" }, iosApp: { version: "3.25.2" }, upstream: { release: "v0.6.0" } };
const same = { macVersion: "3.24.1", iosVersion: "3.25.2", upstreamRelease: "v0.6.0", upstreamCommits: [] };

test("no difference, no report", () => assert.deepEqual(compare(baseline, same), []));
test("each moving part is reported", () => {
  const out = compare(baseline, { macVersion: "3.25.0", iosVersion: "3.26.0", upstreamRelease: "v0.7.0", upstreamCommits: ["abc1234 fix: protocol"] });
  assert.equal(out.length, 4);
  assert.match(out[0], /3\.24\.1 -> 3\.25\.0/);
});
