import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UsageSnapshot } from "@harness/core";
import { toIso } from "../cli-adapter.js";

export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.CODEX_HOME ?? path.join(os.homedir(), ".codex");
}

/** Newest session-log files, newest first (walks the last few YYYY/MM/DD dirs only). */
export function recentRolloutFiles(home = codexHome(), maxDays = 3): string[] {
  const root = path.join(home, "sessions");
  const sortedDirs = (d: string) => {
    try {
      return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
    } catch {
      return [];
    }
  };
  const days: string[] = [];
  for (const y of sortedDirs(root)) {
    for (const m of sortedDirs(path.join(root, y))) {
      for (const d of sortedDirs(path.join(root, y, m))) {
        days.push(path.join(root, y, m, d));
        if (days.length >= maxDays) break;
      }
      if (days.length >= maxDays) break;
    }
    if (days.length >= maxDays) break;
  }
  const files: { f: string; t: number }[] = [];
  for (const day of days) {
    for (const f of fs.readdirSync(day)) {
      if (!f.startsWith("rollout-") || !f.endsWith(".jsonl")) continue;
      const full = path.join(day, f);
      files.push({ f: full, t: fs.statSync(full).mtimeMs });
    }
  }
  return files.sort((a, b) => b.t - a.t).map((x) => x.f);
}

interface CodexLimit {
  used_percent?: number;
  window_minutes?: number;
  resets_at?: number;
}

/** Parse the last `rate_limits` entry in a session log into window snapshots. */
export function parseRolloutRateLimits(text: string, observedAt: string): UsageSnapshot[] {
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (!l.includes('"rate_limits"')) continue;
    let rl: { primary?: CodexLimit; secondary?: CodexLimit } | undefined;
    try {
      rl = (JSON.parse(l) as { payload?: { rate_limits?: typeof rl } }).payload?.rate_limits;
    } catch {
      continue;
    }
    if (!rl) continue;
    const out: UsageSnapshot[] = [];
    for (const lim of [rl.primary, rl.secondary]) {
      if (!lim) continue;
      const kind = lim.window_minutes === 300 ? "5h" : lim.window_minutes === 10080 ? "7d" : undefined;
      if (!kind) continue;
      out.push({ route: "", window: kind, usedPct: typeof lim.used_percent === "number" ? lim.used_percent : null, resetsAt: toIso(lim.resets_at) ?? null, source: "vendor", observedAt });
    }
    return out;
  }
  return [];
}

/** Usage windows recorded for a thread, or from the newest session log if `threadId` is omitted. */
export function readCodexUsage(threadId?: string, home = codexHome(), now = new Date()): UsageSnapshot[] {
  const files = recentRolloutFiles(home);
  const candidates = threadId ? files.filter((f) => f.endsWith(`-${threadId}.jsonl`)) : files.slice(0, 5);
  for (const f of candidates) {
    try {
      const snaps = parseRolloutRateLimits(fs.readFileSync(f, "utf8"), now.toISOString());
      if (snaps.length) return snaps;
    } catch {
      // unreadable log: try the next one
    }
  }
  return [];
}

interface AppServerWindow {
  usedPercent?: number;
  windowDurationMins?: number;
  resetsAt?: number;
}

/** `account/rateLimits/read` result (recorded in fixtures/codex/app-server-ratelimits.json) → window snapshots. */
export function parseAppServerRateLimits(result: unknown, observedAt: string): UsageSnapshot[] {
  const rl = (result as { rateLimits?: { primary?: AppServerWindow | null; secondary?: AppServerWindow | null } } | undefined)?.rateLimits;
  if (!rl) return [];
  const out: UsageSnapshot[] = [];
  for (const w of [rl.primary, rl.secondary]) {
    if (!w) continue;
    const kind = w.windowDurationMins === 300 ? "5h" : w.windowDurationMins === 10080 ? "7d" : undefined;
    if (!kind) continue;
    out.push({ route: "", window: kind, usedPct: typeof w.usedPercent === "number" ? w.usedPercent : null, resetsAt: toIso(w.resetsAt) ?? null, source: "vendor", observedAt });
  }
  return out;
}

/**
 * Ask Codex's app-server for the account's rate limits (JSON-RPC over stdio:
 * initialize → initialized → account/rateLimits/read). It runs no model and
 * spends no quota. Returns [] on any failure or after `timeoutMs`.
 * Never calls the reset-credit methods.
 */
export function readCodexAppServerUsage(bin: string, env: NodeJS.ProcessEnv, timeoutMs = 8000, now = () => new Date()): Promise<UsageSnapshot[]> {
  return new Promise((resolve) => {
    let done = false;
    let buf = "";
    const child = spawn(bin, ["app-server"], { env, stdio: ["pipe", "pipe", "ignore"] });
    const finish = (v: UsageSnapshot[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(v);
    };
    const timer = setTimeout(() => finish([]), timeoutMs);
    child.on("error", () => finish([]));
    child.on("exit", () => finish([]));
    child.stdout.on("data", (d: Buffer) => {
      buf += d.toString("utf8");
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        try {
          const msg = JSON.parse(line) as { id?: number; result?: unknown };
          if (msg.id === 2) finish(parseAppServerRateLimits(msg.result, now().toISOString()));
        } catch {
          // not JSON: ignore
        }
      }
    });
    const send = (o: object) => child.stdin.write(`${JSON.stringify(o)}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "harness", version: "0.1.0" } } });
    send({ jsonrpc: "2.0", method: "initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read", params: null });
  });
}
