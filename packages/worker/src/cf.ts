// The slice of the Cloudflare Durable Object API this package uses. Declared here so the package type-checks with the
// plain DOM + Node libs; the runtime provides the real objects.
export type SqlValue = string | number | null | ArrayBuffer;
export interface SqlCursor<T> extends Iterable<T> { toArray(): T[]; one(): T }
export interface SqlStorage { exec<T = Record<string, SqlValue>>(query: string, ...bindings: SqlValue[]): SqlCursor<T> }
export interface DurableObjectStorage {
  sql: SqlStorage;
  transactionSync<T>(fn: () => T): T;
  setAlarm(scheduledTime: number): Promise<void>;
  getAlarm(): Promise<number | null>;
}
export interface DurableObjectState {
  storage: DurableObjectStorage;
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}
export interface DurableObjectStub { fetch(request: Request): Promise<Response> }
export interface DurableObjectNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStub;
}
