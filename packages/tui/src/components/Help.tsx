import { Box, Text } from "ink";
import { COMMANDS } from "../commands.js";
import type { Theme } from "../theme.js";
import { GradientText } from "./Logo.js";

export function Help({ t }: { t: Theme }) {
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={t.accent} paddingX={1}>
      <GradientText text="✦ what you can type" t={t} bold />
      <Text> </Text>
      <Text>
        <Text color={t.you}>plain text</Text> → talks to the selected agent (it pauses safely, reads it, carries on).
      </Text>
      <Text>{"             "}On an idle agent it becomes a new task for that agent. On the planner it becomes a plan.</Text>
      <Text> </Text>
      {COMMANDS.map((c) => (
        <Text key={c.name}>
          <Text color={t.accent}>{`/${c.name}`.padEnd(10)}</Text>
          <Text color={t.dim}>{c.args.padEnd(26)}</Text>
          {c.desc}
        </Text>
      ))}
      <Text> </Text>
      <Text color={t.dim}>Tab / Shift-Tab switch agents · ↑↓ history · PgUp/PgDn scroll · Esc close · Ctrl-C clear/quit</Text>
      <Text color={t.dim}>The daemon owns all state: closing this screen never stops the agents.</Text>
    </Box>
  );
}
