import { Box, Text } from "ink";
import { clip } from "../format.js";
import { C } from "../theme.js";

export interface DetailLine {
  label: string;
  value: string;
  color?: string | undefined;
}

/** Context for the selected agent: what it was asked, where it writes, how it is doing. */
export function DetailPane({ title, lines, width }: { title: string; lines: DetailLine[]; width: number }) {
  const rule = "─".repeat(Math.max(0, width - title.length - 4));
  return (
    <Box flexDirection="column" width={width}>
      <Text color={C.dim}>
        ── <Text color={undefined} bold>{title}</Text> {rule}
      </Text>
      {lines.map((l, i) => (
        <Text key={i} wrap="truncate-end">
          {" "}
          <Text color={C.dim}>{l.label.padEnd(9)}</Text> <Text color={l.color}>{clip(l.value, width - 12)}</Text>
        </Text>
      ))}
    </Box>
  );
}
