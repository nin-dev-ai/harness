import fs from "node:fs";
import path from "node:path";
import type { ChecksConfig } from "@harness/core";

export interface DetectedChecks {
  checks: ChecksConfig;
  /** Human-readable notes on what was found and from where. */
  sources: string[];
}

type Pm = "pnpm" | "yarn" | "npm" | "bun";

function packageManager(root: string): Pm {
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(root, "bun.lockb")) || fs.existsSync(path.join(root, "bun.lock"))) return "bun";
  return "npm";
}

const INSTALL: Record<Pm, string[]> = {
  pnpm: ["pnpm", "install", "--frozen-lockfile"],
  yarn: ["yarn", "install", "--frozen-lockfile"],
  npm: ["npm", "ci"],
  bun: ["bun", "install", "--frozen-lockfile"],
};

function readJson(file: string): Record<string, unknown> | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

function makeTargets(root: string): Set<string> {
  try {
    const text = fs.readFileSync(path.join(root, "Makefile"), "utf8");
    return new Set([...text.matchAll(/^([A-Za-z0-9_-]+):/gm)].map((m) => m[1]!));
  } catch {
    return new Set();
  }
}

/**
 * Propose checks.yaml from the repo's manifests. Detection only: nothing is run.
 * Order of preference: package.json scripts, pyproject, Cargo, go.mod, Makefile.
 */
export function detectChecks(root: string): DetectedChecks {
  const checks: ChecksConfig["checks"] = [];
  const setup: ChecksConfig["setup"] = [];
  const sources: string[] = [];
  const add = (id: string, argv: string[], required: boolean, timeout_s: number, source: string) => {
    if (checks.some((c) => c.id === id)) return;
    checks.push({ id, argv, required, timeout_s, scope: "all" });
    sources.push(`${id}: ${argv.join(" ")} (from ${source})`);
  };

  const pkg = readJson(path.join(root, "package.json"));
  if (pkg) {
    const pm = packageManager(root);
    const scripts = (pkg.scripts ?? {}) as Record<string, string>;
    const run = (s: string) => (pm === "npm" ? ["npm", "run", s] : [pm, s]);
    if (scripts.typecheck) add("typecheck", run("typecheck"), true, 300, "package.json");
    else if (scripts["type-check"]) add("typecheck", run("type-check"), true, 300, "package.json");
    if (scripts.lint) add("lint", run("lint"), true, 180, "package.json");
    if (scripts.test && !/no test specified/.test(scripts.test)) add("unit", pm === "npm" ? ["npm", "test"] : [pm, "test"], true, 600, "package.json");
    if (scripts.build) add("build", run("build"), false, 600, "package.json");
    setup.push({ argv: INSTALL[pm], timeout_s: 600 });
  }

  const pyproject = fs.existsSync(path.join(root, "pyproject.toml")) ? fs.readFileSync(path.join(root, "pyproject.toml"), "utf8") : "";
  if (pyproject) {
    const uv = fs.existsSync(path.join(root, "uv.lock"));
    const pre = uv ? ["uv", "run"] : [];
    if (/\bmypy\b/.test(pyproject)) add("typecheck", [...pre, "mypy", "."], true, 300, "pyproject.toml");
    if (/\bruff\b/.test(pyproject)) add("lint", [...pre, "ruff", "check", "."], true, 180, "pyproject.toml");
    if (/\bpytest\b/.test(pyproject) || fs.existsSync(path.join(root, "tests"))) add("unit", [...pre, "pytest", "-q"], true, 600, "pyproject.toml");
    if (uv) setup.push({ argv: ["uv", "sync", "--frozen"], timeout_s: 600 });
  }

  if (fs.existsSync(path.join(root, "Cargo.toml"))) {
    add("typecheck", ["cargo", "check", "--all-targets"], true, 600, "Cargo.toml");
    add("lint", ["cargo", "clippy", "--all-targets", "--", "-D", "warnings"], true, 600, "Cargo.toml");
    add("unit", ["cargo", "test"], true, 900, "Cargo.toml");
  }

  if (fs.existsSync(path.join(root, "go.mod"))) {
    add("typecheck", ["go", "vet", "./..."], true, 300, "go.mod");
    add("unit", ["go", "test", "./..."], true, 600, "go.mod");
    add("build", ["go", "build", "./..."], false, 600, "go.mod");
  }

  const targets = makeTargets(root);
  for (const [t, id, required] of [["test", "unit", true], ["lint", "lint", true], ["typecheck", "typecheck", true], ["build", "build", false]] as const) {
    if (targets.has(t)) add(id, ["make", t], required, 600, "Makefile");
  }

  return { checks: { version: 1, checks, setup, env_pass: ["CI", "NODE_ENV"] }, sources };
}

const TEST_FILE = /(\.|_)(test|spec)\.[cm]?[jt]sx?$|^test_.*\.py$|_test\.py$|_test\.go$/;
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", ".harness", "target", ".venv", "venv", "__pycache__", "coverage"]);

/** Count test files in a repo (bounded walk). */
export function countTestFiles(root: string, max = 20_000): number {
  let count = 0;
  let seen = 0;
  const walk = (dir: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > max) return;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(path.join(dir, e.name));
      } else if (TEST_FILE.test(e.name) || (e.name.endsWith(".rs") && dir.split(path.sep).includes("tests"))) count++;
    }
  };
  walk(root);
  return count;
}
