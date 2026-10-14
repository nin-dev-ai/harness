import { Box, Text } from "ink";

const ROWS: [string, string][] = [
  ["↑ ↓ / Tab", "move between workers and tasks"],
  ["Enter", "open the selected worker's live output full screen"],
  ["a", "attach: take over the worker interactively (on a DRAFT task: approve it)"],
  ["p / P", "pause the selected worker / pause everything"],
  ["r", "start or resume the scheduler"],
  ["v", "review the selected task (diff, checks, findings, accept or reject)"],
  ["b", "toggle burst mode"],
  ["l", "limits editor for the selected route"],
  ["n", "new task"],
  ["t", "toggle raw output"],
  ["PgUp / PgDn", "scroll output"],
  ["q / Q", "quit the UI (daemon keeps running) / quit and stop everything"],
];

export function Help() {
  return (
    <Box flexDirection="column" borderStyle="single" paddingX={1}>
      <Text bold>Keys</Text>
      {ROWS.map(([k, d]) => (
        <Text key={k}>
          {k.padEnd(14)} {d}
        </Text>
      ))}
      <Text> </Text>
      <Text color="gray">The daemon owns all state. Closing this UI never stops work.</Text>
    </Box>
  );
}
