import { z } from "zod";
import type { ProjectRuntime } from "./project.js";

const Job = z.object({
  title: z.string().min(3).max(160),
  description: z.string().min(3).max(4000),
  files_hint: z.array(z.string().min(1)).min(1).max(20),
  acceptance: z.array(z.string().min(3)).min(1).max(10),
}).strict();
const Request = z.object({ jobs: z.array(Job).min(1).max(3) }).strict();
export type DelegatedJob = z.infer<typeof Job>;

/** A terminal summary may request a child wave with one exact JSON line. */
export function parseDelegation(summary: string): { jobs: DelegatedJob[] } | { error: string } | null {
  const marker = summary.split("\n").find((line) => line.trimStart().startsWith("DELEGATE:"));
  if (!marker) return null;
  let value: unknown;
  try { value = JSON.parse(marker.slice(marker.indexOf("DELEGATE:") + 9).trim()); }
  catch { return { error: "DELEGATE must contain one JSON object on one line" }; }
  const parsed = Request.safeParse(value);
  return parsed.success ? { jobs: parsed.data.jobs } : { error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ").slice(0, 500) };
}

export interface DelegationWave { childIds: string[]; runId: string; seq: number }

export function delegationWaves(p: ProjectRuntime, parentTaskId: string): DelegationWave[] {
  const out: DelegationWave[] = [];
  for (const e of p.store.events.list({ projectId: p.id, taskId: parentTaskId, types: ["delegation.accepted"] })) {
    if (e.type === "delegation.accepted") out.push({ childIds: e.payload.childIds, runId: e.payload.runId, seq: e.seq ?? 0 });
  }
  return out;
}

export function isDelegatedChild(p: ProjectRuntime, taskId: string): boolean {
  return p.store.events.exists(p.id, "delegation.child", taskId);
}

export function childHandoff(p: ProjectRuntime, parentTaskId: string): string {
  const wave = delegationWaves(p, parentTaskId).at(-1);
  if (!wave) return "";
  const lines = ["## Delegated work completed", "Review and integrate these results in your own task. Check the current files before editing."];
  for (const id of wave.childIds) {
    const task = p.task(id);
    const run = p.store.runs.listByTask(p.id, id).filter((r) => r.kind !== "review").at(-1);
    const finished = run ? p.store.events.list({ projectId: p.id, runId: run.id, types: ["run.finished"] }).at(-1) : undefined;
    const merged = p.store.events.list({ projectId: p.id, taskId: id, types: ["branch.merged"] }).at(-1);
    lines.push(`${id} (${task.title}): ${task.state}`, `Summary: ${finished?.type === "run.finished" ? finished.payload.summary ?? "none" : "none"}`, `Files: ${merged?.type === "branch.merged" ? (merged.payload.files ?? []).join(", ") : "none"}`);
  }
  return lines.join("\n").slice(0, 8000);
}
