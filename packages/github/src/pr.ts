import { HARNESS_BRANCH_PREFIX } from "@harness/core";
import { gh, type Runner } from "./gh.js";

export interface EvidenceTask {
  id: string;
  title: string;
  role: string;
  route: string;
  attempts: number;
  checks: { checkId: string; ok: boolean; durationMs: number | null; required: boolean }[];
  findings: { severity: string; file: string | null; line: number | null; message: string }[];
  runs: number;
  tokensIn: number | null;
  tokensOut: number | null;
  costUsd: number | null;
}

export interface Evidence {
  project: string;
  base: string;
  head: string;
  tasks: EvidenceTask[];
}

const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
const secs = (ms: number | null) => (ms === null ? "" : ` (${(ms / 1000).toFixed(1)}s)`);

/** The PR body: what changed, the independent evidence, and the usage it cost. Deterministic. */
export function buildPrBody(e: Evidence): string {
  const lines: string[] = [];
  lines.push("## Summary", "", `Draft PR from \`${e.head}\` into \`${e.base}\`, produced by harness for **${e.project}**. ${e.tasks.length} task(s).`, "");
  lines.push("## Tasks", "", "| Task | Title | Role | Route | Attempts | Checks | Review |", "| --- | --- | --- | --- | --- | --- | --- |");
  for (const t of e.tasks) {
    const passed = t.checks.filter((c) => c.ok).length;
    const blockers = t.findings.filter((f) => f.severity === "blocker").length;
    lines.push(`| ${t.id} | ${esc(t.title)} | ${t.role} | ${t.route} | ${t.attempts} | ${passed}/${t.checks.length} passed | ${t.findings.length ? `${t.findings.length} finding(s)${blockers ? `, ${blockers} blocker(s) resolved` : ""}` : "clean"} |`);
  }
  lines.push("", "## Check results (final gate, run by harness, not by the agent)", "");
  for (const t of e.tasks) {
    lines.push(`- **${t.id}**: ${t.checks.length ? t.checks.map((c) => `${c.ok ? "✅" : "❌"} ${c.checkId}${c.required ? "" : " (optional)"}${secs(c.durationMs)}`).join(", ") : "no checks recorded"}`);
  }
  const withFindings = e.tasks.filter((t) => t.findings.length);
  lines.push("", "## Reviewer findings", "");
  if (!withFindings.length) lines.push("None.");
  for (const t of withFindings) for (const f of t.findings) lines.push(`- **${t.id}** [${f.severity}] ${f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\` ` : ""}${esc(f.message)}`);
  lines.push("", "## Usage", "", "| Task | Runs | Tokens in / out | Cost |", "| --- | --- | --- | --- |");
  for (const t of e.tasks) {
    const tok = t.tokensIn === null && t.tokensOut === null ? "unknown" : `${t.tokensIn ?? "?"} / ${t.tokensOut ?? "?"}`;
    lines.push(`| ${t.id} | ${t.runs} | ${tok} | ${t.costUsd === null ? "unknown" : `$${t.costUsd.toFixed(2)}`} |`);
  }
  lines.push("", "---", "Every task passed its required checks independently of the agent that wrote it. This PR is a draft; merging is your decision.");
  return lines.join("\n") + "\n";
}

export interface OpenPrOptions {
  cwd: string;
  base: string;
  head: string;
  title: string;
  body: string;
  run: Runner;
}

/** An open PR for this head branch, if one exists. */
export async function findPr(run: Runner, cwd: string, head: string): Promise<{ url: string; number: number } | undefined> {
  const out = await gh(run, cwd, ["pr", "list", "--head", head, "--state", "open", "--json", "url,number"]);
  const list = JSON.parse(out || "[]") as { url: string; number: number }[];
  return list[0];
}

/** Push the head branch (harness/** only) and open a draft PR. Never merges. */
export async function openDraftPr(o: OpenPrOptions): Promise<{ url: string; existed: boolean }> {
  if (!o.head.startsWith(HARNESS_BRANCH_PREFIX)) throw new Error(`refusing to push ${o.head}: only ${HARNESS_BRANCH_PREFIX}** branches are pushed`);
  const push = await o.run("git", ["push", "-u", "origin", `${o.head}:${o.head}`], { cwd: o.cwd });
  if (push.exitCode !== 0) throw new Error(`git push failed: ${push.stderr.trim()}`);
  const existing = await findPr(o.run, o.cwd, o.head);
  if (existing) return { url: existing.url, existed: true };
  const url = await gh(o.run, o.cwd, ["pr", "create", "--draft", "--base", o.base, "--head", o.head, "--title", o.title, "--body-file", "-"], o.body);
  return { url: url.split("\n").pop()!.trim(), existed: false };
}
