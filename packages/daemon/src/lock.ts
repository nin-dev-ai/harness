import fs from "node:fs";
import path from "node:path";
import { HarnessError } from "@harness/core";
import { isAlive, readPid, removePid } from "./pidfile.js";

/**
 * Single-daemon lock: an exclusively created pid file. A stale file (its pid
 * is dead) is taken over. Returns a release function.
 */
export function acquireDaemonLock(pidFile: string, pid = process.pid): () => void {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(pidFile, "wx");
      fs.writeSync(fd, String(pid));
      fs.closeSync(fd);
      return () => removePid(pidFile, pid);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      const other = readPid(pidFile);
      if (other !== undefined && other !== pid && isAlive(other)) {
        throw new HarnessError("CONFLICT", `daemon already running (pid ${other})`, { pid: other });
      }
      fs.rmSync(pidFile, { force: true });
    }
  }
  throw new HarnessError("CONFLICT", `could not acquire ${pidFile}`);
}
