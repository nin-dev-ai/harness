import type { DetectResult, RunRequest } from "../types.js";
import { CliAdapter, type CliAdapterOptions } from "../cli-adapter.js";
import type { LineParser } from "../process.js";
import { CLAUDE_LIMIT_PATTERN, createClaudeParser } from "./parse.js";
import { mergeWindows } from "./usage.js";
import { CLAUDE_BINARIES, detectClaude } from "./detect.js";

export { createClaudeParser, claudeWindows, CLAUDE_LIMIT_PATTERN } from "./parse.js";
export { detectClaude } from "./detect.js";

/** Tools a write-mode run may use. Everything else is denied headless. */
export const CLAUDE_WRITE_TOOLS = ["Read", "Write", "Edit", "MultiEdit", "Glob", "Grep", "Bash", "NotebookEdit", "TodoWrite"];
export const CLAUDE_EDIT_TOOLS = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

export interface ClaudeAdapterOptions extends CliAdapterOptions {
  auth?: "subscription" | "api_key";
}

/** Claude Code adapter. Invocation recorded in docs/VENDORS.md (claude 2.1.285). */
export class ClaudeAdapter extends CliAdapter {
  readonly vendor = "claude" as const;
  protected readonly binaries = CLAUDE_BINARIES;
  protected readonly limitPattern = CLAUDE_LIMIT_PATTERN;

  constructor(private readonly claudeOpts: ClaudeAdapterOptions = {}) {
    super(claudeOpts);
  }

  protected args(req: RunRequest): string[] {
    const a = ["-p", req.prompt, "--output-format", "stream-json", "--verbose"];
    if (req.mode === "readonly") a.push("--permission-mode", "plan", "--disallowedTools", CLAUDE_EDIT_TOOLS.join(","));
    else a.push("--permission-mode", "acceptEdits", "--allowedTools", CLAUDE_WRITE_TOOLS.join(","));
    if (req.model) a.push("--model", req.model);
    if (req.resumeSessionId) a.push("--resume", req.resumeSessionId);
    if (req.jsonSchema) a.push("--json-schema", JSON.stringify(req.jsonSchema));
    return a;
  }

  protected parser(_req: RunRequest): LineParser {
    return createClaudeParser((w) => {
      if (w.length) this.snapshots = mergeWindows(this.snapshots, w);
    });
  }

  detect(): Promise<DetectResult> {
    return detectClaude(this.claudeOpts.auth, this.opts.bin?.[0]);
  }

  interactiveCommand(sessionId: string, _cwd: string): { argv: string[] } {
    return { argv: [this.bin0(), "--resume", sessionId] };
  }
}
