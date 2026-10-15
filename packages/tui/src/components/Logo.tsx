import { Text } from "ink";
import { gradient, type Theme } from "../theme.js";

export function GradientText({ text, t, bold }: { text: string; t: Theme; bold?: boolean }) {
  return (
    <Text bold={bold}>
      {gradient(text, t.gradient).map((g, i) => (
        <Text key={i} color={g.color}>
          {g.ch}
        </Text>
      ))}
    </Text>
  );
}

const LETTERS: Record<string, string[]> = {
  H: ["██╗  ██╗", "██║  ██║", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
  A: [" █████╗ ", "██╔══██╗", "███████║", "██╔══██║", "██║  ██║", "╚═╝  ╚═╝"],
  R: ["██████╗ ", "██╔══██╗", "██████╔╝", "██╔══██╗", "██║  ██║", "╚═╝  ╚═╝"],
  N: ["███╗   ██╗", "████╗  ██║", "██╔██╗ ██║", "██║╚██╗██║", "██║ ╚████║", "╚═╝  ╚═══╝"],
  E: ["███████╗", "██╔════╝", "█████╗  ", "██╔══╝  ", "███████╗", "╚══════╝"],
  S: ["███████╗", "██╔════╝", "███████╗", "╚════██║", "███████║", "╚══════╝"],
};

/** "HARNESS" in huge block letters, six rows tall. */
export const BIG_BANNER: string[] = Array.from({ length: 6 }, (_, row) => [..."HARNESS"].map((c) => LETTERS[c]![row]!).join(""));
export const BIG_BANNER_WIDTH = BIG_BANNER[0]!.length;

/** Fallback for narrow terminals. */
export const SMALL_BANNER = ["╻ ╻┏━┓┏━┓┏┓╻┏━╸┏━┓┏━┓", "┣━┫┣━┫┣┳┛┃┗┫┣╸ ┗━┓┗━┓", "╹ ╹╹ ╹╹┗╸╹ ╹┗━╸┗━┛┗━┛"];
