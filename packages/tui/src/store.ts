import type { HarnessEvent } from "@harness/core";
import type { StatusSnapshot } from "@harness/daemon";
import { toEntry, type Entry } from "./format.js";

/** What the UI needs from the daemon. The CLI adapts a DaemonClient to this; tests fake it. */
export interface TuiApi {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  onEvent(listener: (e: HarnessEvent) => void): () => void;
  subscribe(): Promise<void>;
}

export interface Toast {
  text: string;
  kind: "ok" | "err" | "warn" | "info";
  at: number;
}

export interface FileStat {
  path: string;
  insertions: number;
  deletions: number;
}

const MAX_ENTRIES = 800;

/**
 * Client-side view state. Holds no authority: everything comes from the
 * daemon's snapshot and event stream, so closing the UI changes nothing.
 */
export class TuiStore {
  snapshot: StatusSnapshot | null = null;
  error: string | null = null;
  /** The conversation per task: agent output, your messages, checks, review, merge. */
  readonly entries = new Map<string, Entry[]>();
  /** Local lines (command results) per view key. */
  readonly local = new Map<string, Entry[]>();
  readonly files = new Map<string, FileStat[]>();
  readonly cost = new Map<string, { tokensIn: number; tokensOut: number; usd: number | null }>();
  readonly lastTaskByWorker = new Map<string, string>();
  toasts: Toast[] = [];
  private loaded = new Set<string>();
  private listeners = new Set<() => void>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private filesTimer = new Map<string, ReturnType<typeof setTimeout>>();
  private off: (() => void) | undefined;

  constructor(readonly api: TuiApi) {}

  async start(): Promise<void> {
    this.off = this.api.onEvent((e) => this.onEvent(e));
    await this.api.subscribe();
    await this.refresh();
  }

  stop(): void {
    this.off?.();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    for (const t of this.filesTimer.values()) clearTimeout(t);
  }

  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  emit(): void {
    for (const l of this.listeners) l();
  }

  async refresh(): Promise<void> {
    try {
      this.snapshot = await this.api.call<StatusSnapshot>("status");
      this.error = null;
    } catch (e) {
      this.error = (e as Error).message;
    }
    this.emit();
  }

  private scheduleRefresh(): void {
    this.refreshTimer ??= setTimeout(() => {
      this.refreshTimer = undefined;
      void this.refresh();
    }, 150);
  }

  toast(text: string, kind: Toast["kind"] = "info"): void {
    this.toasts = [...this.toasts.slice(-3), { text, kind, at: Date.now() }];
    this.emit();
  }

  /** A line in the stream that came from you or a command, not the daemon. */
  note(view: string, kind: Entry["kind"], text: string, detail?: string): void {
    const list = this.local.get(view) ?? [];
    list.push({ kind, text, ts: new Date().toISOString(), ...(detail ? { detail } : {}) });
    this.local.set(view, list.slice(-200));
    this.emit();
  }

  private add(taskId: string, e: Entry): void {
    const list = this.entries.get(taskId) ?? [];
    list.push(e);
    if (list.length > MAX_ENTRIES) list.splice(0, list.length - MAX_ENTRIES);
    this.entries.set(taskId, list);
  }

  private track(e: HarnessEvent): void {
    if (e.type === "run.event" && e.taskId && e.payload.event.type === "usage") {
      const u = e.payload.event;
      const c = this.cost.get(e.taskId) ?? { tokensIn: 0, tokensOut: 0, usd: null };
      c.tokensIn += u.tokensIn ?? 0;
      c.tokensOut += u.tokensOut ?? 0;
      if (u.costUsd !== undefined) c.usd = (c.usd ?? 0) + u.costUsd;
      this.cost.set(e.taskId, c);
    }
  }

  onEvent(e: HarnessEvent): void {
    if (e.type === "worker.assigned" && e.workerId && e.taskId) this.lastTaskByWorker.set(e.workerId, e.taskId);
    if (e.taskId) {
      this.track(e);
      const entry = toEntry(e);
      if (entry) this.add(e.taskId, entry);
      if (e.type === "run.event" && e.payload.event.type === "file_change") this.scheduleFiles(e.taskId);
      if (e.type === "run.finished" || e.type === "branch.merged") this.scheduleFiles(e.taskId);
    }
    if (e.type === "branch.merged") this.toast(`🎉 ${e.taskId} merged into ${e.payload.into}`, "ok");
    else if (e.type === "task.needs_human") this.toast(`🙋 ${e.taskId} needs you: ${e.payload.reason}`, "err");
    else if (e.type === "route.paused") this.toast(`⏸  ${e.payload.route} paused${e.payload.until ? ` until ${new Date(e.payload.until).toTimeString().slice(0, 5)}` : ""}`, "warn");
    else if (e.type === "route.resumed") this.toast(`▶  ${e.payload.route} resumed`, "ok");
    else if (e.type === "approval.requested") this.toast(`🔐 ${e.payload.approvalId}: ${e.payload.context}  (/approve ${e.payload.approvalId})`, "warn");
    else if (e.type === "review.passed") this.toast(`👀 ${e.taskId} review passed`, "ok");
    this.scheduleRefresh();
    this.emit();
  }

  /** Backfill a task's whole story the first time it is shown. */
  async loadTask(taskId: string): Promise<void> {
    if (this.loaded.has(taskId)) return;
    this.loaded.add(taskId);
    try {
      const evs = await this.api.call<HarnessEvent[]>("events.list", { taskId });
      const list: Entry[] = [];
      for (const e of evs) {
        this.track(e);
        const entry = toEntry(e);
        if (entry) list.push(entry);
      }
      const streamed = this.entries.get(taskId) ?? [];
      const seen = new Set(list.map((x) => `${x.ts}|${x.text}`));
      this.entries.set(taskId, [...list, ...streamed.filter((x) => !seen.has(`${x.ts}|${x.text}`))].slice(-MAX_ENTRIES));
    } catch {
      // task unknown: show what streams in
    }
    void this.loadFiles(taskId);
    this.emit();
  }

  private scheduleFiles(taskId: string): void {
    if (this.filesTimer.has(taskId)) return;
    this.filesTimer.set(
      taskId,
      setTimeout(() => {
        this.filesTimer.delete(taskId);
        void this.loadFiles(taskId);
      }, 500),
    );
  }

  async loadFiles(taskId: string): Promise<void> {
    try {
      const r = await this.api.call<{ fileStats?: FileStat[] }>("review.show", { id: taskId });
      if (r.fileStats) this.files.set(taskId, r.fileStats);
      this.emit();
    } catch {
      // no worktree yet
    }
  }

  /** The task an agent is on now, else the last one it worked on. */
  taskForWorker(workerId: string): string | undefined {
    const w = this.snapshot?.workers.find((x) => x.id === workerId);
    return w?.taskId ?? this.lastTaskByWorker.get(workerId);
  }

  stream(view: string, taskId: string | undefined): Entry[] {
    const a = taskId ? (this.entries.get(taskId) ?? []) : [];
    const b = this.local.get(view) ?? [];
    if (!b.length) return a;
    return [...a, ...b].sort((x, y) => x.ts.localeCompare(y.ts));
  }
}
