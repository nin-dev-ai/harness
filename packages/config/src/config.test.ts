import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ValidationError } from "@harness/core";
import { loadProject, parseChecksConfig, parseHarnessConfig } from "./load.js";
import { capPct, effectiveUnattended, starterConfig } from "./defaults.js";
import { addRoute, setRoleRoute, writeChecksConfig } from "./write.js";
import { countTestFiles, detectChecks } from "./detect-checks.js";
import { findCycle, formatTaskFile, listTaskFiles, parseTaskFile, readTaskFile, setTaskFileState, writeTaskFile } from "./tasks.js";

const PRD_EXAMPLE = `version: 1
project: market-terminal
integration_branch: harness/integration
base_branch: main

routes:
  claude-sub:
    vendor: claude
    auth: subscription
  codex-sub:
    vendor: codex
    auth: subscription
  cursor-key:
    vendor: cursor
    auth: api_key

roles:
  planner:
    route: claude-sub
    mode: readonly
  frontend:
    route: codex-sub
    mode: write
    paths_allow: ["src/ui/**"]
  backend:
    route: claude-sub
    mode: write
    paths_allow: ["src/server/**"]
  reviewer:
    route: cursor-key
    mode: readonly
    independent_of: [frontend, backend]
    fallback: ask

limits:
  quiet_hours: "00:00-07:00"
  routes:
    claude-sub: { window_5h_cap_pct: 85, window_7d_cap_pct: 80 }
    cursor-key: { manual_budget: { unit: runs, per: day, amount: 40 } }

policy:
  autonomy: approved-scope
  unattended:
    cursor-key: allow
`;

function issues(fn: () => unknown) {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(ValidationError);
    return (e as ValidationError).issues;
  }
  throw new Error("expected a ValidationError");
}

describe("harness.yaml", () => {
  it("loads the PRD example", () => {
    const { config, warnings } = parseHarnessConfig(PRD_EXAMPLE);
    expect(config.roles.frontend?.route).toBe("codex-sub");
    expect(warnings).toEqual([]);
    expect(capPct(config, "claude-sub", "5h")).toBe(85);
    expect(capPct(config, "codex-sub", "7d")).toBe(100);
    expect(effectiveUnattended(config, "claude-sub")).toBe("ask");
    expect(effectiveUnattended(config, "cursor-key")).toBe("allow");
  });

  it("rejects an unknown key with its line number", () => {
    const text = PRD_EXAMPLE.replace("    fallback: ask", "    fallback: ask\n    fallbak: auto");
    const [i] = issues(() => parseHarnessConfig(text));
    expect(i).toMatchObject({ message: 'unknown key "fallbak"', line: 34 });
  });

  it("rejects a missing route with its line number", () => {
    const text = PRD_EXAMPLE.replace("route: codex-sub", "route: codex-pro");
    const [i] = issues(() => parseHarnessConfig(text));
    expect(i?.message).toContain('route "codex-pro" is not defined');
    expect(i?.line).toBe(22);
  });

  it("rejects a role with no route", () => {
    const text = PRD_EXAMPLE.replace("    route: claude-sub\n    mode: readonly\n", "    mode: readonly\n");
    const [i] = issues(() => parseHarnessConfig(text));
    expect(i).toMatchObject({ path: "roles.planner.route", line: 18 });
  });

  it("rejects two fallback routes of the same vendor (no account rotation)", () => {
    const text = PRD_EXAMPLE.replace("  cursor-key:\n    vendor: cursor", "  claude-2:\n    vendor: claude\n    auth: subscription\n  cursor-key:\n    vendor: cursor").replace(
      "    fallback: ask",
      "    fallback: auto\n    fallback_routes: [claude-sub, claude-2]",
    );
    const all = issues(() => parseHarnessConfig(text));
    expect(all.some((i) => i.message.includes("more than one route of vendor claude"))).toBe(true);
  });

  it("warns on write roles without paths_allow and same-route reviewers", () => {
    const text = PRD_EXAMPLE.replace('    paths_allow: ["src/server/**"]\n', "").replace("route: cursor-key\n    mode: readonly", "route: claude-sub\n    mode: readonly");
    const { warnings } = parseHarnessConfig(text);
    expect(warnings.map((w) => w.message).join("\n")).toMatch(/no paths_allow[\s\S]*same-route/);
  });

  it("reports YAML syntax errors with a line", () => {
    const [i] = issues(() => parseHarnessConfig("version: 1\nroutes: [\n"));
    expect(i?.line).toBeGreaterThan(0);
  });

  it("produces a valid starter config", () => {
    for (const v of [[], ["claude"], ["claude", "codex", "cursor"]] as const) {
      expect(() => parseHarnessConfig(starterConfig("demo", [...v]))).not.toThrow();
    }
  });
});

describe("checks.yaml", () => {
  it("rejects duplicates and warns with no required checks", () => {
    expect(issues(() => parseChecksConfig("version: 1\nchecks:\n  - id: a\n    argv: [x]\n  - id: a\n    argv: [y]\n"))[0]).toMatchObject({ line: 5 });
    expect(parseChecksConfig("version: 1\nchecks:\n  - id: a\n    argv: [x]\n    required: false\n").warnings).toHaveLength(1);
  });
});

describe("files on disk", () => {
  let root: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "harness-cfg-"));
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  it("detects checks from package.json and writes checks.yaml", () => {
    fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ scripts: { test: "vitest", lint: "eslint .", typecheck: "tsc", build: "tsup" } }));
    fs.writeFileSync(path.join(root, "pnpm-lock.yaml"), "");
    const d = detectChecks(root);
    expect(d.checks.checks.map((c) => [c.id, c.argv.join(" "), c.required])).toEqual([
      ["typecheck", "pnpm typecheck", true], ["lint", "pnpm lint", true], ["unit", "pnpm test", true], ["build", "pnpm build", false],
    ]);
    expect(d.checks.setup[0]?.argv).toEqual(["pnpm", "install", "--frozen-lockfile"]);
    writeChecksConfig(root, d.checks);
    fs.writeFileSync(path.join(root, "harness.yaml"), starterConfig("demo", ["claude"]));
    const p = loadProject(root);
    expect(p.checks.checks).toHaveLength(4);
  });

  it("detects Makefile, go and python checks, and counts tests", () => {
    fs.writeFileSync(path.join(root, "Makefile"), "test:\n\tgo test\nlint:\n\techo\n");
    fs.writeFileSync(path.join(root, "go.mod"), "module x\n");
    fs.writeFileSync(path.join(root, "pyproject.toml"), "[tool.pytest]\n[tool.ruff]\n");
    fs.mkdirSync(path.join(root, "pkg"));
    fs.writeFileSync(path.join(root, "pkg/a_test.go"), "");
    fs.writeFileSync(path.join(root, "test_b.py"), "");
    fs.mkdirSync(path.join(root, "node_modules/x"), { recursive: true });
    fs.writeFileSync(path.join(root, "node_modules/x/c.test.js"), "");
    const ids = detectChecks(root).checks.checks.map((c) => c.id);
    expect(ids).toEqual(expect.arrayContaining(["unit", "lint", "typecheck", "build"]));
    expect(countTestFiles(root)).toBe(2);
  });

  it("edits harness.yaml keeping comments, refusing invalid edits", () => {
    fs.writeFileSync(path.join(root, "harness.yaml"), starterConfig("demo", ["claude", "codex"]));
    setRoleRoute(root, "frontend", "claude-sub");
    const text = fs.readFileSync(path.join(root, "harness.yaml"), "utf8");
    expect(text).toContain("# task branches merge here");
    expect(parseHarnessConfig(text).config.roles.frontend?.route).toBe("claude-sub");
    expect(() => setRoleRoute(root, "frontend", "nope")).toThrow(ValidationError);
    addRoute(root, "codex-key", { vendor: "codex", auth: "api_key" });
    expect(parseHarnessConfig(fs.readFileSync(path.join(root, "harness.yaml"), "utf8")).config.routes["codex-key"]).toBeDefined();
  });

  it("round-trips task files", () => {
    const t = parseTaskFile(`---
id: T-004
title: Watchlist panel
role: frontend
state: QUEUED
depends_on: [T-002]
acceptance:
  - Panel lists symbols
---

Free-form description.
`);
    expect(t.front).toMatchObject({ id: "T-004", depends_on: ["T-002"], size: "M" });
    writeTaskFile(root, t);
    expect(readTaskFile(root, "T-004")).toEqual(t);
    expect(formatTaskFile(t)).toContain("# managed by the tool");
    setTaskFileState(root, "T-004", "RUNNING");
    expect(listTaskFiles(root)[0]?.front.state).toBe("RUNNING");
    expect(() => parseTaskFile("no front matter")).toThrow(ValidationError);
    expect(() => parseTaskFile("---\nid: T-1\ntitle: x\nrole: y\nbogus: 1\n---\n")).toThrow(ValidationError);
  });

  it("finds dependency cycles", () => {
    expect(findCycle(new Map([["T-001", []], ["T-002", ["T-001"]]]))).toBeUndefined();
    expect(findCycle(new Map([["T-001", ["T-003"]], ["T-002", ["T-001"]], ["T-003", ["T-002"]]]))).toEqual(["T-001", "T-003", "T-002", "T-001"]);
  });
});

describe("wizard config", () => {
  it("builds a valid harness.yaml from wizard answers", async () => {
    const { configFromWizard } = await import("./defaults.js");
    const text = configFromWizard("shop", [
      { role: "planner", vendor: "claude", mode: "readonly" },
      { role: "backend", vendor: "claude", model: "opus", mode: "write", pathsAllow: ["src/server/**"], concurrency: 2 },
      { role: "frontend", vendor: "codex", mode: "write", pathsAllow: ["src/ui/**"] },
      { role: "reviewer", vendor: "cursor", mode: "readonly" },
    ]);
    const { config, warnings } = parseHarnessConfig(text);
    expect(Object.keys(config.routes)).toEqual(["claude", "claude-opus", "codex", "cursor"]);
    expect(config.roles.backend).toMatchObject({ route: "claude-opus", concurrency: 2, paths_allow: ["src/server/**"] });
    expect(config.roles.reviewer?.independent_of).toEqual(["backend", "frontend"]);
    expect(config.routes.cursor?.auth).toBe("api_key");
    expect(warnings).toEqual([]);
  });
});
