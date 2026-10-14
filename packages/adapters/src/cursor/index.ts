import type { DetectResult, RunRequest } from "../types.js";
import { CliAdapter, type CliAdapterOptions } from "../cli-adapter.js";
import type { LineParser } from "../process.js";
import { createCursorParser, CURSOR_LIMIT_PATTERN } from "./parse.js";
import { CURSOR_BINARIES, detectCursor } from "./detect.js";

export { createCursorParser, CURSOR_LIMIT_PATTERN } from "./parse.js";
export { detectCursor } from "./detect.js";

export interface CursorAdapterOptions extends CliAdapterOptions {
  auth?: "subscription" | "api_key";
}

/** Cursor agent adapter. Invocation recorded in docs/VENDORS.md (2026.10.14). */
export class CursorAdapter extends CliAdapter {
  readonly vendor = "cursor" as const;
  protected readonly binaries = CURSOR_BINARIES;
  protected readonly limitPattern = CURSOR_LIMIT_PATTERN;

  constructor(private readonly cursorOpts: CursorAdapterOptions = {}) {
    super(cursorOpts);
  }

  protected args(req: RunRequest): string[] {
    const a = ["-p", req.prompt, "--output-format", "stream-json", "--trust"];
    if (req.mode === "readonly") a.push("--mode", "plan");
    else a.push("--force");
    if (req.model) a.push("--model", req.model);
    if (req.resumeSessionId) a.push("--resume", req.resumeSessionId);
    return a;
  }

  protected parser(_req: RunRequest): LineParser {
    return createCursorParser();
  }

  detect(): Promise<DetectResult> {
    return detectCursor(this.cursorOpts.auth, this.opts.bin?.[0]);
  }

  interactiveCommand(sessionId: string, _cwd: string): { argv: string[] } {
    return { argv: [this.bin0(), "--resume", sessionId] };
  }
}
