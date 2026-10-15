import { Box, Text } from "ink";
import type { Theme } from "../theme.js";

/** Colored blocks like an oh-my-zsh prompt; one line. */
export function StatusLine({ segments, right, t, width }: { segments: string[]; right?: string; t: Theme; width: number }) {
  return (
    <Box width={width} justifyContent="space-between">
      <Text wrap="truncate-end">
        {segments.map((s, i) => (
          <Text key={i} backgroundColor={t.bar[i % t.bar.length]} color={t.barText} bold={i === 0}>
            {` ${s} `}
          </Text>
        ))}
      </Text>
      {right ? <Text dimColor>{right}</Text> : null}
    </Box>
  );
}
