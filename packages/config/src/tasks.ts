import fs from "node:fs";
import path from "node:path";
import { parse, stringify } from "yaml";
import { TaskFrontMatterSchema, ValidationError, type TaskFrontMatter } from "@harness/core";
import { writeFileAtomic } from "./write.js";

export const TASKS_DIR = ".harness/tasks";

export interface TaskFile {
  front: TaskFrontMatter;
  body: string;
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/** Parse a task markdown file (front matter + body). */
export function parseTaskFile(text: string, file = "task.md"): TaskFile {
  const m = FENCE.exec(text);
  if (!m) throw new ValidationError(`${file}: missing front matter`, [{ path: "", message: "expected --- front matter ---", file, line: 1 }]);
  const res = TaskFrontMatterSchema.safeParse(parse(m[1]!));
  if (!res.success) {
    throw new ValidationError(
      `${file}: invalid front matter`,
      res.error.issues.map((i) => ({ path: i.path.join("."), message: i.message, file })),
    );
  }
  return { front: res.data, body: m[2]!.trim() };
}

/** Serialize a task file. The state line carries a do-not-edit comment. */
export function formatTaskFile(t: TaskFile): string {
  const f = t.front;
  const ordered: Record<string, unknown> = {
    id: f.id, title: f.title, role: f.role, state: f.state, depends_on: f.depends_on, size: f.size, attempts_max: f.attempts_max,
    acceptance: f.acceptance, files_hint: f.files_hint,
    ...(f.contract_ref ? { contract_ref: f.contract_ref } : {}),
    ...(f.allow_new_dependencies ? { allow_new_dependencies: true } : {}),
  };
  const yaml = stringify(ordered, { flowCollectionPadding: false }).replace(/^state: (\w+)$/m, "state: $1            # managed by the tool; do not edit by hand");
  return `---\n${yaml}---\n\n${t.body.trim()}\n`;
}

export function taskFilePath(projectRoot: string, id: string): string {
  return path.join(projectRoot, TASKS_DIR, `${id}.md`);
}

export function readTaskFile(projectRoot: string, id: string): TaskFile {
  const file = taskFilePath(projectRoot, id);
  return parseTaskFile(fs.readFileSync(file, "utf8"), path.relative(projectRoot, file));
}

export function writeTaskFile(projectRoot: string, t: TaskFile): string {
  const file = taskFilePath(projectRoot, t.front.id);
  writeFileAtomic(file, formatTaskFile(t));
  return file;
}

/** Update only the state line of a task file, if it exists. */
export function setTaskFileState(projectRoot: string, id: string, state: TaskFrontMatter["state"]): void {
  const file = taskFilePath(projectRoot, id);
  if (!fs.existsSync(file)) return;
  const t = readTaskFile(projectRoot, id);
  writeTaskFile(projectRoot, { ...t, front: { ...t.front, state } });
}

export function listTaskFiles(projectRoot: string): TaskFile[] {
  const dir = path.join(projectRoot, TASKS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => /^T-\d+\.md$/.test(f))
    .sort()
    .map((f) => parseTaskFile(fs.readFileSync(path.join(dir, f), "utf8"), path.join(TASKS_DIR, f)));
}

/** Return a cycle in the dependency graph as a list of ids, or undefined if it is a DAG. */
export function findCycle(deps: Map<string, readonly string[]>): string[] | undefined {
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | undefined => {
    const s = state.get(id);
    if (s === 2) return undefined;
    if (s === 1) return [...stack.slice(stack.indexOf(id)), id];
    state.set(id, 1);
    stack.push(id);
    for (const d of deps.get(id) ?? []) {
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(id, 2);
    return undefined;
  };
  for (const id of deps.keys()) {
    const c = visit(id);
    if (c) return c;
  }
  return undefined;
}
