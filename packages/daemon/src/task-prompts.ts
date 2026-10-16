import fs from "node:fs";
import path from "node:path";
import type { Task } from "@harness/core";
import { readTaskFile } from "@harness/config";
import {
  buildConflictPrompt,
  buildRepairPrompt,
  buildReviewPrompt,
  buildReviewRepairPrompt,
  buildTaskPrompt,
} from "@harness/planner";
import { changedFiles, diffSummary, diffText } from "@harness/workspace";
import { isSecretPath } from "@harness/policy";
import { boardForPrompt, handoffFor } from "./board.js";
import type { ProjectRuntime } from "./project.js";

function taskSpec(p: ProjectRuntime, taskId: string) {
  try {
    return readTaskFile(p.root, taskId);
  } catch {
    return undefined;
  }
}

/** Build the instructions for a fresh implementer session. */
export function taskPrompt(p: ProjectRuntime, task: Task): string {
  const spec = taskSpec(p, task.id);
  const role = p.config.roles[task.role]!;
  return buildTaskPrompt({
    role: task.role,
    instructions: role.instructions,
    taskId: task.id,
    title: task.title,
    body: spec?.body ?? "",
    acceptance: spec?.front.acceptance ?? [],
    agentsMd: fs.existsSync(path.join(p.root, "AGENTS.md")),
    ...(spec?.front.contract_ref ? { contractRef: spec.front.contract_ref } : {}),
    pathsAllow: role.paths_allow ?? [],
    pathsDeny: role.paths_deny,
    checks: p.checks.checks.map((c) => ({ id: c.id, argv: c.argv, required: c.required })),
    board: boardForPrompt(p),
    handoff: handoffFor(p, task),
  });
}

/** Explain the most recent gate, review, conflict, or human rejection. */
export async function repairPrompt(p: ProjectRuntime, task: Task, worktree: string): Promise<string> {
  const req = p.store.events.list({ projectId: p.id, taskId: task.id, types: ["repair.requested"] }).at(-1);
  const cause = req?.type === "repair.requested" ? req.payload.cause : "gate";
  const attempt = req?.type === "repair.requested" ? req.payload.attempt : task.attempts;
  if (cause === "review") {
    const reviewRun = p.store.runs.latestForTask(p.id, task.id, ["review"]);
    const findings = reviewRun ? p.store.runs.findings(reviewRun.id) : [];
    return buildReviewRepairPrompt({ taskId: task.id, attempt, attemptsMax: task.attemptsMax, findings });
  }
  if (cause === "conflict") {
    const files = req?.type === "repair.requested" ? (req.payload.files ?? []) : [];
    return buildConflictPrompt({ taskId: task.id, files, attempt, attemptsMax: task.attemptsMax });
  }
  if (cause === "human") {
    const ev = p.store.events.list({ projectId: p.id, taskId: task.id, types: ["approval.denied"] }).at(-1);
    const comment = ev?.type === "approval.denied" ? ev.payload.comment : undefined;
    return `A reviewer sent this task back.\n\n${comment ?? "(no comment)"}\n\nAddress the comment. The checks will run again after you finish.\n`;
  }
  const gate = p.store.events.list({ projectId: p.id, taskId: task.id, types: ["gate.failed", "gate.passed"] }).at(-1);
  const failures = gate?.runId ? p.store.runs.checkResults(gate.runId).filter((c) => !c.ok && c.required) : [];
  const argv = (id: string) => p.checks.checks.find((c) => c.id === id)?.argv ?? [id];
  const lastImpl = p.store.runs.listByTask(p.id, task.id).filter((r) => r.kind !== "review" && r.kind !== "plan").at(-1);
  const finished = lastImpl ? p.store.events.list({ runId: lastImpl.id, types: ["run.finished"] }).at(-1) : undefined;
  const prevSummary = finished?.type === "run.finished" ? finished.payload.summary : undefined;
  return buildRepairPrompt({
    attempt,
    attemptsMax: task.attemptsMax,
    failures: failures.map((f) => ({ checkId: f.checkId, argv: argv(f.checkId), outputTail: f.outputTail ?? "" })),
    diffStat: (await diffSummary(worktree, p.config.integration_branch)).stat,
    ...(prevSummary ? { previousSummary: prevSummary } : {}),
  });
}

/** Keep secret paths out of the review diff. */
export async function reviewPrompt(p: ProjectRuntime, task: Task, worktree: string): Promise<string> {
  const base = p.config.integration_branch;
  return buildReviewPrompt({
    taskId: task.id,
    title: task.title,
    acceptance: taskSpec(p, task.id)?.front.acceptance ?? [],
    checks: p.checks.checks.filter((c) => c.required).map((c) => c.id),
    diff: await diffText(worktree, base, 200_000, (await changedFiles(worktree, base)).filter(isSecretPath)),
  });
}
