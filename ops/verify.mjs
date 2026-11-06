// Re-verify after the protocol watch fires: compare with ops/baseline.json, then run the drift check and the canary
// on your own deployed Worker. The canary writes one throwaway task (zz-sdk-canary ...) and trashes it.
//   THINGS_WORKER_URL=https://... INTERNAL_TOKEN=xxx node ops/verify.mjs
//   ... node ops/verify.mjs --update-baseline   also rewrites ops/baseline.json when every check passed
// Conformance (needs Go 1.25+) is separate: npm run test:conformance
import { readFileSync, writeFileSync } from "node:fs";
import { compare, fetchCurrent } from "./watch.mjs";

const baselineUrl = new URL("./baseline.json", import.meta.url);

async function runCheck(base, token, which) {
  const res = await fetch(`${base}/admin/run-check?which=${which}`, { method: "POST", headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`${which}: HTTP ${res.status}`);
  return (await res.json()).result;
}

function report(name, r) {
  const good = r.ok === true && !r.inconclusive;
  console.log(`${good ? "PASS" : "FAIL"}  ${name}${r.summary ? `: ${r.summary}` : ""}`);
  if (!good) console.log(`      ${JSON.stringify(r).slice(0, 400)}`);
  return good;
}

if (import.meta.main) {
  const base = process.env.THINGS_WORKER_URL?.replace(/\/$/, "");
  const token = process.env.INTERNAL_TOKEN;
  if (!base || !token) {
    console.error("set THINGS_WORKER_URL and INTERNAL_TOKEN");
    process.exit(2);
  }
  try {
    const baseline = JSON.parse(readFileSync(baselineUrl, "utf8"));
    const current = await fetchCurrent(baseline);
    const diff = compare(baseline, current);
    console.log(diff.length ? `Moved since the baseline:\n${diff.map((d) => `  - ${d}`).join("\n")}\n` : "Nothing moved since the baseline.\n");

    const results = [report("drift check", await runCheck(base, token, "drift")), report("canary", await runCheck(base, token, "canary"))];
    if (!results.every(Boolean)) { console.log("\nNot safe to update the baseline."); process.exit(1); }

    if (process.argv.includes("--update-baseline")) {
      // edit the text, not the parsed JSON, so the file keeps its layout
      const text = readFileSync(baselineUrl, "utf8")
        .replace(/("macApp":[^}]*"version": ")[^"]*/, `$1${current.macVersion}`)
        .replace(/("iosApp":[^}]*"version": ")[^"]*/, `$1${current.iosVersion}`);
      writeFileSync(baselineUrl, text);
      console.log("\nops/baseline.json updated (app versions only). Upstream release and commit are unchanged; edit them by hand if they moved.");
    } else {
      console.log("\nAll passed. Re-run with --update-baseline to record the new versions.");
    }
  } catch (e) {
    console.error(`verify failed: ${e.message}`);
    process.exit(2);
  }
}
