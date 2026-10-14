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
    // Unix socket paths are limited to ~104 bytes on macOS.
    sock: path.join(home, "daemon.sock"),
    pid: path.join(home, "daemon.pid"),
    logs: path.join(home, "logs"),
  };
}
