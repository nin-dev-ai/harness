import type { AgentEvent, ErrorKind, UsageSnapshot, Vendor } from "@harness/core";

export type { AgentEvent, ErrorKind, UsageSnapshot, Vendor };

/** One headless agent run. `env` is already filtered and never contains credentials. */
export interface RunRequest {
  runId: string;
  cwd: string;
  prompt: string;
  model?: string;
  mode: "readonly" | "write";
  resumeSessionId?: string;
  allowedPaths: string[];
  env: Record<string, string>;
  timeoutMs: number;
  jsonSchema?: object;
}

export interface DetectResult {
  installed: boolean;
  version?: string;
  signedIn: "yes" | "no" | "unknown";
  /** Exact command the user should run to fix a missing or signed-out CLI. */
  fixHint?: string;
}

/**
 * Every vendor sits behind this interface. The scheduler and outer loop never
 * know which CLI they are talking to.
 */
export interface AgentAdapter {
  readonly vendor: Vendor;
  detect(): Promise<DetectResult>;
  /** Streams normalized events. Always ends with exactly one `exited`. */
  run(req: RunRequest): AsyncIterable<AgentEvent>;
  /** Kills the run's whole process group. No-op for unknown runs. */
  cancel(runId: string): Promise<void>;
  /** Best available usage data; may be empty. */
  usage(route: string): Promise<UsageSnapshot[]>;
  /** argv for the vendor's interactive CLI resumed on a session (attach). */
  interactiveCommand(sessionId: string, cwd: string): { argv: string[] };
}
