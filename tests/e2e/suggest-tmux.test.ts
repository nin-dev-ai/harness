import { afterEach, describe, expect, it } from "vitest";
import { suggestRoutes } from "@harness/daemon";
import { byMode, createScenario, DEFAULT_CONFIG, startHarness, writes, type Harness, type Scenario } from "../helpers/scenario.js";

describe("roles suggest and tmux mirror (P2)", () => {
  let s: Scenario;
  let h: Harness;
  afterEach(async () => {
    await h?.stop();
    s.cleanup();
  });

  it("explains suggestions from history and never changes roles; ui.tmux without tmux changes nothing", async () => {
    s = createScenario({ config: DEFAULT_CONFIG.replace("roles:", "ui:\n  tmux: true\nroles:") });
    h = await startHarness(s);
    for (const id of ["T-001", "T-002", "T-003"]) s.scripts.set(id, byMode(writes({ [`src/server/${id}.ts`]: "x\n" })));
    const ts = ["A", "B", "C"].map((t) => h.project.createTask({ title: t, role: "backend", state: "QUEUED" }));
    h.engine.start();
    for (const t of ts) await h.until(t.id, "MERGED");
    const r = suggestRoutes(h.project);
    const backend = r.find((x) => x.role === "backend")!;
    expect(backend).toMatchObject({ current: "slow", suggested: null });
    expect(backend.reason).toBe("keep slow: 100% of 3 tasks merged within 3 attempts");
    expect(r.find((x) => x.role === "frontend")?.reason).toContain("not enough history");
    expect(h.project.config.roles.backend?.route).toBe("slow");
  });
});
