import { ThingsError } from "./errors.ts";

/**
 * Makes one value safe to put in a URL path segment (account email, history key, app-instance id) without changing
 * ordinary values: letters, digits, '@', '+', '-', '_', '.', non-ASCII all pass through exactly as the Go client sends
 * them. Characters that would end the path, start a query or fragment, or be rewritten by the URL parser are
 * percent-encoded, and dot-segments are refused.
 */
export function pathSegment(value: string, what: string): string {
  if (value === "" || value === "." || value === "..") throw new ThingsError(`invalid ${what}`);
  return value.replace(/[#?\/\\%\u0000- \u007f]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
}

/** A server-reported position in the log: a non-negative safe integer, or the response is rejected. */
export function serverIndex(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ThingsError(`invalid ${what} in server response`);
  return value;
}
