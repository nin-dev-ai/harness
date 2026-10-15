import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { notesIn, renderBoard } from "@harness/daemon";
import { byMode, createScenario, startHarness, writes, type Harness, type Scenario } from "../helpers/scenario.js";

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
});
