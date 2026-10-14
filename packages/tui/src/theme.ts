/** Themes: gradient stops for the logo and accents, plus colors by meaning. */
export interface Theme {
  name: string;
  gradient: string[];
  accent: string;
  ok: string;
  warn: string;
  bad: string;
  dim: string;
  you: string;
  /** Status bar segment backgrounds, left to right. */
  bar: string[];
  barText: string;
  /** Use powerline glyphs (needs a patched font, like oh-my-zsh agnoster). */
  powerline: boolean;
}

export const THEMES: Record<string, Theme> = {
  neon: { name: "neon", gradient: ["#ff4ecd", "#a259ff", "#3ec7ff"], accent: "#3ec7ff", ok: "#5af78e", warn: "#f3f99d", bad: "#ff5c57", dim: "gray", you: "#ff4ecd", bar: ["#a259ff", "#5b3fd1", "#3a2a8f", "#26215c"], barText: "white", powerline: false },
  sunset: { name: "sunset", gradient: ["#ffb347", "#ff6f61", "#c94b9b"], accent: "#ffb347", ok: "#a8e6a1", warn: "#ffd166", bad: "#ef476f", dim: "gray", you: "#ffb347", bar: ["#ff6f61", "#c94b4b", "#8e3b62", "#4b2142"], barText: "white", powerline: false },
  matrix: { name: "matrix", gradient: ["#00ff41", "#00c22f", "#008f11"], accent: "#00ff41", ok: "#00ff41", warn: "#d4ff00", bad: "#ff3b3b", dim: "#2e7d32", you: "#b9ff9e", bar: ["#008f11", "#006b0d", "#004d09", "#003b00"], barText: "#d7ffd9", powerline: false },
  ocean: { name: "ocean", gradient: ["#00c6ff", "#0072ff", "#6a5af9"], accent: "#00c6ff", ok: "#4be0b0", warn: "#ffd166", bad: "#ff6b6b", dim: "gray", you: "#7fdbff", bar: ["#0072ff", "#0057c2", "#003f8a", "#002a5c"], barText: "white", powerline: false },
  agnoster: { name: "agnoster", gradient: ["#61afef", "#c678dd", "#e06c75"], accent: "#61afef", ok: "#98c379", warn: "#e5c07b", bad: "#e06c75", dim: "gray", you: "#c678dd", bar: ["#61afef", "#98c379", "#e5c07b", "#3e4452"], barText: "black", powerline: true },
  mono: { name: "mono", gradient: ["white", "white"], accent: "white", ok: "white", warn: "white", bad: "white", dim: "gray", you: "white", bar: ["gray", "gray", "gray", "gray"], barText: "black", powerline: false },
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
  if (rgb.some((x) => !x) || stops.length < 2) return [...text].map((ch) => ({ ch, color: stops[0] ?? "white" }));
  const chars = [...text];
  return chars.map((ch, i) => {
    const t = chars.length <= 1 ? 0 : i / (chars.length - 1);
    const seg = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
    const lt = t * (stops.length - 1) - seg;
    const a = rgb[seg]!;
    const b = rgb[seg + 1]!;
    const c = a.map((v, k) => Math.round(v + (b[k]! - v) * lt));
    return { ch, color: `#${c.map((v) => v.toString(16).padStart(2, "0")).join("")}` };
  });
}

/** Vendor badge colors and glyphs. */
export const VENDOR: Record<string, { color: string; icon: string }> = {
  claude: { color: "#d97757", icon: "✻" },
  codex: { color: "#10a37f", icon: "◆" },
  cursor: { color: "#8b7cf6", icon: "▲" },
  fake: { color: "#6c7a89", icon: "◎" },
};

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export function stateColor(t: Theme, s: string): string | undefined {
  if (["RUNNING", "GATING", "REPAIRING", "REVIEWING"].includes(s)) return t.accent;
  if (["MERGED", "PR_READY"].includes(s)) return t.ok;
  if (["NEEDS_HUMAN", "FAILED", "CANCELLED"].includes(s)) return t.bad;
  if (["PAUSED", "WAITING", "STALE", "TAKEN_OVER"].includes(s)) return t.warn;
  return t.dim;
}

export function stateIcon(s: string): string {
  return (
    {
      RUNNING: "⚙", GATING: "🧪", REPAIRING: "🔧", REVIEWING: "👀", PR_READY: "✅", MERGED: "🎉", QUEUED: "⏳", DRAFT: "📝",
      PAUSED: "⏸", NEEDS_HUMAN: "🙋", TAKEN_OVER: "🧑‍💻", CANCELLED: "✖", STALE: "♻", IDLE: "💤", WAITING: "⏳", FAILED: "💥",
    } as Record<string, string>
  )[s] ?? "•";
}

/** Back-compat for code that used the old flat theme. */
export const theme = {
  accent: "cyan",
  ok: "green",
  warn: "yellow",
  bad: "red",
  dim: "gray",
  state: (s: string) => stateColor(THEMES.neon!, s),
  workerIcon: (s: string) => (s === "RUNNING" ? "▶" : s === "PAUSED" ? "⏸" : s === "WAITING" ? "…" : s === "FAILED" ? "✗" : "○"),
};
