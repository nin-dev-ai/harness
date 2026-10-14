import fs from "node:fs";
import path from "node:path";
import { taskBranch, type HarnessEvent, type RunKind, type Task, type TaskState } from "@harness/core";
import { readTaskFile } from "@harness/config";
import {
  buildFreshResumePrompt,
  buildRepairPrompt,
  buildResumePrompt,
  buildReviewPrompt,
  buildReviewRepairPrompt,
  buildTaskPrompt,
  parseReview,
  REVIEW_JSON_SCHEMA,
} from "@harness/planner";
import { gateOutcome, runChecks, runSetup, type CheckResult } from "@harness/verify";
import {
  changedFiles,
  checkpoint,
  commitAll,
  createWorktree,
  diffSummary,
  diffText,
  ensureIntegrationBranch,
  git,
  mergeTask,
  removeWorktree,
  workingTreeHash,
} from "@harness/workspace";
import { isSecretPath } from "@harness/policy";
import type { Guard, GuardDecision } from "./guards.js";
import type { ProjectRuntime } from "./project.js";
import { freeWorker, selectWork, waitingOnDeps, filesOverlap, type WorkItem } from "./scheduler.js";
import type { RunOutcome, Supervisor } from "./supervisor.js";

interface LiveRun {
  runId: string;
  taskId: string;
  workerId: string;
  route: string;
  kind: RunKind;
  startedAt: string;
}

const NEEDS_HUMAN_ERRORS = new Set(["auth", "cli_missing", "cli_version"]);
const MAX_REVIEW_TRIES = 2;
const TICK_MS = 30_000;

export interface EngineOptions {
  /** Called to learn whether a person is attached right now. */
  attended?: () => boolean;
}

/**
 * The outer loop for one project: picks work, starts runs, gates them with
 * independent checks, repairs, reviews and merges. Deterministic; no LLM here.
 */
export class ProjectEngine {
  running = false;
  until: string | null = null;
  onlyRole: string | undefined;
  onlyTask: string | undefined;
  readonly live = new Map<string, LiveRun>();
  /** Workers holding a task outside a run (gating). */
  private holding = new Map<string, string>();
  private lastReason = new Map<string, string>();
  private ticking = false;
  private again = false;
  private cancelTimer: (() => void) | undefined;
  private mergeChain: Promise<unknown> = Promise.resolve();
  private stopped = false;
  /** Promises of in-flight work (runs and their follow-ups), for tests and shutdown. */
  private inflight = new Set<Promise<unknown>>();

  constructor(
    readonly p: ProjectRuntime,
    private supervisor: Supervisor,
    private guards: Guard[] = [],
    private opts: EngineOptions = {},
  ) {
    const last = p.store.events.list({ projectId: p.id, types: ["scheduler.changed"] }).at(-1);
    if (last?.type === "scheduler.changed" && last.payload.running) {
      this.running = true;
      this.until = last.payload.until ?? null;
    }
    this.armTimer();
  }

  // ── scheduler control ────────────────────────────────────────────────

  start(o: { until?: string | null; role?: string; task?: string } = {}): void {
    this.running = true;
    this.until = o.until ?? null;
    this.onlyRole = o.role;
    this.onlyTask = o.task;
    this.p.emit("scheduler.changed", { running: true, until: this.until, ...(o.role || o.task ? { reason: `filter ${o.role ?? ""}${o.task ?? ""}` } : {}) });
    this.kick();
  }

  stop(reason = "user"): void {
    if (!this.running) return;
    this.running = false;
    this.p.emit("scheduler.changed", { running: false, reason });
  }

  shutdown(): void {
    this.stopped = true;
    this.cancelTimer?.();
  }

  private armTimer(): void {
    this.cancelTimer?.();
    if (this.stopped) return;
    this.cancelTimer = this.p.clock.setTimeout(() => {
      this.kick();
      this.armTimer();
    }, TICK_MS);
  }

  /** Run a scheduling pass soon. Coalesces bursts of triggers into one pass. */
  kick(): void {
    if (this.stopped) return;
    setImmediate(() => void this.tick());
  }

  /** Wait until no run or follow-up is in flight (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.inflight.size || this.ticking) {
      await Promise.allSettled([...this.inflight]);
      await new Promise((r) => setImmediate(r));
    }
  }

  private track<T>(pr: Promise<T>): Promise<T> {
    this.inflight.add(pr);
    void pr.finally(() => this.inflight.delete(pr)).catch(() => undefined);
    return pr;
  }

  async tick(): Promise<void> {
    if (this.ticking) {
      this.again = true;
      return;
    }
    this.ticking = true;
    try {
      do {
        this.again = false;
        await this.pass();
      } while (this.again && !this.stopped);
    } catch (e) {
      this.p.emit("task.needs_human", { reason: `scheduler error: ${(e as Error).message}`, evidence: {} });
    } finally {
      this.ticking = false;
    }
  }

  private async pass(): Promise<void> {
    if (!this.running || this.stopped) return;
    const now = this.p.now();
    if (this.until && now >= this.until) {
      this.stop("until reached");
      return;
    }
    const cfg = this.p.config;
    const tasks = this.p.tasks();
    for (const t of waitingOnDeps(tasks)) this.block(t, "dependencies");

    const items = selectWork({
      config: cfg,
      tasks,
      live: new Set([...this.live.values()].map((l) => l.taskId).concat([...this.holding.values()])),
      pauseCause: (id) => this.pauseCause(id),
      filesHint: (id) => this.filesHint(id),
      reviewerRole: this.reviewerRole(),
      onlyRole: this.onlyRole,
      onlyTask: this.onlyTask,
    });

    for (const item of items) {
      if (this.live.size + this.holding.size >= cfg.limits.max_parallel_workers) {
        this.block(item.task, "no_worker", "max_parallel_workers reached");
        continue;
      }
      const workers = this.p.store.workers.list(this.p.id);
      const busy = new Set([...this.live.values()].map((l) => l.workerId).concat([...this.holding.keys()]));
      const worker = freeWorker(workers, item.role, busy);
      if (!worker) {
        this.block(item.task, "no_worker", `no free ${item.role} worker`);
        continue;
      }
      const role = cfg.roles[item.role]!;
      // The role's route is law; fallback routes only with `fallback: auto` (or `ask` + approval, see PolicyGuard).
      const candidates = [role.route, ...(role.fallback !== "none" ? role.fallback_routes : [])];
      let chosen: string | undefined;
      let firstBlock: { reason: NonNullable<Task["blockedReason"]>; detail?: string } | undefined;
      for (const route of candidates) {
        const rs = this.p.store.windows.routeState(this.p.id, route);
        if (rs.pausedUntil && rs.pausedUntil > now) {
          firstBlock ??= { reason: "paused", detail: `route ${route} paused until ${rs.pausedUntil}${rs.pauseSource === "backoff" ? " (probing)" : ""}` };
          continue;
        }
        if (item.kind === "implement") {
          const mine = this.filesHint(item.task.id);
          const clash = [...this.live.values()].find((l) => l.taskId !== item.task.id && filesOverlap(mine, this.filesHint(l.taskId)));
          if (clash) {
            firstBlock ??= { reason: "file_overlap", detail: `files_hint overlaps ${clash.taskId}` };
            break;
          }
        }
        const decision = await this.checkGuards(item, route);
        if (!decision.ok) {
          firstBlock ??= { reason: decision.reason, ...(decision.detail ? { detail: decision.detail } : {}) };
          continue;
        }
        chosen = route;
        break;
      }
      if (!chosen) {
        if (firstBlock) this.block(item.task, firstBlock.reason, firstBlock.detail);
        continue;
      }
      const route = chosen;
      this.p.emit("dispatch.considered", { dispatched: true, route }, { taskId: item.task.id });
      this.lastReason.delete(item.task.id);
      await this.dispatch(item, worker.id, route);
    }
  }

  private async checkGuards(item: WorkItem, route: string): Promise<GuardDecision> {
    const liveOnRoute = [...this.live.values()].filter((l) => l.route === route).map((l) => ({ taskId: l.taskId, kind: l.kind }));
    for (const g of this.guards) {
      if (!g.canDispatch) continue;
      const d = await g.canDispatch({ project: this.p, task: item.task, kind: item.kind, route, liveOnRoute, attended: this.opts.attended?.() ?? false });
      if (!d.ok) return d;
    }
    return { ok: true };
  }

  /** Record why a task did not dispatch, once per change of reason. */
  private block(task: Task, reason: NonNullable<Task["blockedReason"]>, detail?: string): void {
    const key = `${reason}|${detail ?? ""}`;
    if (this.lastReason.get(task.id) === key) return;
    this.lastReason.set(task.id, key);
    this.p.emit("dispatch.considered", { dispatched: false, reason }, { taskId: task.id });
    this.p.emit("task.blocked", { reason, ...(detail ? { detail } : {}) }, { taskId: task.id });
  }

  reviewerRole(): string | undefined {
    return this.p.config.roles.reviewer ? "reviewer" : undefined;
  }

  /** Why a task is PAUSED: the reason on its last transition into PAUSED. */
  pauseCause(taskId: string): "limit" | "user" | undefined {
    const ev = this.lastTransitionInto(taskId, "PAUSED");
    if (!ev) return undefined;
    return ev.reason?.startsWith("limit") ? "limit" : "user";
  }

  private lastTransitionInto(taskId: string, state: TaskState): { from: TaskState; reason?: string | undefined } | undefined {
    const evs = this.p.store.events.list({ projectId: this.p.id, taskId, types: ["task.state_changed"] });
    for (let i = evs.length - 1; i >= 0; i--) {
      const e = evs[i]!;
      if (e.type === "task.state_changed" && e.payload.to === state) return { from: e.payload.from, reason: e.payload.reason };
    }
    return undefined;
  }

  filesHint(taskId: string): string[] {
    try {
      return readTaskFile(this.p.root, taskId).front.files_hint;
    } catch {
      return [];
    }
  }

  private taskSpec(taskId: string) {
    try {
      return readTaskFile(this.p.root, taskId);
    } catch {
      return undefined;
    }
  }

  // ── dispatch ─────────────────────────────────────────────────────────

  private worktreeAbs(task: Task): string {
    return path.join(this.p.root, task.worktree ?? `.harness/worktrees/${task.id}`);
  }

  /** Create the task's branch and worktree from the integration branch, and run setup once. */
  private async ensureWorkspace(task: Task): Promise<{ ok: true; path: string } | { ok: false; detail: string }> {
    const cfg = this.p.config;
    await ensureIntegrationBranch(this.p.root, cfg.integration_branch, cfg.base_branch);
    const branch = task.branch ?? taskBranch(task.role, task.id, task.title);
    const wt = await createWorktree(this.p.root, task.id, branch, cfg.integration_branch);
    if (wt.created) {
      const rel = path.relative(this.p.root, wt.path);
      this.p.emit("task.updated", { fields: { branch, worktree: rel } }, { taskId: task.id });
      this.p.emit("worktree.created", { path: rel, branch, base: cfg.integration_branch }, { taskId: task.id });
      const setup = await runSetup(wt.path, this.p.checks);
      if (!setup.ok) return { ok: false, detail: `setup failed: ${setup.failed?.argv.join(" ")}\n${setup.failed?.output ?? ""}` };
    }
    return { ok: true, path: wt.path };
  }

  private implementerRuns(taskId: string) {
    return this.p.store.runs.listByTask(this.p.id, taskId).filter((r) => r.kind !== "review" && r.kind !== "plan");
  }

  private taskPrompt(task: Task): string {
    const spec = this.taskSpec(task.id);
    const role = this.p.config.roles[task.role]!;
    return buildTaskPrompt({
      role: task.role,
      instructions: role.instructions,
      taskId: task.id,
      title: task.title,
      body: spec?.body ?? "",
      acceptance: spec?.front.acceptance ?? [],
      agentsMd: fs.existsSync(path.join(this.p.root, "AGENTS.md")),
      ...(spec?.front.contract_ref ? { contractRef: spec.front.contract_ref } : {}),
      pathsAllow: role.paths_allow ?? [],
      pathsDeny: role.paths_deny,
      checks: this.p.checks.checks.map((c) => ({ id: c.id, argv: c.argv, required: c.required })),
    });
  }

  private async dispatch(item: WorkItem, workerId: string, route: string): Promise<void> {
    const task = this.p.task(item.task.id);
    if (item.kind === "review") return this.dispatchReview(task, workerId, route);

    const ws = await this.ensureWorkspace(task);
    if (!ws.ok) {
      this.needsHuman(task.id, "workspace setup failed", { detail: ws.detail });
      return;
    }
    const role = this.p.config.roles[task.role]!;
    const prior = this.implementerRuns(task.id);
    const last = prior.at(-1);
    let kind: RunKind = "initial";
    let prompt: string;
    let resumeSessionId: string | undefined;

    if (item.kind === "repair") {
      kind = "repair";
      prompt = await this.repairPrompt(task, ws.path);
      resumeSessionId = this.lastSession(task.id, route);
      if (!resumeSessionId) prompt = `${this.taskPrompt(task)}\n${prompt}`;
    } else if (last) {
      // Continue earlier work: same session if we can, else a fresh one with the checkpoint summary.
      kind = "resume";
      const session = this.lastSession(task.id, route);
      const expired = last.errorKind === "session_expired";
      if (session && !expired) {
        resumeSessionId = session;
        prompt = buildResumePrompt(task.id);
      } else {
        prompt = buildFreshResumePrompt(this.taskPrompt(task), (await diffSummary(ws.path, this.p.config.integration_branch)).stat);
      }
      this.p.emit("run.resumed", { ...(resumeSessionId ? { sessionId: resumeSessionId } : {}), fresh: !resumeSessionId }, { taskId: task.id });
      this.p.transition(task.id, "RUNNING", task.state === "PAUSED" ? "resume after limit" : "resume");
    } else {
      prompt = this.taskPrompt(task);
      this.p.emit("task.updated", { fields: { attempts: task.attempts + 1 } }, { taskId: task.id });
      this.p.transition(task.id, "RUNNING");
    }

    this.startRun(task, workerId, route, {
      kind,
      prompt,
      cwd: ws.path,
      mode: role.mode,
      allowedPaths: role.paths_allow ?? ["**"],
      ...(resumeSessionId ? { resumeSessionId } : {}),
    });
  }

  /** Vendor session to resume: only from the latest implementer run, and only on the same route. */
  private lastSession(taskId: string, route: string): string | undefined {
    const runs = this.implementerRuns(taskId);
    for (let i = runs.length - 1; i >= 0; i--) {
      const r = runs[i]!;
      if (r.errorKind === "session_expired" || r.route !== route) return undefined;
      if (r.vendorSessionId) return r.vendorSessionId;
    }
    return undefined;
  }

  private async repairPrompt(task: Task, worktree: string): Promise<string> {
    const req = this.p.store.events.list({ projectId: this.p.id, taskId: task.id, types: ["repair.requested"] }).at(-1);
    const cause = req?.type === "repair.requested" ? req.payload.cause : "gate";
    const attempt = req?.type === "repair.requested" ? req.payload.attempt : task.attempts;
    if (cause === "review") {
      const reviewRun = this.p.store.runs.latestForTask(this.p.id, task.id, ["review"]);
      const findings = reviewRun ? this.p.store.runs.findings(reviewRun.id) : [];
      return buildReviewRepairPrompt({ taskId: task.id, attempt, attemptsMax: task.attemptsMax, findings });
    }
    if (cause === "human") {
      const ev = this.p.store.events.list({ projectId: this.p.id, taskId: task.id, types: ["approval.denied"] }).at(-1);
      const comment = ev?.type === "approval.denied" ? ev.payload.comment : undefined;
      return `A reviewer sent this task back.\n\n${comment ?? "(no comment)"}\n\nAddress the comment. The checks will run again after you finish.\n`;
    }
    const gateRun = this.lastGateRun(task.id);
    const failures = gateRun ? this.p.store.runs.checkResults(gateRun).filter((c) => !c.ok && c.required) : [];
    const argv = (id: string) => this.p.checks.checks.find((c) => c.id === id)?.argv ?? [id];
    const lastImpl = this.implementerRuns(task.id).at(-1);
    const prevSummary = lastImpl ? this.lastResultSummary(lastImpl.id) : undefined;
    return buildRepairPrompt({
      attempt,
      attemptsMax: task.attemptsMax,
      failures: failures.map((f) => ({ checkId: f.checkId, argv: argv(f.checkId), outputTail: f.outputTail ?? "" })),
      diffStat: (await diffSummary(worktree, this.p.config.integration_branch)).stat,
      ...(prevSummary ? { previousSummary: prevSummary } : {}),
    });
  }

  private lastGateRun(taskId: string): string | undefined {
    const ev = this.p.store.events.list({ projectId: this.p.id, taskId, types: ["gate.failed", "gate.passed"] }).at(-1);
    return ev?.runId ?? undefined;
  }

  private lastResultSummary(runId: string): string | undefined {
    const evs = this.p.store.events.list({ runId, types: ["run.finished"] });
    const e = evs.at(-1);
    return e?.type === "run.finished" ? e.payload.summary : undefined;
  }

  private async dispatchReview(task: Task, workerId: string, route: string): Promise<void> {
    const wt = this.worktreeAbs(task);
    const base = this.p.config.integration_branch;
    const spec = this.taskSpec(task.id);
    const implRoute = this.p.config.roles[task.role]!.route;
    const sameRoute = implRoute === route;
    this.p.emit("review.started", { route, sameRoute }, { taskId: task.id });
    const prompt = buildReviewPrompt({
      taskId: task.id,
      title: task.title,
      acceptance: spec?.front.acceptance ?? [],
      checks: this.p.checks.checks.filter((c) => c.required).map((c) => c.id),
      diff: await diffText(wt, base, 200_000, (await changedFiles(wt, base)).filter(isSecretPath)),
    });
    const before = await workingTreeHash(wt);
    this.startRun(task, workerId, route, { kind: "review", prompt, cwd: wt, mode: "readonly", allowedPaths: [], jsonSchema: REVIEW_JSON_SCHEMA }, before);
  }

  private startRun(
    task: Task,
    workerId: string,
    route: string,
    r: { kind: RunKind; prompt: string; cwd: string; mode: "readonly" | "write"; allowedPaths: string[]; resumeSessionId?: string; jsonSchema?: object },
    reviewTreeHash?: string,
  ): void {
    const { runId, done } = this.supervisor.start(this.p, {
      taskId: task.id, workerId, route, kind: r.kind, prompt: r.prompt, cwd: r.cwd, mode: r.mode, allowedPaths: r.allowedPaths,
      timeoutMs: this.p.config.limits.max_task_minutes * 60_000,
      ...(r.resumeSessionId ? { resumeSessionId: r.resumeSessionId } : {}),
      ...(r.jsonSchema ? { jsonSchema: r.jsonSchema } : {}),
    });
    this.live.set(task.id, { runId, taskId: task.id, workerId, route, kind: r.kind, startedAt: this.p.now() });
    this.p.emit("worker.assigned", { role: this.p.store.workers.get(this.p.id, workerId)!.role }, { taskId: task.id, workerId, runId });
    this.p.setWorker(workerId, "RUNNING", { currentRun: runId });
    this.track(
      done
        .then((outcome) => this.afterRun(task.id, workerId, route, r.kind, outcome, reviewTreeHash))
        .catch((e: Error) => this.safeNeedsHuman(task.id, `internal error after run: ${e.message}`))
        .finally(() => this.kick()),
    );
  }

  // ── after a run ──────────────────────────────────────────────────────

  private async afterRun(taskId: string, workerId: string, route: string, kind: RunKind, outcome: RunOutcome, reviewTreeHash?: string): Promise<void> {
    const task = this.p.task(taskId);
    // A limit pauses the route before this run stops counting as in flight,
    // so nothing else is dispatched into the gap.
    if (outcome.rateLimit && task.state !== "CANCELLED") {
      for (const g of this.guards) await g.onLimit?.(this.p, route, outcome);
      if (!this.guards.some((g) => g.onLimit)) this.defaultPauseRoute(route, outcome);
    }
    this.live.delete(taskId);
    for (const g of this.guards) await g.onRunFinished?.(this.p, task, route, kind, outcome);
    const releaseWorker = (reason: string | null = null) => {
      this.holding.delete(workerId);
      const w = this.p.store.workers.get(this.p.id, workerId);
      if (w && w.state !== "PAUSED") this.p.setWorker(workerId, "IDLE", { reason });
      this.p.emit("worker.released", { role: w?.role ?? "" }, { taskId, workerId });
    };

    if (task.state === "CANCELLED" || outcome.state === "CANCELLED") {
      releaseWorker();
      return;
    }
    if (outcome.state === "TAKEN_OVER") {
      releaseWorker("taken over");
      return;
    }

    const wt = this.worktreeAbs(task);
    if (kind !== "review" && fs.existsSync(wt)) {
      const commit = await checkpoint(wt, task.id, outcome.runId).catch(() => null);
      if (commit) this.p.emit("run.checkpointed", { commit, reason: outcome.state === "PAUSED" ? "pause" : "run finished" }, { taskId, runId: outcome.runId });
    }

    if (outcome.rateLimit) {
      this.p.transition(taskId, "PAUSED", `limit:${route}`);
      const rs = this.p.store.windows.routeState(this.p.id, route);
      this.holding.delete(workerId);
      this.p.setWorker(workerId, "WAITING", { reason: rs.pausedUntil ? `window resets ${rs.pausedUntil}` : "resume time unknown, probing" });
      return;
    }
    if (outcome.state === "PAUSED") {
      // Paused by the user.
      this.p.transition(taskId, "PAUSED", "user");
      releaseWorker();
      return;
    }

    if (kind === "review") {
      releaseWorker();
      await this.afterReview(task, outcome, reviewTreeHash);
      return;
    }

    if (outcome.error && NEEDS_HUMAN_ERRORS.has(outcome.error.kind)) {
      releaseWorker();
      this.needsHuman(taskId, `agent could not run: ${outcome.error.kind}`, { message: outcome.error.message, runId: outcome.runId });
      return;
    }
    if (outcome.errorKind === "session_expired") {
      releaseWorker();
      this.p.transition(taskId, "QUEUED", "session expired; restarting fresh on the same branch");
      return;
    }

    // Whatever the agent claims, the gate decides.
    this.holding.set(workerId, taskId);
    this.p.setWorker(workerId, "RUNNING", { reason: "gating" });
    try {
      await this.gate(task.id, outcome.runId);
    } finally {
      releaseWorker();
    }
  }

  /** Fallback when no quota guard is installed: pause until the reported reset, else 15 minutes. */
  private defaultPauseRoute(route: string, outcome: RunOutcome): void {
    const until = outcome.rateLimit?.resetsAt ?? new Date(this.p.clock.now().getTime() + 15 * 60_000).toISOString();
    this.p.emit("route.paused", { route, until, source: outcome.rateLimit?.resetsAt ? "event" : "backoff", window: outcome.rateLimit?.window ?? "unknown" });
  }

  // ── gate ─────────────────────────────────────────────────────────────

  private async gate(taskId: string, runId: string): Promise<void> {
    let task = this.p.task(taskId);
    this.p.transition(taskId, "GATING");
    const wt = this.worktreeAbs(task);
    const base = this.p.config.integration_branch;
    const env = { taskId, runId };

    let files = await changedFiles(wt, base);
    const pre: CheckResult[] = [];
    for (const g of this.guards) if (g.beforeGate) pre.push(...(await g.beforeGate({ project: this.p, task, worktree: wt, base, changedFiles: files, runId })));
    if (pre.length) {
      await commitAll(wt, `wip(${taskId}): revert out-of-scope changes`);
      files = await changedFiles(wt, base);
    }

    const results: CheckResult[] = [...pre];
    for (const r of pre) this.p.emit("check.finished", { checkId: r.checkId, ok: r.ok, exitCode: r.exitCode, durationMs: r.durationMs, signature: r.signature, outputTail: r.outputTail, required: r.required }, env);
    results.push(
      ...(await runChecks(wt, this.p.checks, {
        changedFiles: files,
        onStart: (c) => this.p.emit("check.started", { checkId: c.id }, env),
        onFinish: (r) => this.p.emit("check.finished", { checkId: r.checkId, ok: r.ok, exitCode: r.exitCode, durationMs: r.durationMs, signature: r.signature, outputTail: r.outputTail, required: r.required }, env),
      })),
    );
    const outcome = gateOutcome(results);
    task = this.p.task(taskId);

    if (outcome.passed) {
      this.p.emit("gate.passed", { checks: results.map((r) => r.checkId) }, env);
      this.p.transition(taskId, "REVIEWING");
      if (!this.reviewerRole()) {
        this.p.emit("review.passed", { findings: 0 }, { taskId });
        this.p.transition(taskId, "PR_READY", "no reviewer role");
        await this.maybeAutoMerge(taskId);
      }
      return;
    }

    const treeHash = await workingTreeHash(wt);
    const previous = this.p.store.events.list({ projectId: this.p.id, taskId, types: ["gate.failed"] }).at(-1);
    this.p.emit("gate.failed", { failed: outcome.failedRequired.map((r) => r.checkId), signatures: outcome.signatures, treeHash }, env);

    const prevSigs = previous?.type === "gate.failed" ? [...previous.payload.signatures].sort().join(",") : undefined;
    const sigs = [...outcome.signatures].sort().join(",");
    if (previous?.type === "gate.failed" && previous.payload.treeHash === treeHash && this.lastRepairCause(taskId) === "gate") {
      return this.stall(taskId, "unchanged_diff", "the repair attempt changed nothing", results);
    }
    if (prevSigs !== undefined && sigs && prevSigs === sigs && this.lastRepairCause(taskId) === "gate") {
      return this.stall(taskId, "same_signature", `same failure twice: ${outcome.failedRequired.map((r) => r.checkId).join(", ")}`, results);
    }
    if (task.attempts >= task.attemptsMax) {
      return this.stall(taskId, "max_attempts", `${task.attempts} of ${task.attemptsMax} attempts used`, results);
    }
    this.requestRepair(task, "gate");
  }

  private lastRepairCause(taskId: string): string | undefined {
    const e = this.p.store.events.list({ projectId: this.p.id, taskId, types: ["repair.requested", "gate.passed"] }).at(-1);
    return e?.type === "repair.requested" ? e.payload.cause : undefined;
  }

  private requestRepair(task: Task, cause: "gate" | "review" | "human"): void {
    const attempt = task.attempts + 1;
    this.p.emit("repair.requested", { attempt, cause }, { taskId: task.id });
    this.p.emit("task.updated", { fields: { attempts: attempt } }, { taskId: task.id });
    this.p.transition(task.id, "REPAIRING", `repair (${cause})`);
  }

  private stall(taskId: string, reason: "same_signature" | "unchanged_diff" | "max_attempts", detail: string, results: CheckResult[]): void {
    this.p.emit("stall.detected", { reason, detail }, { taskId });
    this.needsHuman(taskId, `stalled: ${detail}`, {
      failed: results.filter((r) => !r.ok).map((r) => ({ check: r.checkId, signature: r.signature, tail: r.outputTail.split("\n").slice(-20).join("\n") })),
    });
  }

  private needsHuman(taskId: string, reason: string, evidence: Record<string, unknown>): void {
    this.p.emit("task.needs_human", { reason, evidence }, { taskId });
    this.p.transition(taskId, "NEEDS_HUMAN", reason);
  }

  private safeNeedsHuman(taskId: string, reason: string): void {
    try {
      const t = this.p.task(taskId);
      if (t.state !== "NEEDS_HUMAN" && t.state !== "CANCELLED" && t.state !== "MERGED") this.needsHuman(taskId, reason, {});
    } catch {
      // store closed during shutdown
    }
  }

  // ── review ───────────────────────────────────────────────────────────

  private async afterReview(task: Task, outcome: RunOutcome, before?: string): Promise<void> {
    const wt = this.worktreeAbs(task);
    // Reviewers never edit files: undo anything they changed and record it.
    if (before && fs.existsSync(wt) && (await workingTreeHash(wt)) !== before) {
      await git(wt, ["reset", "-q", "--hard", "HEAD"]);
      await git(wt, ["clean", "-qfd"]);
      this.p.emit("policy.denied", { rule: "reviewer_readonly", detail: "reviewer changed files; changes reverted" }, { taskId: task.id, runId: outcome.runId });
    }
    const parsed = outcome.result ? parseReview(outcome.result.structured, outcome.result.summary) : { ok: false as const, errors: [outcome.error?.message ?? "review run failed"] };
    if (!parsed.ok) {
      const tries = this.reviewRunsSinceGate(task.id);
      if (tries >= MAX_REVIEW_TRIES) this.needsHuman(task.id, "reviewer produced no valid review", { errors: parsed.errors });
      return; // stays REVIEWING; the scheduler retries
    }
    const env = { taskId: task.id, runId: outcome.runId };
    for (const f of parsed.review.findings) this.p.emit("review.finding", { severity: f.severity, file: f.file, line: f.line, message: f.message }, env);
    const blockers = parsed.review.findings.filter((f) => f.severity === "blocker").length;
    if (blockers) {
      this.p.emit("review.blocked", { blockers }, env);
      const t = this.p.task(task.id);
      if (t.attempts >= t.attemptsMax) {
        this.needsHuman(task.id, `reviewer blockers remain after ${t.attempts} attempts`, { blockers });
        return;
      }
      this.requestRepair(t, "review");
      return;
    }
    this.p.emit("review.passed", { findings: parsed.review.findings.length }, env);
    this.p.transition(task.id, "PR_READY");
    await this.maybeAutoMerge(task.id);
  }

  private reviewRunsSinceGate(taskId: string): number {
    const evs = this.p.store.events.list({ projectId: this.p.id, taskId, types: ["gate.passed", "review.started"] });
    let n = 0;
    for (const e of evs) n = e.type === "gate.passed" ? 0 : n + 1;
    return n;
  }

  // ── merge ────────────────────────────────────────────────────────────

  private async maybeAutoMerge(taskId: string): Promise<void> {
    const task = this.p.task(taskId);
    if (this.p.config.policy.autonomy !== "approved-scope") return;
    const files = await changedFiles(this.worktreeAbs(task), this.p.config.integration_branch);
    for (const g of this.guards) if (g.mayAutoMerge && !(await g.mayAutoMerge(this.p, task, files))) return;
    await this.merge(taskId);
  }

  /** Rebase, re-verify, fast-forward. Serialized per project. */
  merge(taskId: string): Promise<void> {
    const run = this.mergeChain.then(() => this.doMerge(taskId));
    this.mergeChain = run.catch(() => undefined);
    return this.track(run);
  }

  private async doMerge(taskId: string): Promise<void> {
    const task = this.p.task(taskId);
    if (task.state !== "PR_READY") throw Object.assign(new Error(`${taskId} is ${task.state}, not PR_READY`), { code: "CONFLICT" });
    if (this.p.store.events.exists(this.p.id, "branch.merged", taskId)) {
      this.p.transition(taskId, "MERGED", "already merged");
      return;
    }
    const cfg = this.p.config;
    const wt = this.worktreeAbs(task);
    const branch = task.branch!;
    const r = await mergeTask({
      root: this.p.root,
      worktree: wt,
      branch,
      integration: cfg.integration_branch,
      message: `${taskId}: ${task.title}`,
      verify: async (dir) => {
        const res = await runChecks(dir, this.p.checks, { requiredOnly: true });
        const g = gateOutcome(res);
        return g.passed ? { ok: true } : { ok: false, detail: g.failedRequired.map((f) => `${f.checkId}: ${f.outputTail.split("\n").slice(-10).join("\n")}`).join("\n\n") };
      },
    });
    if (r.status === "merged") {
      this.p.emit("branch.merged", { branch, into: cfg.integration_branch, commit: r.commit }, { taskId });
      this.p.transition(taskId, "MERGED");
      await removeWorktree(this.p.root, taskId);
      this.p.emit("worktree.removed", { path: task.worktree ?? "" }, { taskId });
      this.kick();
    } else if (r.status === "conflict") {
      this.p.emit("merge.conflict", { branch, files: r.files }, { taskId });
      this.needsHuman(taskId, "merge conflict", { files: r.files });
    } else if (r.status === "checks_failed") {
      this.needsHuman(taskId, "required checks failed after rebase onto the integration branch", { detail: r.detail });
    } else {
      this.needsHuman(taskId, "the task branch has no changes to merge", {});
    }
  }

  // ── user actions ─────────────────────────────────────────────────────

  async pauseTask(taskId: string): Promise<void> {
    const l = this.live.get(taskId);
    if (l) return this.supervisor.stop(l.runId, "pause");
    const t = this.p.task(taskId);
    if (t.state === "QUEUED") this.p.transition(taskId, "PAUSED", "user");
  }

  resumeTask(taskId: string): void {
    const t = this.p.task(taskId);
    if (t.state === "PAUSED") this.p.transition(taskId, "QUEUED", "user resume");
    this.kick();
  }

  async pauseRole(role: string): Promise<void> {
    for (const w of this.p.store.workers.list(this.p.id)) {
      if (w.role !== role) continue;
      const l = [...this.live.values()].find((x) => x.workerId === w.id);
      if (l) await this.supervisor.stop(l.runId, "pause");
      this.p.setWorker(w.id, "PAUSED", { reason: "paused by user" });
    }
  }

  resumeRole(role: string): void {
    for (const w of this.p.store.workers.list(this.p.id)) if (w.role === role && w.state === "PAUSED") this.p.setWorker(w.id, "IDLE");
    this.kick();
  }

  async pauseAll(): Promise<void> {
    this.stop("paused by user");
    await Promise.all([...this.live.values()].map((l) => this.supervisor.stop(l.runId, "pause")));
  }

  async cancelTask(taskId: string): Promise<void> {
    const l = this.live.get(taskId);
    this.p.transition(taskId, "CANCELLED", "user");
    if (l) await this.supervisor.stop(l.runId, "cancel");
    await removeWorktree(this.p.root, taskId).catch(() => undefined);
  }

  /** `harness review --reject -m`: send the work back with a comment. */
  reject(taskId: string, comment: string): void {
    const t = this.p.task(taskId);
    const id = `REJ-${taskId}-${Date.now()}`;
    this.p.emit("approval.requested", { approvalId: id, category: "new_scope", context: `review of ${taskId}`, action: "merge" }, { taskId });
    this.p.emit("approval.denied", { approvalId: id, comment }, { taskId });
    this.requestRepair(t, "human");
    this.kick();
  }

  /** Events of interest for a task (for `review` and `task show`). */
  history(taskId: string): HarnessEvent[] {
    return this.p.store.events.list({ projectId: this.p.id, taskId });
  }
}
