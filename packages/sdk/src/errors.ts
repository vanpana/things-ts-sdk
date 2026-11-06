/** Base class for every error this SDK throws on purpose. */
export class ThingsError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** The server answered with an unexpected HTTP status. 409 on a commit means a stale ancestor index. */
export class ThingsHttpError extends ThingsError {
  readonly status: number;
  readonly statusText: string;
  constructor(status: number, statusText: string, message?: string) {
    super(message ?? `http response code: ${status} ${statusText}`.trim());
    this.status = status;
    this.statusText = statusText;
  }
}

/** HTTP 401: wrong email or password. */
export class UnauthorizedError extends ThingsHttpError {
  constructor(statusText = "Unauthorized") {
    super(401, statusText, "unauthorized");
  }
}

/** A write was refused locally, before anything was sent. */
export class WriteRefusedError extends ThingsError {}

/** An identifier is not a canonical Things Base58 identifier. */
export class InvalidIdentifierError extends ThingsError {}

/** A note value or patch could not be applied. */
export class NoteError extends ThingsError {}

/**
 * Replay met a task kind this SDK does not understand. Continuing would build incomplete state,
 * so the batch is rejected without changing anything. `serverIndex` is -1 when unknown.
 */
export class UnsupportedTaskKindError extends ThingsError {
  readonly kind: string;
  readonly serverIndex: number;
  constructor(kind: string, serverIndex = -1) {
    const shown = diagnosticTaskKind(kind);
    super(
      serverIndex >= 0
        ? `incomplete sync: unsupported task kind ${shown} at server index ${serverIndex}`
        : `incomplete sync: unsupported task kind ${shown}`,
    );
    this.kind = shown;
    this.serverIndex = serverIndex;
  }
}

/** Strict mode only: an item kind outside the supported set was found. */
export class UnknownKindError extends ThingsError {
  readonly kind: string;
  constructor(kind: string) {
    super(`unknown item kind ${printable(kind)}`);
    this.kind = printable(kind);
  }
}

/** A task payload in the log is malformed (not an object, bad note, ...). */
export class MalformedItemError extends ThingsError {}

/** Only prints the protocol's `Task<number>` shape; arbitrary server text never reaches logs. */
export function diagnosticTaskKind(kind: string): string {
  const suffix = kind.startsWith("Task") ? kind.slice(4) : kind;
  if (suffix === kind || suffix === "" || suffix.length > 12 || !/^[0-9]+$/.test(suffix)) return "Task*";
  return kind;
}

function printable(kind: string): string {
  return /^[A-Za-z0-9]{1,24}$/.test(kind) ? kind : "<unprintable>";
}

/** The request could not be completed (network failure, timeout, redirect). `cause` has the platform error. */
export class ThingsNetworkError extends ThingsError {}

/**
 * A commit was sent but its outcome is unknown (timeout, dropped connection, unreadable response). It may have been
 * applied. Do not resend blindly: re-sync and look for the item's uuid in the log first.
 */
export class CommitOutcomeUnknownError extends ThingsNetworkError {}
