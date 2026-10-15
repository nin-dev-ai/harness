import { Box, Text } from "ink";
import { completions } from "../commands.js";
import { C, type Theme } from "../theme.js";

/** The chat input with a short slash-command menu above it. Always the focus. */
export function ChatBar({ value, cursor, menuIndex, placeholder, target, width, t }: { value: string; cursor: number; menuIndex: number; placeholder: string; target: string; width: number; t: Theme }) {
  const menu = value.startsWith("/") ? completions(value).slice(0, 7) : [];
  const at = value[cursor] ?? " ";
  return (
    <Box flexDirection="column" width={width}>
      {menu.map((c, i) => (
        <Text key={c.name} wrap="truncate-end">
          <Text color={i === menuIndex ? t.accent : C.dim} bold={i === menuIndex}>
            {i === menuIndex ? " ▸ " : "   "}
            {`/${c.name}`.padEnd(10)}
          </Text>
          <Text color={C.dim}>
            {c.args.padEnd(26)}
            {c.desc}
          </Text>
        </Text>
      ))}
      <Box borderStyle="round" borderColor={value.startsWith("/") ? t.accent : t.gradient[0]} paddingX={1} width={width}>
        <Text color={t.gradient[0]} bold>
          ❯{" "}
        </Text>
        <Text color={t.accent}>{target} </Text>
        {value ? (
          <Text>
            {value.slice(0, cursor)}
            <Text inverse>{at}</Text>
            {value.slice(cursor + 1)}
          </Text>
        ) : (
          <Text>
            <Text inverse> </Text>
            <Text color={C.dim}>{placeholder}</Text>
          </Text>
        )}
      </Box>
    </Box>
  );
}
