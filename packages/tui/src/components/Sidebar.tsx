import { Box, Text } from "ink";
import type { StatusSnapshot } from "@harness/daemon";
import { clip } from "../format.js";
import type { FileStat } from "../store.js";
import { stateColor, stateIcon, type Theme } from "../theme.js";

type TaskRow = StatusSnapshot["tasks"][number];

const ORDER = ["RUNNING", "GATING", "REPAIRING", "REVIEWING", "PAUSED", "TAKEN_OVER", "NEEDS_HUMAN", "PR_READY", "QUEUED", "DRAFT", "STALE", "MERGED", "CANCELLED"];
export function sortTasks(tasks: TaskRow[]): TaskRow[] {
  return [...tasks].sort((a, b) => ORDER.indexOf(a.state) - ORDER.indexOf(b.state) || a.id.localeCompare(b.id));
}

/** Files the current task changed, plus every task at a glance. */
export function Sidebar({ files, tasks, current, cost, width, height, t }: { files: FileStat[]; tasks: TaskRow[]; current?: string | undefined; cost?: { tokensIn: number; tokensOut: number; usd: number | null } | undefined; width: number; height: number; t: Theme }) {
  const fileRows = Math.min(files.length, Math.max(3, Math.floor(height / 2) - 3));
  const taskRows = Math.max(1, height - fileRows - 6);
  const ins = files.reduce((a, f) => a + f.insertions, 0);
  const del = files.reduce((a, f) => a + f.deletions, 0);
  return (
    <Box flexDirection="column" width={width} borderStyle="round" borderColor={t.dim} paddingX={1}>
      <Text bold>
        📂 Files{current ? ` · ${current}` : ""} <Text color={t.ok}>+{ins}</Text> <Text color={t.bad}>-{del}</Text>
      </Text>
      {files.length === 0 ? <Text color={t.dim}>no changes yet</Text> : null}
      {files.slice(0, fileRows).map((f) => (
        <Text key={f.path} wrap="truncate-end">
          <Text color={t.ok}>{`+${f.insertions}`.padStart(4)}</Text> <Text color={t.bad}>{`-${f.deletions}`.padEnd(4)}</Text> {clip(f.path, width - 14)}
        </Text>
      ))}
      {files.length > fileRows ? <Text color={t.dim}>…and {files.length - fileRows} more (/diff)</Text> : null}
      {cost && (cost.tokensIn || cost.usd !== null) ? (
        <Text color={t.dim}>
          tokens {cost.tokensIn.toLocaleString()}↑ {cost.tokensOut.toLocaleString()}↓{cost.usd !== null ? ` · $${cost.usd.toFixed(2)}` : ""}
        </Text>
      ) : null}
      <Text> </Text>
      <Text bold>📋 Tasks</Text>
      {tasks.length === 0 ? <Text color={t.dim}>none yet. Type what you want built ✨</Text> : null}
      {sortTasks(tasks)
        .slice(0, taskRows)
        .map((x) => (
          <Text key={x.id} wrap="truncate-end" inverse={x.id === current}>
            {stateIcon(x.state)} <Text color={stateColor(t, x.state)}>{x.id}</Text> {clip(x.title, width - 12)}
          </Text>
        ))}
    </Box>
  );
}
