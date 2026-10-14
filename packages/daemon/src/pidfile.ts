import fs from "node:fs";

/** Read a pid file; undefined if missing or garbage. */
export function readPid(file: string): number | undefined {
  try {
    const n = Number(fs.readFileSync(file, "utf8").trim());
    return Number.isInteger(n) && n > 0 ? n : undefined;
  } catch {
    return undefined;
  }
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function removePid(file: string, pid = process.pid): void {
  if (readPid(file) === pid) fs.rmSync(file, { force: true });
}
