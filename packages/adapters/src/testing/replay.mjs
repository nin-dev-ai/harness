#!/usr/bin/env node
// Replays recorded vendor output so real adapters are tested without a vendor.
// REPLAY_STDOUT / REPLAY_STDERR: files to print. REPLAY_EXIT: exit code.
// REPLAY_MODE: "hang" (never exit) or "child" (spawn a grandchild, print its pid, hang).
import { spawn } from "node:child_process";
import fs from "node:fs";

const env = process.env;
if (env.REPLAY_ARGV_FILE) fs.writeFileSync(env.REPLAY_ARGV_FILE, JSON.stringify(process.argv.slice(2)));
if (env.REPLAY_STDOUT) process.stdout.write(fs.readFileSync(env.REPLAY_STDOUT));
if (env.REPLAY_STDERR) process.stderr.write(fs.readFileSync(env.REPLAY_STDERR));
if (env.REPLAY_MODE === "child") {
  const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  process.stdout.write(JSON.stringify({ type: "harness_replay_child", pid: c.pid }) + "\n");
}
if (env.REPLAY_MODE === "hang" || env.REPLAY_MODE === "child") setInterval(() => {}, 1000);
else process.stdout.end(() => process.exit(Number(env.REPLAY_EXIT ?? 0)));
