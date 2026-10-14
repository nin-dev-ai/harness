import { describe, expect, it } from "vitest";
import { FakeClock, addMs, msBetween } from "./time.js";

describe("FakeClock", () => {
  it("only moves when told to", () => {
    const c = new FakeClock("2026-01-01T00:00:00Z");
    expect(c.now().toISOString()).toBe("2026-01-01T00:00:00.000Z");
    c.advance(1000);
    expect(c.now().toISOString()).toBe("2026-01-01T00:00:01.000Z");
  });
  it("fires timers in order and supports cancel", () => {
    const c = new FakeClock("2026-01-01T00:00:00Z");
    const fired: string[] = [];
    c.setTimeout(() => fired.push("b"), 200);
    c.setTimeout(() => fired.push("a"), 100);
    const cancel = c.setTimeout(() => fired.push("x"), 150);
    cancel();
    c.advance(150);
    expect(fired).toEqual(["a"]);
    c.advance(100);
    expect(fired).toEqual(["a", "b"]);
    expect(c.pendingTimers()).toBe(0);
  });
  it("timers scheduled by timers fire within the same advance", () => {
    const c = new FakeClock();
    const fired: number[] = [];
    c.setTimeout(() => c.setTimeout(() => fired.push(2), 10), 10);
    c.advance(30);
    expect(fired).toEqual([2]);
  });
  it("time helpers", () => {
    expect(msBetween("2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z")).toBe(60_000);
    expect(addMs("2026-01-01T00:00:00Z", 1000)).toBe("2026-01-01T00:00:01.000Z");
  });
});
