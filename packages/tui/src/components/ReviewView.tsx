import { Box, Text } from "ink";
import { clip } from "../format.js";
import { theme } from "../theme.js";

export interface ReviewData {
  task: { id: string; title: string; state: string };
  stat: string | null;
  diff: string | null;
  checks: { checkId: string; ok: boolean; required: boolean }[];
  gate: string | null;
  findings: { severity: string; file: string | null; line: number | null; message: string }[];
}

export function ReviewView({ data, showDiff, width, height }: { data: ReviewData; showDiff: boolean; width: number; height: number }) {
  const body = showDiff ? (data.diff ?? "(no diff)").split("\n") : (data.stat ?? "(worktree removed)").split("\n");
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1} width={width}>
      <Text bold>
        REVIEW {data.task.id} {clip(data.task.title, width - 30)} <Text color={theme.state(data.task.state)}>{data.task.state}</Text>
      </Text>
      <Text bold>Checks ({data.gate ?? "not run"})</Text>
      {data.checks.map((c) => (
        <Text key={c.checkId} color={c.ok ? theme.ok : theme.bad}>
          {"  "}
          {c.ok ? "✓" : "✗"} {c.checkId}
          {c.required ? "" : " (optional)"}
        </Text>
      ))}
      <Text bold>Findings</Text>
      {data.findings.length === 0 && <Text color={theme.dim}>  (none)</Text>}
      {data.findings.map((f, i) => (
        <Text key={i} color={f.severity === "blocker" ? theme.bad : f.severity === "major" ? theme.warn : undefined}>
          {"  "}[{f.severity}] {f.file ? `${f.file}${f.line ? `:${f.line}` : ""} ` : ""}
          {clip(f.message, width - 30)}
        </Text>
      ))}
      <Text bold>{showDiff ? "Diff" : "Changes"}</Text>
      {body.slice(0, Math.max(3, height - 10 - data.checks.length - data.findings.length)).map((l, i) => (
        <Text key={i} color={l.startsWith("+") ? theme.ok : l.startsWith("-") ? theme.bad : undefined} wrap="truncate-end">
          {clip(l, width - 4)}
        </Text>
      ))}
    </Box>
  );
}
