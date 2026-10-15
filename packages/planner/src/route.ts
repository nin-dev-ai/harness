import { roleGuide } from "@harness/core";
import type { RoleInfo } from "./plan.js";

/**
 * Deterministic routing: pick the write role a piece of work belongs to,
 * without asking a model. Keyword hints for well-known roles, words from each
 * role's own instructions, and file paths in the text checked against each
 * role's folders. A clear winner routes straight to that agent; a tie or no
 * signal means the work spans roles (or is unclear) and goes to the planner.
 */

const HINTS: Record<string, string[]> = {
  frontend: ["ui", "ux", "page", "pages", "component", "components", "css", "style", "styles", "styling", "button", "layout", "screen", "react", "vue", "svelte", "html", "tailwind", "theme", "dark", "modal", "form", "frontend", "client", "view", "views", "banner", "color", "colors", "animation", "responsive", "tui", "ink", "render", "display", "icon", "font"],
  backend: ["api", "apis", "endpoint", "endpoints", "server", "backend", "database", "db", "sql", "schema", "migration", "migrations", "query", "queue", "worker", "auth", "token", "cache", "redis", "postgres", "sqlite", "rpc", "daemon", "cron", "job", "jobs", "webhook", "storage", "service"],
  tests: ["test", "tests", "testing", "spec", "specs", "coverage", "flaky", "e2e", "unit", "fixture", "fixtures", "vitest", "jest", "pytest", "mock"],
  docs: ["readme", "docs", "doc", "documentation", "document", "guide", "changelog", "comment", "comments", "tutorial", "explain"],
  fullstack: ["feature", "end-to-end", "fullstack", "full-stack", "both"],
};

const STOP = new Set(["the", "and", "for", "with", "not", "its", "their", "code", "change", "changes", "never", "every", "each", "owns", "that", "this", "from", "into", "what", "work", "writes", "fixes", "does"]);

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length > 1);
const PATH = /(?:^|\s|`|")((?:\.?[\w@-]+\/)+[\w.@*-]*|[\w-]+\.(?:tsx?|jsx?|mjs|css|scss|html|md|py|go|rs|sql|json|ya?ml))(?=$|\s|`|"|[,.;:)])/g;

/** File paths mentioned in a message, e.g. `src/ui/panel.tsx` or `README.md`. */
export function mentionedPaths(text: string): string[] {
  return [...text.matchAll(PATH)].map((m) => m[1]!.replace(/[.,;:]+$/, ""));
}

export interface RouteResult {
  /** The chosen role, or undefined when no role clearly wins. */
  role: string | undefined;
  reason: string;
  scores: Record<string, number>;
}

/**
 * `inScope(role, path)` says whether a role may write a path; it is injected
 * so this package stays free of glob dependencies.
 */
export function routeWork(text: string, roles: RoleInfo[], inScope: (role: RoleInfo, path: string) => boolean): RouteResult {
  const writers = roles.filter((r) => r.mode === "write");
  if (writers.length === 1) return { role: writers[0]!.name, reason: "the only agent that writes code", scores: { [writers[0]!.name]: 1 } };
  const tokens = new Set(words(text));
  const paths = mentionedPaths(text);
  const scores: Record<string, number> = {};
  const why: Record<string, string[]> = {};
  for (const r of writers) {
    let s = 0;
    const hit: string[] = [];
    const vocab = new Set([...(HINTS[r.name] ?? []), ...words(roleGuide(r.name, r.instructions)).filter((w) => w.length > 2 && !STOP.has(w)), r.name]);
    for (const w of vocab) if (tokens.has(w)) {
      s += 1;
      hit.push(w);
    }
    // Folder scope is the strongest signal: a role that cannot write a mentioned file is out.
    for (const p of paths) {
      if (!r.pathsAllow) continue;
      if (inScope(r, p)) {
        s += 3;
        hit.push(p);
      } else s -= 5;
    }
    scores[r.name] = s;
    why[r.name] = hit;
  }
  const ranked = writers.map((r) => r.name).sort((a, b) => scores[b]! - scores[a]!);
  const [best, second] = ranked;
  if (best === undefined || scores[best]! <= 0) return { role: undefined, reason: "no agent clearly matches", scores };
  // A second role with real signal means the work likely spans both: let the planner split it.
  if (second !== undefined && scores[second]! > 0 && scores[best]! < 3 * scores[second]!) return { role: undefined, reason: `touches both ${best} and ${second}`, scores };
  return { role: best, reason: `matched ${why[best]!.slice(0, 4).join(", ")}`, scores };
}
