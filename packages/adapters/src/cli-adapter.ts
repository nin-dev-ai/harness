import { execa } from "execa";
import type { AgentEvent, UsageSnapshot, Vendor } from "@harness/core";
import { ProcessRunner, type LineParser } from "./process.js";
import type { AgentAdapter, DetectResult, RunRequest } from "./types.js";

export interface CliAdapterOptions {
  /** Route this adapter instance serves (one adapter per route). */
  route?: string;
  /** Override the command prefix (tests point this at a fixture replayer). */
  bin?: string[];
  /** Extra environment for every run (tests only). */
  extraEnv?: Record<string, string>;
}

/** Find the first of `names` on PATH. */
export async function which(names: readonly string[], env: NodeJS.ProcessEnv = process.env): Promise<string | undefined> {
  for (const n of names) {
    const r = await execa("/usr/bin/env", ["which", n], { reject: false, env: { PATH: env.PATH ?? "" }, extendEnv: false });
    if (r.exitCode === 0 && String(r.stdout).trim()) return String(r.stdout).trim();
  }
  return undefined;
}

/** Run a short CLI command for detection. Output is parsed, never logged. */
export async function probe(argv: string[], timeoutMs = 15_000): Promise<{ code: number; stdout: string; stderr: string }> {
  const [cmd, ...args] = argv;
  const r = await execa(cmd!, args, { reject: false, timeout: timeoutMs, stdin: "ignore" });
  return { code: r.exitCode ?? 1, stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? "") };
}

/**
 * Shared shape of the three vendor adapters: build argv, parse the stream,
 * let ProcessRunner own process groups, timeouts and the started/exited contract.
 */
export abstract class CliAdapter implements AgentAdapter {
  abstract readonly vendor: Vendor;
  protected abstract readonly binaries: readonly string[];
  protected abstract readonly limitPattern: RegExp;
  protected readonly runner = new ProcessRunner();
  protected snapshots: UsageSnapshot[] = [];
  private resolved: string | undefined;

  constructor(protected readonly opts: CliAdapterOptions = {}) {}

  /** Arguments after the binary. */
  protected abstract args(req: RunRequest): string[] | Promise<string[]>;
  /** A fresh stateful parser per run. */
  protected abstract parser(req: RunRequest): LineParser;
  abstract detect(): Promise<DetectResult>;
  abstract interactiveCommand(sessionId: string, cwd: string): { argv: string[] };

  /** Called after the run's stream ends, with the session id the run reported. */
  protected async afterRun(_req: RunRequest, _sessionId: string | undefined): Promise<void> {}

  protected async binary(): Promise<string[]> {
    if (this.opts.bin) return this.opts.bin;
    this.resolved ??= (await which(this.binaries)) ?? this.binaries[0]!;
    return [this.resolved];
  }

  async *run(req: RunRequest): AsyncGenerator<AgentEvent> {
    const argv = [...(await this.binary()), ...(await this.args(req))];
    let sessionId: string | undefined;
    for await (const ev of this.runner.run(req, { argv, env: { ...req.env, ...this.opts.extraEnv }, parse: this.parser(req), limitPattern: this.limitPattern })) {
      if (ev.type === "started") sessionId = ev.sessionId;
      if (ev.type === "exited") await this.afterRun(req, sessionId).catch(() => undefined);
      yield ev;
    }
  }

  cancel(runId: string): Promise<void> {
    return this.runner.cancel(runId);
  }

  async usage(route: string): Promise<UsageSnapshot[]> {
    return this.snapshots.map((s) => ({ ...s, route }));
  }

  protected bin0(): string {
    return this.opts.bin?.join(" ") ?? this.resolved ?? this.binaries[0]!;
  }
}

/** Unix seconds (or ISO) → ISO string. */
export function toIso(t: unknown): string | undefined {
  if (typeof t === "number" && Number.isFinite(t)) return new Date(t < 1e12 ? t * 1000 : t).toISOString();
  if (typeof t === "string" && !Number.isNaN(Date.parse(t))) return new Date(t).toISOString();
  return undefined;
}

/** Short one-line summary of a tool input for the output panel. */
export function summarizeInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const o = input as Record<string, unknown>;
  const v = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.url ?? o.query ?? o.description;
  const s = typeof v === "string" ? v : JSON.stringify(o);
  return s.length > 160 ? `${s.slice(0, 157)}...` : s;
}
