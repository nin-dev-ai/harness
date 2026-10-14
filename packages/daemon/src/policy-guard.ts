import fs from "node:fs";
import path from "node:path";
import type { ApprovalCategory, Task } from "@harness/core";
import { readTaskFile } from "@harness/config";
import {
  addedDependencies,
  checkScope,
  dependencyFiles,
  findApproval,
  nextApprovalId,
  protectedTouched,
  requiresApproval,
  unattendedDecision,
} from "@harness/policy";
import { failureSignature, type CheckResult } from "@harness/verify";
import { revertPaths, showFile } from "@harness/workspace";
import type { DispatchContext, GateContext, Guard, GuardDecision } from "./guards.js";
import type { ProjectRuntime } from "./project.js";

function synthetic(checkId: string, message: string): CheckResult {
  return { checkId, required: true, ok: false, exitCode: 1, durationMs: 0, timedOut: false, startError: null, outputTail: message, signature: failureSignature(checkId, message) };
}

/**
 * Policy outside any prompt: autonomy level, unattended dispatch per route,
 * fallback approval, write scope, protected paths, new dependencies.
 * Nothing an agent writes can change it; every denial is an event.
 */
export class PolicyGuard implements Guard {
  readonly name = "policy";

  constructor(
    private p: ProjectRuntime,
    private attended: () => boolean,
  ) {}

  private approvals() {
    return this.p.store.windows.approvals(this.p.id);
  }

  /** Find or create the approval for one task and one action. */
  request(taskId: string, category: ApprovalCategory | "unattended" | "fallback", action: string, context: string) {
    const existing = findApproval(this.approvals(), taskId, action);
    if (existing) return existing;
    const id = nextApprovalId(this.approvals());
    this.p.emit("approval.requested", { approvalId: id, category, context, action }, { taskId });
    return findApproval(this.approvals(), taskId, action)!;
  }

  private needs(taskId: string, category: Parameters<PolicyGuard["request"]>[1], action: string, context: string): GuardDecision {
    const a = this.request(taskId, category, action, context);
    if (a.state === "GRANTED") return { ok: true };
    if (a.state === "DENIED") return { ok: false, reason: "policy", detail: `${a.id} denied: ${context}` };
    return { ok: false, reason: "approval", detail: `waiting for approval ${a.id}: ${context}` };
  }

  canDispatch(ctx: DispatchContext): GuardDecision {
    const cfg = this.p.config;
    const { task, route } = ctx;
    if (cfg.policy.autonomy === "observe") return { ok: false, reason: "policy", detail: "autonomy: observe (nothing runs)" };

    if (cfg.policy.autonomy === "assisted" && ctx.kind === "implement" && this.p.store.runs.listByTask(this.p.id, task.id).length === 0) {
      const d = this.needs(task.id, "new_scope", "run", `assisted mode: approve ${task.id} to run`);
      if (!d.ok) return d;
    }

    const role = cfg.roles[ctx.kind === "review" ? "reviewer" : task.role];
    if (role && route !== role.route) {
      if (role.fallback === "none") return { ok: false, reason: "policy", detail: "fallback disabled" };
      if (role.fallback === "ask") {
        const d = this.needs(task.id, "fallback", `fallback:${route}:${task.attempts}`, `run ${task.id} on fallback route ${route} instead of ${role.route}`);
        if (!d.ok) return d;
      }
    }

    const hint = this.filesHint(task.id);
    const prot = protectedTouched(hint, cfg.policy.protected_paths);
    if (prot.length && requiresApproval(cfg, "protected_paths") && ctx.kind === "implement") {
      const d = this.needs(task.id, "protected_paths", "run-protected", `${task.id} expects to touch protected paths: ${prot.join(", ")}`);
      if (!d.ok) return d;
    }

    const u = unattendedDecision(cfg, route, ctx.attended);
    if (u.ok && ctx.attended) {
      // Someone is here now: earlier "may I run while you're away?" questions no longer apply.
      for (const a of this.approvals()) {
        if (a.taskId === task.id && a.state === "PENDING" && a.category === "unattended") {
          this.p.emit("approval.denied", { approvalId: a.id, comment: "superseded: dispatched while attended" }, { taskId: task.id });
        }
      }
    }
    if (!u.ok) {
      if (u.action === "deny") {
        this.p.emit("policy.denied", { rule: "unattended", detail: `unattended dispatch denied on route ${route}` }, { taskId: task.id });
        return { ok: false, reason: "policy", detail: `unattended dispatch denied on ${route}` };
      }
      return this.needs(task.id, "unattended", `unattended:${route}:${ctx.kind}:${task.attempts}`, `dispatch ${task.id} on ${route} while nobody is attached`);
    }
    return { ok: true };
  }

  private filesHint(taskId: string): string[] {
    try {
      return readTaskFile(this.p.root, taskId).front.files_hint;
    } catch {
      return [];
    }
  }

  private allowsDeps(task: Task): boolean {
    try {
      if (readTaskFile(this.p.root, task.id).front.allow_new_dependencies) return true;
    } catch {
      // no task file
    }
    return findApproval(this.approvals(), task.id, "new_dependencies")?.state === "GRANTED";
  }

  async beforeGate(ctx: GateContext): Promise<CheckResult[]> {
    const cfg = this.p.config;
    const role = cfg.roles[ctx.task.role]!;
    const env = { taskId: ctx.task.id, runId: ctx.runId };
    const out: CheckResult[] = [];

    const scope = checkScope(ctx.changedFiles, role.paths_allow, role.paths_deny);
    if (scope.violations.length) {
      const files = scope.violations.map((v) => v.file);
      await revertPaths(ctx.worktree, files, ctx.base);
      const lines = scope.violations.map((v) => `${v.file} (${v.why === "denied" ? "in paths_deny" : "outside paths_allow"})`);
      this.p.emit("policy.denied", { rule: "write_scope", detail: `reverted ${files.length} out-of-scope file(s)`, files }, env);
      out.push(synthetic("scope", `These changes were outside the role's write scope and have been reverted:\n${lines.join("\n")}\nAllowed: ${(role.paths_allow ?? ["**"]).join(", ")}`));
    }

    const prot = protectedTouched(scope.allowed, cfg.policy.protected_paths);
    if (prot.length) {
      if (!this.attended()) {
        await revertPaths(ctx.worktree, prot, ctx.base);
        this.p.emit("policy.denied", { rule: "protected_paths", detail: "protected paths changed while unattended; reverted", files: prot }, env);
        out.push(synthetic("protected-paths", `Protected paths cannot change in unattended mode and were reverted:\n${prot.join("\n")}`));
      } else if (requiresApproval(cfg, "protected_paths")) {
        this.request(ctx.task.id, "protected_paths", "merge", `${ctx.task.id} changes protected paths: ${prot.join(", ")}`);
      }
    }

    // Changing a contract other tasks build on (after it exists) needs a human.
    const contracts = this.contractRefs(ctx.task.id);
    for (const f of scope.allowed) {
      if (!contracts.has(f)) continue;
      if ((await showFile(ctx.worktree, ctx.base, f)) === undefined) continue; // creating it is fine
      this.request(ctx.task.id, "new_scope", "contract-change", `${ctx.task.id} changes shared contract ${f} used by ${[...contracts.get(f)!].join(", ")}`);
    }

    const manifests = dependencyFiles(scope.allowed).filter((f) => !/lock|\.sum$/.test(f));
    if (manifests.length && !this.allowsDeps(ctx.task)) {
      const added: string[] = [];
      for (const f of manifests) {
        const after = fs.existsSync(path.join(ctx.worktree, f)) ? fs.readFileSync(path.join(ctx.worktree, f), "utf8") : undefined;
        added.push(...addedDependencies(f, await showFile(ctx.worktree, ctx.base, f), after).map((d) => `${d} (${f})`));
      }
      if (added.length) {
        if (requiresApproval(cfg, "new_dependencies")) this.request(ctx.task.id, "new_dependencies", "new_dependencies", `${ctx.task.id} adds dependencies: ${added.join(", ")}`);
        this.p.emit("policy.denied", { rule: "new_dependencies", detail: `adds ${added.join(", ")}` }, env);
        out.push(synthetic("dependencies", `This change adds dependencies, which this task does not allow:\n${added.join("\n")}\nRemove them, or ask a human to approve them.`));
      }
    }
    return out;
  }

  /** contract_ref file → tasks (other than `except`) that build on it. */
  private contractRefs(except: string): Map<string, Set<string>> {
    const out = new Map<string, Set<string>>();
    for (const t of this.p.tasks()) {
      if (t.id === except || t.state === "CANCELLED") continue;
      let ref: string | undefined;
      try {
        ref = readTaskFile(this.p.root, t.id).front.contract_ref;
      } catch {
        ref = undefined;
      }
      if (ref) out.set(ref, new Set([...(out.get(ref) ?? []), t.id]));
    }
    return out;
  }

  mayAutoMerge(p: ProjectRuntime, task: Task, files: string[]): boolean {
    if (p.config.policy.autonomy !== "approved-scope") return false;
    const contract = findApproval(this.approvals(), task.id, "contract-change");
    if (contract && contract.state !== "GRANTED") return false;
    if (protectedTouched(files, p.config.policy.protected_paths).length && requiresApproval(p.config, "protected_paths")) {
      return findApproval(this.approvals(), task.id, "merge")?.state === "GRANTED";
    }
    return true;
  }
}
