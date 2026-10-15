import { Box, Text } from "ink";
import { COMMANDS } from "../commands.js";
import { C, type Theme } from "../theme.js";
import { GradientText } from "./Logo.js";

export function Help({ t }: { t: Theme }) {
  return (
    <Box flexDirection="column" paddingX={1}>
      <GradientText text="how this works" t={t} bold />
      <Text>
        <Text color={t.you}>type a message</Text> and the planner splits it into mini prompts, one per agent, then starts them.
      </Text>
      <Text>
        <Text color={t.you}>Tab</Text> picks one agent: its live session shows here and your messages go straight to it. Tab back to <Text bold>team</Text>.
      </Text>
      <Text>
        <Text color={t.you}>/</Text> opens commands. <Text color={C.dim}>Ctrl-C closes harness; agents keep working. /stop stops them.</Text>
      </Text>
      <Text> </Text>
      {COMMANDS.map((c) => (
        <Text key={c.name}>
          <Text color={t.accent}>{`/${c.name}`.padEnd(10)}</Text>
          <Text color={C.dim}>{c.args.padEnd(34)}</Text>
          {c.desc}
        </Text>
      ))}
      <Text> </Text>
      <Text color={C.dim}>Agents and what they may edit live in harness.yaml. esc closes this.</Text>
    </Box>
  );
}
