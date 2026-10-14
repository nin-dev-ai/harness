import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AgentEventSchema, type AgentEvent } from "@harness/core";
import { collect, filterEnv, pidAlive, processGroupAlive } from "./process.js";
import type { AgentAdapter, RunRequest } from "./types.js";

/** Scenarios every adapter must handle. Real adapters replay recorded fixtures for these. */
export type ContractScenario =
  | "success"
  | "rate_limit"
  | "unstructured_limit"
  | "garbage"
  | "crash"
  | "hang"
  | "hang_with_child";

export interface ContractSubject {
  name: string;
  /** Return an adapter primed to play `scenario`, or undefined if unsupported. */
  prepare(scenario: ContractScenario): AgentAdapter | undefined;
}

export { collect };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The shared adapter contract test suite (PRD → Adapter rules). */
export function runAdapterContract(subject: ContractSubject): void {
  describe(`adapter contract: ${subject.name}`, () => {
    let cwd: string;
    let n = 0;
    beforeAll(() => {
      cwd = fs.mkdtempSync(path.join(os.tmpdir(), "harness-contract-"));
    });
    afterAll(() => fs.rmSync(cwd, { recursive: true, force: true }));

    const req = (over: Partial<RunRequest> = {}): RunRequest => ({
      runId: `R-T-001-${++n}`,
      cwd,
      prompt: "contract test",
      mode: "write",
      allowedPaths: ["**"],
      env: filterEnv(process.env),
      timeoutMs: 15_000,
      ...over,
    });

    const scenario = (s: ContractScenario, fn: (a: AgentAdapter) => Promise<void>) => {
      const a = subject.prepare(s);
      (a ? it : it.skip)(s, () => fn(a!));
    };

    function assertShape(events: AgentEvent[], runId: string) {
      for (const e of events) {
        expect(AgentEventSchema.safeParse(e).success, JSON.stringify(e)).toBe(true);
        expect(e.runId).toBe(runId);
      }
      expect(events[0]?.type).toBe("started");
      expect(events.at(-1)?.type).toBe("exited");
      expect(events.filter((e) => e.type === "exited")).toHaveLength(1);
      expect(events.filter((e) => e.type === "started")).toHaveLength(1);
    }

    scenario("success", async (a) => {
      const r = req();
      const events = await collect(a.run(r));
      assertShape(events, r.runId);
      const result = events.find((e) => e.type === "result");
      expect(result && result.type === "result" && result.ok).toBe(true);
      const started = events[0];
      expect(started?.type === "started" && started.pid > 0).toBe(true);
    });

    scenario("rate_limit", async (a) => {
      const r = req();
      const events = await collect(a.run(r));
      assertShape(events, r.runId);
      expect(events.some((e) => e.type === "rate_limit")).toBe(true);
    });

    scenario("unstructured_limit", async (a) => {
      const r = req();
      const events = await collect(a.run(r));
      assertShape(events, r.runId);
      const rl = events.find((e) => e.type === "rate_limit");
      expect(rl && rl.type === "rate_limit" && rl.window).toBe("unknown");
    });

    scenario("garbage", async (a) => {
      const r = req();
      const events = await collect(a.run(r));
      assertShape(events, r.runId);
      expect(events.some((e) => e.type === "message")).toBe(true);
    });

    scenario("crash", async (a) => {
      const r = req();
      const events = await collect(a.run(r));
      assertShape(events, r.runId);
      const err = events.find((e) => e.type === "error");
      expect(err && err.type === "error" && err.kind).toBe("crashed");
      const exit = events.at(-1);
      expect(exit?.type === "exited" && exit.code !== 0).toBe(true);
    });

    scenario("hang", async (a) => {
      const r = req();
      const iter = a.run(r);
      const pending = collect(iter);
      await sleep(300);
      await a.cancel(r.runId);
      const events = await pending;
      assertShape(events, r.runId);
      const started = events[0];
      if (started?.type === "started") expect(processGroupAlive(started.pid)).toBe(false);
    });

    scenario("hang_with_child", async (a) => {
      const r = req();
      const events: AgentEvent[] = [];
      let childPid: number | undefined;
      const done = (async () => {
        for await (const e of a.run(r)) {
          events.push(e);
          if (e.type === "message" && e.raw && typeof e.raw === "object" && "pid" in e.raw) childPid = Number((e.raw as { pid: number }).pid);
        }
      })();
      const deadline = Date.now() + 5000;
      while (childPid === undefined && Date.now() < deadline) await sleep(20);
      expect(childPid).toBeGreaterThan(0);
      expect(pidAlive(childPid!)).toBe(true);
      await a.cancel(r.runId);
      await done;
      assertShape(events, r.runId);
      expect(pidAlive(childPid!)).toBe(false);
    });

    it("cancel of an unknown run is a no-op", async () => {
      const a = subject.prepare("success");
      if (a) await expect(a.cancel("R-T-999-1")).resolves.toBeUndefined();
    });

    it("times out", async () => {
      const a = subject.prepare("hang");
      if (!a) return;
      const r = req({ timeoutMs: 300 });
      const events = await collect(a.run(r));
      assertShape(events, r.runId);
      expect(events.some((e) => e.type === "error" && e.kind === "timeout")).toBe(true);
    });
  });
}
