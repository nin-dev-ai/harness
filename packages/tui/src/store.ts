import type { HarnessEvent } from "@harness/core";
import type { StatusSnapshot } from "@harness/daemon";
import { formatRunEvent } from "./format.js";

/** What the UI needs from the daemon. The CLI adapts a DaemonClient to this; tests fake it. */
export interface TuiApi {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  onEvent(listener: (e: HarnessEvent) => void): () => void;
  subscribe(): Promise<void>;
}

export interface OutputBuffer {
  lines: string[];
  raw: string[];
  loaded: boolean;
}

const MAX_LINES = 1000;

/**
 * Client-side view state. Holds no authority: everything comes from the
 * daemon's snapshot and event stream, so closing the UI changes nothing.
 */
export class TuiStore {
  snapshot: StatusSnapshot | null = null;
  readonly outputs = new Map<string, OutputBuffer>();
  /** Last run per worker and per task, from the event stream. */
  readonly lastRunByWorker = new Map<string, string>();
  readonly lastRunByTask = new Map<string, string>();
  private listeners = new Set<() => void>();
  private refreshTimer: ReturnType<typeof setTimeout> | undefined;
  private off: (() => void) | undefined;
  error: string | null = null;

  constructor(readonly api: TuiApi) {}

  async start(): Promise<void> {
    this.off = this.api.onEvent((e) => this.onEvent(e));
    await this.api.subscribe();
    await this.refresh();
  }

  stop(): void {
    this.off?.();
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
  }

  onChange(l: () => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }

  private emit(): void {
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
    }, 200);
  }

  buffer(runId: string): OutputBuffer {
    let b = this.outputs.get(runId);
    if (!b) {
      b = { lines: [], raw: [], loaded: false };
      this.outputs.set(runId, b);
    }
    return b;
  }

  private push(runId: string, line: string | undefined, raw: unknown): void {
    const b = this.buffer(runId);
    if (line) b.lines.push(line);
    b.raw.push(JSON.stringify(raw));
    if (b.lines.length > MAX_LINES) b.lines.splice(0, b.lines.length - MAX_LINES);
    if (b.raw.length > MAX_LINES) b.raw.splice(0, b.raw.length - MAX_LINES);
  }

  onEvent(e: HarnessEvent): void {
    if (e.runId) {
      if (e.workerId && e.type === "run.started") this.lastRunByWorker.set(e.workerId, e.runId);
      if (e.taskId && e.type === "run.started") this.lastRunByTask.set(e.taskId, e.runId);
      const line = formatRunEvent(e);
      if (line || e.type === "run.event") this.push(e.runId, line, e.type === "run.event" ? e.payload.event : e.payload);
    }
    this.scheduleRefresh();
    this.emit();
  }

  /** Backfill a run's output from the daemon the first time it is shown. */
  async load(runId: string): Promise<void> {
    const b = this.buffer(runId);
    if (b.loaded) return;
    b.loaded = true;
    try {
      const r = await this.api.call<{ events: HarnessEvent[] }>("logs", { runId });
      const lines: string[] = [];
      const raw: string[] = [];
      for (const e of r.events) {
        const l = formatRunEvent(e);
        if (l) lines.push(l);
        if (e.type === "run.event") raw.push(JSON.stringify(e.payload.event));
      }
      b.lines = [...lines, ...b.lines.filter((l) => !lines.includes(l))].slice(-MAX_LINES);
      b.raw = raw.slice(-MAX_LINES);
    } catch {
      // run unknown to the daemon (e.g. already pruned): show what streamed in
    }
    this.emit();
  }

  /** The run to show for a worker: its live run, else its last one. */
  runForWorker(workerId: string): string | undefined {
    const w = this.snapshot?.workers.find((x) => x.id === workerId);
    return w?.currentRun ?? this.lastRunByWorker.get(workerId);
  }
}
