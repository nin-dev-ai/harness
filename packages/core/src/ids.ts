/** Identity of things on disk and in the database. See PRD → Core concepts. */

const TASK_ID = /^T-(\d{3,})$/;

export function formatTaskId(n: number): string {
  return `T-${String(n).padStart(3, "0")}`;
}

export function parseTaskId(id: string): number {
  const m = TASK_ID.exec(id);
  if (!m?.[1]) throw new Error(`not a task id: ${id}`);
  return Number(m[1]);
}

export function isTaskId(id: string): boolean {
  return TASK_ID.test(id);
}

/** Next task id given the existing ones (T-001 when there are none). */
export function nextTaskId(existing: Iterable<string>): string {
  let max = 0;
  for (const id of existing) if (isTaskId(id)) max = Math.max(max, parseTaskId(id));
  return formatTaskId(max + 1);
}

/** Run ids are R-<task>-<n>, n starting at 1. */
export function runId(taskId: string, n: number): string {
  return `R-${taskId}-${n}`;
}

export function workerId(role: string, n: number): string {
  return `${role}-${n}`;
}

export function slugify(title: string, maxLen = 32): string {
  const s = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
  return s || "task";
}

/** Task branch: harness/<role>/<task-id>-<slug>. */
export function taskBranch(role: string, taskId: string, title: string): string {
  return `harness/${role}/${taskId}-${slugify(title)}`;
}

/** Worktree path relative to the project root. */
export function worktreePath(taskId: string): string {
  return `.harness/worktrees/${taskId}`;
}

export const HARNESS_BRANCH_PREFIX = "harness/";
