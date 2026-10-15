import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

/**
 * Vendor drift: the flags harness passes to each CLI, checked against that
 * CLI's own --help, plus the version the adapters were recorded against
 * (docs/VENDORS.md, fixtures/). `harness doctor` reports missing flags as
 * blocking and a newer version as a warning.
 */

export type DriftVendor = "claude" | "codex" | "cursor";

export const USED_FLAGS: Record<DriftVendor, { helpArgs: string[]; flags: string[] }[]> = {
  claude: [{ helpArgs: ["--help"], flags: ["-p", "--output-format", "--verbose", "--permission-mode", "--disallowedTools", "--allowedTools", "--model", "--resume", "--json-schema"] }],
  codex: [
    { helpArgs: ["exec", "--help"], flags: ["--json", "--skip-git-repo-check", "-s", "-m", "--output-schema"] },
    { helpArgs: ["exec", "resume", "--help"], flags: ["--json", "--skip-git-repo-check", "-c"] },
  ],
  cursor: [{ helpArgs: ["--help"], flags: ["-p", "--output-format", "--trust", "--mode", "--force", "--model", "--resume"] }],
};

/** Versions the adapters and fixtures were recorded against. */
export const RECORDED_VERSIONS: Record<DriftVendor, string> = { claude: "2.1.301", codex: "0.162.1", cursor: "2026.10.14" };

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Flags from `flags` that a help text does not mention as an option. */
export function missingFlags(help: string, flags: string[]): string[] {
  return flags.filter((f) => !new RegExp(`(^|[\\s,\\[(])${esc(f)}(?=[\\s,=<\\[.]|$)`, "m").test(help));
}

export interface DriftReport {
  vendor: DriftVendor;
  version: string | undefined;
  recorded: string;
  newer: boolean;
  missing: string[];
  /** --help could not be read (the CLI may be missing). */
  unreadable: boolean;
}

/** Compare dotted or dated versions numerically, part by part. */
export function versionNewer(a: string, b: string): boolean {
  // Only the leading dotted version counts: "2026.10.14-0f9edde" is 2026.10.14, "2.1.301 (Claude Code)" is 2.1.301.
  const parts = (v: string) => (/\d+(?:\.\d+)+|\d+/.exec(v)?.[0] ?? "").split(".").filter(Boolean).map(Number);
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  }
  return false;
}

/** A CLI's help output; empty when it timed out or failed (partial output must not look like missing flags). */
async function helpText(bin: string, args: string[]): Promise<string> {
  // Straight into a file descriptor, not a pipe: a CLI that calls process.exit() loses whatever is
  // still in a pipe's buffer (Claude Code's --help was cut mid-line at ~16 KB), which would look like
  // missing flags. A file descriptor the child writes to directly cannot be cut short.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-help-"));
  const file = path.join(dir, "help.txt");
  const fd = fs.openSync(file, "w");
  try {
    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(bin, args, { stdio: ["ignore", fd, fd] });
      const timer = setTimeout(() => {
        child.kill();
        resolve(null);
      }, 30_000);
      child.on("error", () => (clearTimeout(timer), resolve(null)));
      child.on("exit", (c) => (clearTimeout(timer), resolve(c)));
    });
    return code === 0 ? fs.readFileSync(file, "utf8") : "";
  } finally {
    fs.closeSync(fd);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

export async function checkDrift(vendor: DriftVendor, bin: string, version: string | undefined, run = (args: string[]) => helpText(bin, args)): Promise<DriftReport> {
  const missing: string[] = [];
  let unreadable = false;
  for (const s of USED_FLAGS[vendor]) {
    const help = await run(s.helpArgs).catch(() => "");
    if (!help.trim()) {
      unreadable = true;
      continue;
    }
    missing.push(...missingFlags(help, s.flags).map((f) => `${s.helpArgs.filter((a) => a !== "--help").join(" ")}${s.helpArgs.length > 1 ? " " : ""}${f}`.trim()));
  }
  const recorded = RECORDED_VERSIONS[vendor];
  return { vendor, version, recorded, newer: !!version && versionNewer(version, recorded), missing, unreadable };
}
