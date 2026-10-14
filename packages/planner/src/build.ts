import { bullet, render } from "./prompts.js";

export interface TaskPromptInput {
  role: string;
  instructions: string;
  taskId: string;
  title: string;
  body: string;
  acceptance: string[];
  agentsMd: boolean;
  contractRef?: string;
  pathsAllow: string[];
  pathsDeny: string[];
  checks: { id: string; argv: string[]; required: boolean }[];
}

const checkList = (checks: TaskPromptInput["checks"]) =>
  bullet(checks.map((c) => `\`${c.argv.join(" ")}\`${c.required ? "" : " (optional)"}`));

/** Initial prompt for an implementer run. */
export function buildTaskPrompt(i: TaskPromptInput): string {
  return render("task", {
    role: i.role,
    instructions: i.instructions || "(no extra instructions)",
    taskId: i.taskId,
    title: i.title,
    body: i.body || "(no description)",
    acceptance: bullet(i.acceptance, "(none given: use the title and description)"),
    agentsMd: i.agentsMd ? "Read AGENTS.md in the repository root before you start and follow it." : "There is no AGENTS.md; follow the conventions of the surrounding code.",
    contract: i.contractRef ? `\nThis task must follow the shared interface in \`${i.contractRef}\`. Do not change that file.` : "",
    pathsAllow: i.pathsAllow.length ? i.pathsAllow.map((p) => `\`${p}\``).join(", ") : "anywhere in the repository",
    pathsDeny: i.pathsDeny.length ? i.pathsDeny.map((p) => `\`${p}\``).join(", ") : "(nothing extra)",
    checks: checkList(i.checks),
  });
}

export interface FailedCheck {
  checkId: string;
  argv: string[];
  outputTail: string;
  timedOut?: boolean;
}

/** Repair prompt after a failed gate: failing output and the diff summary only, no transcript replay. */
export function buildRepairPrompt(i: { attempt: number; attemptsMax: number; failures: FailedCheck[]; diffStat: string; previousSummary?: string }): string {
  const failures = i.failures
    .map((f) => `## Check \`${f.checkId}\` failed${f.timedOut ? " (timed out)" : ""}\nCommand: \`${f.argv.join(" ")}\`\n\nLast lines of output:\n\`\`\`\n${f.outputTail.trim()}\n\`\`\``)
    .join("\n\n");
  return render("repair", {
    attempt: i.attempt,
    attemptsMax: i.attemptsMax,
    failures,
    diffStat: i.diffStat.trim() ? "```\n" + i.diffStat.trim() + "\n```" : "(no changes yet)",
    previous: i.previousSummary ? `## Your previous summary\n${i.previousSummary.trim()}\n` : "",
  });
}

export interface FindingInput {
  severity: "blocker" | "major" | "nit";
  file: string | null;
  line: number | null;
  message: string;
}

const findingLine = (f: FindingInput) => `${f.file ? `\`${f.file}${f.line ? `:${f.line}` : ""}\`: ` : ""}${f.message}`;

/** Repair prompt after a reviewer blocker. */
export function buildReviewRepairPrompt(i: { taskId: string; attempt: number; attemptsMax: number; findings: FindingInput[] }): string {
  return render("review-repair", {
    taskId: i.taskId,
    attempt: i.attempt,
    attemptsMax: i.attemptsMax,
    findings: bullet(i.findings.filter((f) => f.severity === "blocker").map(findingLine)),
    other: bullet(i.findings.filter((f) => f.severity !== "blocker").map((f) => `[${f.severity}] ${findingLine(f)}`)),
  });
}

/** Messages typed by the person into the chat bar, delivered on the agent's next turn. */
export function buildMessagePrompt(taskId: string, messages: string[]): string {
  return render("message", { taskId, messages: messages.map((m) => `> ${m.trim().split("\n").join("\n> ")}`).join("\n\n") });
}

/** Prompt to continue a resumed vendor session after a pause. */
export function buildResumePrompt(taskId: string): string {
  return render("resume", { taskId });
}

/** Prompt for a fresh session when the old one cannot be resumed. */
export function buildFreshResumePrompt(taskPrompt: string, diffStat: string): string {
  return render("resume-fresh", { taskPrompt: taskPrompt.trim(), diffStat: diffStat.trim() ? "```\n" + diffStat.trim() + "\n```" : "(no changes yet)" });
}

/** Read-only review prompt. */
export function buildReviewPrompt(i: { taskId: string; title: string; acceptance: string[]; checks: string[]; diff: string }): string {
  return render("review", {
    taskId: i.taskId,
    title: i.title,
    acceptance: bullet(i.acceptance, "(none given: judge against the title)"),
    checks: i.checks.join(", ") || "(none)",
    diff: i.diff.trim() || "(empty diff)",
  });
}
