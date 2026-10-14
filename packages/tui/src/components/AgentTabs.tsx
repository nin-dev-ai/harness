import { Box, Text } from "ink";
import type { WorkerView } from "@harness/daemon";
import { SPINNER, VENDOR, type Theme } from "../theme.js";

/** Agent pills; the selected one is filled. Running agents spin. */
export function AgentTabs({ workers, selected, frame, t }: { workers: WorkerView[]; selected: number; frame: number; t: Theme }) {
  return (
    <Box flexWrap="wrap" columnGap={1}>
      {workers.map((w, i) => {
        const v = VENDOR[w.vendor] ?? VENDOR.fake!;
        const sel = i === selected;
        const busy = w.state === "RUNNING";
        const mark = busy ? SPINNER[frame % SPINNER.length] : w.state === "PAUSED" ? "⏸" : w.state === "WAITING" ? "…" : "·";
        const label = ` ${mark} ${w.id} ${v.icon} ${w.vendor}${w.taskId ? ` · ${w.taskId}` : ""} `;
        return sel ? (
          <Text key={w.id} backgroundColor={v.color} color="black" bold>
            {label}
          </Text>
        ) : (
          <Text key={w.id} color={busy ? v.color : t.dim}>
            {label}
          </Text>
        );
      })}
    </Box>
  );
}
