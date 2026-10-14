import { Box, Text } from "ink";
import { theme } from "../theme.js";

export type View = "main" | "output" | "review" | "limits" | "new" | "help" | "reject";

const KEYS: Record<View, string> = {
  main: "↑↓ select · tab panel · ⏎ output · a attach · p/P pause · r run · v review · b burst · l limits · n new · ? help · q quit · Q stop",
  output: "⏎/esc back  t raw  pgup/pgdn scroll",
  review: "A accept  R reject  d diff  esc back",
  reject: "type a comment  ⏎ send  esc cancel",
  limits: "←→ window  type budget  ⏎ save  esc cancel",
  new: "type a title  tab role  ⏎ create  esc cancel",
  help: "esc back",
};

export function Footer({ view, message }: { view: View; message?: string | null }) {
  return (
    <Box flexDirection="column">
      {message ? <Text color={message.startsWith("error") ? theme.bad : theme.accent}> {message}</Text> : null}
      <Text color={theme.dim} wrap="truncate-end">
        {" "}
        {KEYS[view]}
      </Text>
    </Box>
  );
}
