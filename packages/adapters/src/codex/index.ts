import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UsageSnapshot } from "@harness/core";
import type { DetectResult, RunRequest } from "../types.js";
import { CliAdapter, type CliAdapterOptions } from "../cli-adapter.js";
import type { LineParser } from "../process.js";
import { CODEX_LIMIT_PATTERN, createCodexParser } from "./parse.js";
import { codexHome, readCodexUsage } from "./usage.js";
import { CODEX_BINARIES, detectCodex } from "./detect.js";

export { createCodexParser, parseRetryIn, CODEX_LIMIT_PATTERN } from "./parse.js";
export { readCodexUsage, parseRolloutRateLimits } from "./usage.js";
export { detectCodex } from "./detect.js";

export interface CodexAdapterOptions extends CliAdapterOptions {
  auth?: "subscription" | "api_key";
  /** Where Codex keeps session logs (default $CODEX_HOME or ~/.codex). */
  home?: string;
}

/** Codex adapter. Invocation recorded in docs/VENDORS.md (codex-cli 0.162.1). */
export class CodexAdapter extends CliAdapter {
  readonly vendor = "codex" as const;
  protected readonly binaries = CODEX_BINARIES;
  protected readonly limitPattern = CODEX_LIMIT_PATTERN;

  constructor(private readonly codexOpts: CodexAdapterOptions = {}) {
    super(codexOpts);
  }

  protected args(req: RunRequest): string[] {
    const sandbox = req.mode === "readonly" ? "read-only" : "workspace-write";
    const model = req.model ? ["-m", req.model] : [];
    let schema: string[] = [];
    if (req.jsonSchema) {
      const file = path.join(os.tmpdir(), `harness-schema-${req.runId}.json`);
      fs.writeFileSync(file, JSON.stringify(req.jsonSchema));
      schema = ["--output-schema", file];
    }
    if (req.resumeSessionId) {
      return ["exec", "resume", "--json", "--skip-git-repo-check", "-c", `sandbox_mode="${sandbox}"`, ...model, ...schema, req.resumeSessionId, req.prompt];
    }
    return ["exec", "--json", "--skip-git-repo-check", "-s", sandbox, ...model, ...schema, req.prompt];
  }

  protected parser(_req: RunRequest): LineParser {
    return createCodexParser();
  }

  protected override async afterRun(req: RunRequest, sessionId: string | undefined): Promise<void> {
    if (req.jsonSchema) fs.rmSync(path.join(os.tmpdir(), `harness-schema-${req.runId}.json`), { force: true });
    if (!sessionId) return;
    const snaps = readCodexUsage(sessionId, this.codexOpts.home ?? codexHome());
    if (snaps.length) this.snapshots = snaps;
  }

  override async usage(route: string): Promise<UsageSnapshot[]> {
    if (!this.snapshots.length) this.snapshots = readCodexUsage(undefined, this.codexOpts.home ?? codexHome());
    return super.usage(route);
  }

  detect(): Promise<DetectResult> {
    return detectCodex(this.codexOpts.auth, this.opts.bin?.[0]);
  }

  interactiveCommand(sessionId: string, _cwd: string): { argv: string[] } {
    return { argv: [this.bin0(), "resume", sessionId] };
  }
}
