import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { checkDrift, missingFlags, versionNewer } from "./drift.js";

const fixture = (p: string) => fs.readFileSync(new URL(`../../../fixtures/${p}`, import.meta.url), "utf8");

describe("vendor drift", () => {
  it("every flag harness passes is in the recorded --help of each CLI", async () => {
    const files: Record<string, string> = { "--help": "", "exec --help": "codex/exec-help.txt", "exec resume --help": "codex/exec-resume-help.txt" };
    const claude = await checkDrift("claude", "claude", "2.1.301", async () => fixture("claude/help.txt"));
    const codex = await checkDrift("codex", "codex", "0.162.1", async (args) => fixture(files[args.join(" ")]!));
    const cursor = await checkDrift("cursor", "agent", "2026.10.14", async () => fixture("cursor/help.txt"));
    for (const r of [claude, codex, cursor]) expect(r).toMatchObject({ missing: [], newer: false, unreadable: false });
  });

  it("finds a removed flag and a newer version", async () => {
    expect(missingFlags("  -p, --print   print\n  --model <m>", ["-p", "--model", "--json-schema"])).toEqual(["--json-schema"]);
    expect(missingFlags("  --jsonx", ["--json"])).toEqual(["--json"]);
    expect(versionNewer("2.1.310", "2.1.301")).toBe(true);
    expect(versionNewer("2026.10.14", "2026.10.14")).toBe(false);
    expect(versionNewer("0.161.9", "0.162.1")).toBe(false);
    expect(versionNewer("2026.10.14-0f9edde", "2026.10.14")).toBe(false);
    expect(versionNewer("2.1.301 (Claude Code)", "2.1.301")).toBe(false);
    expect(versionNewer("codex-cli 0.163.0", "0.162.1")).toBe(true);
    const r = await checkDrift("claude", "claude", "2.2.0", async () => "Usage: claude\n  -p, --print\n");
    expect(r.newer).toBe(true);
    expect(r.missing).toContain("--json-schema");
  });
});
