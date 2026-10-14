import { describe, expect, it } from "vitest";
import { HarnessConfigSchema } from "@harness/core";
import { checkScope, isSecretPath, protectedTouched } from "./paths.js";
import { unattendedDecision, unattendedSetting } from "./routes.js";
import { addedDependencies, dependencyFiles, maskSecrets, secretValues } from "./commands.js";
import { findApproval, nextApprovalId, requiresApproval } from "./approvals.js";
import { isBudgetIncrease } from "./caps.js";

const cfg = HarnessConfigSchema.parse({
  version: 1, project: "p",
  routes: { sub: { vendor: "claude", auth: "subscription" }, key: { vendor: "cursor", auth: "api_key" }, d: { vendor: "codex", auth: "subscription" } },
  roles: { a: { route: "sub" } },
  policy: { unattended: { d: "deny" } },
});

describe("policy", () => {
  it("checks write scope with allow and deny", () => {
    const r = checkScope(["src/ui/a.ts", "src/server/b.ts", "src/ui/.env.local"], ["src/ui/**"], ["**/.env*"]);
    expect(r.allowed).toEqual(["src/ui/a.ts"]);
    expect(r.violations).toEqual([{ file: "src/server/b.ts", why: "not_allowed" }, { file: "src/ui/.env.local", why: "denied" }]);
    expect(checkScope(["anything.ts"], undefined, []).violations).toEqual([]);
  });
  it("finds protected and secret paths", () => {
    expect(protectedTouched([".github/workflows/ci.yml", "src/a.ts", "harness.yaml"], cfg.policy.protected_paths)).toEqual([".github/workflows/ci.yml", "harness.yaml"]);
    expect(isSecretPath("config/.env.production")).toBe(true);
    expect(isSecretPath("src/env.ts")).toBe(false);
  });
  it("defaults unattended to ask for subscriptions and allow for API keys", () => {
    expect(unattendedSetting(cfg, "sub")).toBe("ask");
    expect(unattendedSetting(cfg, "key")).toBe("allow");
    expect(unattendedDecision(cfg, "sub", false)).toEqual({ ok: false, action: "ask" });
    expect(unattendedDecision(cfg, "d", false)).toEqual({ ok: false, action: "deny" });
    expect(unattendedDecision(cfg, "d", true)).toEqual({ ok: true });
  });
  it("detects added dependencies", () => {
    expect(dependencyFiles(["package.json", "src/a.ts", "web/pnpm-lock.yaml"])).toEqual(["package.json", "web/pnpm-lock.yaml"]);
    expect(addedDependencies("package.json", '{"dependencies":{"a":"1"}}', '{"dependencies":{"a":"2","left-pad":"1"},"devDependencies":{"vitest":"1"}}')).toEqual(["left-pad", "vitest"]);
    expect(addedDependencies("requirements.txt", "requests==2\n", "requests==2\nnumpy>=1\n")).toEqual(["numpy"]);
    expect(addedDependencies("go.mod", "require github.com/a/b v1.0.0\n", "require github.com/a/b v1.0.0\nrequire github.com/c/d v0.1.0\n")).toEqual(["github.com/c/d"]);
    expect(addedDependencies("README.md", "", "x")).toEqual([]);
  });
  it("masks secrets by pattern and value", () => {
    const vals = secretValues({ MY_API_KEY: "supersecretvalue123", PATH: "/bin" });
    expect(vals).toEqual(["supersecretvalue123"]);
    expect(maskSecrets("key=supersecretvalue123 tok=ghp_abcdefghijklmnopqrstuvwxyz0123 sk-ant-api03-abcdefghijklmnop", vals)).toBe("key=[masked] tok=[masked] [masked]");
  });
  it("handles approvals and budget increases", () => {
    expect(requiresApproval(cfg, "protected_paths")).toBe(true);
    expect(requiresApproval(cfg, "new_scope")).toBe(false);
    const list = [{ id: "A-1", taskId: "T-1", category: "x", action: "run", state: "GRANTED" as const }];
    expect(findApproval(list, "T-1", "run")?.id).toBe("A-1");
    expect(findApproval(list, "T-1", "merge")).toBeUndefined();
    expect(findApproval(list, "T-2", "run")).toBeUndefined();
    expect(nextApprovalId([{ id: "A-1" }, { id: "A-7" }, { id: "REJ-x" }])).toBe("A-8");
    expect(isBudgetIncrease({ window_5h_cap_pct: 80 }, { window_5h_cap_pct: 90 })).toBe(true);
    expect(isBudgetIncrease({ window_5h_cap_pct: 80 }, { window_5h_cap_pct: 70 })).toBe(false);
  });
});
