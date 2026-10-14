import { Box, Text } from "ink";
import type { RouteView, WindowView } from "@harness/daemon";
import { bar, resetText } from "../format.js";
import { theme } from "../theme.js";

function WindowCell({ w, now }: { w: WindowView; now: string }) {
  const label = w.kind === "budget" ? "budget" : w.kind;
  const color = w.usedPct === null ? undefined : w.usedPct >= w.capPct ? theme.bad : w.usedPct >= w.capPct * 0.8 ? theme.warn : undefined;
  return (
    <Text dimColor={w.stale}>
      {label} <Text color={color}>{bar(w.usedPct)}</Text> {w.display.padStart(7)}
      {w.detail ? ` of budget (${w.detail})` : ""}
      {w.kind !== "budget" ? `  resets ${resetText(now, w.resetsAt)}` : ""}
      {w.capPct < 100 ? `  cap ${w.capPct}%` : ""}
      {"  "}
      <Text color={theme.dim}>[{w.source}]{w.stale ? " stale" : ""}</Text>
    </Text>
  );
}

/** One row per route: every window with its source; unknown is never 0%. */
export function UsageBar({ routes, now, width }: { routes: RouteView[]; now: string; width: number }) {
  return (
    <Box flexDirection="column" borderStyle="single" width={width} paddingX={1}>
      <Text bold>USAGE</Text>
      {routes.map((r) => (
        <Box key={r.route} flexDirection="row" gap={2}>
          <Box width={14}>
            <Text>{r.route.slice(0, 13)}</Text>
          </Box>
          {r.windows.filter((w) => w.kind !== "budget").length === 0 && <Text color={theme.dim}>5h unknown   7d unknown</Text>}
          {r.windows.map((w) => (
            <WindowCell key={w.kind} w={w} now={now} />
          ))}
          {r.pausedUntil && (
            <Text color={theme.warn}>
              {r.pauseSource === "backoff" ? "paused, probing" : `paused until ${resetText(now, r.pausedUntil)}`}
            </Text>
          )}
        </Box>
      ))}
    </Box>
  );
}
