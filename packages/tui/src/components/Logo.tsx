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

const BIG = [
  "╻ ╻┏━┓┏━┓┏┓╻┏━╸┏━┓┏━┓",
  "┣━┫┣━┫┣┳┛┃┗┫┣╸ ┗━┓┗━┓",
  "╹ ╹╹ ╹╹┗╸╹ ╹┗━╸┗━┛┗━┛",
];

/** The welcome banner: a gradient wordmark. */
export function Banner({ t }: { t: Theme }) {
  return (
    <>
      {BIG.map((l, i) => (
        <GradientText key={i} text={l} t={t} bold />
      ))}
    </>
  );
}
