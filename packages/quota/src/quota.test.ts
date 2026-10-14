import { describe, expect, it } from "vitest";
import { estimateCost } from "./estimator.js";
import { fits, usableHeadroom, budgetLeft } from "./burst.js";
import { activeHoursUntil, inQuietHours, parseQuietHours, remaining5hWindows, weeklyPerWindow } from "./weekly-pacing.js";
import { jitterMs, periodStart, probeDelay } from "./backoff.js";
import { currentUsed, shouldReplace, type StoredWindow } from "./windows.js";

const cold = { S: 6, M: 12, L: 25 };

describe("estimator", () => {
  it("is cold with fewer than 3 samples", () => {
    expect(estimateCost([], "M", cold)).toEqual({ p80: 12, mean: 12, samples: 0, cold: true });
    expect(estimateCost([1, 2], "L", cold)).toMatchObject({ p80: 25, cold: true });
  });
  it("uses measured values after 3 samples with a p80 above the mean", () => {
    const e = estimateCost([10, 14, 12, 16], "M", cold);
    expect(e.cold).toBe(false);
    expect(e.mean).toBeGreaterThan(11);
    expect(e.mean).toBeLessThan(16);
    expect(e.p80).toBeGreaterThan(e.mean);
    expect(estimateCost([8, 8, 8], "M", cold)).toMatchObject({ p80: 8, mean: 8, cold: false });
  });
});

describe("headroom", () => {
  const base = { now: new Date("2026-01-05T09:00:00Z"), cap5h: 100, cap7d: 100, safetyMarginPct: 5, weeklyReservePct: 10, weeklyResetsAt: null, used7d: null };
  it("applies the safety margin and cap to the 5h window", () => {
    expect(usableHeadroom({ ...base, used5h: 75 }).usable).toBe(20);
    expect(usableHeadroom({ ...base, used5h: 75, cap5h: 85 }).usable).toBe(10);
  });
  it("skips unknown terms and is null when nothing is known", () => {
    expect(usableHeadroom({ ...base, used5h: null }).usable).toBeNull();
  });
  it("paces the weekly window across remaining 5h windows", () => {
    const h = usableHeadroom({ ...base, used5h: 10, used7d: 80, weeklyResetsAt: "2026-01-07T09:00:00Z" });
    expect(h.windowsLeft).toBe(10); // 48h / 5h
    expect(h.weeklyPerWindow).toBe(1); // (90 - 80) / 10
    expect(h.usable).toBe(1);
  });
  it("compares each window in its own units", async () => {
    const { fitsWindows } = await import("./burst.js");
    // 12% of a 5h window is ~2.4% of the week: fits a 3% weekly share even though 12 > 3.
    expect(fitsWindows({ headroom5h: 33, weeklyPerWindow: 3, cost5h: 12, cost7d: 2.4, inFlight5h: 0, inFlight7d: 0 })).toEqual({ ok: true });
    expect(fitsWindows({ headroom5h: 33, weeklyPerWindow: 2, cost5h: 12, cost7d: 2.4, inFlight5h: 0, inFlight7d: 0 })).toMatchObject({ ok: false, reason: "would_not_fit" });
    expect(fitsWindows({ headroom5h: 10, weeklyPerWindow: null, cost5h: 12, cost7d: 2.4, inFlight5h: 0, inFlight7d: 0 })).toMatchObject({ ok: false });
  });

  it("implements would-not-fit and exhausted", () => {
    expect(fits(15, 20, 0)).toEqual({ ok: true });
    expect(fits(15, 20, 15)).toMatchObject({ ok: false, reason: "would_not_fit" });
    expect(fits(6, 6, 0)).toEqual({ ok: true });
    expect(fits(1, 0, 0)).toMatchObject({ ok: false, reason: "window_exhausted" });
  });
  it("computes budgets", () => {
    expect(budgetLeft({ unit: "runs", amount: 40, used: 11 })).toEqual({ usedPct: 27.5, left: 29 });
  });
});

describe("quiet hours and pacing", () => {
  it("parses and wraps midnight (local time)", () => {
    const q = parseQuietHours("22:00-06:00")!;
    expect(inQuietHours(new Date(2026, 0, 5, 23, 0), q)).toBe(true);
    expect(inQuietHours(new Date(2026, 0, 5, 5, 59), q)).toBe(true);
    expect(inQuietHours(new Date(2026, 0, 5, 6, 0), q)).toBe(false);
    expect(parseQuietHours("bad")).toBeUndefined();
  });
  it("counts only active hours", () => {
    const q = parseQuietHours("00:00-07:00");
    expect(activeHoursUntil(new Date(2026, 0, 5, 0, 0), new Date(2026, 0, 6, 0, 0), q)).toBe(17);
    expect(remaining5hWindows(new Date(2026, 0, 5, 0, 0), new Date(2026, 0, 6, 0, 0), q)).toBe(4);
    expect(weeklyPerWindow(50, 100, 10, 4)).toBe(10);
  });
});

describe("backoff and windows", () => {
  it("backs off 15m, 30m, 1h, 2h, then caps at 4h", () => {
    expect([0, 1, 2, 3, 4, 9].map((n) => probeDelay(n) / 60_000)).toEqual([15, 30, 60, 120, 240, 240]);
    expect(jitterMs([5, 120], () => 0)).toBe(5000);
    expect(jitterMs([5, 120], () => 1)).toBe(120_000);
  });
  it("computes budget periods", () => {
    const now = new Date(2026, 0, 7, 15, 30); // Wednesday
    expect(periodStart(now, "day")).toEqual(new Date(2026, 0, 7));
    expect(periodStart(now, "week")).toEqual(new Date(2026, 0, 5));
  });
  it("prefers vendor data, then newer data, and resets past windows", () => {
    const now = new Date("2026-01-05T09:00:00Z");
    const w = (o: Partial<StoredWindow>): StoredWindow => ({ route: "r", kind: "5h", usedPct: 50, resetsAt: "2026-01-05T12:00:00Z", source: "vendor", observedAt: "2026-01-05T08:58:00Z", ...o });
    expect(shouldReplace(w({}), w({ source: "inferred", observedAt: "2026-01-05T08:59:00Z" }), now)).toBe(false);
    expect(shouldReplace(w({ source: "inferred" }), w({}), now)).toBe(true);
    expect(shouldReplace(w({ observedAt: "2026-01-05T08:00:00Z" }), w({ source: "inferred" }), now)).toBe(true); // stale vendor
    expect(currentUsed(w({ resetsAt: "2026-01-05T08:00:00Z" }), now)).toBe(0);
    expect(currentUsed(w({ usedPct: null }), now)).toBeNull();
  });
});
