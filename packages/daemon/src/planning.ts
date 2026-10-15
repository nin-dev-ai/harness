import fs from "node:fs";
import path from "node:path";
import { HarnessError, type Task } from "@harness/core";
import { editHarnessConfig } from "@harness/config";
import {
  buildDispatchPrompt,
  buildPlanPrompt,
  buildPlanRetryPrompt,
  buildRolesPrompt,
  PLAN_JSON_SCHEMA,
  ROLES_JSON_SCHEMA,
  topoOrder,
  validatePlan,
  validateRoles,
  type PlannedTask,
  type PlanOutput,
  type RoleInfo,
  type RolesProposal,
} from "@harness/planner";
import { protectedTouched } from "@harness/policy";
import { git } from "@harness/workspace";
import matcher from "./glob.js";
import type { ProjectRuntime } from "./project.js";
import type { RunOutcome, Supervisor } from "./supervisor.js";

/** A short, deterministic picture of the repo for planning prompts. */
export async function repoSummary(root: string): Promise<string> {
  const files = (await git(root, ["ls-files"])).split("\n").filter(Boolean);
  const dirs = new Map<string, number>();
  for (const f of files) {
    const parts = f.split("/");
    const d = parts.length > 2 ? parts.slice(0, 2).join("/") + "/" : parts.length === 2 ? parts[0] + "/" : f;
    dirs.set(d, (dirs.get(d) ?? 0) + 1);
  }
  const tree = [...dirs.entries()].sort().slice(0, 80).map(([d, n]) => (d.endsWith("/") ? `${d} (${n} files)` : d));
  let readme = "";
  for (const r of ["README.md", "README", "readme.md"]) {
    const p = path.join(root, r);
    if (fs.existsSync(p)) {
      readme = fs.readFileSync(p, "utf8").split("\n").slice(0, 40).join("\n");
      break;
    }
  }
  return `${files.length} tracked files.\n${tree.join("\n")}${readme ? `\n\nREADME (start):\n${readme}` : ""}`;
}

const PSEUDO = { plan: "PLAN", roles: "ROLES" } as const;

/** Does a write role's folder scope cover a file or folder hint (`src/ui/**` counts as `src/ui/x`)? */
function covers(role: RoleInfo, hint: string): boolean {
  if (!role.pathsAllow) return true;
  const probe = hint.replace(/\*\*?/g, "x");
  return role.pathsAllow.some((g) => matcher(g)(probe));
}

export interface RoleMove {
  key: string;
  from: string;
  to: string;
  files: string[];
}

/**
 * Deterministic role fix-up after planning: a task whose files fall outside
 * its role's folders would have its edits reverted, so it moves to the write
 * role that may change all of them (the one with the fewest tasks so far).
 * Tasks no role covers are left alone; policy reports them.
 */
export function fitRoles(tasks: PlannedTask[], roles: RoleInfo[]): { tasks: PlannedTask[]; moves: RoleMove[] } {
  const writers = roles.filter((r) => r.mode === "write");
  const load = new Map(writers.map((r) => [r.name, 0]));
  const moves: RoleMove[] = [];
  const out = tasks.map((t) => {
    const own = writers.find((r) => r.name === t.role);
    const fits = (r: RoleInfo) => t.files_hint.every((f) => covers(r, f));
    let role = t.role;
    if (own && !fits(own)) {
      const better = writers.filter(fits).sort((a, b) => load.get(a.name)! - load.get(b.name)!)[0];
      if (better) {
        moves.push({ key: t.key, from: t.role, to: better.name, files: t.files_hint.filter((f) => !covers(own, f)) });
        role = better.name;
      }
    }
    load.set(role, (load.get(role) ?? 0) + 1);
    return role === t.role ? t : { ...t, role };
  });
  return { tasks: out, moves };
}

/**
 * Runs the planner role headless (read-only, structured output), validates
 * the result, retries once with the validation errors, then fails with a typed error.
 */
export class Planner {
  constructor(
    private p: ProjectRuntime,
    private supervisor: Supervisor,
  ) {}

  private plannerRole() {
    const role = this.p.config.roles.planner;
    if (!role) throw new HarnessError("CONFIG", 'no "planner" role in harness.yaml');
    return role;
  }

  private async run(kind: "plan" | "roles", prompt: string, jsonSchema: object, resumeSessionId?: string): Promise<RunOutcome> {
    const role = this.plannerRole();
    const workerId = "planner-1";
    const { runId, done } = this.supervisor.start(this.p, {
      taskId: PSEUDO[kind], workerId, route: role.route, kind: "plan", prompt, cwd: this.p.root, mode: "readonly", allowedPaths: [],
      timeoutMs: this.p.config.limits.max_task_minutes * 60_000, jsonSchema, ...(resumeSessionId ? { resumeSessionId } : {}),
    });
    this.p.setWorker(workerId, "RUNNING", { currentRun: runId });
    try {
      return await done;
    } finally {
      this.p.setWorker(workerId, "IDLE");
    }
  }

  private roleInfo(): RoleInfo[] {
    return Object.entries(this.p.config.roles).map(([name, r]) => ({ name, mode: r.mode, instructions: r.instructions, pathsAllow: r.paths_allow, concurrency: r.concurrency }));
  }

  /** Two attempts at most: the first, and one retry carrying the validation errors. */
  private async twoTries<T>(
    kind: "plan" | "roles",
    prompt: string,
    schema: object,
    validate: (o: RunOutcome) => { ok: true; value: T } | { ok: false; errors: string[] },
  ): Promise<{ value: T; attempts: number }> {
    let outcome = await this.run(kind, prompt, schema);
    let v = validate(outcome);
    if (v.ok) return { value: v.value, attempts: 1 };
    this.p.emit("plan.invalid", { errors: v.errors, attempt: 1 });
    const retry = buildPlanRetryPrompt(v.errors);
    outcome = outcome.sessionId ? await this.run(kind, retry, schema, outcome.sessionId) : await this.run(kind, `${prompt}\n\n${retry}`, schema);
    v = validate(outcome);
    if (v.ok) return { value: v.value, attempts: 2 };
    this.p.emit("plan.invalid", { errors: v.errors, attempt: 2 });
    throw new HarnessError("VALIDATION", `planner output was invalid twice:\n${v.errors.map((e) => `  - ${e}`).join("\n")}`, { errors: v.errors });
  }

  private outcomeValue<T>(o: RunOutcome, check: (structured: unknown, text: string) => { ok: true; value: T } | { ok: false; errors: string[] }) {
    if (!o.result) return { ok: false as const, errors: [`planner run failed: ${o.error?.message ?? o.state}`] };
    return check(o.result.structured, o.result.summary);
  }

  /**
   * `harness plan <file>`: DRAFT tasks with roles and dependencies. Nothing runs until approved.
   * `chat`: a team chat message, split into one parallel mini prompt per agent.
   */
  async plan(document: string, source: string, o: { chat?: boolean } = {}): Promise<{ summary: string; tasks: Task[]; attempts: number; needsApproval: string[] }> {
    this.p.emit("plan.requested", { source });
    const roles = this.roleInfo();
    const prompt = (o.chat ? buildDispatchPrompt : buildPlanPrompt)({
      document, roles, repo: await repoSummary(this.p.root),
      existing: this.p.tasks().filter((t) => t.state !== "CANCELLED").map((t) => ({ id: t.id, title: t.title, role: t.role, state: t.state })),
    });
    const { value: raw, attempts } = await this.twoTries<PlanOutput>("plan", prompt, PLAN_JSON_SCHEMA, (o) =>
      this.outcomeValue(o, (s, t) => {
        const r = validatePlan(s, t, roles);
        return r.ok ? { ok: true, value: r.plan } : r;
      }),
    );
    const fitted = fitRoles(raw.tasks, roles);
    for (const m of fitted.moves) this.p.emit("plan.reassigned", { ...m });
    const plan = { ...raw, tasks: fitted.tasks };
    const ids = new Map<string, string>();
    const created: Task[] = [];
    const needsApproval: string[] = [];
    for (const t of topoOrder(plan.tasks)) {
      const task = this.p.createTask({
        title: t.title, role: t.role, size: t.size, dependsOn: t.depends_on.map((k) => ids.get(k)!), body: t.description,
        acceptance: t.acceptance, filesHint: t.files_hint, ...(t.contract_ref ? { contractRef: t.contract_ref } : {}), state: "DRAFT",
      });
      ids.set(t.key, task.id);
      created.push(task);
      if (protectedTouched(t.files_hint, this.p.config.policy.protected_paths).length) needsApproval.push(task.id);
    }
    this.p.emit("plan.drafted", { taskIds: created.map((t) => t.id) });
    return { summary: plan.summary, tasks: created, attempts, needsApproval };
  }

  /** `harness roles propose`: a proposal only; `apply` writes it after the user agrees. */
  async proposeRoles(document: string): Promise<RolesProposal & { attempts: number }> {
    const routes = Object.entries(this.p.config.routes).map(([name, r]) => ({ name, vendor: r.vendor, auth: r.auth, model: r.model ?? null }));
    const prompt = buildRolesPrompt({ routes, repo: await repoSummary(this.p.root), document });
    const { value, attempts } = await this.twoTries<RolesProposal>("roles", prompt, ROLES_JSON_SCHEMA, (o) =>
      this.outcomeValue(o, (s, t) => {
        const r = validateRoles(s, t, routes.map((x) => x.name));
        return r.ok ? { ok: true, value: r.proposal } : r;
      }),
    );
    return { ...value, attempts };
  }

  /** Write approved roles into harness.yaml (validated before it is written). */
  applyRoles(proposal: RolesProposal): void {
    editHarnessConfig(this.p.root, (doc) => {
      for (const r of proposal.roles) {
        doc.setIn(["roles", r.name], doc.createNode({
          route: r.route, mode: r.mode, ...(r.paths_allow ? { paths_allow: r.paths_allow } : {}), ...(r.instructions ? { instructions: r.instructions } : {}),
          ...(r.name === "reviewer" ? { independent_of: proposal.roles.filter((x) => x.mode === "write").map((x) => x.name) } : {}),
        }));
      }
    });
    this.p.load();
    this.p.ensureWorkers();
    this.p.emit("config.changed", { file: "harness.yaml", summary: `roles applied: ${proposal.roles.map((r) => r.name).join(", ")}` });
  }
}
