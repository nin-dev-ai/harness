import type { ApprovalCategory, HarnessConfig } from "@harness/core";

export interface ApprovalLike {
  id: string;
  taskId: string | null;
  category: string;
  action: string | null;
  state: "PENDING" | "GRANTED" | "DENIED";
}

/** Does this category need a human in this project's configuration? */
export function requiresApproval(config: HarnessConfig, category: ApprovalCategory): boolean {
  return config.policy.require_approval.includes(category);
}

/** An approval applies to exactly one task and one action, and is never reused for another. */
export function findApproval(list: readonly ApprovalLike[], taskId: string, action: string): ApprovalLike | undefined {
  return [...list].reverse().find((a) => a.taskId === taskId && a.action === action);
}

export function nextApprovalId(existing: readonly { id: string }[]): string {
  let max = 0;
  for (const a of existing) {
    const m = /^A-(\d+)$/.exec(a.id);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `A-${max + 1}`;
}
