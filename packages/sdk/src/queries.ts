// Hierarchy queries, ported from the Go SDK's state/memory package. Results are sorted by `index`
// (ties keep log order, which makes them deterministic; the Go SDK leaves ties unspecified).
import { allAreas, allChecklistItems, allTags, allTasks, toTask } from "./entities.ts";
import type { State } from "./state.ts";
import { TaskStatus, TaskType } from "./types.ts";
import type { Area, ChecklistItem, Tag, Task } from "./types.ts";

export interface ListOptions { excludeCompleted?: boolean; excludeInTrash?: boolean }

const byIndex = <T extends { index: number }>(xs: T[]): T[] => xs.sort((a, b) => a.index - b.index);

export const projects = (s: State): Task[] => allTasks(s).filter((t) => t.type === TaskType.Project);

/** Tasks whose parent is `rootId` (a project, or a heading's project). */
export function subtasks(s: State, rootId: string, o: ListOptions = {}): Task[] {
  return byIndex(allTasks(s).filter((t) =>
    t.uuid !== rootId
    && !(o.excludeCompleted && t.status === TaskStatus.Completed)
    && !(o.excludeInTrash && t.inTrash)
    && t.parentTaskIds.includes(rootId)));
}

function hasArea(s: State, task: Task | undefined, depth = 0): boolean {
  if (!task || depth > 64) return false;
  if (task.areaIds.length !== 0) return true;
  return task.parentTaskIds.some((id) => { const p = s.tasks.get(id); return hasArea(s, p && toTask(id, p), depth + 1); });
}

/** Open, untrashed tasks in no area, directly or through their parent chain. */
export function tasksWithoutArea(s: State): Task[] {
  return byIndex(allTasks(s).filter((t) => t.status !== TaskStatus.Completed && !t.inTrash && !hasArea(s, t)));
}

export const areaByName = (s: State, name: string): Area | undefined => allAreas(s).find((a) => a.title === name);
export const projectByName = (s: State, name: string): Task | undefined => projects(s).find((t) => t.title === name);

export function tasksByArea(s: State, areaId: string, o: ListOptions = {}): Task[] {
  return byIndex(allTasks(s).filter((t) =>
    !(o.excludeCompleted && t.status === TaskStatus.Completed)
    && !(o.excludeInTrash && t.inTrash)
    && t.areaIds.includes(areaId)));
}

export function checklistItemsByTask(s: State, taskId: string, o: ListOptions = {}): ChecklistItem[] {
  return byIndex(allChecklistItems(s).filter((c) => !(o.excludeCompleted && c.status === TaskStatus.Completed) && c.taskIds.includes(taskId)));
}

export const headings = (s: State, projectId: string): Task[] =>
  byIndex(allTasks(s).filter((t) => t.type === TaskType.Heading && t.parentTaskIds.includes(projectId)));

export function tasksByHeading(s: State, headingId: string, o: ListOptions = {}): Task[] {
  return byIndex(allTasks(s).filter((t) =>
    t.type === TaskType.Task
    && !(o.excludeCompleted && t.status === TaskStatus.Completed)
    && !(o.excludeInTrash && t.inTrash)
    && t.actionGroupIds.includes(headingId)));
}

/** Child tags of `rootId`, sorted by shorthand. */
export const subTags = (s: State, rootId: string): Tag[] =>
  allTags(s).filter((t) => t.uuid !== rootId && t.parentTagIds.includes(rootId)).sort((a, b) => (a.shortHand < b.shortHand ? -1 : a.shortHand > b.shortHand ? 1 : 0));
