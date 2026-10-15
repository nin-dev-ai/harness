import { describe, expect, it, vi } from "vitest";
import { withAlternateScreen } from "./terminal.js";

describe("alternate terminal screen", () => {
  it("restores the shell after the UI closes", async () => {
    const write = vi.fn();
    const result = await withAlternateScreen({ isTTY: true, write }, async () => "quit");
    expect(result).toBe("quit");
    expect(write.mock.calls.map(([chunk]) => chunk)).toEqual(["\u001b[?1049h", "\u001b[?1049l"]);
  });

  it("restores the shell when the UI fails", async () => {
    const write = vi.fn();
    await expect(withAlternateScreen({ isTTY: true, write }, async () => { throw new Error("render failed"); })).rejects.toThrow("render failed");
    expect(write).toHaveBeenLastCalledWith("\u001b[?1049l");
  });

  it("leaves redirected output alone", async () => {
    const write = vi.fn();
    await withAlternateScreen({ isTTY: false, write }, async () => undefined);
    expect(write).not.toHaveBeenCalled();
  });
});
