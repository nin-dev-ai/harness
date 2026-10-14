import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { ContractScenario, ContractSubject } from "../contract-suite.js";
import type { AgentAdapter } from "../types.js";
import type { CliAdapterOptions } from "../cli-adapter.js";
import { tryJson, type LineParser, type OutputLine } from "../process.js";
import type { AgentEvent } from "@harness/core";

const here = path.dirname(fileURLToPath(import.meta.url));
export const REPLAY_BIN = path.join(here, "replay.mjs");
export const FIXTURES = path.resolve(here, "../../../../fixtures");

export function fixture(rel: string): string {
  return path.join(FIXTURES, rel);
}

/** Write a temp file and return its path (for inline stdout/stderr). */
export function tempFile(content: string): string {
  const f = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "harness-replay-")), "out");
  fs.writeFileSync(f, content);
  return f;
}

export interface ReplayPlan {
  stdout?: string;
  stderr?: string;
  exit?: number;
  mode?: "hang" | "child";
}

/**
 * A contract subject for a CLI adapter: each scenario replays a fixture
 * through replay.mjs. `plans` returns undefined for scenarios a vendor cannot produce.
 */
export function replaySubject(
  name: string,
  make: (opts: CliAdapterOptions) => AgentAdapter,
  plans: (s: ContractScenario) => ReplayPlan | undefined,
): ContractSubject {
  return {
    name,
    prepare(s) {
      const p = plans(s);
      if (!p) return undefined;
      const extraEnv: Record<string, string> = {};
      if (p.stdout) extraEnv.REPLAY_STDOUT = p.stdout;
      if (p.stderr) extraEnv.REPLAY_STDERR = p.stderr;
      if (p.exit !== undefined) extraEnv.REPLAY_EXIT = String(p.exit);
      if (p.mode) extraEnv.REPLAY_MODE = p.mode;
      return make({ bin: [process.execPath, REPLAY_BIN], extraEnv });
    },
  };
}

/** Wraps a vendor parser so the replay child's pid line surfaces as the contract suite expects. */
export function withReplayChild(parser: LineParser): LineParser {
  return (line: OutputLine, runId: string) => {
    const o = tryJson(line.line) as { type?: string; pid?: number } | undefined;
    if (o?.type === "harness_replay_child") return { events: [{ type: "message", runId, text: "child", raw: { pid: o.pid } } as AgentEvent] };
    return parser(line, runId);
  };
}

/** Feed a fixture file through a parser and collect events. */
export function parseFixture(parser: LineParser, file: string, stream: "stdout" | "stderr" = "stdout"): { events: AgentEvent[]; sessionIds: string[] } {
  const events: AgentEvent[] = [];
  const sessionIds: string[] = [];
  for (const l of fs.readFileSync(file, "utf8").split("\n")) {
    if (!l.trim()) continue;
    const r = parser({ stream, line: l }, "R-T-001-1");
    events.push(...r.events);
    if (r.sessionId) sessionIds.push(r.sessionId);
  }
  return { events, sessionIds };
}

/** Common replay plans built from a vendor's fixtures. */
export function standardPlans(f: { success: string; rateLimit?: string; limitStderr: string; crashStdout?: string }) {
  const sessionLine = tempFile(fs.readFileSync(f.success, "utf8").split("\n")[0] + "\n");
  const garbage = tempFile(["not json", "{broken", '{"type":"brand_new_event_type","x":1}', fs.readFileSync(f.success, "utf8")].join("\n"));
  return (s: ContractScenario): ReplayPlan | undefined => {
    switch (s) {
      case "success":
        return { stdout: f.success, exit: 0 };
      case "rate_limit":
        return f.rateLimit ? { stdout: f.rateLimit, exit: 1 } : undefined;
      case "unstructured_limit":
        return { stderr: tempFile(f.limitStderr), exit: 1 };
      case "garbage":
        return { stdout: garbage, exit: 0 };
      case "crash":
        return { ...(f.crashStdout ? { stdout: tempFile(f.crashStdout) } : {}), exit: 3 };
      case "hang":
        return { stdout: sessionLine, mode: "hang" };
      case "hang_with_child":
        return { stdout: sessionLine, mode: "child" };
    }
  };
}
