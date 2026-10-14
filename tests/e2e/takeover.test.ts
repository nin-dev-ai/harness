import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { byMode, createScenario, startHarness, writes, type Harness, type Scenario } from "../helpers/scenario.js";
import { waitFor } from "../helpers/fake-clock.js";

/** Attach and takeover (FR-15). */
describe("takeover", () => {
  let s: Scenario;
  let h: Harness;
  afterEach(async () => {
    await h?.stop();
    s.cleanup();
  });

  it("pauses the worker, writes a wip checkpoint, and the resumed session sees it", async () => {
    s = createScenario();
    h = await startHarness(s);
    s.scripts.set("T-001", byMode({
      sessionId: "sess-take",
      steps: [{ kind: "file_change", path: "src/server/half.ts", content: "half\n" }, { kind: "hang" }],
      resumeSteps: [{ kind: "tool_call", tool: "read", summary: "src/server/half.ts" }, ...writes({ "src/server/done.ts": "done\n" }).steps],
    }));
    const t = h.project.createTask({ title: "Half", role: "backend", state: "QUEUED" });
    h.engine.start();
    await waitFor(() => fs.existsSync(path.join(s.repo.root, ".harness/worktrees/T-001/src/server/half.ts")), 10_000, "agent wrote half");

    const r = await h.engine.takeover("backend-1");
    expect(r.taskId).toBe(t.id);
    expect(r.sessionId).toBe("sess-take");
    expect(h.project.task(t.id).state).toBe("TAKEN_OVER");
    const runs = h.project.store.runs.listByTask(h.project.id, t.id);
    expect(runs[0]?.state).toBe("TAKEN_OVER");
    const branch = h.project.task(t.id).branch!;
    expect(s.repo.git("log", "--format=%s", `harness/integration..${branch}`)).toBe(`wip(T-001): checkpoint ${runs[0]!.id}`);
    expect(r.argv).toContain("--interactive");
    expect(r.argv).toContain("sess-take");

    // The person works in the vendor CLI (here: the fake interactive mode), then edits a file by hand.
    const out = execFileSync(r.argv[0]!, r.argv.slice(1), { cwd: r.cwd, encoding: "utf8" });
    expect(out).toContain("fake interactive session sess-take");
    fs.writeFileSync(path.join(r.cwd, "src/server/by-hand.ts"), "manual\n");

    // The scheduler never touches a taken-over task.
    h.engine.kick();
    await h.engine.idle();
    expect(h.project.task(t.id).state).toBe("TAKEN_OVER");

    await h.engine.releaseTakeover(t.id, true);
    await h.until(t.id, "MERGED");
    const resumed = h.project.store.runs.listByTask(h.project.id, t.id).filter((x) => x.kind === "resume")[0]!;
    expect(s.adapters.get("slow")!.requests.find((q) => q.runId === resumed.id)?.resumeSessionId).toBe("sess-take");
    const files = s.repo.git("ls-tree", "-r", "--name-only", "harness/integration");
    expect(files).toContain("src/server/half.ts");
    expect(files).toContain("src/server/by-hand.ts");
    expect(files).toContain("src/server/done.ts");
  });

  it("leaves the task with the person when automation is not resumed", async () => {
    s = createScenario();
    h = await startHarness(s);
    s.scripts.set("T-001", byMode({ sessionId: "s2", steps: [{ kind: "hang" }] }));
    const t = h.project.createTask({ title: "X", role: "backend", state: "QUEUED" });
    h.engine.start();
    await h.until(t.id, "RUNNING");
    await waitFor(() => h.engine.live.size === 1 && !!h.project.store.runs.listByTask(h.project.id, t.id)[0]?.vendorSessionId, 5000);
    await h.engine.takeover(t.id);
    await h.engine.releaseTakeover(t.id, false);
    h.engine.kick();
    await h.engine.idle();
    expect(h.project.task(t.id).state).toBe("TAKEN_OVER");
  });
});
