import fs from "node:fs";
import path from "node:path";
import type { HarnessEvent, Task } from "@harness/core";
import { writeFileAtomic } from "@harness/config";
import type { ProjectRuntime } from "./project.js";

/**
 * The team board: one `.harness/HARNESS.md` that says what the person asked
 * for, who is working on what, what each agent finished and changed, the notes
 * agents left for each other, and what needs the person. It is rebuilt from
 * the event log (no model writes it) and every agent prompt carries it, so
 * agents in separate sessions share one picture of the work.
 */

export const BOARD_FILE = ".harness/HARNESS.md";

/** Event types that change what the board shows. */
const BOARD_EVENTS = new Set([
  "team.request", "task.created", "task.state_changed", "task.routed", "task.needs_human", "run.started", "run.finished",
  "branch.merged", "worker.assigned", "review.passed", "review.blocked", "lead.reported",
]);

const IMPLEMENT = new Set(["initial", "repair", "resume"]);

export interface BoardTask {
  id: string;
  title: string;
  role: string;
  state: string;
  dependsOn: string[];
  agent?: string | undefined;
  vendor?: string | undefined;
  summary?: string | undefined;
  files?: string[] | undefined;
  reason?: string | undefined;
}

export interface BoardData {
  project: string;
  updatedAt: string;
  requests: { ts: string; text: string }[];
  tasks: BoardTask[];
  notes: { taskId: string; agent: string; text: string }[];
  lead?: string | undefined;
}

/** `NOTE:` lines an agent left in its summary for the rest of the team. */
export function notesIn(summary: string): string[] {
  return summary
    .split("\n")
    .map((l) => /^\s*(?:[-*]\s*)?NOTE:\s*(.+)$/i.exec(l)?.[1]?.trim())
    .filter((x): x is string => !!x);
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
const ACTIVE = new Set(["RUNNING", "GATING", "REPAIRING", "REVIEWING"]);
const WAITING = new Set(["DRAFT", "QUEUED", "BLOCKED", "PAUSED", "STALE"]);

/** Render the board as Markdown. Pure and deterministic. */
export function renderBoard(d: BoardData): string {
  const out: string[] = [`# Team board · ${d.project}`, "", `_Kept by harness from its event log; updated ${d.updatedAt}. Agents: read it, do not edit it. Leave notes with \`NOTE:\` lines in your final summary._`, ""];
  out.push("## What the person asked for");
  out.push(...(d.requests.length ? d.requests.slice(-5).map((r) => `- ${clip(oneLine(r.text), 300)}`) : ["- (nothing yet)"]), "");
  if (d.lead) out.push("## Lead's view", d.lead.trim(), "");
  const line = (t: BoardTask) => `- **${t.id}** ${t.title} · \`${t.role}\`${t.agent ? ` (${t.agent}${t.vendor ? `, ${t.vendor}` : ""})` : ""}`;
  const active = d.tasks.filter((t) => ACTIVE.has(t.state));
  out.push("## Working now", ...(active.length ? active.map((t) => `${line(t)} · ${t.state.toLowerCase()}`) : ["- nobody"]), "");
  const waiting = d.tasks.filter((t) => WAITING.has(t.state));
  if (waiting.length) out.push("## Up next", ...waiting.map((t) => `${line(t)} · ${t.state.toLowerCase()}${t.dependsOn.length ? ` after ${t.dependsOn.join(", ")}` : ""}`), "");
  const needs = d.tasks.filter((t) => t.state === "NEEDS_HUMAN");
  if (needs.length) out.push("## Needs the person", ...needs.map((t) => `${line(t)}${t.reason ? ` · ${t.reason}` : ""}`), "");
  const done = d.tasks.filter((t) => t.state === "MERGED" || t.state === "PR_READY").slice(-12);
  out.push("## Done");
  if (!done.length) out.push("- nothing yet");
  for (const t of done) {
    out.push(`${line(t)}${t.state === "PR_READY" ? " · ready to merge" : ""}`);
    if (t.summary) out.push(`  - did: ${clip(oneLine(t.summary), 400)}`);
    if (t.files?.length) out.push(`  - changed: ${t.files.slice(0, 12).map((f) => `\`${f}\``).join(", ")}${t.files.length > 12 ? ` +${t.files.length - 12} more` : ""}`);
  }
  out.push("");
  out.push("## Notes from agents", ...(d.notes.length ? d.notes.slice(-20).map((n) => `- ${n.taskId} (${n.agent}): ${clip(oneLine(n.text), 300)}`) : ["- none yet"]), "");
  return out.join("\n");
}

/** Collect board data from the store. */
export function boardData(p: ProjectRuntime): BoardData {
  const events = p.store.events.list({ projectId: p.id, types: ["team.request", "run.started", "run.finished", "worker.assigned", "branch.merged", "task.needs_human", "lead.reported"] });
  const byTask = new Map<string, { agent?: string; vendor?: string; summary?: string; files?: string[]; reason?: string }>();
  const runs = new Map<string, { kind: string; vendor: string }>();
  const requests: BoardData["requests"] = [];
  const notes: BoardData["notes"] = [];
  let lead: string | undefined;
  const slot = (id: string) => byTask.get(id) ?? (byTask.set(id, {}), byTask.get(id)!);
  for (const e of events as HarnessEvent[]) {
    const pl = e.payload as Record<string, unknown>;
    if (e.type === "team.request") requests.push({ ts: e.ts, text: String(pl.text) });
    else if (e.type === "lead.reported") lead = String(pl.status ?? "");
    if (!e.taskId) continue;
    if (e.type === "run.started" && e.runId) runs.set(e.runId, { kind: String(pl.kind), vendor: String(pl.vendor) });
    else if (e.type === "worker.assigned" && e.workerId && pl.role !== "reviewer") slot(e.taskId).agent = e.workerId;
    else if (e.type === "run.finished" && e.runId && IMPLEMENT.has(runs.get(e.runId)?.kind ?? "") && typeof pl.summary === "string" && pl.summary.trim()) {
      const s = slot(e.taskId);
      s.summary = pl.summary.replace(/^\s*(?:[-*]\s*)?NOTE:.*$/gim, "").trim() || s.summary;
      s.vendor = runs.get(e.runId)!.vendor;
      for (const n of notesIn(pl.summary)) notes.push({ taskId: e.taskId, agent: e.workerId ?? "", text: n });
    } else if (e.type === "branch.merged" && Array.isArray(pl.files)) slot(e.taskId).files = pl.files as string[];
    else if (e.type === "task.needs_human") slot(e.taskId).reason = String(pl.reason);
  }
  const tasks: BoardTask[] = p.tasks().filter((t: Task) => t.state !== "CANCELLED").map((t) => ({ id: t.id, title: t.title, role: t.role, state: t.state, dependsOn: t.dependsOn, ...byTask.get(t.id) }));
  return { project: p.config.project, updatedAt: p.now(), requests, tasks, notes, lead };
}

/** The board as agents see it in their prompt: the newest content, capped in size. */
export function boardForPrompt(p: ProjectRuntime, maxChars = 6000): string {
  const text = renderBoard(boardData(p));
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…(board truncated; full copy in ${BOARD_FILE})` : text;
}

/** Keeps `.harness/HARNESS.md` current as events arrive. */
export class BoardWriter {
  private unsubscribe: (() => void) | undefined;

  constructor(private p: ProjectRuntime) {}

  start(): void {
    this.write();
    this.unsubscribe = this.p.store.subscribe((e) => {
      if (e.projectId === this.p.id && BOARD_EVENTS.has(e.type)) this.write();
    });
  }

  stop(): void {
    this.unsubscribe?.();
  }

  write(): void {
    try {
      const file = path.join(this.p.root, BOARD_FILE);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      writeFileAtomic(file, renderBoard(boardData(this.p)));
    } catch {
      // The board is a view; failing to write it never stops the work.
    }
  }
}

/**
 * What a task builds on: for each dependency, what its agent did, the files it
 * changed and the notes it left. Goes into the task prompt so a dependent
 * agent starts from the facts instead of rediscovering them.
 */
export function handoffFor(p: ProjectRuntime, task: Task): string {
  if (!task.dependsOn.length) return "";
  const d = boardData(p);
  const parts: string[] = [];
  for (const id of task.dependsOn) {
    const t = d.tasks.find((x) => x.id === id);
    if (!t) continue;
    const notes = d.notes.filter((n) => n.taskId === id).map((n) => `  - note: ${oneLine(n.text)}`);
    parts.push(
      `- **${t.id}** ${t.title} (\`${t.role}\`${t.agent ? `, ${t.agent}` : ""}) · ${t.state.toLowerCase()}`,
      ...(t.summary ? [`  - did: ${clip(oneLine(t.summary), 800)}`] : []),
      ...(t.files?.length ? [`  - changed: ${t.files.slice(0, 30).map((f) => `\`${f}\``).join(", ")}`] : []),
      ...notes,
    );
  }
  return parts.join("\n");
}
