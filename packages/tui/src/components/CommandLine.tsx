import { Box, Text } from "ink";
import { completions } from "../commands.js";
import { C } from "../theme.js";

/** The `/` command line with a short menu of matching commands. */
export function CommandLine({ value, cursor, menuIndex, width }: { value: string; cursor: number; menuIndex: number; width: number }) {
  const menu = completions(value).slice(0, 6);
  return (
    <Box flexDirection="column" width={width}>
      {menu.map((c, i) => (
        <Text key={c.name} wrap="truncate-end" color={i === menuIndex ? C.accent : C.dim}>
          {i === menuIndex ? " ▸ " : "   "}
          {`/${c.name}`.padEnd(10)}
          {c.args.padEnd(30)}
          {c.desc}
        </Text>
      ))}
      <Text>
        <Text color={C.accent}>/</Text>
        {value.slice(0, cursor)}
        <Text inverse>{value[cursor] ?? " "}</Text>
        {value.slice(cursor + 1)}
      </Text>
    </Box>
  );
}
