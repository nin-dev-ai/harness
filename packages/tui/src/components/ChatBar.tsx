import { Box, Text } from "ink";
import { completions, type SlashCommand } from "../commands.js";
import type { Theme } from "../theme.js";

/** The input line and, while typing a slash command, a menu of matches above it. */
export function ChatBar({ value, cursor, menuIndex, placeholder, width, t }: { value: string; cursor: number; menuIndex: number; placeholder: string; width: number; t: Theme }) {
  const menu: SlashCommand[] = completions(value).slice(0, 8);
  const before = value.slice(0, cursor);
  const at = value[cursor] ?? " ";
  const after = value.slice(cursor + 1);
  return (
    <Box flexDirection="column" width={width}>
      {menu.length > 0 && (
        <Box flexDirection="column" paddingX={1}>
          {menu.map((c, i) => (
            <Text key={c.name} wrap="truncate-end">
              <Text color={i === menuIndex ? "black" : t.accent} backgroundColor={i === menuIndex ? t.accent : undefined}>
                {` /${c.name} `}
              </Text>
              <Text color={t.dim}> {c.args ? `${c.args}  ` : ""}</Text>
              <Text>{c.desc}</Text>
            </Text>
          ))}
        </Box>
      )}
      <Box borderStyle="round" borderColor={value.startsWith("/") ? t.accent : t.gradient[0]} paddingX={1} width={width}>
        <Text color={t.gradient[0]} bold>
          ❯{" "}
        </Text>
        {value ? (
          <Text>
            {before}
            <Text inverse>{at}</Text>
            {after}
          </Text>
        ) : (
          <Text>
            <Text inverse> </Text>
            <Text color={t.dim}>{placeholder}</Text>
          </Text>
        )}
      </Box>
    </Box>
  );
}
