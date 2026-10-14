import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FakeAdapter, type FakeScript } from "@harness/adapters";
import type { RunRequest } from "@harness/adapters";
import { createTempRepo, type TempRepo } from "./temp-repo.js";

export interface ScenarioOptions {
  /** harness.yaml body (defaults to two fake routes and frontend/backend/reviewer roles). */
  config?: string;
  checks?: string;
  files?: Record<string, string>;
}

export const DEFAULT_CONFIG = `version: 1
project: demo
routes:
  fast:
    vendor: fake
    auth: api_key
  slow:
    vendor: fake
    auth: api_key
  rev:
    vendor: fake
    auth: api_key
roles:
  frontend:
    route: fast
    paths_allow: ["src/ui/**", "src/shared/**"]
  backend:
    route: slow
    paths_allow: ["src/server/**", "src/shared/**", "docs/contracts/**"]
  reviewer:
    route: rev
    mode: readonly
    independent_of: [frontend, backend]
limits:
  max_attempts_per_task: 3
burst:
  resume_jitter_seconds: [0, 0]
`;

/** A check that passes unless a file named FAIL exists in the worktree (agents control it). */
export const DEFAULT_CHECKS = `version: 1
checks:
  - id: unit
    argv: ["node", "-e", "const fs=require('fs'); if (fs.existsSync('FAIL')) { console.error('Error: ' + fs.readFileSync('FAIL','utf8')); process.exit(1) } console.log('ok')"]
    timeout_s: 30
env_pass: []
`;

export interface Scenario {
  repo: TempRepo;
  home: string;
  /** Scripts per task id (initial runs) and per task id + kind. */
  scripts: Map<string, FakeScript | ((req: RunRequest) => FakeScript)>;
  adapters: Map<string, FakeAdapter>;
  adapterFactory: (route: string) => FakeAdapter;
  cleanup(): void;
}

/** Temp repo + temp HARNESS_HOME + fake adapters scripted per task. */
export function createScenario(o: ScenarioOptions = {}): Scenario {
  const repo = createTempRepo({ "README.md": "# demo\n", "src/shared/a.ts": "export const a = 1;\n", ...o.files });
  repo.write("harness.yaml", o.config ?? DEFAULT_CONFIG);
  repo.write(".harness/checks.yaml", o.checks ?? DEFAULT_CHECKS);
  repo.write("AGENTS.md", "# conventions\n");
  repo.commit("harness config");
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "harness-home-")));
  const scripts: Scenario["scripts"] = new Map();
  const adapters = new Map<string, FakeAdapter>();
  const scriptFor = (req: RunRequest): FakeScript => {
    const task = /^R-(T-\d+)-\d+$/.exec(req.runId)?.[1] ?? "";
    const s = scripts.get(task) ?? { steps: [{ kind: "result", ok: true, summary: "done" }] };
    return typeof s === "function" ? s(req) : s;
  };
  const adapterFactory = (route: string) => {
    let a = adapters.get(route);
    if (!a) {
      a = new FakeAdapter({ script: scriptFor });
      adapters.set(route, a);
    }
    return a;
  };
  return {
    repo, home, scripts, adapters, adapterFactory,
    cleanup: () => {
      repo.cleanup();
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}
