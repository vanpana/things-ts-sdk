// Worker entry: authenticates the caller with a shared secret and forwards to the account's Durable Object.
// This is not the public front door. The private layer in front (OAuth, owner check, rate limits) calls it with
// INTERNAL_TOKEN; without that secret configured, every request is refused.
export { ThingsAccount } from "./account.ts";
import type { Env } from "./account.ts";
import { describeTools } from "./tools.ts";

const MAX_BODY = 64 * 1024;
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Constant-time comparison of the presented bearer token with the secret. */
function tokenOk(header: string | null, secret: string | undefined): boolean {
  if (!secret || secret.length < 16 || !header?.startsWith("Bearer ")) return false;
  const a = new TextEncoder().encode(header.slice(7)), b = new TextEncoder().encode(secret);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (!tokenOk(req.headers.get("authorization"), env.INTERNAL_TOKEN)) return json(401, { ok: false, error: { name: "Unauthorized", message: "unauthorized" } });
    const { pathname } = new URL(req.url);
    if (req.method === "GET" && pathname === "/tools") return json(200, { ok: true, result: describeTools() });
    const forwarded = pathname === "/tool" || pathname.startsWith("/admin/") || (env.TEST_ROUTES === "1" && pathname.startsWith("/__test/"));
    if (!forwarded) return json(404, { ok: false, error: { name: "NotFound", message: "no such route" } });
    if (req.method === "POST" && Number(req.headers.get("content-length") ?? 0) > MAX_BODY) return json(413, { ok: false, error: { name: "TooLarge", message: "request too large" } });
    if (!env.THINGS_EMAIL) return json(503, { ok: false, error: { name: "NotConfigured", message: "credentials are not configured" } });
    const stub = env.ACCOUNT.get(env.ACCOUNT.idFromName(env.THINGS_EMAIL));
    return stub.fetch(req);
  },
};
