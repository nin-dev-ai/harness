import { afterEach, describe, expect, it } from "vitest";
import { waitFor } from "../helpers/fake-clock.js";
import { byMode, createScenario, DEFAULT_CONFIG, startHarness, writes, type Harness, type Scenario } from "../helpers/scenario.js";

/** M20: the lead checks each settled batch, reports, and sets bounded follow-ups. */
const CONFIG = DEFAULT_CONFIG.replace("roles:\n", "roles:\n  lead:\n    route: rev\n    mode: readonly\n");
const leadSays = (status: string, followups: unknown[] = [], done = false, facts: string[] = []) => ({ steps: [{ kind: "result" as const, ok: true, summary: status, structured: { status, done, followups, facts } }] });

describe("lead (compiler) agent", () => {
  let s: Scenario;
  let h: Harness;
  afterEach(async () => {
    await h?.stop();
    s?.cleanup();
  });

  it("reviews a settled request, sets a follow-up, then stops at the round limit", async () => {
    s = createScenario({ config: CONFIG.replace("land: manual", "land: auto") });
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
        : leadSays("All done.", [{ title: "Should be ignored", role: "backend", description: "", acceptance: [], files_hint: [] }], false, ["Prices are integer cents everywhere", "Tests run with node --test", "x", "Money helpers live in server/money.js", "A fourth confirmed fact is over the cap"]),
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
    // The report covers the request, the lead's follow-ups and the lead runs.
    const { qualityLedger, renderReport, requestReport } = await import("@harness/daemon");
    const rep = requestReport(h.project)!;
    expect(rep.tasks.map((t) => [t.id, t.role, t.routes, t.state])).toEqual([
      ["T-001", "backend", ["slow"], "MERGED"], ["T-002", "frontend", ["fast"], "MERGED"], ["T-003", "backend", ["slow"], "MERGED"], ["T-004", "backend", ["slow"], "MERGED"],
    ]);
    expect(rep.planning.runs).toBe(2);
    expect(rep.endedAt).not.toBeNull();
    expect(rep.lead).toBe("All done.");
    const text = renderReport(rep, qualityLedger(h.project));
    expect(text).toContain("# Report · Fix the 500 in src/server/feed.ts");
    expect(text).toContain("- fake: 4/4 (100%), 1 attempt on average");
    expect(text).toContain("A one-agent baseline");
    // The lead's confirmed facts are kept (at most 3 per report, too-short ones dropped).
    expect(renderBoard(boardData(h.project))).toContain("## Project facts");
    const { projectFacts } = await import("@harness/daemon");
    expect(projectFacts(h.project)).toEqual(["Prices are integer cents everywhere", "Tests run with node --test", "Money helpers live in server/money.js"]);
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

  it("project facts: the lead and the person add them, every later prompt carries them, the newest 15 are kept", async () => {
    s = createScenario({ config: CONFIG });
    h = await startHarness(s);
    const ctx = { attended: true, subscribe: () => () => undefined };
    const call = h.daemon.handlers().facts!;
    await call({ projectId: h.project.id, add: "Use pnpm, never npm" }, ctx);
    await call({ projectId: h.project.id, add: "use PNPM, never npm" }, ctx);
    for (let i = 0; i < 16; i++) await call({ projectId: h.project.id, add: `fact number ${i}` }, ctx);
    const r = (await call({ projectId: h.project.id, remove: 1 }, ctx)) as { facts: string[] };
    expect(r.facts).toHaveLength(14);
    expect(r.facts[0]).toBe("fact number 2");
    expect(r.facts).not.toContain("Use pnpm, never npm");
    s.scripts.set("T-001", byMode(writes({ "src/server/a.ts": "a\n" })));
    const t = h.project.createTask({ title: "A", role: "backend", state: "QUEUED" });
    h.engine.start();
    await h.until(t.id, "MERGED");
    expect(s.adapters.get("slow")!.requests[0]!.prompt).toContain("## Project facts");
    expect(s.adapters.get("slow")!.requests[0]!.prompt).toContain("14. fact number 15");
  });
});

