import { Box, Text } from "ink";
import { clip } from "../format.js";
import { theme } from "../theme.js";

/** Live normalized events (or raw JSON) for one run, newest at the bottom. */
export function Output({ title, lines, height, width, scroll, raw }: { title: string; lines: string[]; height: number; width: number; scroll: number; raw: boolean }) {
  const h = Math.max(1, height - 1);
  const end = Math.max(0, lines.length - scroll);
  const shown = lines.slice(Math.max(0, end - h), end);
  return (
    <Box flexDirection="column" paddingX={1} width={width}>
      <Text bold>
        OUTPUT: {clip(title, width - 12)}
        {raw ? <Text color={theme.dim}> (raw)</Text> : null}
        {scroll > 0 ? <Text color={theme.dim}> (scrolled {scroll})</Text> : null}
      </Text>
      {shown.length === 0 && <Text color={theme.dim}>(no output yet)</Text>}
      {shown.map((l, i) => (
        <Text key={i} color={l.startsWith("✗") ? theme.bad : l.startsWith("✓") ? theme.ok : l.startsWith("⏸") ? theme.warn : undefined} wrap="truncate-end">
          {clip(l, width - 3)}
        </Text>
      ))}
    </Box>
  );
}
