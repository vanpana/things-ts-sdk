// Differential tests against the Go SDK (v0.6.0). Expected values come from conformance/fixtures, produced by
// conformance/go-oracle running the real Go code on conformance/cases.
import test from "node:test";
import assert from "node:assert/strict";
import { applyPatches, applyPatchesChecked, computeFirstScheduledDate, decodeUuid, encodeLegacyIdentifier, encodeUuid, isNeverending, isValidId, nextScheduledDate } from "../src/index.ts";
import type { RepeaterConfiguration } from "../src/index.ts";
import { fixture } from "./helpers.ts";

const hex = (b: Uint8Array): string => Buffer.from(b).toString("hex");
const fromHex = (h: string): Uint8Array => Uint8Array.from(Buffer.from(h, "hex"));

test("base58: every operation matches the Go SDK", () => {
  const { cases, expected } = fixture<{ op: string; input: string }>("base58");
  assert.equal(cases.length, expected.length);
  const counts: Record<string, number> = {};
  for (const [i, c] of cases.entries()) {
    const want = expected[i];
    counts[c.op] = (counts[c.op] ?? 0) + 1;
    const where = `${c.op} ${JSON.stringify(c.input)}`;
    switch (c.op) {
      case "encode": assert.equal(encodeUuid(fromHex(c.input)), want.output, where); break;
      case "decode": {
        let got: string | null = null;
        try { got = hex(decodeUuid(c.input)); } catch { /* invalid */ }
        assert.equal(got !== null, want.ok, where);
        if (want.ok) assert.equal(got, want.output, where);
        break;
      }
      case "validate": assert.equal(isValidId(c.input), want.ok, where); break;
      case "legacy": assert.equal(encodeLegacyIdentifier(c.input), want.output, where); break;
    }
  }
  assert.ok(Object.values(counts).every((n) => n > 50), JSON.stringify(counts));
});

test("notes: byte-offset patches match the Go SDK", () => {
  const { cases, expected } = fixture<{ original: string; patches: { r: string; p: number; l: number }[] }>("notes");
  let checkedOk = 0;
  let checkedRejected = 0;
  for (const [i, c] of cases.entries()) {
    const want = expected[i];
    const patches = c.patches.map((p) => ({ ...p, ch: 0 }));
    let checked: string | null = null;
    try { checked = applyPatchesChecked(c.original, patches); } catch { /* rejected */ }
    assert.equal(checked === null, Boolean(want.checkedError), `checked verdict #${i} ${JSON.stringify(c)}`);
    if (checked !== null) {
      assert.equal(checked, want.checked, `checked #${i}`);
      assert.equal(applyPatches(c.original, patches), want.unchecked, `unchecked #${i}`);
      checkedOk++;
    } else checkedRejected++;
  }
  assert.ok(checkedOk > 100 && checkedRejected > 10, `${checkedOk} ok, ${checkedRejected} rejected`);
});

test("repeat: first and next dates match the Go SDK", () => {
  const { cases, expected } = fixture<{ config: RepeaterConfiguration; first: number | null; repeats: number[] }>("repeat");
  let compared = 0;
  for (const [i, c] of cases.entries()) {
    const want = expected[i];
    assert.equal(isNeverending(c.config), want.neverending, `neverending #${i}`);
    if (want.panic) continue;
    if (c.first !== null) {
      const got = computeFirstScheduledDate(c.config, new Date(c.first * 1000));
      assert.equal(got ? got.getTime() / 1000 : null, want.first, `first #${i} ${JSON.stringify(c.config)}`);
    }
    const next = c.repeats.map((n) => { const d = nextScheduledDate(c.config, n); return d ? d.getTime() / 1000 : null; });
    assert.deepEqual(next, want.next, `next #${i} ${JSON.stringify(c.config)}`);
    compared++;
  }
  assert.ok(compared > 80, `${compared} compared`);
});
