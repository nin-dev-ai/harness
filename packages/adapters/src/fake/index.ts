import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AgentEventSchema, type AgentEvent, type UsageSnapshot } from "@harness/core";
import { ProcessRunner, tryJson, type LineParser } from "../process.js";
import type { AgentAdapter, DetectResult, RunRequest } from "../types.js";

/** One scripted step. `delayMs` is real time before the step (keep it small in tests). */
export const FakeStepSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("message"), text: z.string(), delayMs: z.number().optional() }),
  z.object({ kind: z.literal("tool_call"), tool: z.string(), summary: z.string().optional(), delayMs: z.number().optional() }),
  z.object({ kind: z.literal("file_change"), path: z.string(), content: z.string().optional(), delete: z.boolean().optional(), delayMs: z.number().optional() }),
  z.object({ kind: z.literal("usage"), tokensIn: z.number().optional(), tokensOut: z.number().optional(), costUsd: z.number().optional(), delayMs: z.number().optional() }),
  z.object({
    kind: z.literal("rate_limit"),
    window: z.enum(["5h", "7d", "unknown"]).optional(),
    resetsAt: z.string().optional(),
    /** false: print only an unstructured limit message on stderr. */
    structured: z.boolean().optional(),
    exitCode: z.number().optional(),
    delayMs: z.number().optional(),
  }),
  z.object({ kind: z.literal("raw"), line: z.string(), delayMs: z.number().optional() }),
  z.object({ kind: z.literal("stderr"), line: z.string(), delayMs: z.number().optional() }),
  z.object({ kind: z.literal("spawn_child"), delayMs: z.number().optional() }),
  z.object({ kind: z.literal("hang"), delayMs: z.number().optional() }),
  z.object({ kind: z.literal("crash"), code: z.number().optional(), message: z.string().optional(), delayMs: z.number().optional() }),
  z.object({
    kind: z.literal("error"),
    errorKind: z.string().optional(),
    message: z.string().optional(),
    retryable: z.boolean().optional(),
    delayMs: z.number().optional(),
  }),
  z.object({ kind: z.literal("result"), ok: z.boolean().optional(), summary: z.string().optional(), structured: z.unknown().optional(), delayMs: z.number().optional() }),
]);
export type FakeStep = z.infer<typeof FakeStepSchema>;

export const FakeScriptSchema = z.object({
  sessionId: z.string().optional(),
  steps: z.array(FakeStepSchema),
  /** Steps played when the run resumes a session; defaults to `steps`. */
  resumeSteps: z.array(FakeStepSchema).optional(),
  sessionExpiredOnResume: z.boolean().optional(),
  exitCode: z.number().optional(),
});
export type FakeScript = z.infer<typeof FakeScriptSchema>;

export type FakeScriptSource = FakeScript | ((req: RunRequest) => FakeScript);

export interface FakeAdapterOptions {
  script?: FakeScriptSource;
  usage?: Record<string, UsageSnapshot[]>;
  detect?: DetectResult;
}

const ASSETS = (globalThis as { __HARNESS_ASSETS__?: string }).__HARNESS_ASSETS__;
export const FAKE_AGENT_BIN = ASSETS ? path.join(ASSETS, "fake", "agent.mjs") : path.join(path.dirname(fileURLToPath(import.meta.url)), "agent.mjs");

/** Translate the fake agent's protocol into normalized events. Unknown lines become messages. */
export const parseFakeLine: LineParser = (line, runId) => {
  const obj = tryJson(line.line) as Record<string, unknown> | undefined;
  if (!obj || typeof obj.t !== "string") {
    return { events: line.line.trim() ? [{ type: "message", runId, text: line.line, raw: { stream: line.stream } }] : [] };
  }
  const ev = ((): AgentEvent | AgentEvent[] | { sessionId: string } => {
    switch (obj.t) {
      case "session":
        return { sessionId: String(obj.id) };
      case "message":
        return { type: "message", runId, text: String(obj.text ?? "") };
      case "tool":
        return { type: "tool_call", runId, tool: String(obj.tool), summary: String(obj.summary ?? "") };
      case "file":
        return { type: "file_change", runId, path: String(obj.path) };
      case "usage":
        return AgentEventSchema.parse({ type: "usage", runId, tokensIn: obj.tokensIn, tokensOut: obj.tokensOut, costUsd: obj.costUsd });
      case "rate_limit":
        return AgentEventSchema.parse({ type: "rate_limit", runId, window: obj.window ?? "unknown", ...(obj.resetsAt ? { resetsAt: obj.resetsAt } : {}) });
      case "result":
        return { type: "result", runId, ok: Boolean(obj.ok), summary: String(obj.summary ?? ""), ...(obj.structured !== undefined ? { structured: obj.structured } : {}) };
      case "error":
        return AgentEventSchema.parse({ type: "error", runId, kind: obj.kind ?? "unknown", message: obj.message ?? "", retryable: Boolean(obj.retryable) });
      default:
        return { type: "message", runId, text: line.line, raw: obj };
    }
  })();
  if ("sessionId" in ev) return { events: [], sessionId: ev.sessionId };
  return { events: Array.isArray(ev) ? ev : [ev] };
};

/**
 * Scripted adapter used by every test. Runs `agent.mjs` as a real child
 * process, so process groups, cancellation and parsing are exercised for real.
 */
export class FakeAdapter implements AgentAdapter {
  readonly vendor = "fake" as const;
  readonly requests: RunRequest[] = [];
  private runner = new ProcessRunner();
  private script: FakeScriptSource;
  private snapshots: Record<string, UsageSnapshot[]>;
  private detectResult: DetectResult;

  constructor(opts: FakeAdapterOptions = {}) {
    this.script = opts.script ?? { steps: [{ kind: "result", ok: true, summary: "done" }] };
    this.snapshots = opts.usage ?? {};
    this.detectResult = opts.detect ?? { installed: true, version: "fake-agent 1.0.0", signedIn: "yes" };
  }

  setScript(script: FakeScriptSource): void {
    this.script = script;
  }

  setUsage(route: string, snapshots: UsageSnapshot[]): void {
    this.snapshots[route] = snapshots;
  }

  async detect(): Promise<DetectResult> {
    return this.detectResult;
  }

  run(req: RunRequest): AsyncIterable<AgentEvent> {
    this.requests.push(req);
    const script = FakeScriptSchema.parse(typeof this.script === "function" ? this.script(req) : this.script);
    const argv = [process.execPath, FAKE_AGENT_BIN, "--run-id", req.runId];
    if (req.resumeSessionId) argv.push("--resume", req.resumeSessionId);
    if (req.mode === "readonly") argv.push("--readonly");
    return this.runner.run(req, {
      argv,
      env: { ...req.env, HARNESS_FAKE_SCRIPT: JSON.stringify(script) },
      parse: parseFakeLine,
      limitPattern: /usage limit reached|rate limit/i,
    });
  }

  cancel(runId: string): Promise<void> {
    return this.runner.cancel(runId);
  }

  async usage(route: string): Promise<UsageSnapshot[]> {
    return this.snapshots[route] ?? [];
  }

  interactiveCommand(sessionId: string, _cwd: string): { argv: string[] } {
    return { argv: [process.execPath, FAKE_AGENT_BIN, "--interactive", sessionId] };
  }

  liveRuns(): string[] {
    return this.runner.liveRuns();
  }
}
