import { Box, Text } from "ink";
import type { RouteView } from "@harness/daemon";
import { bar, resetText } from "../format.js";
import { VENDOR, type Theme } from "../theme.js";

/** One compact pill per route: each window's bar, %, source; unknown is never 0%. */
export function UsagePills({ routes, now, t }: { routes: RouteView[]; now: string; t: Theme }) {
  return (
    <Box flexWrap="wrap" columnGap={2}>
      {routes.map((r) => {
        const v = VENDOR[r.vendor] ?? VENDOR.fake!;
        const wins = r.windows.filter((w) => w.kind !== "budget");
        const budget = r.windows.find((w) => w.kind === "budget");
        return (
          <Text key={r.route}>
            <Text color={v.color}>{v.icon} </Text>
            <Text bold>{r.route}</Text>{" "}
            {r.pausedUntil ? <Text color={t.warn}>⏸ {r.pauseSource === "backoff" ? "probing" : resetText(now, r.pausedUntil)} </Text> : null}
            {wins.length === 0 && !budget ? <Text color={t.dim}>usage unknown</Text> : null}
            {wins.map((w) => {
              const hot = w.usedPct !== null && w.usedPct >= w.capPct * 0.85;
              return (
                <Text key={w.kind} dimColor={w.stale}>
                  <Text color={t.dim}>{w.kind} </Text>
                  <Text color={hot ? t.bad : t.accent}>{bar(w.usedPct, 6)}</Text> {w.display}
                  <Text color={t.dim}> ↺{resetText(now, w.resetsAt).split(" ")[0]} </Text>
                </Text>
              );
            })}
            {budget ? (
              <Text>
                <Text color={t.dim}>budget </Text>
                <Text color={t.accent}>{bar(budget.usedPct, 6)}</Text> {budget.detail ?? budget.display}{" "}
              </Text>
            ) : null}
          </Text>
        );
      })}
    </Box>
  );
}
