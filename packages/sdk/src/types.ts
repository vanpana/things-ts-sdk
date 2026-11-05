// Wire-level and domain types. Field names on the wire are Things' own short keys (tt, ss, st, sr, ...).

/** What happened to an item. */
export const ItemAction = { Created: 0, Modified: 1, Deleted: 2 } as const;
export type ItemAction = (typeof ItemAction)[keyof typeof ItemAction];

/**
 * The start state, not the view. The view comes from `st` together with `sr`/`tir`:
 * Inbox = 0; Anytime = 1 without a date; Today = 1 with today's date; Someday = 2 without a date; Upcoming = 2 with a future date.
 */
export const TaskSchedule = { Inbox: 0, Anytime: 1, Someday: 2 } as const;
export type TaskSchedule = (typeof TaskSchedule)[keyof typeof TaskSchedule];

export const TaskStatus = { Pending: 0, Canceled: 2, Completed: 3 } as const;
export type TaskStatus = (typeof TaskStatus)[keyof typeof TaskStatus];

export const TaskType = { Task: 0, Project: 1, Heading: 2 } as const;
export type TaskType = (typeof TaskType)[keyof typeof TaskType];

/** Entity kinds seen on the wire. Newer kinds are the current generation; older ones appear in long histories. */
export const ItemKind = {
  ChecklistItem: "ChecklistItem",
  ChecklistItem2: "ChecklistItem2",
  ChecklistItem3: "ChecklistItem3",
  Task6: "Task6",
  Task7: "Task7",
  Task4: "Task4",
  Task3: "Task3",
  TaskPlain: "Task",
  /** Never write this kind: Things.app ignores Area2 creates and invents a duplicate area. */
  Area2: "Area2",
  Area3: "Area3",
  AreaPlain: "Area",
  Settings3: "Settings3",
  Settings4: "Settings4",
  Settings5: "Settings5",
  Tag3: "Tag3",
  Tag4: "Tag4",
  TagPlain: "Tag",
  Tombstone2: "Tombstone2",
  TombstonePlain: "Tombstone",
} as const;

/** One entity as it appears inside a commit: `{ e, t, p }`. */
export interface RawItem { e: string; t: number; p: unknown }

/** One server commit: a map from identifier to the change. */
export type Commit = Record<string, RawItem>;

/** An item with its identifier and (when read from the server) its position in the log. */
export interface Item {
  uuid: string;
  kind: string;
  action: number;
  payload: unknown;
  /** Index of the commit this item arrived in. Absent for locally built items. */
  serverIndex?: number;
}

/** A change to send: the same shape as {@link Item} without a server position. */
export interface WriteItem {
  uuid: string;
  kind: string;
  action: ItemAction;
  payload: Record<string, unknown>;
}

// ---- Typed views of folded entities (what the Go SDK calls Task, Area, Tag, CheckListItem) -------------------

/** A task, project or heading (see `type`). A snapshot: changing it does not change the state. */
export interface Task {
  uuid: string;
  /** `cd`. */
  creationDate: Date | null;
  /** `md`: null on a task that was never modified. */
  modificationDate: Date | null;
  /** `ss`: a {@link TaskStatus} value (pending 0, canceled 2, completed 3). */
  status: number;
  title: string;
  /** Plain text of the note. */
  note: string;
  /** `sr`: the start date, midnight UTC of the calendar day. Together with `schedule` it decides the view. */
  scheduledDate: Date | null;
  /** `sp`: when it was completed or canceled. */
  completionDate: Date | null;
  /** `dd`: the deadline. */
  deadlineDate: Date | null;
  /** `ix`: order within its container. */
  index: number;
  /** `ar`: the area, if directly in one. */
  areaIds: string[];
  /** `pr`: the project (or, for a heading, its project). */
  parentTaskIds: string[];
  /** `agr`: the heading inside the project. */
  actionGroupIds: string[];
  /** `tr`: in the trash (recoverable). */
  inTrash: boolean;
  /** `st`: a {@link TaskSchedule} value (inbox 0, anytime/today 1, someday/upcoming 2). */
  schedule: number;
  /** `tp`: a {@link TaskType} value (task 0, project 1, heading 2). */
  type: number;
  /** `ti`: order within Today. */
  todayIndex: number;
  /** `do`. */
  dueOrder: number;
  alarmTimeOffset: number | null;
  /** `tg`. */
  tagIds: string[];
  /** `rt`: links of a recurring template or instance. */
  recurrenceIds: string[];
  delegateIds: string[];
}

export interface Area { uuid: string; title: string }

export interface Tag { uuid: string; title: string; shortHand: string; parentTagIds: string[] }

export interface ChecklistItem {
  uuid: string;
  creationDate: Date | null;
  modificationDate: Date | null;
  status: number;
  title: string;
  index: number;
  completionDate: Date | null;
  taskIds: string[];
}
