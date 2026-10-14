import { Box, Text } from "ink";
import { clip, duration } from "../format.js";
import { C, SPINNER } from "../theme.js";

export interface AgentRow {
  id: string;
  tool: string;
  status: string;
  statusColor?: string | undefined;
  busy: boolean;
  task: string;
  taskDim: boolean;
  elapsedMs: number | null;
  context: string;
  cost: string;
}

const COLS = { agent: 13, tool: 18, status: 11, time: 6, context: 8, cost: 7 };

/** One row per agent: who, which tool, doing what, for how long, with how much context. */
export function AgentTable({ rows, selected, width, frame }: { rows: AgentRow[]; selected: number; width: number; frame: number }) {
  const taskWidth = Math.max(12, width - (COLS.agent + COLS.tool + COLS.status + COLS.time + COLS.context + COLS.cost) - 9);
  const head = (s: string, w: number) => s.padEnd(w);
  return (
    <Box flexDirection="column" width={width}>
      <Text color={C.dim}>
        {"  "}
        {head("AGENT", COLS.agent)} {head("TOOL", COLS.tool)} {head("STATUS", COLS.status)} {head("TASK", taskWidth)} {head("TIME", COLS.time)} {head("CONTEXT", COLS.context)} {"COST"}
      </Text>
      {rows.map((r, i) => {
        const sel = i === selected;
        const mark = r.busy ? SPINNER[frame % SPINNER.length]! : " ";
        return (
          <Text key={r.id} wrap="truncate-end">
            <Text color={sel ? C.accent : undefined} bold={sel}>
              {sel ? "▸" : " "}
              {mark}
              {clip(r.id, COLS.agent - 1).padEnd(COLS.agent)}
            </Text>{" "}
            <Text color={C.dim}>{clip(r.tool, COLS.tool - 1).padEnd(COLS.tool)}</Text> <Text color={r.statusColor}>{r.status.padEnd(COLS.status)}</Text>{" "}
            <Text color={r.taskDim ? C.dim : undefined}>{clip(r.task, taskWidth - 1).padEnd(taskWidth)}</Text> <Text color={C.dim}>{duration(r.elapsedMs).padEnd(COLS.time)}</Text>{" "}
            <Text color={C.dim}>{r.context.padEnd(COLS.context)}</Text> <Text color={C.dim}>{r.cost}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
