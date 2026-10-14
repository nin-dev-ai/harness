import type { Route } from "@harness/core";
import type { AgentAdapter } from "./types.js";
import { ClaudeAdapter } from "./claude/index.js";
import { CodexAdapter } from "./codex/index.js";
import { CursorAdapter } from "./cursor/index.js";
import { FakeAdapter } from "./fake/index.js";

/** Build the adapter for a route. One adapter instance per route. */
export function createAdapter(routeName: string, route: Route): AgentAdapter {
  switch (route.vendor) {
    case "claude":
      return new ClaudeAdapter({ route: routeName, auth: route.auth });
    case "codex":
      return new CodexAdapter({ route: routeName, auth: route.auth });
    case "cursor":
      return new CursorAdapter({ route: routeName, auth: route.auth });
    case "fake":
      return new FakeAdapter();
  }
}
