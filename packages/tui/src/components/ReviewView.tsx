import { Box, Text } from "ink";
import { clip } from "../format.js";
import { C, stateColor } from "../theme.js";

export interface ReviewData {
  task: { id: string; title: string; state: string };
  stat: string | null;
  diff: string | null;
  checks: { checkId: string; ok: boolean; required: boolean }[];
  gate: string | null;
  findings: { severity: string; file: string | null; line: number | null; message: string }[];
  fileStats?: { path: string; insertions: number; deletions: number }[];
}

/** Checks, findings and files, or the full diff, for one task. */
export function ReviewView({ data, showDiff, width, height, scroll }: { data: ReviewData; showDiff: boolean; width: number; height: number; scroll: number }) {
  const lines = showDiff ? (data.diff ?? "(no diff)").split("\n") : [];
  const avail = Math.max(3, height - 3);
  return (
    <Box flexDirection="column" width={width}>
      <Text color={C.dim}>
        ── <Text bold color={undefined}>{showDiff ? "diff" : "review"} {data.task.id} {clip(data.task.title, width - 40)}</Text> <Text color={stateColor(data.task.state)}>{data.task.state.toLowerCase()}</Text>
      </Text>
      {showDiff ? (
        lines.slice(scroll, scroll + avail).map((l, i) => (
          <Text key={i} wrap="truncate-end" color={l.startsWith("+") && !l.startsWith("+++") ? "green" : l.startsWith("-") && !l.startsWith("---") ? C.bad : l.startsWith("@@") || l.startsWith("diff") ? C.dim : undefined}>
            {l || " "}
          </Text>
        ))
      ) : (
        <>
          <Text>
            <Text color={C.dim}>{" checks".padEnd(10)}</Text>
            {data.checks.length ? data.checks.map((c) => `${c.ok ? "✓" : "✗"} ${c.checkId}${c.required ? "" : " (optional)"}`).join("   ") : "not run yet"}
            <Text color={C.dim}> ({data.gate === "gate.passed" ? "passed" : data.gate === "gate.failed" ? "failed" : "pending"}, run by harness)</Text>
          </Text>
          <Text color={C.dim}>{" findings"}</Text>
          {data.findings.length === 0 ? <Text color={C.dim}>{"           none"}</Text> : null}
          {data.findings.map((f, i) => (
            <Text key={i} wrap="truncate-end" color={f.severity === "blocker" ? C.bad : f.severity === "major" ? C.warn : undefined}>
              {"           "}[{f.severity}] {f.file ? `${f.file}${f.line ? `:${f.line}` : ""} ` : ""}
              {f.message}
            </Text>
          ))}
          <Text color={C.dim}>{" files"}</Text>
          {(data.fileStats ?? []).length === 0 ? <Text color={C.dim}>{"           no changes"}</Text> : null}
          {(data.fileStats ?? []).map((f) => (
            <Text key={f.path} wrap="truncate-end">
              {"           "}
              {f.path} <Text color={C.dim}>+{f.insertions} -{f.deletions}</Text>
            </Text>
          ))}
          <Text> </Text>
          <Text color={C.dim}> /diff full diff · /accept merge · /reject &lt;comment&gt; · esc back</Text>
        </>
      )}
    </Box>
  );
}
