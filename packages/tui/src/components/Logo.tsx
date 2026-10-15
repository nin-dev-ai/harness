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

/** Twice the height and width of the existing six-row wordmark. */
export const XL_BANNER: string[] = BIG_BANNER.flatMap((row) => {
  const wide = [...row].map((ch) => ch.repeat(2)).join("");
  return [wide, wide];
});
export const XL_BANNER_WIDTH = [...XL_BANNER[0]!].length;

/** Fallback for narrow terminals. */
export const SMALL_BANNER = ["╻ ╻┏━┓┏━┓┏┓╻┏━╸┏━┓┏━┓", "┣━┫┣━┫┣┳┛┃┗┫┣╸ ┗━┓┗━┓", "╹ ╹╹ ╹╹┗╸╹ ╹┗━╸┗━┛┗━┛"];

export type BannerTier = "xl" | "big" | "small" | "off";

/** Choose the largest requested tier that fits the remaining terminal space. */
export function pickBanner(columns: number, rows: number, reservedRows: number, override?: string): BannerTier {
  const tiers: BannerTier[] = ["xl", "big", "small", "off"];
  const requested = override?.toLowerCase();
  const start = requested && tiers.includes(requested as BannerTier) ? tiers.indexOf(requested as BannerTier) : 0;
  for (const tier of tiers.slice(start)) {
    if (tier === "off") return tier;
    const banner = tier === "xl" ? XL_BANNER : tier === "big" ? BIG_BANNER : SMALL_BANNER;
    if (columns >= [...banner[0]!].length + 2 && rows >= banner.length + reservedRows) return tier;
  }
  return "off";
}
