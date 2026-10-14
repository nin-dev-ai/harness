import { Box, Text } from "ink";
import type { WorkerView } from "@harness/daemon";
import { clip, duration } from "../format.js";
import { theme } from "../theme.js";

export function Workers({ workers, selected, focused, width }: { workers: WorkerView[]; selected: number; focused: boolean; width: number }) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={focused ? theme.accent : undefined}>WORKERS</Text>
      {workers.length === 0 && <Text color={theme.dim}>(no roles)</Text>}
      {workers.map((w, i) => {
        const sel = focused && i === selected;
        const detail = w.taskId ? `${w.taskId} ${w.taskTitle ?? ""}` : w.waitingReason ? `waiting: ${w.waitingReason}` : "";
        return (
          <Box key={w.id} flexDirection="column">
            <Text inverse={sel}>
              {theme.workerIcon(w.state)} {w.id.padEnd(12)} {w.vendor.padEnd(7)} <Text color={theme.state(w.state)}>{w.state.padEnd(8)}</Text>
            </Text>
            <Text color={theme.dim}>
              {"  "}
              {clip(detail, Math.max(10, width - 12))} {duration(w.elapsedMs)}
            </Text>
          </Box>
        );
      })}
    </Box>
  );
}
