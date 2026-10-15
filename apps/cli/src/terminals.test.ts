import { describe, expect, it } from "vitest";
import { openAgentWindows, terminalScript, watchCommand } from "./terminals.js";
import { watchLine } from "./commands/watch.js";

const plain = { bold: (s: string) => s, dim: (s: string) => s, red: (s: string) => s, green: (s: string) => s, yellow: (s: string) => s } as never;

describe("agent terminals", () => {
  it("builds a quoted watch command and AppleScript for Terminal and iTerm", () => {
    const cmd = watchCommand("/Users/me/my 'app'", ["/usr/bin/node", "/x/main.js"], "backend-1");
    expect(cmd).toBe(`cd '/Users/me/my '\\''app'\\''' && '/usr/bin/node' '/x/main.js' watch 'backend-1'`);
    expect(terminalScript("Terminal", 'echo "hi"')).toContain('do script "echo \\"hi\\""');
    expect(terminalScript("iTerm", "harness watch a")).toContain("create window with default profile command");
  });

  it("opens one window per agent on macOS, and hands back commands elsewhere", async () => {
    const calls: string[][] = [];
    const mac = await openAgentWindows("/p", ["backend-1", "frontend-1"], { TERM_PROGRAM: "iTerm.app" }, "darwin", async (a) => (calls.push(a), true));
    expect(mac).toEqual({ opened: ["backend-1", "frontend-1"], manual: [] });
    expect(calls).toHaveLength(2);
    expect(calls[0]![1]).toContain('tell application "iTerm"');
    const linux = await openAgentWindows("/p", ["backend-1"], {}, "linux");
    expect(linux.opened).toEqual([]);
    expect(linux.manual[0]).toContain("watch 'backend-1'");
  });

  it("formats a watched session like the live pane", () => {
    expect(watchLine({ kind: "tool", text: "Edit", detail: "src/a.ts", ts: "2026-10-15T10:00:01.000Z" }, plain)).toBe("10:00:01 ⏺ Edit src/a.ts");
    expect(watchLine({ kind: "edit", text: "src/a.ts", ts: "2026-10-15T10:00:02.000Z" }, plain)).toBe("10:00:02 ✎ src/a.ts");
  });
});
