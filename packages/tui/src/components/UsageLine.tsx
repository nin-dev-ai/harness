import { Text } from "ink";
import type { RouteView } from "@harness/daemon";
import { bar, resetText } from "../format.js";
import { C, VENDOR, type Theme } from "../theme.js";

/** One short pill per tool: its windows and source; unknown is never shown as 0%. */
export function UsageLine({ routes, now, t }: { routes: RouteView[]; now: string; t: Theme }) {
  const seen = new Set<string>();
  const pills = routes
    .map((r) => {
      const five = r.windows.find((w) => w.kind === "5h");
      const seven = r.windows.find((w) => w.kind === "7d");
      const budget = r.windows.find((w) => w.kind === "budget");
      const text = r.pausedUntil
        ? `paused until ${resetText(now, r.pausedUntil).split(" ")[0]}`
        : budget
          ? `${bar(budget.usedPct, 5)} ${budget.detail ?? budget.display}`
          : five || seven
            ? [five && `5h ${bar(five.usedPct, 5)} ${five.display}`, seven && `7d ${seven.display}`].filter(Boolean).join(" · ")
            : "usage unknown";
      const hot = [five, seven].some((w) => w && w.usedPct !== null && w.usedPct >= w.capPct * 0.9);
      return { key: `${r.vendor}|${text}`, vendor: r.vendor, text, color: r.pausedUntil || hot ? C.warn : undefined };
    })
    .filter((p) => (seen.has(p.key) ? false : (seen.add(p.key), true)));
  return (
    <Text wrap="truncate-end">
      {pills.map((p, i) => {
        const v = VENDOR[p.vendor] ?? VENDOR.fake!;
        return (
          <Text key={p.key}>
            {i ? "   " : ""}
            <Text color={v.color}>{v.icon} </Text>
            <Text bold>{p.vendor}</Text> <Text color={p.color ?? t.accent} dimColor={!p.color && p.text === "usage unknown"}>
              {p.text}
            </Text>
          </Text>
        );
      })}
    </Text>
  );
}
