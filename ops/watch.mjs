// Protocol watch. Cultured Code does not announce protocol changes, so the earliest signals are a new Things release
// and new commits in the reference Go SDK. This compares both with ops/baseline.json and exits 1 when something moved.
// After a human has re-run the canary and the conformance suite, update ops/baseline.json.
//   node ops/watch.mjs            prints the report
import { readFileSync } from "node:fs";

/** @returns {string[]} one line per difference */
export function compare(baseline, current) {
  const out = [];
  if (current.macVersion !== baseline.macApp.version) out.push(`Things for Mac: ${baseline.macApp.version} -> ${current.macVersion}`);
  if (current.iosVersion !== baseline.iosApp.version) out.push(`Things for iOS: ${baseline.iosApp.version} -> ${current.iosVersion}`);
  if (current.upstreamRelease !== baseline.upstream.release) out.push(`Go SDK release: ${baseline.upstream.release} -> ${current.upstreamRelease}`);
  if (current.upstreamCommits.length > 0) out.push(`Go SDK has ${current.upstreamCommits.length} new commit(s) on the default branch: ${current.upstreamCommits.slice(0, 8).join("; ")}`);
  return out;
}

async function json(url) {
  const res = await fetch(url, { headers: { "User-Agent": "things-ts-sdk-watch", Accept: "application/json", ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return res.json();
}

export async function fetchCurrent(baseline) {
  const lookup = async (id, entity) => (await json(`https://itunes.apple.com/lookup?id=${id}&country=us${entity ? `&entity=${entity}` : ""}`)).results[0]?.version;
  const [macVersion, iosVersion, releases, commits] = await Promise.all([
    lookup(baseline.macApp.id, "macSoftware"),
    lookup(baseline.iosApp.id),
    json(`https://api.github.com/repos/${baseline.upstream.repo}/releases?per_page=1`),
    json(`https://api.github.com/repos/${baseline.upstream.repo}/commits?per_page=30`),
  ]);
  if (!macVersion || !iosVersion) throw new Error("App Store lookup returned no version");
  const seen = commits.findIndex((c) => c.sha === baseline.upstream.commit);
  const fresh = (seen === -1 ? commits : commits.slice(0, seen)).map((c) => `${c.sha.slice(0, 7)} ${c.commit.message.split("\n")[0].slice(0, 80)}`);
  return { macVersion, iosVersion, upstreamRelease: releases[0]?.tag_name ?? baseline.upstream.release, upstreamCommits: fresh };
}

if (import.meta.main) {
  const baseline = JSON.parse(readFileSync(new URL("./baseline.json", import.meta.url), "utf8"));
  // Exit codes: 0 no change, 1 something changed, 2 the check itself failed (not a protocol signal).
  try {
    const diff = compare(baseline, await fetchCurrent(baseline));
    if (diff.length === 0) console.log("no change since the baseline");
    else { console.log(diff.map((d) => `- ${d}`).join("\n")); process.exitCode = 1; }
  } catch (e) {
    console.error(`watch failed: ${e.message}`);
    process.exitCode = 2;
  }
}
