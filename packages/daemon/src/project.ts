import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  iso,
  makeEvent,
  nextTaskId,
  transitionTask,
  workerId,
  type ChecksConfig,
  type Clock,
  type EventPayloadInput,
  type EventType,
  type HarnessConfig,
  type HarnessEvent,
  type Task,
  type TaskSize,
  type TaskState,
  type ValidationIssue,
  type WorkerState,
} from "@harness/core";
import { loadProject, setTaskFileState, TASKS_DIR, writeTaskFile } from "@harness/config";
import type { Store } from "@harness/storage";
import type { AgentAdapter } from "@harness/adapters";

export type AdapterFactory = (routeName: string, route: HarnessConfig["routes"][string], project: ProjectRuntime) => AgentAdapter;

export interface EventEnv {
  taskId?: string | null;
  runId?: string | null;
  workerId?: string | null;
}

export interface NewTaskInput {
  title: string;
  role: string;
  size?: TaskSize;
  dependsOn?: string[];
  body?: string;
  acceptance?: string[];
  filesHint?: string[];
  contractRef?: string;
  state?: "DRAFT" | "QUEUED";
  attemptsMax?: number;
}

/** Stable project id: name plus a short hash of the repo path. */
export function projectIdFor(name: string, root: string): string {
  const h = crypto.createHash("sha1").update(fs.realpathSync(root)).digest("hex").slice(0, 6);
  return `${name}-${h}`;
}

/**
 * One open project inside the daemon: its config, adapters and the helpers
 * every component uses to change state (always through events).
 */
export class ProjectRuntime {
  readonly id: string;
  config!: HarnessConfig;
  checks!: ChecksConfig;
  warnings: ValidationIssue[] = [];
  readonly adapters = new Map<string, AgentAdapter>();

  constructor(
    readonly root: string,
    readonly store: Store,
    readonly clock: Clock,
    private adapterFactory: AdapterFactory,
  ) {
    this.load();
    this.id = projectIdFor(this.config.project, root);
  }

  /** (Re)load harness.yaml and checks.yaml; rebuild adapters for changed routes. */
  load(): void {
    const p = loadProject(this.root);
    this.config = p.harness;
    this.checks = p.checks;
    this.warnings = p.warnings;
    for (const name of [...this.adapters.keys()]) if (!this.config.routes[name]) this.adapters.delete(name);
  }

  adapter(route: string): AgentAdapter {
    let a = this.adapters.get(route);
    if (!a) {
      const r = this.config.routes[route];
      if (!r) throw new Error(`unknown route ${route}`);
      a = this.adapterFactory(route, r, this);
      this.adapters.set(route, a);
    }
    return a;
  }

  now(): string {
    return iso(this.clock);
  }

  emit<T extends EventType>(type: T, payload: EventPayloadInput<T>, env: EventEnv = {}): HarnessEvent {
    return this.store.append(makeEvent(type, payload, { ts: this.now(), projectId: this.id, ...env }) as HarnessEvent);
  }

  /** First open: record the project and create a worker slot per role × concurrency. */
  initialize(): void {
    if (!this.store.events.list({ projectId: this.id, types: ["project.initialized"], limit: 1 }).length) {
      this.emit("project.initialized", { path: this.root, name: this.config.project });
    }
    this.ensureWorkers();
  }

  ensureWorkers(): void {
    const existing = new Set(this.store.workers.list(this.id).map((w) => w.id));
    for (const [role, r] of Object.entries(this.config.roles)) {
      for (let n = 1; n <= r.concurrency; n++) {
        const id = workerId(role, n);
        if (!existing.has(id)) this.emit("worker.state_changed", { role, from: null, to: "IDLE" }, { workerId: id });
      }
    }
  }

  task(id: string): Task {
    const t = this.store.tasks.get(this.id, id);
    if (!t) throw Object.assign(new Error(`unknown task ${id}`), { code: "NOT_FOUND" });
    return t;
  }

  tasks(states?: readonly TaskState[]): Task[] {
    return this.store.tasks.list(this.id, states);
  }

  /** Validated state change: event first, then the task file's state line. */
  transition(taskId: string, to: TaskState, reason?: string): void {
    const t = this.task(taskId);
    if (t.state === to) return;
    transitionTask(t.state, to);
    this.emit("task.state_changed", { from: t.state, to, ...(reason ? { reason } : {}) }, { taskId });
    try {
      setTaskFileState(this.root, taskId, to);
    } catch {
      // The task file is a mirror; the event log is the source of truth.
    }
  }

  setWorker(id: string, to: WorkerState, opts: { currentRun?: string | null; reason?: string | null } = {}): void {
    const w = this.store.workers.get(this.id, id);
    if (!w) throw new Error(`unknown worker ${id}`);
    if (w.state === to && w.currentRun === (opts.currentRun ?? null) && w.waitingReason === (opts.reason ?? null)) return;
    this.emit("worker.state_changed", { role: w.role, from: w.state, to, currentRun: opts.currentRun ?? null, reason: opts.reason ?? null }, { workerId: id });
  }

  createTask(input: NewTaskInput): Task {
    if (!this.config.roles[input.role]) throw Object.assign(new Error(`unknown role "${input.role}"`), { code: "VALIDATION" });
    const id = nextTaskId([...this.store.tasks.ids(this.id), ...this.taskFileIds()]);
    for (const d of input.dependsOn ?? []) this.task(d);
    const state = input.state ?? "DRAFT";
    const front = {
      id, title: input.title, role: input.role, state, depends_on: input.dependsOn ?? [], size: input.size ?? "M",
      attempts_max: input.attemptsMax ?? this.config.limits.max_attempts_per_task, acceptance: input.acceptance ?? [],
      files_hint: input.filesHint ?? [], allow_new_dependencies: false, ...(input.contractRef ? { contract_ref: input.contractRef } : {}),
    };
    writeTaskFile(this.root, { front, body: input.body ?? "" });
    this.emit("task.created", {
      title: input.title, role: input.role, size: front.size, dependsOn: front.depends_on, state, specPath: `${TASKS_DIR}/${id}.md`, attemptsMax: front.attempts_max,
    }, { taskId: id });
    return this.task(id);
  }

  private taskFileIds(): string[] {
    const dir = path.join(this.root, TASKS_DIR);
    return fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^T-\d+\.md$/.test(f)).map((f) => f.slice(0, -3)) : [];
  }

  /** Artifact directory for a run (.harness/runs/<run-id>/). */
  runDir(runId: string): string {
    return path.join(this.root, ".harness", "runs", runId);
  }
}
