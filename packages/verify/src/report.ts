import type { CheckResult } from "./runner.js";
import type { ReadinessReport } from "./readiness.js";

const mark = (ok: boolean) => (ok ? "✓" : "✗");

function seconds(ms: number): string {
  return `${(ms / 1000).toFixed(1)}s`;
}

/** One line per check: ✓ unit (required) 3.2s */
export function formatCheckResults(results: readonly CheckResult[]): string {
  return results
    .map((r) => {
      const why = r.timedOut ? " timed out" : r.startError ? ` could not start: ${r.startError}` : r.ok ? "" : ` exit ${r.exitCode}`;
      return `${mark(r.ok)} ${r.checkId}${r.required ? "" : " (optional)"} ${seconds(r.durationMs)}${why}`;
    })
    .join("\n");
}

/** Human-readable readiness report printed by `harness init` and `doctor`. */
export function formatReadiness(r: ReadinessReport): string {
  const lines: string[] = [];
  lines.push(`Readiness: ${r.grade.toUpperCase()}`);
  lines.push("");
  lines.push("Checks:");
  if (!r.checks.length) lines.push("  (none)");
  for (const c of r.checks) lines.push(`  ${c.required ? "required" : "optional"}  ${c.id.padEnd(10)} ${c.argv.join(" ")}`);
  lines.push(`Tests found: ${r.testsFound}`);
  lines.push(`AGENTS.md: ${r.agentsMd ? "present" : "missing"}`);
  if (r.baseline) {
    lines.push(`Baseline: ${r.baseline.ok ? "green" : "RED"}`);
    lines.push(...formatCheckResults(r.baseline.results).split("\n").map((l) => `  ${l}`));
  } else lines.push("Baseline: not checked");
  if (r.warnings.length) lines.push("", "Warnings:", ...r.warnings.map((w) => `  ! ${w}`));
  if (r.suggestions.length) lines.push("", "Suggestions:", ...r.suggestions.map((s) => `  → ${s}`));
  return lines.join("\n");
}
