import { Box, Text } from "ink";
import type { Entry } from "../format.js";
import { SPINNER, VENDOR, type Theme } from "../theme.js";

export interface PaneProps {
  id: string;
  vendor: string;
  model: string;
  status: string;
  statusColor?: string | undefined;
  busy: boolean;
  frame: number;
  subtitle: string;
  meta: string;
  entries: Entry[];
  extra?: { label: string; value: string; color?: string | undefined }[];
  idleHint: string;
  width: number;
  height: number;
  focused: boolean;
  t: Theme;
}

const clip = (s: string, n: number) => (n <= 0 ? "" : s.length > n ? `${s.slice(0, Math.max(0, n - 1))}…` : s);

interface Line {
  prefix: string;
  text: string;
  color?: string | undefined;
  prefixColor?: string | undefined;
  dim?: boolean;
}

/** One plain, Claude-Code-like line per event. Body text stays the default color. */
export function entryLine(e: Entry, t: Theme): Line | undefined {
  switch (e.kind) {
    case "you":
      return { prefix: "❯ ", prefixColor: t.you, text: e.text };
    case "say":
      return { prefix: "⏺ ", prefixColor: t.accent, text: e.text.replace(/\s+/g, " ") };
    case "tool":
      return { prefix: "⏺ ", prefixColor: t.accent, text: `${e.text}(${e.detail ?? ""})` };
    case "edit":
      return { prefix: "  ⎿ ", text: `✎ ${e.text}`, dim: true };
    case "check":
      return { prefix: "  ⎿ ", text: `${e.text} ${e.detail ?? ""}`, ...(e.text.startsWith("✗") ? { color: "red" } : { dim: true }) };
    case "ok":
      return { prefix: "✔ ", text: e.text, dim: true };
    case "err":
      return { prefix: "✘ ", prefixColor: "red", text: e.text, color: "red" };
    case "warn":
      return { prefix: "⚠ ", prefixColor: "yellow", text: e.text, color: "yellow" };
    case "finding":
      return { prefix: "  ⎿ ", text: `[${e.detail}] ${e.text}` };
    case "run":
      return { prefix: "─ ", text: `${e.text} ${e.detail ?? ""}`.trim(), dim: true };
    case "sys":
      return { prefix: "· ", text: e.text, dim: true };
    default:
      return undefined;
  }
}

/** One agent's live session in a bordered pane in the tool's own color. */
export function Pane(p: PaneProps) {
  const v = VENDOR[p.vendor] ?? VENDOR.fake!;
  const inner = Math.max(10, p.width - 4);
  const fixed = 4 + (p.extra?.length ?? 0);
  const streamRows = Math.max(1, p.height - 2 - fixed);
  const lines = p.entries.map((e) => entryLine(e, p.t)).filter((l): l is Line => Boolean(l)).slice(-streamRows);
  const mark = p.busy ? SPINNER[p.frame % SPINNER.length]! : "·";
  return (
    <Box
      flexDirection="column"
      width={p.width}
      height={p.height}
      flexShrink={0}
      borderStyle={p.focused ? "bold" : "round"}
      borderColor={v.color}
      borderDimColor={!p.focused}
      paddingX={1}
      overflow="hidden"
    >
      <Box justifyContent="space-between" width={inner}>
        <Text wrap="truncate-end">
          <Text color={v.color}>{mark} </Text>
          <Text bold>{clip(p.id, inner - p.status.length - 3)}</Text>
        </Text>
        <Text color={p.statusColor} dimColor={!p.statusColor}>
          {p.status}
        </Text>
      </Box>
      <Text dimColor wrap="truncate-end">
        <Text color={v.color}>{v.icon} </Text>
        {clip(`${p.vendor}/${p.model}`, inner - 2)}
      </Text>
      <Text wrap="truncate-end">{clip(p.subtitle, inner)}</Text>
      <Text dimColor wrap="truncate-end">
        {clip(p.meta, inner)}
      </Text>
      {(p.extra ?? []).map((x, i) => (
        <Text key={i} wrap="truncate-end">
          <Text dimColor>{x.label.padEnd(8)}</Text>
          <Text color={x.color}>{clip(x.value, inner - 8)}</Text>
        </Text>
      ))}
      {lines.length === 0 ? <Text dimColor>{p.idleHint}</Text> : null}
      {lines.map((l, i) => (
        <Text key={i} wrap="truncate-end">
          <Text color={l.prefixColor} dimColor={l.dim}>
            {l.prefix}
          </Text>
          <Text color={l.color} dimColor={l.dim}>
            {clip(l.text, inner - l.prefix.length)}
          </Text>
        </Text>
      ))}
    </Box>
  );
}
