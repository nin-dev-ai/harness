import fs from "node:fs";
import path from "node:path";
import Database, { type Database as Db } from "better-sqlite3";
import { HarnessEventSchema, type HarnessEvent } from "@harness/core";
import { migrate } from "./migrate.js";
import { applyEvent, PROJECTION_TABLES } from "./projector.js";
import { EventsRepo } from "./repos/events.js";
import { RunsRepo } from "./repos/runs.js";
import { TasksRepo } from "./repos/tasks.js";
import { WindowsRepo } from "./repos/windows.js";
import { WorkersRepo } from "./repos/workers.js";

export type EventListener = (e: HarnessEvent) => void;

/**
 * The only way state changes: `append` validates an event, writes it to the
 * log and applies it to the projection tables in one transaction.
 */
export class Store {
  readonly db: Db;
  readonly tasks: TasksRepo;
  readonly runs: RunsRepo;
  readonly workers: WorkersRepo;
  readonly windows: WindowsRepo;
  readonly events: EventsRepo;
  private listeners = new Set<EventListener>();
  private insert;

  constructor(file: string) {
    if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new Database(file);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");
    migrate(this.db);
    this.tasks = new TasksRepo(this.db);
    this.runs = new RunsRepo(this.db);
    this.workers = new WorkersRepo(this.db);
    this.windows = new WindowsRepo(this.db);
    this.events = new EventsRepo(this.db);
    this.insert = this.db.prepare(
      "INSERT INTO events (ts, project_id, type, task_id, run_id, worker_id, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
  }

  /** Validate, persist and project one event. Returns it with its sequence number. */
  append(event: HarnessEvent): HarnessEvent {
    return this.appendMany([event])[0]!;
  }

  /** Append several events atomically: all or none. */
  appendMany(events: HarnessEvent[]): HarnessEvent[] {
    const stored = this.db.transaction(() =>
      events.map((ev) => {
        const e = HarnessEventSchema.parse(ev);
        const info = this.insert.run(e.ts, e.projectId, e.type, e.taskId ?? null, e.runId ?? null, e.workerId ?? null, JSON.stringify(e.payload));
        const withSeq = { ...e, seq: Number(info.lastInsertRowid) } as HarnessEvent;
        applyEvent(this.db, withSeq);
        return withSeq;
      }),
    )();
    for (const e of stored) for (const l of this.listeners) l(e);
    return stored;
  }

  /** Subscribe to appended events. Returns an unsubscribe function. */
  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Drop every projection and replay the event log. */
  rebuild(): void {
    this.db.transaction(() => {
      for (const t of PROJECTION_TABLES) this.db.exec(`DELETE FROM ${t}`);
      for (const e of this.events.list()) applyEvent(this.db, e);
    })();
  }

  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}

export function openStore(file: string): Store {
  return new Store(file);
}
