#!/usr/bin/env node
// Fake vendor CLI. Plays a script of timed steps and prints one JSON line per step.
// Script comes from HARNESS_FAKE_SCRIPT (JSON). Used by every test; never calls a model.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

if (args.includes("--interactive")) {
  process.stdout.write(`fake interactive session ${flag("--interactive")}\n`);
  process.exit(0);
}
if (args.includes("--version")) {
  process.stdout.write("fake-agent 1.0.0\n");
  process.exit(0);
}

const script = JSON.parse(process.env.HARNESS_FAKE_SCRIPT ?? '{"steps":[]}');
const resume = flag("--resume");
const runId = flag("--run-id") ?? "run";
const sessionId = resume ?? script.sessionId ?? `fake-session-${runId}`;
const out = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

out({ t: "session", id: sessionId, resumed: Boolean(resume) });

if (resume && script.sessionExpiredOnResume) {
  out({ t: "error", kind: "session_expired", message: `session ${resume} expired` });
  process.exit(1);
}

const steps = (resume && script.resumeSteps) ? script.resumeSteps : script.steps;
for (const step of steps) {
  if (step.delayMs) await sleep(step.delayMs);
  switch (step.kind) {
    case "message":
      out({ t: "message", text: step.text });
      break;
    case "tool_call":
      out({ t: "tool", tool: step.tool, summary: step.summary ?? "" });
      break;
    case "file_change": {
      const p = path.resolve(process.cwd(), step.path);
      if (step.delete) fs.rmSync(p, { force: true });
      else {
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, step.content ?? `// written by fake agent\n`);
      }
      out({ t: "file", path: step.path });
      break;
    }
    case "usage":
      out({ t: "usage", tokensIn: step.tokensIn, tokensOut: step.tokensOut, costUsd: step.costUsd });
      break;
    case "rate_limit":
      if (step.structured === false) process.stderr.write("Error: usage limit reached, try again later\n");
      else out({ t: "rate_limit", window: step.window ?? "unknown", resetsAt: step.resetsAt });
      process.exit(step.exitCode ?? 2);
      break;
    case "raw":
      process.stdout.write(step.line + "\n");
      break;
    case "stderr":
      process.stderr.write(step.line + "\n");
      break;
    case "spawn_child": {
      const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
      out({ t: "child", pid: c.pid });
      break;
    }
    case "hang":
      setInterval(() => {}, 1000);
      await new Promise(() => {});
      break;
    case "crash":
      process.stderr.write(step.message ?? "fake agent crashed\n");
      process.exit(step.code ?? 1);
      break;
    case "error":
      out({ t: "error", kind: step.errorKind ?? "unknown", message: step.message ?? "error", retryable: step.retryable ?? false });
      break;
    case "result":
      out({ t: "result", ok: step.ok ?? true, summary: step.summary ?? "done", structured: step.structured });
      break;
    default:
      out({ t: "unknown-step", step });
  }
}
process.exit(script.exitCode ?? 0);
