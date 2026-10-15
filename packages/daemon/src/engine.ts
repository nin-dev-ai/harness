import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { HarnessError, type Task, type TaskSize } from "@harness/core";
import { editHarnessConfig, findCycle, readTaskFile, setRouteLimit, writeTaskFile } from "@harness/config";
import { changedFiles, diffSummary, diffText, landIntegration, rebuildOrphanedIntegration } from "@harness/workspace";
import type { Daemon, DaemonPlugin } from "./daemon.js";
import type { Guard } from "./guards.js";
import { ProjectEngine } from "./outer-loop.js";
import type { ProjectRuntime } from "./project.js";
import type { RpcHandler } from "./server.js";
import { snapshot } from "./status.js";
import { pickRole, Planner } from "./planning.js";
import { sizeOfRequest } from "@harness/planner";
import { BOARD_FILE, boardData, renderBoard } from "./board.js";
import { Lead } from "./lead.js";
import { suggestRoutes } from "./suggest.js";

const P = z.object({ projectId: z.string(), attended: z.boolean().optional() });
const parse = <T extends z.ZodTypeAny>(schema: T, params: unknown): z.infer<T> => {
  const r = schema.safeParse(params ?? {});
  if (!r.success) throw new HarnessError("VALIDATION", `invalid params: ${r.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")}`);
  return r.data;
};

export type GuardFactory = (p: ProjectRuntime, d: Daemon, kick: () => void) => Guard[];

/** How long after the last client command a person counts as present. */
const ATTENDED_WINDOW_MS = 10 * 60_000;

/**
 * The scheduler and outer loop as a daemon plugin: one ProjectEngine per open
 * project, plus every RPC method the CLI and UI call.
 */
export class EnginePlugin implements DaemonPlugin {
  readonly engines = new Map<string, ProjectEngine>();
  private readonly leads = new Map<string, Lead>();
  private readonly unsubscribers: (() => void)[] = [];
  private lastAttended = 0;
  private daemon?: Daemon;

  constructor(private guardFactory: GuardFactory = () => []) {}

  isAttended(): boolean {
    const now = this.daemon?.clock.now().getTime() ?? Date.now();
    return this.lastAttended > 0 && now - this.lastAttended < ATTENDED_WINDOW_MS;
  }

  markAttended(): void {
    this.lastAttended = this.daemon?.clock.now().getTime() ?? Date.now();
  }

  attach(d: Daemon): void {
    this.daemon = d;
    // A daemon started by a person's command starts attended.
    if (d.opts.env?.HARNESS_ATTENDED_AT_START === "1") this.markAttended();
  }

  onProjectOpen(p: ProjectRuntime): void {
    if (this.engines.has(p.id) || !this.daemon) return;
    const e = new ProjectEngine(p, this.daemon.supervisor, this.guardFactory(p, this.daemon, () => this.engines.get(p.id)?.kick()), { attended: () => this.isAttended() });
    this.engines.set(p.id, e);
    // A base branch with rewritten history leaves the integration branch unlandable: keep it, start fresh.
    void rebuildOrphanedIntegration(p.root, p.config.integration_branch, p.config.base_branch, p.now())
      .then((kept) => kept && p.emit("integration.rebuilt", { kept, base: p.config.base_branch }))
      .catch(() => undefined)
      .finally(() => e.kick()); // work starts only after the branch is sound
    // The lead looks at each batch of team work once it settles.
    const lead = new Lead(p, this.daemon.supervisor, (ids) => {
      this.approve(p, ids);
      if (e.running) e.kick();
      else e.start({});
    });
    this.leads.set(p.id, lead);
    const settle = new Set(["MERGED", "PR_READY", "NEEDS_HUMAN", "CANCELLED"]);
    this.unsubscribers.push(
      p.store.subscribe((ev) => {
        if (ev.projectId === p.id && ev.type === "task.state_changed" && settle.has(ev.payload.to)) void lead.check().catch(() => undefined);
      }),
    );
  }

  lead(projectId: string): Lead | undefined {
    return this.leads.get(projectId);
  }

  async stop(): Promise<void> {
    for (const u of this.unsubscribers.splice(0)) u();
    for (const e of this.engines.values()) e.shutdown();
  }

  engine(projectId: string): ProjectEngine {
    const e = this.engines.get(projectId);
    if (!e) throw new HarnessError("NOT_FOUND", `project ${projectId} is not open`);
    return e;
  }

  handlers(d: Daemon): Record<string, RpcHandler> {
    this.daemon = d;
    const ctxProject = (params: unknown, attended: boolean) => {
      const { projectId } = parse(P.passthrough(), params);
      if (attended) this.markAttended();
      const p = d.project(projectId);
      return { p, e: this.engine(projectId) };
    };

    return {
      "project.open": async (params, ctx) => {
        const { path: dir } = parse(z.object({ path: z.string() }).passthrough(), params);
        if (ctx.attended) this.markAttended();
        const p = await d.openProject(dir);
        this.onProjectOpen(p);
        return { projectId: p.id, name: p.config.project, root: p.root, warnings: p.warnings };
      },
      "project.reload": (params, ctx) => {
        const { p, e } = ctxProject(params, ctx.attended);
        p.load();
        p.ensureWorkers();
        p.emit("config.changed", { file: "harness.yaml", summary: "reloaded" });
        e.kick();
        return { warnings: p.warnings };
      },
      status: (params, ctx) => {
        const { p, e } = ctxProject(params, ctx.attended);
        return snapshot(p, e);
      },
      "task.add": (params, ctx) => {
        const { p, e } = ctxProject(params, ctx.attended);
        const a = parse(
          P.extend({
            title: z.string().min(1),
            role: z.string().optional(),
            size: z.enum(["S", "M", "L"]).optional(),
            dependsOn: z.array(z.string()).optional(),
            body: z.string().optional(),
            acceptance: z.array(z.string()).optional(),
            filesHint: z.array(z.string()).optional(),
            contractRef: z.string().optional(),
            approve: z.boolean().optional(),
          }),
          params,
        );
        const picked = a.role ? undefined : pickRole(p, `${a.title}\n${a.body ?? ""}\n${(a.filesHint ?? []).join(" ")}`);
        const t = p.createTask({
          title: a.title, role: a.role ?? picked!.role, ...(a.size ? { size: a.size as TaskSize } : {}), dependsOn: a.dependsOn ?? [], body: a.body ?? "",
          acceptance: a.acceptance ?? [], filesHint: a.filesHint ?? [], ...(a.contractRef ? { contractRef: a.contractRef } : {}),
        });
        if (picked) p.emit("task.routed", { role: picked.role, reason: picked.reason }, { taskId: t.id });
        if (a.approve) this.approve(p, [t.id]);
        e.kick();
        return p.task(t.id);
      },
      "task.list": (params, ctx) => ctxProject(params, ctx.attended).p.tasks(),
      "task.show": (params, ctx) => {
        const { p } = ctxProject(params, ctx.attended);
        const { id } = parse(P.extend({ id: z.string() }), params);
        const t = p.task(id);
        const runs = p.store.runs.listByTask(p.id, id);
        let spec: unknown = null;
        try {
          spec = readTaskFile(p.root, id);
        } catch {
          spec = null;
        }
        return {
          task: t,
          spec,
          runs: runs.map((r) => ({ ...r, checks: p.store.runs.checkResults(r.id), findings: p.store.runs.findings(r.id) })),
          events: p.store.events.list({ projectId: p.id, taskId: id }).filter((ev) => ev.type !== "run.event"),
        };
      },
      "task.edit": (params, ctx) => {
        const { p, e } = ctxProject(params, ctx.attended);
        const a = parse(P.extend({ id: z.string(), title: z.string().optional(), role: z.string().optional(), size: z.enum(["S", "M", "L"]).optional(), dependsOn: z.array(z.string()).optional() }), params);
        const t = p.task(a.id);
        if (!["DRAFT", "QUEUED", "PAUSED", "NEEDS_HUMAN"].includes(t.state)) throw new HarnessError("CONFLICT", `cannot edit a task in state ${t.state}`);
        if (a.role && !p.config.roles[a.role]) throw new HarnessError("VALIDATION", `unknown role "${a.role}"`);
        const fields = { ...(a.title ? { title: a.title } : {}), ...(a.role ? { role: a.role } : {}), ...(a.size ? { size: a.size } : {}), ...(a.dependsOn ? { dependsOn: a.dependsOn } : {}) };
        if (a.dependsOn) this.assertDag(p, new Map([[a.id, a.dependsOn]]));
        p.emit("task.updated", { fields }, { taskId: a.id });
        try {
          const f = readTaskFile(p.root, a.id);
          writeTaskFile(p.root, { ...f, front: { ...f.front, ...(a.title ? { title: a.title } : {}), ...(a.role ? { role: a.role } : {}), ...(a.size ? { size: a.size } : {}), ...(a.dependsOn ? { depends_on: a.dependsOn } : {}) } });
        } catch {
          // task file mirror only
        }
        e.kick();
        return p.task(a.id);
      },
      "task.approve": (params, ctx) => {
        const { p, e } = ctxProject(params, ctx.attended);
        const a = parse(P.extend({ ids: z.array(z.string()).optional(), all: z.boolean().optional() }), params);
        const ids = a.all ? p.tasks(["DRAFT"]).map((t) => t.id) : (a.ids ?? []);
        const approved = this.approve(p, ids);
        e.kick();
        return { approved };
      },
      "task.cancel": async (params, ctx) => {
        const { e } = ctxProject(params, ctx.attended);
        const { id } = parse(P.extend({ id: z.string() }), params);
        await e.cancelTask(id);
        return { cancelled: id };
      },
      "task.requeue": (params, ctx) => {
        const { p, e } = ctxProject(params, ctx.attended);
        const { id } = parse(P.extend({ id: z.string() }), params);
        p.transition(id, "QUEUED", "requeued by user");
        e.kick();
        return p.task(id);
      },
      run: (params, ctx) => {
        const { e } = ctxProject(params, ctx.attended);
        const a = parse(P.extend({ role: z.string().optional(), task: z.string().optional(), until: z.string().optional() }), params);
        e.start({ ...(a.until ? { until: new Date(a.until).toISOString() } : {}), ...(a.role ? { role: a.role } : {}), ...(a.task ? { task: a.task } : {}) });
        return { running: true };
      },
      pause: async (params, ctx) => {
        const { e } = ctxProject(params, ctx.attended);
        const a = parse(P.extend({ role: z.string().optional(), task: z.string().optional(), all: z.boolean().optional() }), params);
        if (a.task) await e.pauseTask(a.task);
        else if (a.role) await e.pauseRole(a.role);
        else await e.pauseAll();
        return { paused: a.task ?? a.role ?? "all" };
      },
      resume: (params, ctx) => {
        const { e } = ctxProject(params, ctx.attended);
        const a = parse(P.extend({ role: z.string().optional(), task: z.string().optional(), all: z.boolean().optional() }), params);
        if (a.task) e.resumeTask(a.task);
        else if (a.role) e.resumeRole(a.role);
        else e.start({});
        return { resumed: a.task ?? a.role ?? "all" };
      },
      "review.show": async (params, ctx) => {
        const { p } = ctxProject(params, ctx.attended);
        const { id } = parse(P.extend({ id: z.string() }), params);
        const t = p.task(id);
        const wt = t.worktree ? path.join(p.root, t.worktree) : null;
        const base = p.config.integration_branch;
        const runs = p.store.runs.listByTask(p.id, id);
        const lastGate = p.store.events.list({ projectId: p.id, taskId: id, types: ["gate.passed", "gate.failed"] }).at(-1);
        const reviewRun = runs.filter((r) => r.kind === "review").at(-1);
        return {
          task: t,
          diff: wt && fs.existsSync(wt) ? await diffText(wt, base) : null,
          ...(wt && fs.existsSync(wt) ? await diffSummary(wt, base).then((d) => ({ stat: d.stat, fileStats: d.fileStats })) : { stat: null, fileStats: [] }),
          files: wt && fs.existsSync(wt) ? await changedFiles(wt, base) : [],
          checks: lastGate?.runId ? p.store.runs.checkResults(lastGate.runId) : [],
          gate: lastGate?.type ?? null,
          findings: reviewRun ? p.store.runs.findings(reviewRun.id) : [],
          runs: runs.map((r) => ({ id: r.id, kind: r.kind, state: r.state, route: r.route, startedAt: r.startedAt, endedAt: r.endedAt })),
        };
      },
      "review.accept": async (params, ctx) => {
        const { p, e } = ctxProject(params, ctx.attended);
        const { id } = parse(P.extend({ id: z.string() }), params);
        // A human accepting the review is the approval for this merge.
        for (const a of p.store.windows.approvals(p.id, "PENDING")) if (a.taskId === id) this.decide(p, a.id, true);
        await e.merge(id);
        return p.task(id);
      },
      "review.reject": (params, ctx) => {
        const { p, e } = ctxProject(params, ctx.attended);
        const a = parse(P.extend({ id: z.string(), comment: z.string().min(1) }), params);
        e.reject(a.id, a.comment);
        return p.task(a.id);
      },
      logs: (params, ctx) => {
        const { p } = ctxProject(params, ctx.attended);
        const { runId } = parse(P.extend({ runId: z.string() }), params);
        const run = p.store.runs.get(runId);
        if (!run) throw new HarnessError("NOT_FOUND", `unknown run ${runId}`);
        return { run, events: p.store.events.list({ runId }), artifactDir: path.join(p.root, run.artifactDir) };
      },
      usage: (params, ctx) => {
        const { p, e } = ctxProject(params, ctx.attended);
        return snapshot(p, e).routes;
      },
      "limits.set": (params, ctx) => {
        const { p, e } = ctxProject(params, ctx.attended);
        const a = parse(P.extend({ route: z.string(), window: z.enum(["5h", "7d", "budget"]), budget: z.string() }), params);
        if (!p.config.routes[a.route]) throw new HarnessError("VALIDATION", `unknown route "${a.route}"`);
        const parsed = parseBudget(a.window, a.budget);
        const current = p.config.limits.routes[a.route];
        const raising = (a.window === "5h" && (current?.window_5h_cap_pct ?? 100) < (parsed.value as number)) || (a.window === "7d" && (current?.window_7d_cap_pct ?? 100) < (parsed.value as number));
        setRouteLimit(p.root, a.route, parsed.key, parsed.value);
        p.load();
        p.emit("config.changed", { file: "harness.yaml", summary: `limits.routes.${a.route}.${parsed.key} = ${JSON.stringify(parsed.value)}${raising ? " (budget increase)" : ""}` });
        e.kick();
        return p.config.limits.routes[a.route];
      },
      "approval.list": (params, ctx) => {
        const { p } = ctxProject(params, ctx.attended);
        const a = parse(P.extend({ state: z.enum(["PENDING", "GRANTED", "DENIED"]).optional() }), params);
        return p.store.windows.approvals(p.id, a.state);
      },
      "approval.grant": (params, ctx) => {
        const { p, e } = ctxProject(params, ctx.attended);
        const a = parse(P.extend({ id: z.string() }), params);
        this.decide(p, a.id, true);
        e.kick();
        return p.store.windows.approvals(p.id).find((x) => x.id === a.id);
      },
      "approval.deny": (params, ctx) => {
        const { p, e } = ctxProject(params, ctx.attended);
        const a = parse(P.extend({ id: z.string(), comment: z.string().optional() }), params);
        this.decide(p, a.id, false, a.comment);
        e.kick();
        return p.store.windows.approvals(p.id).find((x) => x.id === a.id);
      },
      plan: async (params, ctx) => {
        const { p } = ctxProject(params, ctx.attended);
        const a = parse(P.extend({ document: z.string().min(1), source: z.string().default("(inline)") }), params);
        return new Planner(p, d.supervisor).plan(a.document, a.source);
      },
      /**
       * Chat to the team: the planner splits a message into one mini prompt
       * per agent, the new tasks are approved, and the scheduler starts them.
       */
      dispatch: async (params, ctx) => {
        const { p, e } = ctxProject(params, ctx.attended);
        const a = parse(P.extend({ document: z.string().min(1), source: z.string().default("chat") }), params);
        let created: Task[];
        let summary = "";
        const picked = pickRole(p, a.document);
        if (picked.sure || !p.config.roles.planner) {
          // One agent's job (or no planner to ask): start it now, no planning run.
          const t = p.createTask({ title: a.document.split("\n")[0]!.slice(0, 80), role: picked.role, body: a.document, size: sizeOfRequest(a.document) });
          p.emit("task.routed", { role: picked.role, reason: picked.reason }, { taskId: t.id });
          created = [t];
          summary = `${picked.role} takes this (${picked.reason})`;
        } else {
          const r = await new Planner(p, d.supervisor).plan(a.document, a.source, { chat: true });
          created = r.tasks;
          summary = r.summary;
        }
        p.emit("team.request", { text: a.document, taskIds: created.map((t) => t.id) });
        this.approve(p, created.map((t) => t.id));
        if (e.running) e.kick();
        else e.start({});
        return { summary, tasks: created.map((t) => ({ id: t.id, title: t.title, role: t.role, dependsOn: t.dependsOn })) };
      },
      "roles.propose": async (params, ctx) => {
        const { p } = ctxProject(params, ctx.attended);
        const a = parse(P.extend({ document: z.string().default("") }), params);
        return new Planner(p, d.supervisor).proposeRoles(a.document);
      },
      "roles.suggest": (params, ctx) => suggestRoutes(ctxProject(params, ctx.attended).p),
      "roles.apply": (params, ctx) => {
        const { p, e } = ctxProject(params, ctx.attended);
        const a = parse(P.extend({ proposal: z.object({ rationale: z.string().default(""), roles: z.array(z.object({ name: z.string(), route: z.string(), mode: z.enum(["readonly", "write"]), paths_allow: z.array(z.string()).optional(), instructions: z.string().default("") })) }) }), params);
        new Planner(p, d.supervisor).applyRoles(a.proposal);
        e.kick();
        return { roles: Object.keys(p.config.roles) };
      },
      /** Bring finished work from the integration branch into the base branch. Only on request. */
      land: async (params, ctx) => {
        const { p } = ctxProject(params, ctx.attended);
        const r = await landIntegration(p.root, p.config.integration_branch, p.config.base_branch);
        if (r.status === "landed") p.emit("integration.landed", { into: p.config.base_branch, mode: r.mode, commit: r.commit, commits: r.commits });
        return { ...r, into: p.config.base_branch, from: p.config.integration_branch };
      },
      /** The team board (HARNESS.md) as Markdown. */
      board: (params, ctx) => {
        const { p } = ctxProject(params, ctx.attended);
        return { file: BOARD_FILE, text: renderBoard(boardData(p)) };
      },
      "agent.message": async (params, ctx) => {
        const { e } = ctxProject(params, ctx.attended);
        const a = parse(P.extend({ target: z.string(), text: z.string().min(1) }), params);
        return e.message(a.target, a.text);
      },
      "attach.prepare": async (params, ctx) => {
        const { e } = ctxProject(params, ctx.attended);
        const a = parse(P.extend({ target: z.string() }), params);
        return e.takeover(a.target);
      },
      "attach.done": async (params, ctx) => {
        const { p, e } = ctxProject(params, ctx.attended);
        const a = parse(P.extend({ taskId: z.string(), resume: z.boolean() }), params);
        await e.releaseTakeover(a.taskId, a.resume);
        return p.task(a.taskId);
      },
      "burst.set": (params, ctx) => {
        const { p, e } = ctxProject(params, ctx.attended);
        const a = parse(P.extend({ enabled: z.boolean() }), params);
        editHarnessConfig(p.root, (doc) => doc.setIn(["burst", "enabled"], a.enabled));
        p.load();
        p.emit("config.changed", { file: "harness.yaml", summary: `burst.enabled = ${a.enabled}` });
        e.kick();
        return { burst: a.enabled };
      },
      "pr.evidence": (params, ctx) => {
        const { p } = ctxProject(params, ctx.attended);
        const a = parse(P.extend({ taskId: z.string().optional() }), params);
        return prEvidence(p, a.taskId);
      },
      "pr.record": (params, ctx) => {
        const { p } = ctxProject(params, ctx.attended);
        const a = parse(P.extend({ url: z.string(), branch: z.string(), taskIds: z.array(z.string()) }), params);
        for (const id of a.taskIds) if (!p.store.events.exists(p.id, "pr.opened", id)) p.emit("pr.opened", { url: a.url, branch: a.branch }, { taskId: id });
        if (!a.taskIds.length) p.emit("pr.opened", { url: a.url, branch: a.branch });
        return { recorded: a.taskIds.length };
      },
      "events.list": (params, ctx) => {
        const { p } = ctxProject(params, ctx.attended);
        const a = parse(P.extend({ afterSeq: z.number().optional(), limit: z.number().optional(), taskId: z.string().optional() }), params);
        return p.store.events.list({ projectId: p.id, ...(a.afterSeq !== undefined ? { afterSeq: a.afterSeq } : {}), ...(a.limit ? { limit: a.limit } : {}), ...(a.taskId ? { taskId: a.taskId } : {}) });
      },
    };
  }

  private assertDag(p: ProjectRuntime, overrides: Map<string, string[]>): void {
    const deps = new Map<string, readonly string[]>();
    for (const t of p.tasks()) if (t.state !== "CANCELLED") deps.set(t.id, overrides.get(t.id) ?? t.dependsOn);
    for (const [id, ds] of overrides) {
      deps.set(id, ds);
      for (const x of ds) if (!deps.has(x)) throw new HarnessError("VALIDATION", `${id} depends on unknown task ${x}`);
    }
    const cycle = findCycle(deps);
    if (cycle) throw new HarnessError("VALIDATION", `dependency cycle: ${cycle.join(" -> ")}`);
  }

  decide(p: ProjectRuntime, id: string, grant: boolean, comment?: string): void {
    const a = p.store.windows.approvals(p.id).find((x) => x.id === id);
    if (!a) throw new HarnessError("NOT_FOUND", `unknown approval ${id}`);
    if (a.state !== "PENDING") throw new HarnessError("CONFLICT", `${id} is already ${a.state}`);
    if (grant) p.emit("approval.granted", { approvalId: id }, { taskId: a.taskId });
    else p.emit("approval.denied", { approvalId: id, ...(comment ? { comment } : {}) }, { taskId: a.taskId });
  }

  /**
   * `harness approve <id>`: DRAFT → QUEUED (rejecting cycles and unknown
   * dependencies), and grants that task's pending approvals.
   */
  approve(p: ProjectRuntime, ids: string[]): string[] {
    this.assertDag(p, new Map());
    const out: string[] = [];
    for (const id of ids) {
      const t = p.task(id);
      for (const a of p.store.windows.approvals(p.id, "PENDING")) {
        if (a.taskId === id) {
          this.decide(p, a.id, true);
          if (!out.includes(id)) out.push(id);
        }
      }
      if (t.state !== "DRAFT") continue;
      p.emit("task.approved", { by: "user" }, { taskId: id });
      p.transition(id, "QUEUED", "approved");
      out.push(id);
    }
    return out;
  }
}

/** "85%" for 5h/7d caps; "40 runs/day", "120 minutes/week", "30%/5h" for manual budgets. */
export function parseBudget(window: "5h" | "7d" | "budget", text: string): { key: string; value: unknown } {
  const t = text.trim();
  if (window !== "budget") {
    const m = /^(\d+(?:\.\d+)?)\s*%?$/.exec(t);
    if (!m) throw new HarnessError("VALIDATION", `expected a percentage like "85%", got "${text}"`);
    const v = Number(m[1]);
    if (v < 0 || v > 100) throw new HarnessError("VALIDATION", "cap must be between 0 and 100");
    return { key: window === "5h" ? "window_5h_cap_pct" : "window_7d_cap_pct", value: v };
  }
  const m = /^(\d+(?:\.\d+)?)\s*(runs?|minutes?|mins?|%|pct)\s*\/\s*(day|week|5h)$/.exec(t);
  if (!m) throw new HarnessError("VALIDATION", `expected a budget like "40 runs/day" or "120 minutes/week", got "${text}"`);
  const unit = m[2]!.startsWith("run") ? "runs" : m[2]!.startsWith("min") ? "minutes" : "pct";
  return { key: "manual_budget", value: { unit, per: m[3], amount: Number(m[1]) } };
}

/** Everything a PR body needs, from the event log. Also says if a PR already exists. */
export function prEvidence(p: ProjectRuntime, taskId?: string) {
  const cfg = p.config;
  const tasks = taskId ? [p.task(taskId)] : p.tasks(["MERGED"]);
  if (taskId && !["PR_READY", "MERGED"].includes(tasks[0]!.state)) throw new HarnessError("CONFLICT", `${taskId} is ${tasks[0]!.state}; only PR_READY or MERGED tasks get a PR`);
  if (!tasks.length) throw new HarnessError("CONFLICT", "no merged tasks on the integration branch yet");
  const head = taskId ? tasks[0]!.branch! : cfg.integration_branch;
  const existing = p.store.events.list({ projectId: p.id, types: ["pr.opened"] }).find((e) => e.type === "pr.opened" && e.payload.branch === head);
  const evTasks = tasks.map((t) => {
    const runs = p.store.runs.listByTask(p.id, t.id);
    const gate = p.store.events.list({ projectId: p.id, taskId: t.id, types: ["gate.passed"] }).at(-1);
    const review = runs.filter((r) => r.kind === "review");
    let tokensIn: number | null = null;
    let tokensOut: number | null = null;
    let costUsd: number | null = null;
    for (const e of p.store.events.list({ projectId: p.id, taskId: t.id, types: ["run.event"] })) {
      if (e.type !== "run.event" || e.payload.event.type !== "usage") continue;
      const u = e.payload.event;
      if (u.tokensIn !== undefined) tokensIn = (tokensIn ?? 0) + u.tokensIn;
      if (u.tokensOut !== undefined) tokensOut = (tokensOut ?? 0) + u.tokensOut;
      if (u.costUsd !== undefined) costUsd = (costUsd ?? 0) + u.costUsd;
    }
    return {
      id: t.id, title: t.title, role: t.role, route: runs.find((r) => r.kind !== "review")?.route ?? cfg.roles[t.role]?.route ?? "?", attempts: t.attempts,
      checks: gate?.runId ? p.store.runs.checkResults(gate.runId).map((c) => ({ checkId: c.checkId, ok: c.ok, durationMs: c.durationMs, required: c.required })) : [],
      findings: review.flatMap((r) => p.store.runs.findings(r.id)).map((f) => ({ severity: f.severity, file: f.file, line: f.line, message: f.message })),
      runs: runs.length, tokensIn, tokensOut, costUsd,
    };
  });
  return {
    evidence: { project: cfg.project, base: cfg.base_branch, head, tasks: evTasks },
    title: taskId ? `${tasks[0]!.id}: ${tasks[0]!.title}` : `harness: ${tasks.length} task(s) from ${cfg.integration_branch}`,
    existing: existing?.type === "pr.opened" ? existing.payload.url : null,
    firstPush: !p.store.events.list({ projectId: p.id, types: ["pr.opened"], limit: 1 }).length,
    taskIds: tasks.map((t) => t.id),
  };
}
