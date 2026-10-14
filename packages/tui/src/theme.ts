/** Colors by meaning, so panels agree. Ink color names. */
export const theme = {
  accent: "cyan",
  ok: "green",
  warn: "yellow",
  bad: "red",
  dim: "gray",
  state(s: string): string | undefined {
    if (["RUNNING", "GATING", "REPAIRING", "REVIEWING"].includes(s)) return "cyan";
    if (["MERGED", "PR_READY"].includes(s)) return "green";
    if (["NEEDS_HUMAN", "FAILED", "CANCELLED"].includes(s)) return "red";
    if (["PAUSED", "WAITING", "STALE", "TAKEN_OVER"].includes(s)) return "yellow";
    if (["IDLE", "DRAFT"].includes(s)) return "gray";
    return undefined;
  },
  workerIcon(s: string): string {
    return s === "RUNNING" ? "▶" : s === "PAUSED" ? "⏸" : s === "WAITING" ? "…" : s === "FAILED" ? "✗" : "○";
  },
} as const;
