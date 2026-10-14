import fs from "node:fs";
import type { Route } from "@harness/core";
import type { AgentAdapter } from "./types.js";
import { ClaudeAdapter } from "./claude/index.js";
import { CodexAdapter } from "./codex/index.js";
import { CursorAdapter } from "./cursor/index.js";
import { FakeAdapter, FakeScriptSchema, type FakeScript } from "./fake/index.js";
import type { RunRequest } from "./types.js";

/**
 * Scripts for the `fake` vendor from $HARNESS_FAKE_SCRIPTS (a JSON file):
 * {"T-001": script, "review": script, "*": script}. Used by demos and CLI tests.
 */
export function fakeScriptsFromEnv(env: NodeJS.ProcessEnv = process.env): ((req: RunRequest) => FakeScript) | undefined {
  const file = env.HARNESS_FAKE_SCRIPTS;
  if (!file) return undefined;
  return (req) => {
    const all = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    const task = /^R-(T-\d+|PLAN|ROLES)-\d+$/.exec(req.runId)?.[1];
    if (task === "PLAN" || task === "ROLES") return FakeScriptSchema.parse(all[task] ?? { steps: [{ kind: "result", ok: false, summary: "no planner script" }] });
    if (req.mode === "readonly") {
      return FakeScriptSchema.parse(all[`${task}:review`] ?? all.review ?? { steps: [{ kind: "result", ok: true, summary: "reviewed", structured: { summary: "ok", findings: [] } }] });
    }
    return FakeScriptSchema.parse((task ? all[task] : undefined) ?? all["*"] ?? { steps: [{ kind: "result", ok: true, summary: "done" }] });
  };
}

/** Build the adapter for a route. One adapter instance per route. */
export function createAdapter(routeName: string, route: Route): AgentAdapter {
  switch (route.vendor) {
    case "claude":
      return new ClaudeAdapter({ route: routeName, auth: route.auth });
    case "codex":
      return new CodexAdapter({ route: routeName, auth: route.auth });
    case "cursor":
      return new CursorAdapter({ route: routeName, auth: route.auth });
    case "fake": {
      const script = fakeScriptsFromEnv();
      return new FakeAdapter(script ? { script } : {});
    }
  }
}
