import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

/** Global state directory: $HARNESS_HOME or ~/.harness. */
export function harnessHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.HARNESS_HOME ?? path.join(os.homedir(), ".harness");
}

export interface HomePaths {
  home: string;
  db: string;
  sock: string;
  pid: string;
  logs: string;
}

export function homePaths(home = harnessHome()): HomePaths {
  return {
    home,
    db: path.join(home, "state.db"),
    sock: socketPath(home),
    pid: path.join(home, "daemon.pid"),
    logs: path.join(home, "logs"),
  };
}

/** Unix socket paths are limited to ~104 bytes on macOS; long homes get a short, stable path in /tmp. */
export function socketPath(home: string): string {
  const p = path.join(home, "daemon.sock");
  if (Buffer.byteLength(p) <= 100) return p;
  return path.join("/tmp", `harness-${crypto.createHash("sha1").update(home).digest("hex").slice(0, 12)}.sock`);
}
