import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approve, byMode, createScenario, startHarness, writes, type Harness, type Scenario } from "../helpers/scenario.js";

/** Scenario tests for the outer loop (M8), all against the fake adapter. */
describe("outer loop", () => {
  let s: Scenario;
  let h: Harness;
  let mainHead: string;
  beforeEach(() => {
    s = createScenario();
    mainHead = s.repo.git("rev-parse", "main");
  });
  afterEach(async () => {
    await h?.stop();
    expect(s.repo.git("rev-parse", "main")).toBe(mainHead); // main is never written
    for (const b of s.repo.git("branch", "--format=%(refname:short)").split("\n")) expect(b === "main" || b.startsWith("harness/")).toBe(true);
    s.cleanup();
  });

  const events = (taskId: string) => h.project.store.events.list({ projectId: h.project.id, taskId }).map((e) => e.type);

  it("happy-path: two roles in parallel worktrees, gated, reviewed, merged", async () => {
    s.scripts.set("T-001", byMode(writes({ "src/server/api.ts": "export const api = 1;\n" })));
    s.scripts.set("T-002", byMode(writes({ "src/ui/panel.ts": "export const panel = 1;\n" })));
    h = await startHarness(s);
    const a = h.project.createTask({ title: "API", role: "backend", state: "QUEUED" });
    const b = h.project.createTask({ title: "Panel", role: "frontend", state: "QUEUED" });
    h.engine.start();
    await h.until(a.id, "MERGED");
    await h.until(b.id, "MERGED");
    const log = s.repo.git("log", "--format=%s", "main..harness/integration").split("\n").sort();
    expect(log).toEqual(["T-001: API", "T-002: Panel"]);
    expect(s.repo.git("show", "harness/integration:src/ui/panel.ts")).toContain("panel");
    expect(events(a.id)).toEqual(expect.arrayContaining(["worktree.created", "gate.passed", "review.started", "review.passed", "branch.merged"]));
    expect(fs.existsSync(path.join(s.repo.root, ".harness/worktrees/T-001"))).toBe(false);
    const reviews = h.project.store.runs.listByTask(h.project.id, a.id).filter((r) => r.kind === "review");
    expect(reviews).toHaveLength(1);
    expect(h.project.task(a.id).attempts).toBe(1);
  });

  it("repair-loop: a failed check is repaired by resuming the same session", async () => {
    s.scripts.set("T-001", byMode({
      sessionId: "sess-T1",
      steps: [{ kind: "file_change", path: "src/server/a.ts", content: "x\n" }, { kind: "file_change", path: "FAIL", content: "assert failed in a.test.ts" }, { kind: "result", ok: true }],
      resumeSteps: [{ kind: "file_change", path: "FAIL", delete: true }, { kind: "result", ok: true, summary: "fixed" }],
    }));
    h = await startHarness(s);
    const t = h.project.createTask({ title: "A", role: "backend", state: "QUEUED" });
    h.engine.start();
    await h.until(t.id, "MERGED");
    const runs = h.project.store.runs.listByTask(h.project.id, t.id).filter((r) => r.kind !== "review");
    expect(runs.map((r) => r.kind)).toEqual(["initial", "repair"]);
    expect(runs[1]?.vendorSessionId).toBe("sess-T1");
    const fake = s.adapters.get("slow")!;
    const repairReq = fake.requests.find((r) => r.runId === runs[1]!.id)!;
    expect(repairReq.resumeSessionId).toBe("sess-T1");
    expect(repairReq.prompt).toContain("assert failed in a.test.ts");
    expect(events(t.id).filter((e) => e === "gate.failed")).toHaveLength(1);
    expect(h.project.task(t.id).attempts).toBe(2);
  });

  it("repair-loop: the same failure twice moves the task to NEEDS_HUMAN", async () => {
    s.scripts.set("T-001", byMode({
      steps: [{ kind: "file_change", path: "FAIL", content: "TypeError: x is undefined at /a/b/c.ts:10:5" }, { kind: "result", ok: true }],
      resumeSteps: [{ kind: "file_change", path: "FAIL", content: "TypeError: x is undefined at /a/b/c.ts:12:9" }, { kind: "file_change", path: "src/server/y.ts", content: "y\n" }, { kind: "result", ok: true }],
    }));
    h = await startHarness(s);
    const t = h.project.createTask({ title: "A", role: "backend", state: "QUEUED" });
    h.engine.start();
    await h.until(t.id, "NEEDS_HUMAN");
    const stall = h.project.store.events.list({ projectId: h.project.id, taskId: t.id, types: ["stall.detected"] });
    expect(stall[0]?.type === "stall.detected" && stall[0].payload.reason).toBe("same_signature");
  });

  it("false-success: an agent that claims success with a failing check never reaches PR_READY", async () => {
    s.scripts.set("T-001", byMode({
      steps: [{ kind: "file_change", path: "FAIL", content: "1 test failed" }, { kind: "result", ok: true, summary: "All tests pass!" }],
      resumeSteps: [{ kind: "message", text: "Everything passes." }, { kind: "result", ok: true, summary: "All tests pass!" }],
    }));
    h = await startHarness(s);
    const t = h.project.createTask({ title: "A", role: "backend", state: "QUEUED" });
    h.engine.start();
    await h.until(t.id, "NEEDS_HUMAN");
    const states = h.project.store.events.list({ projectId: h.project.id, taskId: t.id, types: ["task.state_changed"] }).map((e) => (e.type === "task.state_changed" ? e.payload.to : ""));
    expect(states).not.toContain("PR_READY");
    expect(states).not.toContain("REVIEWING");
    const stall = h.project.store.events.list({ projectId: h.project.id, taskId: t.id, types: ["stall.detected"] })[0];
    expect(stall?.type === "stall.detected" && stall.payload.reason).toBe("unchanged_diff");
  });

  it("stops after max attempts", async () => {
    let n = 0;
    s.scripts.set("T-001", byMode({ steps: [] }));
    s.scripts.set("T-001", (req) => (req.mode === "readonly" ? approve() : { steps: [{ kind: "file_change", path: "FAIL", content: `failure number ${++n}` }, { kind: "result", ok: true }] }));
    h = await startHarness(s);
    const t = h.project.createTask({ title: "A", role: "backend", state: "QUEUED", attemptsMax: 2 });
    h.engine.start();
    await h.until(t.id, "NEEDS_HUMAN");
    const stall = h.project.store.events.list({ projectId: h.project.id, taskId: t.id, types: ["stall.detected"] })[0];
    expect(stall?.type === "stall.detected" && stall.payload.reason).toBe("max_attempts");
    expect(h.project.task(t.id).attempts).toBe(2);
  });

  it("a reviewer blocker triggers a repair; the reviewer's worktree changes are reverted", async () => {
    let reviews = 0;
    s.scripts.set("T-001", (req) => {
      if (req.mode === "readonly") {
        reviews++;
        return reviews === 1
          ? { steps: [{ kind: "file_change", path: "src/server/sneaky.ts", content: "x" }, ...approve([{ severity: "blocker", message: "missing null check", file: "src/server/a.ts", line: 1 }]).steps] }
          : approve([{ severity: "nit", message: "rename" }]);
      }
      return { sessionId: "s1", steps: writes({ "src/server/a.ts": "a\n" }).steps, resumeSteps: writes({ "src/server/a.ts": "a // checked\n" }).steps };
    });
    h = await startHarness(s);
    const t = h.project.createTask({ title: "A", role: "backend", state: "QUEUED" });
    h.engine.start();
    await h.until(t.id, "MERGED");
    const ev = events(t.id);
    expect(ev).toEqual(expect.arrayContaining(["review.blocked", "repair.requested", "policy.denied", "review.passed"]));
    const repair = s.adapters.get("slow")!.requests.find((r) => r.resumeSessionId === "s1")!;
    expect(repair.prompt).toContain("missing null check");
    expect(s.repo.git("ls-tree", "-r", "--name-only", "harness/integration")).not.toContain("src/server/sneaky.ts");
    const reviewReq = s.adapters.get("rev")!.requests[0]!;
    expect(reviewReq.mode).toBe("readonly");
    expect(reviewReq.prompt).toContain("+a");
  });

  it("dependency-order: a dependent task waits, then starts from an integration branch with the dependency", async () => {
    s.scripts.set("T-001", byMode(writes({ "docs/contracts/quotes.ts": "export type Quote = { px: number };\n" })));
    s.scripts.set("T-002", byMode({ steps: [{ kind: "tool_call", tool: "read", summary: "docs/contracts/quotes.ts" }, ...writes({ "src/ui/q.ts": "import type { Quote } from '../../docs/contracts/quotes';\n" }).steps] }));
    h = await startHarness(s);
    const a = h.project.createTask({ title: "Contract", role: "backend", state: "QUEUED" });
    const b = h.project.createTask({ title: "Consumer", role: "frontend", state: "QUEUED", dependsOn: [a.id] });
    h.engine.start();
    await h.until(b.id, "MERGED");
    const bStarted = h.project.store.events.list({ projectId: h.project.id, taskId: b.id, types: ["run.started"] })[0]!.seq!;
    const aMerged = h.project.store.events.list({ projectId: h.project.id, taskId: a.id, types: ["branch.merged"] })[0]!.seq!;
    expect(aMerged).toBeLessThan(bStarted);
    expect(events(b.id)).toContain("task.blocked");
    expect(s.repo.git("log", "--format=%s", "main..harness/integration").split("\n")).toEqual(["T-002: Consumer", "T-001: Contract"]);
  });

  it("merge-conflict: a conflict lands in NEEDS_HUMAN with the files listed and nothing resolved", async () => {
    s.scripts.set("T-001", byMode(writes({ "src/shared/a.ts": "export const a = 'backend';\n" })));
    s.scripts.set("T-002", byMode({ steps: [{ kind: "message", text: "slow", delayMs: 400 }, ...writes({ "src/shared/a.ts": "export const a = 'frontend';\n" }).steps] }));
    h = await startHarness(s);
    const a = h.project.createTask({ title: "A", role: "backend", state: "QUEUED" });
    const b = h.project.createTask({ title: "B", role: "frontend", state: "QUEUED" });
    h.engine.start();
    await h.until(a.id, "MERGED");
    await h.until(b.id, "NEEDS_HUMAN");
    const c = h.project.store.events.list({ projectId: h.project.id, taskId: b.id, types: ["merge.conflict"] })[0];
    expect(c?.type === "merge.conflict" && c.payload.files).toEqual(["src/shared/a.ts"]);
    expect(s.repo.git("show", "harness/integration:src/shared/a.ts")).toContain("backend");
  });

  it("assisted autonomy waits for review --accept; reject sends work back with the comment", async () => {
    s.repo.write("harness.yaml", fs.readFileSync(path.join(s.repo.root, "harness.yaml"), "utf8") + "policy:\n  autonomy: assisted\n");
    s.repo.commit("assisted");
    mainHead = s.repo.git("rev-parse", "main");
    s.scripts.set("T-001", byMode({ sessionId: "s", steps: writes({ "src/server/a.ts": "1\n" }).steps, resumeSteps: writes({ "src/server/a.ts": "2\n" }).steps }));
    h = await startHarness(s);
    const t = h.project.createTask({ title: "A", role: "backend", state: "QUEUED" });
    h.engine.start();
    await h.until(t.id, "PR_READY");
    await h.engine.idle();
    expect(h.project.task(t.id).state).toBe("PR_READY");
    h.engine.reject(t.id, "Please use a constant.");
    await h.until(t.id, "PR_READY");
    expect(s.adapters.get("slow")!.requests.at(-1)!.prompt).toContain("Please use a constant.");
    await h.engine.merge(t.id);
    expect(h.project.task(t.id).state).toBe("MERGED");
    expect(s.repo.git("show", "harness/integration:src/server/a.ts")).toBe("2");
  });
});
