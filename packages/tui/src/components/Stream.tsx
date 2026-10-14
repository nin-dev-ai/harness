import { Box, Text } from "ink";
import type { Entry } from "../format.js";
import type { Theme } from "../theme.js";

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  for (const raw of text.split("\n")) {
    let line = raw;
    while (line.length > width) {
      const cut = line.lastIndexOf(" ", width);
      const at = cut > width * 0.5 ? cut : width;
      out.push(line.slice(0, at));
      line = line.slice(at).replace(/^ /, "");
    }
    out.push(line);
  }
  return out;
}

interface Row {
  key: string;
  node: React.ReactNode;
}

/** The conversation for one agent/task, Claude-Code style, newest at the bottom. */
export function Stream({ entries, width, height, scroll, t, empty }: { entries: Entry[]; width: number; height: number; scroll: number; t: Theme; empty?: React.ReactNode }) {
  const w = Math.max(20, width);
  const rows: Row[] = [];
  entries.forEach((e, i) => {
    const k = `${i}`;
    const push = (prefix: React.ReactNode, text: string, color?: string, dim?: boolean) => {
      wrap(text, w - 3).forEach((l, j) =>
        rows.push({
          key: `${k}-${j}`,
          node: (
            <Text>
              {j === 0 ? prefix : "  "}
              <Text color={color} dimColor={dim}>
                {l}
              </Text>
            </Text>
          ),
        }),
      );
    };
    switch (e.kind) {
      case "you":
        rows.push({ key: `${k}-gap`, node: <Text> </Text> });
        push(<Text color={t.you} bold>❯ </Text>, e.text, t.you);
        break;
      case "say":
        push(<Text color={t.accent}>⏺ </Text>, e.text);
        break;
      case "tool":
        push(<Text color={t.ok}>⏺ </Text>, `${e.text}(${e.detail ?? ""})`, undefined);
        break;
      case "edit":
        push(<Text color={t.warn}>  ⎿ ✎ </Text>, e.text, t.warn);
        break;
      case "check":
        push(<Text>  ⎿ </Text>, `${e.text} ${e.detail ?? ""}`, e.text.startsWith("✓") ? t.ok : t.bad);
        break;
      case "ok":
        push(<Text color={t.ok}>✔ </Text>, `${e.detail ? `${e.detail}: ` : ""}${e.text}`, t.ok);
        break;
      case "err":
        push(<Text color={t.bad}>✘ </Text>, `${e.detail ? `${e.detail}: ` : ""}${e.text}`, t.bad);
        break;
      case "warn":
        push(<Text color={t.warn}>⚠ </Text>, e.text, t.warn);
        break;
      case "finding":
        push(<Text color={t.warn}>  ⎿ 👀 </Text>, `[${e.detail}] ${e.text}`);
        break;
      case "run":
        rows.push({ key: `${k}-gap`, node: <Text> </Text> });
        push(<Text color={t.dim}>── </Text>, `${e.text} ${e.detail ?? ""} ${"─".repeat(Math.max(0, w - e.text.length - (e.detail?.length ?? 0) - 8))}`, t.dim);
        break;
      default:
        push(<Text color={t.dim}>· </Text>, e.text, t.dim, true);
    }
  });
  const end = Math.max(0, rows.length - scroll);
  const shown = rows.slice(Math.max(0, end - height), end);
  return (
    <Box flexDirection="column" width={w} height={height} overflow="hidden">
      {shown.length === 0 ? empty : shown.map((r) => <Box key={r.key}>{r.node}</Box>)}
      {scroll > 0 ? <Text color={t.dim}>↓ {scroll} more (PgDn)</Text> : null}
    </Box>
  );
}
