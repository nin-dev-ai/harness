import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { AgentEvent, RunRequest } from "./types.js";

/** A line of child output. */
export interface OutputLine {
  stream: "stdout" | "stderr";
  line: string;
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
}

/** A child process that leads its own process group. */
export interface GroupProcess {
  readonly pid: number;
  readonly lines: AsyncIterable<OutputLine>;
  readonly exited: Promise<ExitInfo>;
  /** SIGTERM the group, wait `graceMs`, then SIGKILL. Resolves when the group is gone. */
  kill(graceMs?: number): Promise<void>;
}

/** Minimal async queue used to merge stdout and stderr into one ordered stream. */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/** True if any process in the group is alive (including zombies not yet reaped). */
export function processGroupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Send a signal to a whole process group, ignoring "already gone". */
export function signalGroup(pgid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pgid, signal);
  } catch {
    // group already gone
  }
}

/** Kill a process group: SIGTERM, wait, SIGKILL, wait until no member remains. */
export async function killGroup(pgid: number, graceMs = 2000): Promise<void> {
  signalGroup(pgid, "SIGTERM");
  const deadline = Date.now() + graceMs;
  while (processGroupAlive(pgid) && Date.now() < deadline) await sleep(25);
  if (processGroupAlive(pgid)) signalGroup(pgid, "SIGKILL");
  const hard = Date.now() + 5000;
  while (processGroupAlive(pgid) && Date.now() < hard) await sleep(25);
}

/** Spawn argv (no shell) as the leader of a new process group. */
export function spawnGroup(argv: string[], opts: { cwd: string; env: Record<string, string>; stdin?: string }): GroupProcess {
  const [cmd, ...args] = argv;
  if (!cmd) throw new Error("spawnGroup: empty argv");
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env,
    detached: true,
    stdio: [opts.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (opts.stdin !== undefined) child.stdin?.end(opts.stdin);

  const queue = new AsyncQueue<OutputLine>();
  let open = 2;
  const done = () => {
    if (--open === 0) queue.close();
  };
  for (const stream of ["stdout", "stderr"] as const) {
    const src = child[stream];
    if (!src) {
      done();
      continue;
    }
    const rl = createInterface({ input: src, crlfDelay: Infinity });
    rl.on("line", (line) => queue.push({ stream, line }));
    rl.on("close", done);
  }

  const exited = new Promise<ExitInfo>((resolve) => {
    let settled = false;
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      queue.push({ stream: "stderr", line: `spawn error: ${err.message}` });
      queue.close();
      resolve({ code: 127, signal: null });
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      resolve({ code, signal });
    });
  });

  const pid = child.pid ?? -1;
  return {
    pid,
    lines: queue,
    exited,
    kill: async (graceMs = 2000) => {
      if (pid > 0) await killGroup(pid, graceMs);
    },
  };
}

/** Environment variables a child may inherit by default. Everything else is dropped. */
export const DEFAULT_ENV_ALLOW = [
  "PATH", "HOME", "USER", "LOGNAME", "SHELL", "TERM", "TMPDIR", "LANG", "TZ",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME",
];

/** Build a child environment from an allow-list, plus explicit extras. */
export function filterEnv(
  parent: NodeJS.ProcessEnv,
  allow: readonly string[] = DEFAULT_ENV_ALLOW,
  extra: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(parent)) {
    if (v === undefined) continue;
    if (allow.includes(k) || k.startsWith("LC_")) out[k] = v;
  }
  return { ...out, ...extra };
}

/** What a vendor parser returns for one output line. */
export interface ParsedLine {
  events: AgentEvent[];
  sessionId?: string;
}

export type LineParser = (line: OutputLine, runId: string) => ParsedLine;

export interface AgentProcessSpec {
  argv: string[];
  env: Record<string, string>;
  stdin?: string;
  parse: LineParser;
  /** Output matching this on a non-zero exit with no structured limit event becomes `rate_limit` (window unknown). */
  limitPattern?: RegExp;
}

/**
 * Tracks live runs so `cancel` can find them, and turns a vendor process into
 * a normalized event stream: `started` first, `exited` last, always.
 */
export class ProcessRunner {
  private live = new Map<string, { proc: GroupProcess; cancelled: boolean }>();

  async *run(req: RunRequest, spec: AgentProcessSpec): AsyncGenerator<AgentEvent> {
    const runId = req.runId;
    let proc: GroupProcess;
    try {
      proc = spawnGroup(spec.argv, { cwd: req.cwd, env: spec.env, ...(spec.stdin !== undefined ? { stdin: spec.stdin } : {}) });
    } catch (e) {
      yield { type: "error", runId, kind: "cli_missing", message: (e as Error).message, retryable: false };
      yield { type: "exited", runId, code: null, signal: null };
      return;
    }
    const entry = { proc, cancelled: false };
    this.live.set(runId, entry);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void proc.kill(1000);
    }, req.timeoutMs);

    let started = false;
    const pending: AgentEvent[] = [];
    let linesBeforeStart = 0;
    let sawResult = false;
    let sawLimit = false;
    let sawError = false;
    const tail: string[] = [];
    const startedEvent = (sessionId?: string): AgentEvent => ({
      type: "started",
      runId,
      pid: proc.pid,
      ...(sessionId ? { sessionId } : {}),
    });

    try {
      for await (const line of proc.lines) {
        tail.push(line.line);
        if (tail.length > 200) tail.shift();
        let parsed: ParsedLine;
        try {
          parsed = spec.parse(line, runId);
        } catch (e) {
          parsed = { events: [{ type: "message", runId, text: line.line, raw: { parseError: (e as Error).message } }] };
        }
        // Hold events until the vendor reports its session id (or a few lines pass),
        // so `started` can carry it even when other output comes first.
        if (!started) {
          pending.push(...parsed.events);
          linesBeforeStart++;
          if (!parsed.sessionId && linesBeforeStart < 20) continue;
          started = true;
          yield startedEvent(parsed.sessionId);
          parsed = { events: pending.splice(0) };
        }
        for (const ev of parsed.events) {
          if (ev.type === "started") continue;
          if (ev.type === "result") sawResult = true;
          if (ev.type === "rate_limit") sawLimit = true;
          if (ev.type === "error") {
            sawError = true;
            if (ev.kind === "rate_limit" || ev.kind === "quota_exhausted") sawLimit = true;
          }
          yield ev;
        }
      }
      const exit = await proc.exited;
      if (!started) {
        started = true;
        yield startedEvent();
        for (const ev of pending.splice(0)) {
          if (ev.type === "started") continue;
          if (ev.type === "result") sawResult = true;
          if (ev.type === "rate_limit") sawLimit = true;
          if (ev.type === "error") {
            sawError = true;
            if (ev.kind === "rate_limit" || ev.kind === "quota_exhausted") sawLimit = true;
          }
          yield ev;
        }
      }
      if (timedOut) {
        yield { type: "error", runId, kind: "timeout", message: `run exceeded ${req.timeoutMs}ms`, retryable: true };
      } else if (!entry.cancelled && exit.code !== 0) {
        if (!sawLimit && spec.limitPattern && tail.some((l) => spec.limitPattern?.test(l))) {
          yield { type: "rate_limit", runId, window: "unknown" };
        } else if (!sawLimit && !sawError && !sawResult) {
          const msg = exit.code === 127 ? "CLI could not be started" : `process exited with code ${exit.code}${exit.signal ? ` (${exit.signal})` : ""}`;
          yield { type: "error", runId, kind: exit.code === 127 ? "cli_missing" : "crashed", message: msg, retryable: exit.code !== 127 };
        }
      }
      yield { type: "exited", runId, code: exit.code, signal: exit.signal };
    } finally {
      clearTimeout(timer);
      this.live.delete(runId);
      // A consumer that stops early must not leave the process running.
      if (processGroupAlive(proc.pid)) await proc.kill(500);
    }
  }

  async cancel(runId: string): Promise<void> {
    const entry = this.live.get(runId);
    if (!entry) return;
    entry.cancelled = true;
    await entry.proc.kill();
  }

  liveRuns(): string[] {
    return [...this.live.keys()];
  }
}

/** Parse a line as JSON, or undefined. */
export function tryJson(line: string): unknown {
  const t = line.trim();
  if (!t.startsWith("{") && !t.startsWith("[")) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** Drain an event stream into an array. */
export async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const e of it) out.push(e);
  return out;
}
