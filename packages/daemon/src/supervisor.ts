import fs from "node:fs";
import path from "node:path";
import { runId as makeRunId, type AgentEvent, type ErrorKind, type Route, type RunKind, type RunState, type TaskSize } from "@harness/core";
import { DEFAULT_ENV_ALLOW, filterEnv } from "@harness/adapters";
import { maskSecrets, secretValues } from "@harness/policy";
import type { ProjectRuntime } from "./project.js";

export interface StartRunInput {
  taskId: string;
  workerId: string;
  route: string;
  kind: RunKind;
  prompt: string;
  cwd: string;
  mode: "readonly" | "write";
  resumeSessionId?: string;
  allowedPaths: string[];
  timeoutMs: number;
  jsonSchema?: object;
  /** Task size: picks the route's model tier (`models.S|M|L`) when it has one. */
  size?: TaskSize;
}

/** The model a run uses: the route's tier for the task size, else its default model. */
export function modelFor(route: Route | undefined, size?: TaskSize): string | undefined {
  return (size ? route?.models?.[size] : undefined) ?? route?.model;
}

export interface RunOutcome {
  runId: string;
  state: RunState;
  exitCode: number | null;
  errorKind: ErrorKind | null;
  sessionId?: string;
  result?: { ok: boolean; summary: string; structured?: unknown };
  rateLimit?: { window: "5h" | "7d" | "unknown"; resetsAt?: string };
  error?: { kind: ErrorKind; message: string };
  files: string[];
}

export type StopReason = "pause" | "takeover" | "cancel";

/** Vendor config locations a CLI needs to find its own sign-in; never credentials themselves. */
const VENDOR_ENV = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "CURSOR_CONFIG_DIR", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "NODE_EXTRA_CA_CERTS"];
const API_KEY_ENV: Record<string, string> = { claude: "ANTHROPIC_API_KEY", codex: "OPENAI_API_KEY", cursor: "CURSOR_API_KEY" };

/** Child environment for a route: allow-list plus, for api_key routes, that one key. */
export function runEnv(project: ProjectRuntime, route: string, parent: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const r = project.config.routes[route]!;
  const extra: Record<string, string> = { HARNESS_PROJECT: project.id };
  const keyVar = API_KEY_ENV[r.vendor];
  if (r.auth === "api_key" && keyVar && parent[keyVar]) extra[keyVar] = parent[keyVar]!;
  return filterEnv(parent, [...DEFAULT_ENV_ALLOW, ...VENDOR_ENV], extra);
}

/**
 * Starts vendor runs, streams their events into the log, and turns the end
 * of a run into a RunOutcome. Knows nothing about tasks beyond ids.
 */
export class Supervisor {
  private live = new Map<string, { project: ProjectRuntime; route: string; stop?: StopReason }>();

  /** Runs in flight across all projects. */
  get liveCount(): number {
    return this.live.size;
  }

  private secrets: string[];

  constructor(private parentEnv: NodeJS.ProcessEnv = process.env) {
    this.secrets = secretValues(parentEnv);
  }

  /** Agent output is masked before it is stored or shown. */
  private mask(ev: AgentEvent): AgentEvent {
    if (ev.type === "message") return { ...ev, text: maskSecrets(ev.text, this.secrets), ...(ev.raw !== undefined ? { raw: JSON.parse(maskSecrets(JSON.stringify(ev.raw), this.secrets)) } : {}) };
    if (ev.type === "tool_call") return { ...ev, summary: maskSecrets(ev.summary, this.secrets) };
    if (ev.type === "result") return { ...ev, summary: maskSecrets(ev.summary, this.secrets) };
    if (ev.type === "error") return { ...ev, message: maskSecrets(ev.message, this.secrets) };
    return ev;
  }

  start(project: ProjectRuntime, input: StartRunInput): { runId: string; done: Promise<RunOutcome> } {
    const n = project.store.runs.nextNumber(project.id, input.taskId);
    const runId = makeRunId(input.taskId, n);
    const route = project.config.routes[input.route]!;
    const dir = project.runDir(runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "prompt.md"), input.prompt);
    project.emit(
      "run.started",
      {
        route: input.route, vendor: route.vendor, model: modelFor(route, input.size) ?? null, kind: input.kind,
        artifactDir: path.relative(project.root, dir), ...(input.resumeSessionId ? { resumeOf: input.resumeSessionId } : {}),
      },
      { taskId: input.taskId, runId, workerId: input.workerId },
    );
    this.live.set(runId, { project, route: input.route });
    const done = this.consume(project, runId, input).finally(() => this.live.delete(runId));
    return { runId, done };
  }

  private async consume(project: ProjectRuntime, runId: string, input: StartRunInput): Promise<RunOutcome> {
    const adapter = project.adapter(input.route);
    const log = fs.createWriteStream(path.join(project.runDir(runId), "events.jsonl"), { flags: "a" });
    const env = { taskId: input.taskId, runId, workerId: input.workerId };
    const out: RunOutcome = { runId, state: "FAILED", exitCode: null, errorKind: null, files: [] };
    const files = new Set<string>();
    let exited = false;
    try {
      const stream = adapter.run({
        runId, cwd: input.cwd, prompt: input.prompt, mode: input.mode, allowedPaths: input.allowedPaths,
        env: runEnv(project, input.route, this.parentEnv), timeoutMs: input.timeoutMs,
        ...(modelFor(project.config.routes[input.route], input.size) ? { model: modelFor(project.config.routes[input.route], input.size)! } : {}),
        ...(input.resumeSessionId ? { resumeSessionId: input.resumeSessionId } : {}),
        ...(input.jsonSchema ? { jsonSchema: input.jsonSchema } : {}),
      });
      for await (const raw of stream) {
        const ev = this.mask(raw);
        log.write(JSON.stringify(ev) + "\n");
        this.observe(out, files, ev);
        project.emit("run.event", { event: ev }, env);
        if (ev.type === "exited") exited = true;
      }
    } catch (e) {
      out.error = { kind: "crashed", message: (e as Error).message };
      out.errorKind = "crashed";
    } finally {
      log.end();
    }
    out.files = [...files];
    const stop = this.live.get(runId)?.stop;
    out.state = this.finalState(out, stop, exited);
    project.emit(
      "run.finished",
      { state: out.state, exitCode: out.exitCode, errorKind: out.errorKind, ...(out.result ? { summary: out.result.summary.slice(0, 2000) } : {}), ...(out.sessionId ? { sessionId: out.sessionId } : {}) },
      env,
    );
    return out;
  }

  private observe(out: RunOutcome, files: Set<string>, ev: AgentEvent): void {
    switch (ev.type) {
      case "started":
        if (ev.sessionId) out.sessionId = ev.sessionId;
        break;
      case "file_change":
        files.add(ev.path);
        break;
      case "result":
        out.result = { ok: ev.ok, summary: ev.summary, ...(ev.structured !== undefined ? { structured: ev.structured } : {}) };
        break;
      case "rate_limit":
        out.rateLimit = { window: ev.window, ...(ev.resetsAt ? { resetsAt: ev.resetsAt } : {}) };
        out.errorKind = "rate_limit";
        break;
      case "error":
        if (ev.kind === "rate_limit" || ev.kind === "quota_exhausted") {
          out.rateLimit ??= { window: "unknown" };
          out.errorKind = ev.kind;
        } else if (!out.error) {
          out.error = { kind: ev.kind, message: ev.message };
          out.errorKind = out.errorKind ?? ev.kind;
        }
        break;
      case "exited":
        out.exitCode = ev.code;
        break;
    }
  }

  private finalState(out: RunOutcome, stop: StopReason | undefined, exited: boolean): RunState {
    if (stop === "pause") return "PAUSED";
    if (stop === "takeover") return "TAKEN_OVER";
    if (stop === "cancel") return "CANCELLED";
    if (out.rateLimit) return "PAUSED";
    if (exited && out.exitCode === 0 && !out.error) return "SUCCEEDED";
    return "FAILED";
  }

  /** Stop a run. The outcome's state reflects why (PAUSED, TAKEN_OVER, CANCELLED). */
  async stop(runId: string, reason: StopReason): Promise<void> {
    const entry = this.live.get(runId);
    if (!entry) return;
    entry.stop = reason;
    await entry.project.adapter(entry.route).cancel(runId);
  }

  async stopAll(reason: StopReason = "cancel"): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.stop(id, reason)));
  }

  activeRuns(): string[] {
    return [...this.live.keys()];
  }

  isLive(runId: string): boolean {
    return this.live.has(runId);
  }
}
