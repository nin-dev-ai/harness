import { Box, Text } from "ink";
import type { StatusSnapshot } from "@harness/daemon";
import { clip } from "../format.js";
import { theme } from "../theme.js";

type TaskRow = StatusSnapshot["tasks"][number];

const ORDER = ["RUNNING", "GATING", "REPAIRING", "REVIEWING", "PAUSED", "TAKEN_OVER", "NEEDS_HUMAN", "PR_READY", "QUEUED", "DRAFT", "STALE", "MERGED", "CANCELLED"];

export function sortTasks(tasks: TaskRow[]): TaskRow[] {
  return [...tasks].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.id.localeCompare(b.id));
}

export function Tasks({ tasks, selected, focused, width, height }: { tasks: TaskRow[]; selected: number; focused: boolean; width: number; height: number }) {
  const start = Math.max(0, Math.min(selected - Math.floor(height / 2), tasks.length - height));
  const visible = tasks.slice(start, start + Math.max(1, height));
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={focused ? theme.accent : undefined}>TASKS</Text>
      {tasks.length === 0 && <Text color={theme.dim}>(no tasks: press n, or run harness plan)</Text>}
      {visible.map((t, i) => {
        const sel = focused && start + i === selected;
        const tail = t.state === "QUEUED" && t.blockedReason ? `(${t.blockedReason})` : t.dependsOn.length && t.state !== "MERGED" ? `→ ${t.dependsOn.join(",")}` : t.state === "PR_READY" ? "✓ gate" : "";
        return (
          <Text key={t.id} inverse={sel} wrap="truncate-end">
            {t.id} <Text color={theme.state(t.state)}>{t.state.padEnd(11)}</Text> {t.role.padEnd(9)} {clip(t.title, Math.max(6, width - 46))} <Text color={theme.dim}>{tail}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
