import { Box, Text } from "ink";
import { COMMANDS } from "../commands.js";
import { C } from "../theme.js";

export function Help() {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold>Keys</Text>
      <Text>
        <Text color={C.dim}>{"↑ ↓".padEnd(10)}</Text>select an agent
      </Text>
      <Text>
        <Text color={C.dim}>{"enter".padEnd(10)}</Text>review the selected agent's task (checks, findings, files)
      </Text>
      <Text>
        <Text color={C.dim}>{"/".padEnd(10)}</Text>command line
      </Text>
      <Text>
        <Text color={C.dim}>{"r  p".padEnd(10)}</Text>run the scheduler · pause the selected agent's task
      </Text>
      <Text>
        <Text color={C.dim}>{"q".padEnd(10)}</Text>close the panel (agents keep working)
      </Text>
      <Text> </Text>
      <Text bold>Commands</Text>
      {COMMANDS.map((c) => (
        <Text key={c.name}>
          <Text color={C.accent}>{`/${c.name}`.padEnd(10)}</Text>
          <Text color={C.dim}>{c.args.padEnd(32)}</Text>
          {c.desc}
        </Text>
      ))}
      <Text> </Text>
      <Text color={C.dim}>Agents are set in harness.yaml (the first-run wizard writes it). esc closes this.</Text>
    </Box>
  );
}
