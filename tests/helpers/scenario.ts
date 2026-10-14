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
    const task = /^R-(T-\d+|PLAN|ROLES)-\d+$/.exec(req.runId)?.[1] ?? "";
    const s =
      scripts.get(task) ??
      (req.mode === "readonly"
        ? { steps: [{ kind: "result" as const, ok: true, summary: "reviewed", structured: { summary: "ok", findings: [] } }] }
        : { steps: [{ kind: "result" as const, ok: true, summary: "done" }] });
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

// ── running a daemon with the engine against a scenario ──────────────────

import { FakeClock, type TaskState } from "@harness/core";
import { Daemon, EnginePlugin, type GuardFactory, type ProjectEngine, type ProjectRuntime } from "@harness/daemon";
import { waitFor } from "./fake-clock.js";

export interface Harness {
  daemon: Daemon;
  plugin: EnginePlugin;
  project: ProjectRuntime;
  engine: ProjectEngine;
  clock: FakeClock;
  /** Wait until the task reaches one of the states (real time; runs are real processes). */
  until(taskId: string, ...states: TaskState[]): Promise<void>;
  stop(): Promise<void>;
}

export async function startHarness(s: Scenario, o: { clock?: FakeClock; guards?: GuardFactory; noServer?: boolean } = {}): Promise<Harness> {
  const clock = o.clock ?? new FakeClock("2026-01-05T09:00:00Z");
  const plugin = new EnginePlugin(o.guards);
  const daemon = new Daemon({ home: s.home, clock, adapterFactory: (r) => s.adapterFactory(r), noServer: o.noServer ?? true }).use(plugin);
  await daemon.start();
  const project = await daemon.openProject(s.repo.root);
  plugin.onProjectOpen(project);
  const engine = plugin.engine(project.id);
  return {
    daemon, plugin, project, engine, clock,
    until: (taskId, ...states) =>
      waitFor(() => states.includes(project.task(taskId).state), 20_000, `${taskId} in ${states.join("|")} (now ${project.task(taskId).state})`),
    stop: async () => {
      await engine.idle();
      await daemon.stop();
    },
  };
}

/** Script by run mode: write runs get `impl`, read-only (review) runs get `review`. */
export function byMode(impl: FakeScript, review?: FakeScript): (req: RunRequest) => FakeScript {
  return (req) => (req.mode === "readonly" ? (review ?? approve()) : impl);
}

/** A reviewer result with findings. */
export function approve(findings: { severity: "blocker" | "major" | "nit"; message: string; file?: string; line?: number }[] = []): FakeScript {
  return { steps: [{ kind: "result", ok: true, summary: "reviewed", structured: { summary: "reviewed", findings: findings.map((f) => ({ file: null, line: null, ...f })) } }] };
}

/** Implementer steps that write files then report success. */
export function writes(files: Record<string, string | null>, extra: Partial<FakeScript> = {}): FakeScript {
  return {
    steps: [
      ...Object.entries(files).map(([path, content]) => (content === null ? { kind: "file_change" as const, path, delete: true } : { kind: "file_change" as const, path, content })),
      { kind: "result", ok: true, summary: `wrote ${Object.keys(files).join(", ")}` },
    ],
    ...extra,
  };
}
