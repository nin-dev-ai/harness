import { describe, expect, it } from "vitest";
import { filterEnv, killGroup, pidAlive, processGroupAlive, spawnGroup, type OutputLine } from "./process.js";

describe("process groups", () => {
  it("streams stdout and stderr lines and the exit code", async () => {
    const p = spawnGroup([process.execPath, "-e", "console.log('a'); console.error('b'); process.exit(4)"], { cwd: process.cwd(), env: filterEnv(process.env) });
    const lines: OutputLine[] = [];
    for await (const l of p.lines) lines.push(l);
    expect(lines).toEqual(expect.arrayContaining([{ stream: "stdout", line: "a" }, { stream: "stderr", line: "b" }]));
    expect((await p.exited).code).toBe(4);
  });

  it("kills grandchildren with the group: no orphans", async () => {
    const code = `
      const { spawn } = require("node:child_process");
      const c = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
      console.log(c.pid);
      setInterval(() => {}, 1000);`;
    const p = spawnGroup([process.execPath, "-e", code], { cwd: process.cwd(), env: filterEnv(process.env) });
    let child = 0;
    for await (const l of p.lines) {
      child = Number(l.line);
      break;
    }
    expect(pidAlive(child)).toBe(true);
    await p.kill(500);
    expect(processGroupAlive(p.pid)).toBe(false);
    expect(pidAlive(child)).toBe(false);
  });

  it("escalates to SIGKILL when SIGTERM is ignored", async () => {
    const p = spawnGroup([process.execPath, "-e", "process.on('SIGTERM',()=>{}); console.log('up'); setInterval(()=>{},1000)"], { cwd: process.cwd(), env: filterEnv(process.env) });
    for await (const _ of p.lines) break;
    await killGroup(p.pid, 200);
    expect(processGroupAlive(p.pid)).toBe(false);
  });

  it("reports a missing binary as exit 127", async () => {
    const p = spawnGroup(["definitely-not-a-real-binary-xyz"], { cwd: process.cwd(), env: filterEnv(process.env) });
    for await (const _ of p.lines) void _;
    expect((await p.exited).code).toBe(127);
  });

  it("filters the environment to an allow-list", () => {
    const env = filterEnv({ PATH: "/bin", HOME: "/h", ANTHROPIC_API_KEY: "secret", LC_ALL: "C", OPENAI_API_KEY: "x" }, undefined, { CURSOR_API_KEY: "k" });
    expect(env).toEqual({ PATH: "/bin", HOME: "/h", LC_ALL: "C", CURSOR_API_KEY: "k" });
  });
});
