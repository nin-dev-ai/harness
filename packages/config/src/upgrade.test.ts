import { describe, expect, it } from "vitest";
import { parseHarnessConfig } from "./load.js";
import { upgradeConfigText } from "./upgrade.js";

const OLD = `version: 1
project: harness
routes:
  claude-sub:
    vendor: claude
    auth: subscription
  codex-sub:
    vendor: codex
    auth: subscription
  cursor-key:
    vendor: cursor
    auth: api_key                # reads CURSOR_API_KEY
roles:
  planner:
    route: claude-sub
    mode: readonly
    instructions: "Split work into small, independently testable tasks."
  backend:
    route: claude-sub
    mode: write
    concurrency: 1
  frontend:
    route: codex-sub
    mode: write
    concurrency: 1
  reviewer:
    route: cursor-key
    mode: readonly
    independent_of: [frontend, backend]
limits:
  max_attempts_per_task: 3
`;

describe("upgrade harness.yaml", () => {
  it("adds only what is missing and keeps the person's edits and comments", () => {
    const r = upgradeConfigText(OLD);
    const c = parseHarnessConfig(r.text).config;
    expect(c.roles.backend?.instructions).toMatch(/^Servers, APIs/);
    expect(c.roles.frontend?.instructions).toMatch(/^UI and client code/);
    expect(c.roles.planner?.instructions).toBe("Split work into small, independently testable tasks.");
    expect(c.roles.lead).toMatchObject({ route: "claude-sub", mode: "readonly" });
    expect(c.limits.review_sizes).toEqual(["M", "L"]);
    expect(c.roles.backend?.pool).toEqual([]);
    expect(r.text).toContain("# reads CURSOR_API_KEY");
    expect(r.changes).toHaveLength(5);
    expect(r.hints).toEqual([
      "backend could also use codex-sub, cursor-key: rerun with --pool, or add `pool: [codex-sub, cursor-key]`",
      "frontend could also use claude-sub, cursor-key: rerun with --pool, or add `pool: [claude-sub, cursor-key]`",
    ]);
  });

  it("pools writers across other vendors only when asked, and is idempotent", () => {
    const once = upgradeConfigText(OLD, { pool: true });
    const c = parseHarnessConfig(once.text).config;
    expect(c.roles.backend?.pool).toEqual(["codex-sub", "cursor-key"]);
    expect(c.roles.frontend?.pool).toEqual(["claude-sub", "cursor-key"]);
    const twice = upgradeConfigText(once.text, { pool: true });
    expect(twice.changes).toEqual([]);
    expect(twice.text).toBe(once.text);
  });
});
