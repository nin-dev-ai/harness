import { buildLeadPrompt, LEAD_JSON_SCHEMA, validateLead, type LeadOutput } from "@harness/planner";
import type { ProjectRuntime } from "./project.js";
import type { Supervisor } from "./supervisor.js";
import { boardData, boardForPrompt, projectFacts } from "./board.js";
import { pickRole, roleInfos } from "./planning.js";
import { taskDelivery } from "./delivery.js";

/** A batch of work the lead looks at once it settles: one chat request, or one round of the lead's own follow-ups. */
export interface Batch {
  key: string;
  request: string;
  taskIds: string[];
  round: number;
}

const SETTLED = new Set(["MERGED", "NEEDS_HUMAN", "CANCELLED"]);

/**
 * The lead (the "compiler" agent): when a batch of team work settles, a
 * read-only `lead` role reads the board and the batch, reports a status line
 * for the person, and may set a few small follow-up jobs. Rounds and
 * follow-ups are capped by config, so the team cannot loop forever.
 */
export class Lead {
  private busy = false;

  constructor(
    private p: ProjectRuntime,
    private supervisor: Supervisor,
    private onTasks: (ids: string[]) => void,
  ) {}

  /** Every batch, oldest first, with whether the lead has reported on it. */
  batches(): (Batch & { reported: boolean })[] {
    const out: (Batch & { reported: boolean })[] = [];
    const reported = new Set<string>();
    const events = this.p.store.events.list({ projectId: this.p.id, types: ["team.request", "lead.reported"] });
    const byKey = new Map<string, Batch>();
    for (const e of events) {
      if (e.type === "team.request") {
        const b = { key: `R${e.seq}`, request: e.payload.text, taskIds: e.payload.taskIds, round: 0 };
        byKey.set(b.key, b);
        out.push({ ...b, reported: false });
      } else if (e.type === "lead.reported") {
        if (e.payload.batch) reported.add(e.payload.batch);
        const parent = e.payload.batch ? byKey.get(e.payload.batch) : undefined;
        if (parent && e.payload.followups.length) {
          const b = { key: `L${e.seq}`, request: parent.request, taskIds: e.payload.followups, round: parent.round + 1 };
          byKey.set(b.key, b);
          out.push({ ...b, reported: false });
        }
      }
    }
    return out.map((b) => ({ ...b, reported: reported.has(b.key) }));
  }

  /** The oldest settled batch the lead has not reported on. */
  next(): Batch | undefined {
    const tasks = new Map(this.p.tasks().map((t) => [t.id, t]));
    // PR_READY merges by itself under approved-scope; otherwise it waits for the person, so it counts as settled.
    const waitsForPerson = this.p.config.policy.autonomy !== "approved-scope";
    const settled = (id: string) => {
      const st = tasks.get(id)?.state ?? "CANCELLED";
      if (st === "MERGED" && this.p.config.land === "auto") return taskDelivery(this.p, id) === "delivered";
      return SETTLED.has(st) || (waitsForPerson && st === "PR_READY");
    };
    return this.batches().find((b) => !b.reported && b.taskIds.length > 0 && b.taskIds.every(settled));
  }

  /** Run the lead on the next settled batch, if there is a lead role and one is waiting. */
  async check(): Promise<LeadOutput | undefined> {
    const role = this.p.config.roles.lead;
    if (!role || this.busy) return undefined;
    const batch = this.next();
    if (!batch) return undefined;
    this.busy = true;
    try {
      return await this.review(batch, role.route);
    } finally {
      this.busy = false;
    }
  }

  private async review(batch: Batch, route: string): Promise<LeadOutput> {
    const limits = this.p.config.limits;
    const max = batch.round + 1 >= limits.lead_rounds ? 0 : limits.lead_followups;
    const roles = roleInfos(this.p);
    const data = boardData(this.p);
    const prompt = buildLeadPrompt({
      request: batch.request,
      tasks: batch.taskIds.map((id) => data.tasks.find((t) => t.id === id)).filter((t) => t !== undefined),
      board: boardForPrompt(this.p),
      roles,
      max,
    });
    const workerId = "lead-1";
    const { runId, done } = this.supervisor.start(this.p, {
      taskId: "LEAD", workerId, route, kind: "plan", prompt, cwd: this.p.root, mode: "readonly", allowedPaths: [],
      timeoutMs: limits.max_task_minutes * 60_000, jsonSchema: LEAD_JSON_SCHEMA,
    });
    this.p.setWorker(workerId, "RUNNING", { currentRun: runId });
    let outcome;
    try {
      outcome = await done;
    } finally {
      this.p.setWorker(workerId, "IDLE");
    }
    const v = outcome.result ? validateLead(outcome.result.structured, outcome.result.summary, roles, max) : ({ ok: false, errors: [outcome.error?.message ?? outcome.state] } as const);
    if (!v.ok) {
      // A broken lead reply never blocks the team: report it and move on.
      const status = `the lead's reply could not be used (${v.errors.join("; ").slice(0, 200)})`;
      this.p.emit("lead.reported", { status, followups: [], batch: batch.key, round: batch.round, done: false });
      return { status, done: false, followups: [], facts: [] };
    }
    const ids: string[] = [];
    for (const f of v.lead.followups) {
      const picked = f.role ? undefined : pickRole(this.p, `${f.title}\n${f.description}\n${f.files_hint.join(" ")}`);
      const t = this.p.createTask({ title: f.title, role: f.role || picked!.role, body: f.description, acceptance: f.acceptance, filesHint: f.files_hint });
      if (picked) this.p.emit("task.routed", { role: picked.role, reason: picked.reason }, { taskId: t.id });
      ids.push(t.id);
    }
    const known = new Set(projectFacts(this.p).map((f) => f.toLowerCase()));
    for (const f of v.lead.facts) if (!known.has(f.toLowerCase())) this.p.emit("fact.added", { text: f, by: "lead" });
    this.p.emit("lead.reported", { status: v.lead.status, followups: ids, batch: batch.key, round: batch.round, done: v.lead.done });
    if (ids.length) this.onTasks(ids);
    return v.lead;
  }
}
