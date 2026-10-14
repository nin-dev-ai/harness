import { Box, Text } from "ink";
import { clip } from "../format.js";
import { stateColor, type Theme } from "../theme.js";

export interface ReviewData {
  task: { id: string; title: string; state: string };
  stat: string | null;
  diff: string | null;
  checks: { checkId: string; ok: boolean; required: boolean }[];
  gate: string | null;
  findings: { severity: string; file: string | null; line: number | null; message: string }[];
  fileStats?: { path: string; insertions: number; deletions: number }[];
}

/** Checks, findings and changes, or the full colored diff, for one task. */
export function ReviewView({ data, showDiff, width, height, scroll, t }: { data: ReviewData; showDiff: boolean; width: number; height: number; scroll: number; t: Theme }) {
  const lines = showDiff ? (data.diff ?? "(no diff)").split("\n") : [];
  const avail = Math.max(3, height - 4);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.accent} paddingX={1} width={width} height={height}>
      <Text bold>
        {showDiff ? "📜 diff" : "🔍 review"} {data.task.id} {clip(data.task.title, width - 40)} <Text color={stateColor(t, data.task.state)}>{data.task.state}</Text>
      </Text>
      {showDiff ? (
        lines.slice(scroll, scroll + avail).map((l, i) => (
          <Text key={i} wrap="truncate-end" color={l.startsWith("+++") || l.startsWith("---") ? t.dim : l.startsWith("+") ? t.ok : l.startsWith("-") ? t.bad : l.startsWith("@@") ? t.accent : undefined} bold={l.startsWith("diff --git")}>
            {l || " "}
          </Text>
        ))
      ) : (
        <>
          <Text bold>Checks <Text color={t.dim}>({data.gate ?? "not run"}, run by harness)</Text></Text>
          {data.checks.length === 0 ? <Text color={t.dim}>  none yet</Text> : null}
          {data.checks.map((c) => (
            <Text key={c.checkId} color={c.ok ? t.ok : t.bad}>
              {"  "}
              {c.ok ? "✓" : "✗"} {c.checkId}
              {c.required ? "" : " (optional)"}
            </Text>
          ))}
          <Text bold>Findings</Text>
          {data.findings.length === 0 ? <Text color={t.dim}>  none</Text> : null}
          {data.findings.map((f, i) => (
            <Text key={i} wrap="truncate-end" color={f.severity === "blocker" ? t.bad : f.severity === "major" ? t.warn : undefined}>
              {"  "}[{f.severity}] {f.file ? `${f.file}${f.line ? `:${f.line}` : ""} ` : ""}
              {f.message}
            </Text>
          ))}
          <Text bold>Files</Text>
          {(data.fileStats ?? []).map((f) => (
            <Text key={f.path} wrap="truncate-end">
              <Text color={t.ok}>{`+${f.insertions}`.padStart(5)}</Text> <Text color={t.bad}>{`-${f.deletions}`.padEnd(5)}</Text> {f.path}
            </Text>
          ))}
          <Text> </Text>
          <Text color={t.dim}>/diff full diff · /accept merge · /reject &lt;comment&gt; send back · Esc close</Text>
        </>
      )}
    </Box>
  );
}
