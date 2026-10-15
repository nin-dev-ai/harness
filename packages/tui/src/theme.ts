/** Colors used by static components (tables, review, help). Calm: gray, one accent, yellow/red for problems. */
export const C = {
  accent: "cyan",
  dim: "gray",
  warn: "yellow",
  bad: "red",
} as const;

/** A look: gradient stops for the logo, accents, and status bar blocks. Color is for chrome, never body text. */
export interface Theme {
  name: string;
  gradient: string[];
  accent: string;
  you: string;
  bar: string[];
  barText: string;
}

export const THEMES: Record<string, Theme> = {
  neon: { name: "neon", gradient: ["#ff4ecd", "#a259ff", "#3ec7ff"], accent: "#3ec7ff", you: "#ff4ecd", bar: ["#a259ff", "#5b3fd1", "#3a2a8f", "#26215c"], barText: "white" },
  sunset: { name: "sunset", gradient: ["#ffb347", "#ff6f61", "#c94b9b"], accent: "#ffb347", you: "#ff9e7a", bar: ["#ff6f61", "#c94b4b", "#8e3b62", "#4b2142"], barText: "white" },
  ocean: { name: "ocean", gradient: ["#00c6ff", "#0072ff", "#6a5af9"], accent: "#00c6ff", you: "#7fdbff", bar: ["#0072ff", "#0057c2", "#003f8a", "#002a5c"], barText: "white" },
  matrix: { name: "matrix", gradient: ["#00ff41", "#00c22f", "#008f11"], accent: "#00ff41", you: "#b9ff9e", bar: ["#008f11", "#006b0d", "#004d09", "#003b00"], barText: "#d7ffd9" },
  mono: { name: "mono", gradient: ["white", "white"], accent: "white", you: "white", bar: ["gray", "gray", "gray", "gray"], barText: "black" },
};
export const THEME_NAMES = Object.keys(THEMES);

function hex(c: string): [number, number, number] | undefined {
  const m = /^#([0-9a-f]{6})$/i.exec(c);
  if (!m) return undefined;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** One color per character, interpolated across the stops. */
export function gradient(text: string, stops: string[]): { ch: string; color: string }[] {
  const rgb = stops.map(hex);
  const chars = [...text];
  if (rgb.some((x) => !x) || stops.length < 2) return chars.map((ch) => ({ ch, color: stops[0] ?? "white" }));
  return chars.map((ch, i) => {
    const tt = chars.length <= 1 ? 0 : i / (chars.length - 1);
    const seg = Math.min(stops.length - 2, Math.floor(tt * (stops.length - 1)));
    const lt = tt * (stops.length - 1) - seg;
    const a = rgb[seg]!;
    const b = rgb[seg + 1]!;
    const c = a.map((v, k) => Math.round(v + (b[k]! - v) * lt));
    return { ch, color: `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}` };
  });
}

/** Each tool keeps its own color and glyph, so a pane reads at a glance. */
export const VENDOR: Record<string, { color: string; icon: string }> = {
  claude: { color: "#d97757", icon: "✻" },
  codex: { color: "#10a37f", icon: "◆" },
  cursor: { color: "#8b7cf6", icon: "▲" },
  fake: { color: "#6c7a89", icon: "◎" },
};

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Task state color: only waiting and problems get one. */
export function stateColor(s: string): string | undefined {
  if (["NEEDS_HUMAN", "FAILED"].includes(s)) return C.bad;
  if (["PAUSED", "WAITING", "STALE", "TAKEN_OVER"].includes(s)) return C.warn;
  if (["DRAFT", "CANCELLED", "MERGED", "IDLE"].includes(s)) return C.dim;
  return undefined;
}
