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

export const SMALL_BANNER = [
  "╻ ╻┏━┓┏━┓┏┓╻┏━╸┏━┓┏━┓",
  "┣━┫┣━┫┣┳┛┃┗┫┣╸ ┗━┓┗━┓",
  "╹ ╹╹ ╹╹┗╸╹ ╹┗━╸┗━┛┗━┛",
];

// Keep the original three-row glyphs as the compact fallback. The six-row
// letters are enlarged from those same rows, so all tiers spell the same logo.
const LETTERS = SMALL_BANNER.flatMap((row) => {
  const enlarged = [...row].map((ch) => ch.repeat(4)).join("");
  return [enlarged, enlarged];
});
export const BIG_BANNER = LETTERS;
export const BIG_BANNER_WIDTH = [...BIG_BANNER[0]!].length;
export const XL_BANNER = LETTERS.flatMap((row) => {
  const enlarged = [...row].map((ch) => ch.repeat(2)).join("");
  return [enlarged, enlarged];
});
export const XL_BANNER_WIDTH = [...XL_BANNER[0]!].length;

export type BannerTier = "xl" | "big" | "small" | "off";

// The surrounding layout needs 13 rows for its header, input, status line,
// stream label and the welcome text around the logo.
const RESERVED_ROWS = 13;

/** Choose the largest banner that fits both terminal dimensions. */
export function pickBanner(columns: number, rows: number, override?: string): BannerTier {
  const tiers: BannerTier[] = ["xl", "big", "small", "off"];
  const requested = override?.toLowerCase();
  const first = requested && tiers.includes(requested as BannerTier) ? tiers.indexOf(requested as BannerTier) : 0;
  for (const tier of tiers.slice(first)) {
    if (tier === "off") return tier;
    const banner = tier === "xl" ? XL_BANNER : tier === "big" ? BIG_BANNER : SMALL_BANNER;
    if (columns >= [...banner[0]!].length + 2 && rows >= banner.length + RESERVED_ROWS) return tier;
  }
  return "off";
}

/** The welcome banner: a gradient wordmark. */
export function Banner({ t, tier = "small" }: { t: Theme; tier?: BannerTier }) {
  const lines = tier === "xl" ? XL_BANNER : tier === "big" ? BIG_BANNER : tier === "small" ? SMALL_BANNER : [];
  return (
    <>
      {lines.map((l, i) => (
        <GradientText key={i} text={l} t={t} bold />
      ))}
    </>
  );
}
