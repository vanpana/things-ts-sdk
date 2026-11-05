// The canary: a fixed create -> edit -> complete -> trash sequence on a clearly labelled throwaway task, run through
// the same code path as real writes. Any refusal, HTTP error or read-back mismatch is a failed step. Callers switch
// writes off when `ok` is false.
import { buildCreate, buildEdit, KNOWN_SCHEMA, preflightFromState, syncState } from "../../sdk/src/index.ts";
import type { History, State } from "../../sdk/src/index.ts";

export type Step = { step: string; ok: boolean; detail?: string };
export interface CanaryResult { ok: boolean; steps: Step[]; taskId?: string }

export interface CanaryDeps {
  history: History;
  state: State;
  /** Syncs a fresh state from index 0 (used for the final independent read-back). */
  reconnect: () => Promise<{ state: State }>;
  timeZone?: string;
  retryBaseMs?: number;
}

export async function runCanary(deps: CanaryDeps): Promise<CanaryResult> {
  const steps: Step[] = [];
  const rec = (step: string, ok: boolean, detail?: string): void => { steps.push(detail === undefined ? { step, ok } : { step, ok, detail }); };
  const { history, state } = deps;
  const sync = (): Promise<unknown> => syncState(history, state, { retryBaseMs: deps.retryBaseMs ?? 200 });
  const ctx = { timeZone: deps.timeZone ?? "UTC" };
  let taskId: string | undefined;
  try {
    rec("sync + schema", history.latestSchemaVersion === KNOWN_SCHEMA, `schema ${history.latestSchemaVersion}`);
    const label = `zz-sdk-probe ${new Date().toISOString()}`;
    const create = buildCreate({ title: label, note: "created by the things-ts-sdk canary; safe to delete" }, ctx);
    taskId = create.uuid;
    await history.write([create]);
    await sync();
    rec("create", state.tasks.get(create.uuid)?.fields["tt"] === label);

    const edit = async (name: string, o: Parameters<typeof buildEdit>[2], check: (f: Record<string, unknown>) => boolean): Promise<void> => {
      await history.write([buildEdit(state, create.uuid, o, ctx)], { preflight: (t) => preflightFromState(state, t) });
      await sync();
      rec(name, check(state.tasks.get(create.uuid)?.fields ?? {}));
    };
    await edit("edit title + note", { title: label + " (edited)", note: "edited note ✓ ünïcode" }, (f) => f["tt"] === label + " (edited)");
    rec("note round trip (unicode)", state.tasks.get(create.uuid)?.note === "edited note ✓ ünïcode");
    await edit("complete", { complete: true }, (f) => f["ss"] === 3);
    await edit("trash", { trash: true }, (f) => f["tr"] === true);

    // A stale ancestor must be rejected with 409 and change nothing.
    try {
      await history.write([buildEdit(state, create.uuid, { restore: true }, ctx)], { preflight: () => Math.max(0, state.cursor - 1) });
      rec("stale ancestor rejected", false, "write unexpectedly succeeded");
    } catch (e) { rec("stale ancestor rejected", (e as { status?: number }).status === 409, `status ${(e as { status?: number }).status ?? (e as Error).name}`); }

    const after = (await deps.reconnect()).state.tasks.get(create.uuid)?.fields;
    rec("independent read-back: trashed + completed", after?.["tr"] === true && after?.["ss"] === 3);
  } catch (e) {
    rec("canary aborted", false, `${(e as Error).name}: ${(e as Error).message.slice(0, 160)}`);
    if (taskId) { // do not leave the throwaway task open in the account
      try {
        await sync();
        if (state.tasks.get(taskId)?.fields["tr"] !== true) {
          await history.write([buildEdit(state, taskId, { trash: true }, ctx)], { preflight: (t) => preflightFromState(state, t) });
        }
        rec("aborted canary task trashed", true);
      } catch (c) { rec("aborted canary task trashed", false, (c as Error).name); }
    }
  }
  const result: CanaryResult = { ok: steps.every((s) => s.ok), steps };
  if (taskId) result.taskId = taskId;
  return result;
}
