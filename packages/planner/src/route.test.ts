import { describe, expect, it } from "vitest";
import { mentionedPaths, routeWork } from "./route.js";
import type { RoleInfo } from "./plan.js";

const roles: RoleInfo[] = [
  { name: "backend", mode: "write", instructions: "", pathsAllow: ["src/server/**"] },
  { name: "frontend", mode: "write", instructions: "", pathsAllow: ["src/ui/**"] },
  { name: "reviewer", mode: "readonly", instructions: "", pathsAllow: undefined },
];
const inScope = (r: RoleInfo, p: string) => (r.pathsAllow ?? []).some((g) => p.startsWith(g.replace("**", "")));

describe("routeWork", () => {
  it("routes clear single-role work without a model", () => {
    expect(routeWork("Add a dark mode toggle button to the settings page", roles, inScope).role).toBe("frontend");
    expect(routeWork("The quotes API endpoint returns 500 when the database is empty", roles, inScope).role).toBe("backend");
  });

  it("file paths beat keywords: a role that cannot write the file is out", () => {
    const r = routeWork("fix the button colors in src/server/render.ts", roles, inScope);
    expect(r.role).toBe("backend");
    expect(r.reason).toContain("src/server/render.ts");
  });

  it("work spanning roles, or with no signal, is left for the planner", () => {
    expect(routeWork("Build a quotes API and a watchlist page that shows it", roles, inScope).role).toBeUndefined();
    expect(routeWork("make it better", roles, inScope)).toMatchObject({ role: undefined, reason: "no agent clearly matches" });
  });

  it("uses a custom role's own instructions and a lone writer always wins", () => {
    const custom: RoleInfo[] = [...roles, { name: "infra", mode: "write", instructions: "Terraform, Kubernetes and deployment pipelines", pathsAllow: undefined }];
    expect(routeWork("bump the kubernetes replicas for terraform", custom, inScope).role).toBe("infra");
    expect(routeWork("anything", roles.slice(1), inScope).role).toBe("frontend");
  });

  it("finds paths in prose", () => {
    expect(mentionedPaths("see `src/ui/panel.tsx`, README.md and packages/tui/src/App.tsx.")).toEqual(["src/ui/panel.tsx", "README.md", "packages/tui/src/App.tsx"]);
  });
});
