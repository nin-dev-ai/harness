import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { notesIn, renderBoard } from "@harness/daemon";
import { approve, byMode, createScenario, startHarness, writes, type Harness, type Scenario } from "../helpers/scenario.js";

/** M18: one shared team board, rebuilt from events and carried in every prompt. */
describe("team board (HARNESS.md)", () => {
  let s: Scenario;
  let h: Harness;
  afterEach(async () => {
    await h?.stop();
    s?.cleanup();
  });

  it("reads NOTE: lines and renders a stable board", () => {
    expect(notesIn("Added the feed.\nNOTE: quotes come from GET /api/quotes?symbol=\n - note: prices are cents")).toEqual(["quotes come from GET /api/quotes?symbol=", "prices are cents"]);
    const b = renderBoard({
      project: "demo", updatedAt: "2026-10-15T10:00:00.000Z",
      requests: [{ ts: "t", text: "Live quotes with a watchlist" }],
      tasks: [
        { id: "T-001", title: "Quote feed", role: "backend", state: "MERGED", dependsOn: [], agent: "backend-1", vendor: "claude", summary: "Added the feed", files: ["src/server/feed.ts"] },
        { id: "T-002", title: "Watchlist", role: "frontend", state: "RUNNING", dependsOn: ["T-001"], agent: "frontend-1", vendor: "codex" },
      ],
      notes: [{ taskId: "T-001", agent: "backend-1", text: "GET /api/quotes" }],
    });
    expect(b).toContain("## What the person asked for\n- Live quotes with a watchlist");
    expect(b).toContain("## Working now\n- **T-002** Watchlist · `frontend` (frontend-1, codex) · running");
    expect(b).toContain("- **T-001** Quote feed · `backend` (backend-1, claude)\n  - did: Added the feed\n  - changed: `src/server/feed.ts`");
    expect(b).toContain("- T-001 (backend-1): GET /api/quotes");
  });

  it("a later agent sees what the first one did, changed and noted; the file stays current", async () => {
    s = createScenario();
    h = await startHarness(s);
    s.scripts.set("T-001", byMode({
      steps: [
        { kind: "file_change", path: "src/server/feed.ts", content: "export const feed = 1;\n" },
        { kind: "result", ok: true, summary: "Added the quote feed.\nNOTE: quotes are served at GET /api/quotes" },
      ],
    }));
    s.scripts.set("T-002", byMode(writes({ "src/ui/list.ts": "export const list = 1;\n" })));
    const call = h.daemon.handlers();
    const ctx = { attended: true, subscribe: () => () => undefined };
    const a = (await call["task.add"]!({ projectId: h.project.id, title: "Quote feed", role: "backend", approve: true }, ctx)) as { id: string };
    const b = (await call["task.add"]!({ projectId: h.project.id, title: "Watchlist", role: "frontend", dependsOn: [a.id], approve: true }, ctx)) as { id: string };
    h.engine.start();
    await h.until(a.id, "MERGED");
    await h.until(b.id, "MERGED");
    const prompt = s.adapters.get("fast")!.requests.find((r) => r.mode === "write")!.prompt;
    expect(prompt).toContain("<<<BOARD");
    expect(prompt).toContain("- did: Added the quote feed.");
    expect(prompt).toContain("- changed: `src/server/feed.ts`");
    expect(prompt).toContain("(backend-1): quotes are served at GET /api/quotes");
    expect(prompt).toContain("NOTE:");
    const file = fs.readFileSync(path.join(s.repo.root, ".harness/HARNESS.md"), "utf8");
    expect(file).toContain("**T-002** Watchlist");
    expect(file).toContain("## Working now\n- nobody");
  });

  it("a session past the context budget is left behind: the repair starts fresh from the board", async () => {
    s = createScenario({ config: (await import("../helpers/scenario.js")).DEFAULT_CONFIG.replace("  max_attempts_per_task: 3", "  max_attempts_per_task: 3\n  fresh_session_after_tokens: 100000") });
    h = await startHarness(s);
    let n = 0;
    s.scripts.set("T-001", (req) => (req.mode === "readonly" ? approve() : n++ === 0
      ? { sessionId: "big", steps: [{ kind: "file_change", path: "src/server/a.ts", content: "a\n" }, { kind: "file_change", path: "FAIL", content: "boom" }, { kind: "usage", tokensIn: 180_000 }, { kind: "result", ok: true, summary: "first try" }] }
      : { sessionId: "fresh", steps: [{ kind: "file_change", path: "FAIL", delete: true }, { kind: "result", ok: true, summary: "fixed" }] }));
    const t = h.project.createTask({ title: "Feed", role: "backend", state: "QUEUED" });
    h.engine.start();
    await h.until(t.id, "MERGED");
    const repair = s.adapters.get("slow")!.requests[1]!;
    expect(repair.resumeSessionId).toBeUndefined();
    expect(repair.prompt).toContain("<<<BOARD");
    expect(repair.prompt).toContain("Task T-001: Feed");
    expect(h.project.store.events.list({ projectId: h.project.id, types: ["session.refreshed"] }).map((e) => e.payload)).toEqual([{ sessionId: "big", tokens: 180_000, budget: 100_000 }]);
  });

  it("a dependent task's prompt says what it builds on", async () => {
    s = createScenario();
    h = await startHarness(s);
    s.scripts.set("T-001", byMode({ steps: [{ kind: "file_change", path: "src/shared/types.ts", content: "export type Quote = {};\n" }, { kind: "result", ok: true, summary: "Added the Quote type.\nNOTE: import Quote from src/shared/types.ts" }] }));
    s.scripts.set("T-002", byMode(writes({ "src/ui/q.ts": "q\n" })));
    const a = h.project.createTask({ title: "Quote type", role: "backend", state: "QUEUED" });
    const b = h.project.createTask({ title: "Quote row", role: "frontend", dependsOn: [a.id], state: "QUEUED" });
    h.engine.start();
    await h.until(b.id, "MERGED");
    const prompt = s.adapters.get("fast")!.requests[0]!.prompt;
    expect(prompt).toContain("### This task builds on");
    expect(prompt).toContain("- **T-001** Quote type (`backend`, backend-1) · merged\n  - did: Added the Quote type.\n  - changed: `src/shared/types.ts`\n  - note: import Quote from src/shared/types.ts");
  });
});

