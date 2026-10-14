/**
 * One calm palette: default text, gray for secondary, one accent for the
 * selection, and yellow/red only when something needs a person.
 */
export const C = {
  accent: "cyan",
  dim: "gray",
  warn: "yellow",
  bad: "red",
} as const;

export const VENDOR_LABEL: Record<string, string> = { claude: "claude", codex: "codex", cursor: "cursor", fake: "fake" };

export const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

/** Task state color: only problems and waiting get a color. */
export function stateColor(s: string): string | undefined {
  if (["NEEDS_HUMAN", "FAILED"].includes(s)) return C.bad;
  if (["PAUSED", "WAITING", "STALE", "TAKEN_OVER"].includes(s)) return C.warn;
  if (["DRAFT", "CANCELLED", "MERGED", "IDLE"].includes(s)) return C.dim;
  return undefined;
}

/** Back-compat shim for older imports. */
export const theme = { accent: C.accent, ok: undefined, warn: C.warn, bad: C.bad, dim: C.dim, state: stateColor };
