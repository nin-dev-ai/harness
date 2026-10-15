import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HarnessError } from "@harness/core";
import { Planner, separateOverlaps } from "@harness/daemon";
import { byMode, createScenario, DEFAULT_CONFIG, startHarness, writes, type Harness, type Scenario } from "../helpers/scenario.js";

/** Planner scenarios (M12): schema-validated drafts, one retry, typed failure. */
const CONFIG = DEFAULT_CONFIG.replace("roles:\n", "roles:\n  planner:\n    route: rev\n    mode: readonly\n");

const plan = (tasks: unknown[]) => ({ steps: [{ kind: "result" as const, ok: true, summary: "plan", structured: { summary: "two tasks", tasks } }] });
const t = (key: string, o: Record<string, unknown> = {}) => ({ key, title: `Task ${key}`, role: "backend", size: "S", depends_on: [], acceptance: ["passes"], files_hint: [], contract_ref: null, description: `do ${key}`, ...o });

describe("split only independent work", () => {
  it("merges same-role tasks on the same files, chains different roles, leaves independent ones alone", () => {
    const p = (key: string, role: string, files: string[], o: Record<string, unknown> = {}) => ({ key, title: key, role, size: "S" as const, depends_on: [] as string[], acceptance: [`${key} ok`], files_hint: files, contract_ref: null, description: `do ${key}`, ...o });
    const r = separateOverlaps([
      p("a", "backend", ["src/server/feed.ts"]),
      p("b", "backend", ["src/server/**"], { size: "M" }),
      p("c", "frontend", ["src/server/feed.ts", "src/ui/x.ts"]),
      p("d", "frontend", ["src/ui/other.ts"]),
      p("e", "frontend", ["src/ui/x.ts"], { depends_on: ["c"] }),
    ]);
    expect(r.tasks.map((t) => [t.key, t.role, t.size, t.depends_on])).toEqual([
      ["a", "backend", "M", []],
      ["c", "frontend", "S", ["a"]],
      ["d", "frontend", "S", []],
      ["e", "frontend", "S", ["c"]],
    ]);
    expect(r.tasks[0]).toMatchObject({ title: "a; b", acceptance: ["a ok", "b ok"], description: "do a\n\ndo b" });
    expect(r.changes).toEqual([
      { kind: "merged", keys: ["a", "b"], files: ["src/server/**"] },
      { kind: "chained", keys: ["a", "c"], files: ["src/server/feed.ts"] },
    ]);
  });
});

describe("planner", () => {
  let s: Scenario;
  let h: Harness;
  afterEach(async () => {
    await h?.stop();
    s.cleanup();
  });
  const start = async () => {
    s = createScenario({ config: CONFIG });
    h = await startHarness(s);
    return new Planner(h.project, h.daemon.supervisor);
  };

  it("drafts tasks with roles and dependencies; nothing runs until approved", async () => {
    const planner = await start();
    s.scripts.set("PLAN", plan([
      t("ui", { role: "frontend", depends_on: ["contract"], contract_ref: "docs/contracts/quotes.ts", files_hint: ["src/ui/**"] }),
      t("contract", { title: "Quote contract", files_hint: ["docs/contracts/quotes.ts"] }),
      t("ci", { title: "Add CI", files_hint: [".github/workflows/ci.yml"] }),
    ]));
    const r = await planner.plan("# PRD\nBuild a watchlist.", "docs/prd.md");
    expect(r.attempts).toBe(1);
    expect(r.tasks.map((x) => [x.id, x.title, x.state, x.dependsOn])).toEqual([
      ["T-001", "Quote contract", "DRAFT", []],
      ["T-002", "Task ui", "DRAFT", ["T-001"]],
      ["T-003", "Add CI", "DRAFT", []],
    ]);
    expect(r.needsApproval).toEqual(["T-003"]);
    const file = fs.readFileSync(path.join(s.repo.root, ".harness/tasks/T-002.md"), "utf8");
    expect(file).toContain("contract_ref: docs/contracts/quotes.ts");
    expect(file).toContain("do ui");
    const req = s.adapters.get("rev")!.requests[0]!;
    expect(req.mode).toBe("readonly");
    expect(req.jsonSchema).toBeDefined();
    expect(req.prompt).toContain("Build a watchlist.");
    expect(h.project.store.events.list({ projectId: h.project.id, types: ["plan.requested", "plan.drafted"] }).map((e) => e.type)).toEqual(["plan.requested", "plan.drafted"]);
    h.engine.start();
    await h.engine.idle();
    expect(h.project.store.runs.listByTask(h.project.id, "T-001")).toHaveLength(0);
  });

  it("retries once with the validation errors, resuming the planner session", async () => {
    const planner = await start();
    s.scripts.set("PLAN", (req) =>
      req.resumeSessionId
        ? { sessionId: "p1", steps: plan([t("a")]).steps }
        : { sessionId: "p1", steps: plan([t("a", { role: "devops" })]).steps },
    );
    const r = await planner.plan("PRD", "prd.md");
    expect(r.attempts).toBe(2);
    expect(r.tasks).toHaveLength(1);
    const retry = s.adapters.get("rev")!.requests[1]!;
    expect(retry.resumeSessionId).toBe("p1");
    expect(retry.prompt).toContain('role "devops" is not one of');
    expect(h.project.store.events.list({ projectId: h.project.id, types: ["plan.invalid"] })).toHaveLength(1);
  });

  it("fails with a typed error after the retry is also invalid", async () => {
    const planner = await start();
    s.scripts.set("PLAN", { steps: [{ kind: "result", ok: true, summary: "I think you should build it in Rust." }] });
    const err = await planner.plan("PRD", "prd.md").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(HarnessError);
    expect((err as HarnessError).code).toBe("VALIDATION");
    expect(h.project.store.events.list({ projectId: h.project.id, types: ["plan.invalid"] })).toHaveLength(2);
    expect(h.project.tasks()).toHaveLength(0);
  });

  it("proposes roles, and applies them only when asked", async () => {
    const planner = await start();
    s.scripts.set("ROLES", { steps: [{ kind: "result", ok: true, structured: { rationale: "split by layer", roles: [{ name: "api", route: "slow", mode: "write", paths_allow: ["src/api/**"], instructions: "REST" }, { name: "reviewer", route: "rev", mode: "readonly", paths_allow: null, instructions: "" }] } }] });
    const p = await planner.proposeRoles("notes");
    expect(p.roles.map((r) => r.name)).toEqual(["api", "reviewer"]);
    expect(h.project.config.roles.api).toBeUndefined();
    planner.applyRoles(p);
    expect(h.project.config.roles.api).toMatchObject({ route: "slow", paths_allow: ["src/api/**"] });
    expect(h.project.config.roles.reviewer?.independent_of).toEqual(["api"]);
    expect(h.project.store.workers.get(h.project.id, "api-1")).toBeDefined();
  });
});

describe("dispatch (chat to the team)", () => {
  let s2: Scenario;
  let h2: Harness;
  afterEach(async () => {
    await h2?.stop();
    s2.cleanup();
  });

  it("explicit planning splits one message across agents", async () => {
    s2 = createScenario({ config: CONFIG });
    h2 = await startHarness(s2);
    s2.scripts.set("PLAN", plan([
      t("api", { title: "Quote feed", role: "backend" }),
      t("ui", { title: "Watchlist", role: "frontend", depends_on: ["api"] }),
    ]));
    s2.scripts.set("T-001", byMode(writes({ "src/server/feed.ts": "x\n" })));
    s2.scripts.set("T-002", byMode(writes({ "src/ui/panel.ts": "y\n" })));
    const r = await new Planner(h2.project, h2.daemon.supervisor).plan("Live quotes with a watchlist", "chat", { chat: true });
    expect(r.tasks.map((x) => [x.id, x.role])).toEqual([["T-001", "backend"], ["T-002", "frontend"]]);
    h2.plugin.approve(h2.project, r.tasks.map((x) => x.id));
    h2.engine.start();
    await h2.until("T-001", "MERGED");
    await h2.engine.idle();
    await h2.until("T-002", "MERGED");
    expect(s2.repo.git("log", "--format=%s", "main..harness/integration").split("\n")).toEqual(["T-002: Watchlist", "T-001: Quote feed"]);
  });

  it("moves a task to the role whose folders cover its files", async () => {
    s2 = createScenario({ config: CONFIG });
    h2 = await startHarness(s2);
    s2.scripts.set("PLAN", plan([
      t("ui", { title: "Panel", role: "frontend", files_hint: ["src/ui/panel.ts"] }),
      t("feed", { title: "Feed", role: "frontend", files_hint: ["src/server/**"] }),
    ]));
    const r = await new Planner(h2.project, h2.daemon.supervisor).plan("quotes", "chat", { chat: true });
    expect(r.tasks.map((x) => [x.title, x.role])).toEqual([["Panel", "frontend"], ["Feed", "backend"]]);
    expect(s2.adapters.get("rev")!.requests[0]!.prompt).toContain("<<<MESSAGE");
    expect(h2.project.store.events.list({ projectId: h2.project.id, types: ["plan.reassigned"] }).map((e) => e.payload)).toEqual([
      { key: "feed", from: "frontend", to: "backend", files: ["src/server/**"] },
    ]);
  });

  it("one agent's job starts at once with no planner run; /task needs no @agent", async () => {
    s2 = createScenario({ config: CONFIG });
    h2 = await startHarness(s2);
    s2.scripts.set("T-001", byMode(writes({ "src/server/feed.ts": "x\n" })));
    const call = h2.daemon.handlers();
    const ctx = { attended: true, subscribe: () => () => undefined };
    const r = (await call.dispatch!({ projectId: h2.project.id, document: "Fix the 500 in src/server/feed.ts when the quotes API gets an empty symbol" }, ctx)) as { summary: string; tasks: { id: string; role: string }[] };
    expect(r.tasks.map((x) => x.role)).toEqual(["backend"]);
    expect(r.summary).toContain("backend owns this request");
    expect((s2.adapters.get("rev")?.requests ?? []).filter((q) => q.runId.startsWith("R-PLAN"))).toHaveLength(0);
    const t = (await call["task.add"]!({ projectId: h2.project.id, title: "Restyle the watchlist page layout" }, ctx)) as { role: string };
    expect(t.role).toBe("frontend");
    expect(h2.project.store.events.list({ projectId: h2.project.id, types: ["task.routed"] }).map((e) => (e.payload as { role: string }).role)).toEqual(["backend", "frontend"]);
    await h2.until("T-001", "MERGED");
  });
});

