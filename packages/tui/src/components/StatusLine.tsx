import { Box, Text } from "ink";
import type { Theme } from "../theme.js";

/** oh-my-zsh style segments: colored blocks, with powerline arrows in the agnoster theme. */
export function StatusLine({ segments, right, t, width }: { segments: string[]; right?: string; t: Theme; width: number }) {
  return (
    <Box width={width} justifyContent="space-between">
      <Text>
        {segments.map((s, i) => {
          const bg = t.bar[i % t.bar.length]!;
          const next = t.bar[(i + 1) % t.bar.length];
          return (
            <Text key={i}>
              <Text backgroundColor={bg} color={t.barText} bold={i === 0}>
                {` ${s} `}
              </Text>
              {t.powerline ? (
                <Text color={bg} backgroundColor={i < segments.length - 1 ? next : undefined}>
                  {""}
                </Text>
              ) : null}
            </Text>
          );
        })}
      </Text>
      {right ? <Text color={t.dim}>{right}</Text> : null}
    </Box>
  );
}
