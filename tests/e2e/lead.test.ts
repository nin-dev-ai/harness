import { afterEach, describe, expect, it } from "vitest";
import { waitFor } from "../helpers/fake-clock.js";
import { byMode, createScenario, DEFAULT_CONFIG, startHarness, writes, type Harness, type Scenario } from "../helpers/scenario.js";

/** M20: the lead checks each settled batch, reports, and sets bounded follow-ups. */
const CONFIG = DEFAULT_CONFIG.replace("roles:\n", "roles:\n  lead:\n    route: rev\n    mode: readonly\n");
const leadSays = (status: string, followups: unknown[] = [], done = false) => ({ steps: [{ kind: "result" as const, ok: true, summary: status, structured: { status, done, followups } }] });

describe("lead (compiler) agent", () => {
  let s: Scenario;
  let h: Harness;
  afterEach(async () => {
    await h?.stop();
    s?.cleanup();
  });

  it("reviews a settled request, sets a follow-up, then stops at the round limit", async () => {
    s = createScenario({ config: CONFIG });
    h = await startHarness(s);
    let leadRuns = 0;
    s.scripts.set("LEAD", () =>
      leadRuns++ === 0
        ? leadSays("The feed works but the page shows no error state.", [
            { title: "Show feed errors on the quotes page", role: "", description: "Render an error row in src/ui/feed.ts when the feed fails", acceptance: ["error row shows"], files_hint: ["src/ui/feed.ts"] },
            { title: "Extra 1", role: "backend", description: "x", acceptance: [], files_hint: [] },
            { title: "Extra 2", role: "backend", description: "x", acceptance: [], files_hint: [] },
            { title: "Extra 3", role: "backend", description: "x", acceptance: [], files_hint: [] },
          ])
        : leadSays("All done.", [{ title: "Should be ignored", role: "backend", description: "", acceptance: [], files_hint: [] }]),
    );
    s.scripts.set("T-001", byMode(writes({ "src/server/feed.ts": "feed\n" })));
    s.scripts.set("T-002", byMode(writes({ "src/ui/feed.ts": "err\n" })));
    for (const id of ["T-003", "T-004"]) s.scripts.set(id, byMode(writes({ [`src/server/${id}.ts`]: "x\n" })));
    const ctx = { attended: true, subscribe: () => () => undefined };
    await h.daemon.handlers().dispatch!({ projectId: h.project.id, document: "Fix the 500 in src/server/feed.ts for the quotes API" }, ctx);
    await waitFor(() => h.project.store.events.list({ projectId: h.project.id, types: ["lead.reported"] }).length === 2, 20_000, "two lead reports");
    const reports = h.project.store.events.list({ projectId: h.project.id, types: ["lead.reported"] }).map((e) => e.payload as { status: string; followups: string[]; round: number });
    // Round 0: capped at lead_followups (3); the unnamed role was routed by harness.
    expect(reports[0]).toMatchObject({ status: "The feed works but the page shows no error state.", followups: ["T-002", "T-003", "T-004"], round: 0 });
    expect(h.project.task("T-002").role).toBe("frontend");
    // Round 1 is the last (lead_rounds: 2): nothing new is created.
    expect(reports[1]).toMatchObject({ status: "All done.", followups: [], round: 1 });
    expect(h.project.tasks().map((t) => t.state)).toEqual(["MERGED", "MERGED", "MERGED", "MERGED"]);
    const prompt = s.adapters.get("rev")!.requests.find((r) => r.runId === "R-LEAD-1")!.prompt;
    expect(prompt).toContain("Fix the 500 in src/server/feed.ts");
    expect(prompt).toContain("T-001 [merged] `backend`");
    expect(prompt).toContain("At most 3 follow-ups");
    expect(s.adapters.get("rev")!.requests.find((r) => r.runId === "R-LEAD-2")!.prompt).toContain("this was the last round");
    // The board's checklist covers the request and the lead's follow-ups, ticked as they merge.
    const { boardData, renderBoard } = await import("@harness/daemon");
    const board = renderBoard(boardData(h.project));
    expect(board).toContain("## Checklist for the latest request (4/4 done)");
    expect(board).toContain("- [x] T-002: error row shows");
    expect(s.adapters.get("rev")!.requests.find((r) => r.runId === "R-LEAD-2")!.prompt).toContain("- [x] T-002: error row shows");
  });

  it("without a lead role nothing extra runs", async () => {
    s = createScenario();
    h = await startHarness(s);
    s.scripts.set("T-001", byMode(writes({ "src/server/feed.ts": "feed\n" })));
    const ctx = { attended: true, subscribe: () => () => undefined };
    await h.daemon.handlers().dispatch!({ projectId: h.project.id, document: "Fix the 500 in src/server/feed.ts" }, ctx);
    await h.until("T-001", "MERGED");
    await h.engine.idle();
    expect(h.project.store.events.list({ projectId: h.project.id, types: ["lead.reported"] })).toEqual([]);
  });
});
