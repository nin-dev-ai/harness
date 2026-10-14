import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ClaudeAdapter, CodexAdapter, CursorAdapter, collect, filterEnv, type AgentAdapter } from "@harness/adapters";

/**
 * Live smoke tests: one trivial real prompt per vendor. Off unless
 * HARNESS_SMOKE names the vendor (pnpm smoke:claude|codex|cursor). Spends quota.
 */
const vendor = process.env.HARNESS_SMOKE;
const adapters: Record<string, () => AgentAdapter> = {
  claude: () => new ClaudeAdapter(),
  codex: () => new CodexAdapter(),
  cursor: () => new CursorAdapter({ auth: "subscription" }),
};

describe.skipIf(!vendor)(`smoke: ${vendor ?? "off"}`, () => {
  it("detects, runs one read-only prompt, and reports a session", async () => {
    const a = adapters[vendor!]!();
    const d = await a.detect();
    expect(d.installed).toBe(true);
    expect(d.signedIn).toBe("yes");
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "harness-smoke-"));
    const events = await collect(
      a.run({ runId: "R-T-000-1", cwd, prompt: "Reply with exactly: OK", mode: "readonly", allowedPaths: [], env: filterEnv(process.env), timeoutMs: 120_000 }),
    );
    expect(events[0]).toMatchObject({ type: "started", sessionId: expect.any(String) });
    expect(events.find((e) => e.type === "result")).toMatchObject({ ok: true });
    console.log("usage:", JSON.stringify(await a.usage("smoke")));
  }, 180_000);
});
