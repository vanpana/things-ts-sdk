// HTTP client. Fetch only: no Node APIs, so it runs in Workers, Deno, Bun and browsers (CORS permitting).
import { ThingsError, ThingsHttpError, ThingsNetworkError, UnauthorizedError } from "./errors.ts";
import { History } from "./history.ts";
import { pathSegment, serverIndex } from "./path.ts";

export const API_ENDPOINT = "https://cloud.culturedcode.com";
export const THINGS_USER_AGENT = "ThingsMac/32209501";

/** The device description Things sends in the `Things-Client-Info` header. */
export interface ClientInfo {
  dm: string; lr: string; nf: boolean; nk: boolean; nn: string; nv: string; on: string; ov: string; pl: string; ul: string;
}

export const DEFAULT_CLIENT_INFO: Readonly<ClientInfo> = Object.freeze({
  dm: "MacBookPro18,3", lr: "US", nf: true, nk: true, nn: "ThingsMac", nv: "32209501",
  on: "macOS", ov: "15.7.3", pl: "en-US", ul: "en-Latn-US",
});

/** Paths contain the account email and the history key (a credential): keep them out of messages and logs. */
function redactPath(path: string): string {
  return path.replace(/\/account\/[^/]+/, "/account/<email>").replace(/\/history\/[^/]+/, "/history/<key>").replace(/\/own-history-keys\/[^/]+/, "/own-history-keys/<key>");
}

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  /** Defaults to https://cloud.culturedcode.com. */
  endpoint?: string;
  /** Defaults to the global `fetch`. */
  fetch?: FetchLike;
  clientInfo?: Partial<ClientInfo>;
  userAgent?: string;
  /** Per-request timeout in milliseconds. Default 60000; 0 disables. */
  timeoutMs?: number;
  /** Permit a non-https endpoint (tests, local mocks). The password is sent in a header: never enable this for the real service. */
  allowInsecure?: boolean;
}

export type AccountStatus = "SYAccountStatusActive" | (string & {});

export interface VerifyResponse {
  "SLA-version-accepted": string;
  issues: unknown;
  email: string;
  "maildrop-email": string;
  status: AccountStatus;
  "history-key": string;
}

export interface AppInstanceRequest {
  appInstanceId: string;
  historyKey: string;
  apnsToken: string;
  appId: string;
  dev: boolean;
}

/** Internal request description shared by the client and History. */
export interface RequestSpec {
  method: "GET" | "POST" | "PUT" | "DELETE";
  path: string;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: string;
  authorized?: boolean;
}

export class ThingsClient {
  readonly email: string;
  readonly endpoint: string;
  readonly clientInfo: ClientInfo;
  readonly userAgent: string;
  // A true private field: it does not show up in console.log(client), JSON.stringify or structured clones.
  readonly #password: string;
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(email: string, password: string, options: ClientOptions = {}) {
    this.email = email;
    // A header value with control characters or non-Latin-1 characters makes the runtime throw an error that quotes it.
    if (typeof password !== "string" || /[^\x20-\x7e\xa0-\xff]/.test(password)) {
      throw new ThingsError("the password contains characters that cannot be sent in an HTTP header (control characters, or outside Latin-1)");
    }
    this.#password = password;
    let url: URL;
    try { url = new URL(options.endpoint ?? API_ENDPOINT); } catch (e) { throw new ThingsError("invalid endpoint", { cause: e }); }
    if (url.protocol !== "https:" && !options.allowInsecure) {
      throw new ThingsError("refusing a non-https endpoint: the password is sent as a header (pass allowInsecure for tests)");
    }
    if (url.username || url.password) throw new ThingsError("the endpoint must not contain credentials");
    this.endpoint = url.origin + url.pathname.replace(/\/+$/, "");
    this.clientInfo = { ...DEFAULT_CLIENT_INFO, ...options.clientInfo };
    this.userAgent = options.userAgent ?? THINGS_USER_AGENT;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 60_000;
  }

  /** @internal Sends a request with the common Things headers. The password never leaves this method. */
  async request(spec: RequestSpec): Promise<Response> {
    // Go's url.Values.Encode sorts keys; do the same so requests are byte-identical to the reference client.
    const query = spec.query ? "?" + new URLSearchParams(Object.entries(spec.query).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))).toString() : "";
    const headers: Record<string, string> = {
      "User-Agent": this.userAgent,
      Accept: "application/json",
      "Accept-Charset": "UTF-8",
      "Accept-Language": "en-US,en;q=0.9",
      "Things-Client-Info": btoa(JSON.stringify(this.clientInfo)),
      ...spec.headers,
    };
    if (spec.method !== "GET" && spec.method !== "DELETE") {
      headers["Content-Type"] = "application/json; charset=UTF-8";
      headers["Content-Encoding"] = "UTF-8";
    }
    if (spec.authorized) headers["Authorization"] = `Password ${this.#password}`;
    // A redirect would re-send the request (and possibly the password) somewhere we did not choose. "error" is not
    // implemented by Cloudflare Workers, so ask for the redirect response itself and refuse it below.
    const init: RequestInit = { method: spec.method, headers, redirect: "manual" };
    if (spec.body !== undefined) init.body = spec.body;
    if (this.timeoutMs > 0) init.signal = AbortSignal.timeout(this.timeoutMs);
    let res: Response;
    try { res = await this.fetchImpl(this.endpoint + spec.path + query, init); }
    catch (e) { throw new ThingsNetworkError(`${spec.method} ${redactPath(spec.path)} failed: ${(e as Error)?.name ?? "error"}`, spec.authorized ? {} : { cause: e }); }
    if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") {
      await res.body?.cancel();
      throw new ThingsNetworkError(`${spec.method} ${redactPath(spec.path)} was redirected: refusing to follow it`);
    }
    return res;
  }

  /** @internal */
  async json<T>(spec: RequestSpec, okStatus = 200): Promise<T> {
    const res = await this.request(spec);
    if (res.status !== okStatus) {
      await res.body?.cancel();
      if (res.status === 401) throw new UnauthorizedError(res.statusText);
      throw new ThingsHttpError(res.status, res.statusText);
    }
    try { return (await res.json()) as T; }
    catch (e) { throw new ThingsError(`invalid JSON in response to ${spec.method} ${redactPath(spec.path)}`, { cause: e }); }
  }

  /** Checks the credentials and returns the account, including the history key. */
  verify(): Promise<VerifyResponse> {
    return this.json<VerifyResponse>({ method: "GET", path: `/version/1/account/${pathSegment(this.email, "email")}`, authorized: true });
  }

  /** The account's own history, fetched via {@link verify}. */
  async ownHistory(): Promise<History> {
    const v = await this.verify();
    if (typeof v["history-key"] !== "string") throw new ThingsError("invalid history-key in server response");
    return new History(this, v["history-key"]);
  }

  /** A history object for a known id, without any network call. */
  historyWithId(id: string): History { return new History(this, id); }

  /** Requests a specific history, including its current head and schema version. */
  async history(id: string): Promise<History> {
    const v = await this.json<{ "latest-schema-version": number; "latest-total-content-size": number; "latest-server-index": number }>(
      { method: "GET", path: `/version/1/history/${pathSegment(id, "history id")}` },
    );
    const h = new History(this, id);
    h.latestServerIndex = serverIndex(v["latest-server-index"], "latest-server-index");
    h.latestSchemaVersion = serverIndex(v["latest-schema-version"], "latest-schema-version");
    h.latestTotalContentSize = serverIndex(v["latest-total-content-size"], "latest-total-content-size");
    return h;
  }

  /** All history keys of the account. */
  async histories(): Promise<History[]> {
    const keys = await this.json<string[]>({ method: "GET", path: `/version/1/account/${pathSegment(this.email, "email")}/own-history-keys`, authorized: true });
    if (!Array.isArray(keys) || !keys.every((k) => typeof k === "string")) throw new ThingsError("decoding history keys: expected an array of strings");
    return keys.map((k) => new History(this, k));
  }

  /** Requests a new, empty history key. Not needed for normal use. */
  async createHistory(): Promise<History> {
    const v = await this.json<{ "new-history-key": string }>({ method: "POST", path: `/version/1/account/${pathSegment(this.email, "email")}/own-history-keys`, authorized: true });
    if (typeof v["new-history-key"] !== "string") throw new ThingsError("invalid new-history-key in server response");
    return new History(this, v["new-history-key"]);
  }

  /** Registers a device for push notifications. */
  async registerAppInstance(req: AppInstanceRequest): Promise<void> {
    const res = await this.request({
      method: "PUT",
      path: `/version/1/app-instance/${pathSegment(req.appInstanceId, "app instance id")}`,
      body: JSON.stringify({ "history-key": req.historyKey, "apns-token": req.apnsToken, "app-id": req.appId, dev: req.dev }),
    });
    await res.body?.cancel();
    if (res.status !== 200) throw new ThingsHttpError(res.status, res.statusText);
  }
}
