// The allow-listed tools. Transport-agnostic: no MCP wire protocol and no authentication here (the private layer in
// front of this Worker does both). Every input is validated at this boundary; the SDK validates again before writing.
//
// Views such as Inbox / Today / Upcoming are deliberately absent: their semantics are not verified against the Things
// database yet, so `list_open_tasks` only offers plain filters.

import {
  allTags, areaByName, buildAddChecklistItem, buildCreate, buildEdit, checklistItemsByTask, getArea, getTag, getTask,
  isValidId, projectByName, TaskStatus, TaskType,
} from "../../sdk/src/index.ts";
import type { State, Task, When, WriteItem } from "../../sdk/src/index.ts";

/** An error whose message is safe to show to the caller. */
export class ToolError extends Error {
  readonly status: number;
  constructor(status: number, message: string) { super(message); this.name = "ToolError"; this.status = status; }
}

export interface ToolContext {
  /** IANA zone that defines "today" for scheduling. */
  timeZone: string;
  /** The state, synced if it is stale. `stale` is true when the sync failed and the last good state is served. */
  read(): Promise<{ state: State; stale: boolean }>;
  /** Runs one serialised, read-back-verified write. `tool` goes in the journal. */
  write(tool: string, build: (state: State) => WriteItem[]): Promise<{ ids: string[] }>;
  status(): Promise<unknown>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

// ---- input validation ------------------------------------------------------------------------------------------------

const MAX_TITLE = 1000;
const MAX_NOTE = 20_000;
const MAX_NAME = 200;
const MAX_LIMIT = 200;

type Args = Record<string, unknown>;
const bad = (message: string): never => { throw new ToolError(400, message); };

function only(args: Args, allowed: readonly string[]): void {
  for (const k of Object.keys(args)) if (!allowed.includes(k)) bad(`unknown argument ${JSON.stringify(k.slice(0, 40))}`);
}
function text(args: Args, key: string, max: number, required: boolean): string | undefined {
  const v = args[key];
  if (v === undefined) { if (required) bad(`${key} is required`); return undefined; }
  if (typeof v !== "string" || !v.isWellFormed()) return bad(`${key} must be a string`);
  if (required && v.trim() === "") bad(`${key} must not be empty`);
  if (v.length > max) bad(`${key} is longer than ${max} characters`);
  return v;
}
function id(args: Args, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !isValidId(v)) return bad(`${key} must be a Things identifier`);
  return v;
}
function flag(args: Args, key: string): boolean | undefined {
  const v = args[key];
  if (v === undefined) return undefined;
  if (typeof v !== "boolean") return bad(`${key} must be true or false`);
  return v;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

function summary(state: State, t: Task): Record<string, unknown> {
  return {
    id: t.uuid, title: t.title, type: t.type, status: t.status, trashed: t.inTrash,
    schedule: t.schedule, scheduledDate: iso(t.scheduledDate), deadline: iso(t.deadlineDate),
    areaIds: t.areaIds, projectIds: t.parentTaskIds, tagIds: t.tagIds, hasNote: t.note !== "",
    checklistItems: checklistItemsByTask(state, t.uuid).length,
  };
}

// ---- tools ----------------------------------------------------------------------------------------------------------

const idSchema = { type: "string", description: "A Things identifier (22 characters, base58)." };

export const TOOLS: readonly ToolDefinition[] = [
  {
    name: "status",
    description: "Health of the connection: sync position, schema version, counts, whether writes are switched off and why, and the last drift and canary checks.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    handler: async (args, ctx) => { only(args, []); return ctx.status(); },
  },
  {
    name: "get_task",
    description: "One task, project or heading by id, with its note, checklist, tags, area and project.",
    inputSchema: { type: "object", properties: { id: idSchema }, required: ["id"], additionalProperties: false },
    handler: async (args, ctx) => {
      only(args, ["id"]);
      const taskId = id(args, "id");
      const { state, stale } = await ctx.read();
      const t = getTask(state, taskId);
      if (!t) throw new ToolError(404, "task not found");
      return {
        stale,
        task: {
          ...summary(state, t), note: t.note, completedAt: iso(t.completionDate), createdAt: iso(t.creationDate), modifiedAt: iso(t.modificationDate),
          tags: t.tagIds.map((x) => getTag(state, x)?.title).filter((x): x is string => x !== undefined),
          areas: t.areaIds.map((x) => getArea(state, x)?.title).filter((x): x is string => x !== undefined),
          projects: t.parentTaskIds.map((x) => getTask(state, x)?.title).filter((x): x is string => x !== undefined),
          checklist: checklistItemsByTask(state, t.uuid).map((c) => ({ id: c.uuid, title: c.title, done: c.status === TaskStatus.Completed })),
        },
      };
    },
  },
  {
    name: "list_open_tasks",
    description: "Open (not completed, not trashed) tasks, optionally only those in an area, a project or with a tag, matched by exact name. Ordered as in Things. No Inbox / Today / Upcoming views yet.",
    inputSchema: {
      type: "object",
      properties: {
        area: { type: "string", maxLength: MAX_NAME }, project: { type: "string", maxLength: MAX_NAME }, tag: { type: "string", maxLength: MAX_NAME },
        limit: { type: "integer", minimum: 1, maximum: MAX_LIMIT, default: 50 },
      },
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      only(args, ["area", "project", "tag", "limit"]);
      const area = text(args, "area", MAX_NAME, false), project = text(args, "project", MAX_NAME, false), tag = text(args, "tag", MAX_NAME, false);
      let limit = 50;
      if (args["limit"] !== undefined) {
        const l = args["limit"];
        if (typeof l !== "number" || !Number.isInteger(l) || l < 1 || l > MAX_LIMIT) bad(`limit must be an integer from 1 to ${MAX_LIMIT}`);
        limit = l as number;
      }
      const { state, stale } = await ctx.read();
      const areaId = area === undefined ? undefined : (areaByName(state, area)?.uuid ?? bad("unknown area"));
      const projectId = project === undefined ? undefined : (projectByName(state, project)?.uuid ?? bad("unknown project"));
      const tagId = tag === undefined ? undefined : (allTags(state).find((x) => x.title === tag)?.uuid ?? bad("unknown tag"));
      const open: Task[] = [];
      for (const e of state.tasks.keys()) {
        const t = getTask(state, e)!;
        if (t.type !== TaskType.Task || t.status !== TaskStatus.Pending || t.inTrash) continue;
        if (areaId && !t.areaIds.includes(areaId)) continue;
        if (projectId && !t.parentTaskIds.includes(projectId)) continue;
        if (tagId && !t.tagIds.includes(tagId)) continue;
        open.push(t);
      }
      open.sort((a, b) => a.index - b.index || (a.uuid < b.uuid ? -1 : 1));
      return { stale, total: open.length, truncated: open.length > limit, tasks: open.slice(0, limit).map((t) => summary(state, t)) };
    },
  },
  {
    name: "create_task",
    description: "Create a task. `when` is inbox (default), anytime, today or someday.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", minLength: 1, maxLength: MAX_TITLE }, note: { type: "string", maxLength: MAX_NOTE },
        when: { type: "string", enum: ["inbox", "anytime", "today", "someday"] },
      },
      required: ["title"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      only(args, ["title", "note", "when"]);
      const title = text(args, "title", MAX_TITLE, true)!;
      const note = text(args, "note", MAX_NOTE, false);
      const when = args["when"] as When | undefined;
      if (when !== undefined && when !== "inbox" && when !== "anytime" && when !== "today" && when !== "someday") bad("when must be inbox, anytime, today or someday");
      return ctx.write("create_task", () => [buildCreate({ title, ...(note !== undefined ? { note } : {}), ...(when ? { when } : {}) }, { timeZone: ctx.timeZone })]);
    },
  },
  {
    name: "edit_task",
    description: "Change an ordinary task: title, note, complete / reopen, trash / restore. Projects, headings and recurring tasks are refused.",
    inputSchema: {
      type: "object",
      properties: {
        id: idSchema, title: { type: "string", minLength: 1, maxLength: MAX_TITLE }, note: { type: "string", maxLength: MAX_NOTE },
        complete: { type: "boolean" }, reopen: { type: "boolean" }, trash: { type: "boolean" }, restore: { type: "boolean" },
      },
      required: ["id"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      only(args, ["id", "title", "note", "complete", "reopen", "trash", "restore"]);
      const taskId = id(args, "id");
      const title = text(args, "title", MAX_TITLE, false), note = text(args, "note", MAX_NOTE, false);
      if (title !== undefined && title.trim() === "") bad("title must not be empty");
      const complete = flag(args, "complete"), reopen = flag(args, "reopen"), trash = flag(args, "trash"), restore = flag(args, "restore");
      const edit = {
        ...(title !== undefined ? { title } : {}), ...(note !== undefined ? { note } : {}),
        ...(complete ? { complete } : {}), ...(reopen ? { reopen } : {}), ...(trash ? { trash } : {}), ...(restore ? { restore } : {}),
      };
      if (Object.keys(edit).length === 0) bad("nothing to change");
      return ctx.write("edit_task", (state) => [buildEdit(state, taskId, edit, { timeZone: ctx.timeZone })]);
    },
  },
  {
    name: "add_checklist_item",
    description: "Add an item to the checklist of an ordinary, open task.",
    inputSchema: {
      type: "object",
      properties: { task_id: idSchema, title: { type: "string", minLength: 1, maxLength: MAX_TITLE } },
      required: ["task_id", "title"],
      additionalProperties: false,
    },
    handler: async (args, ctx) => {
      only(args, ["task_id", "title"]);
      const taskId = id(args, "task_id");
      const title = text(args, "title", MAX_TITLE, true)!;
      return ctx.write("add_checklist_item", (state) => [buildAddChecklistItem(state, { taskId, title })]);
    },
  },
];

/** Names only, for the allow-list check. */
export const TOOL_NAMES: readonly string[] = TOOLS.map((t) => t.name);

export function describeTools(): { name: string; description: string; inputSchema: Record<string, unknown> }[] {
  return TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
}

export async function callTool(name: unknown, args: unknown, ctx: ToolContext): Promise<unknown> {
  const tool = typeof name === "string" ? TOOLS.find((t) => t.name === name) : undefined;
  if (!tool) throw new ToolError(404, "unknown tool");
  if (args === undefined) args = {};
  if (typeof args !== "object" || args === null || Array.isArray(args)) throw new ToolError(400, "arguments must be an object");
  return tool.handler(args as Args, ctx);
}

