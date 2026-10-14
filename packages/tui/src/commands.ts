/** Commands for the `/` command line. Pure: parsing and completion only; the panel runs them. */
export interface SlashCommand {
  name: string;
  args: string;
  desc: string;
}

export const COMMANDS: SlashCommand[] = [
  { name: "task", args: "<title> @role", desc: "add a task for a role (approved, runs when a worker is free)" },
  { name: "plan", args: "<file.md>", desc: "planner splits a document into draft tasks" },
  { name: "approve", args: "<T-n|A-n|all>", desc: "approve drafts or pending approvals" },
  { name: "msg", args: "<text>", desc: "send a note to the selected agent's task" },
  { name: "run", args: "", desc: "start the scheduler" },
  { name: "pause", args: "[all]", desc: "pause the selected agent's task (or everything)" },
  { name: "resume", args: "[all]", desc: "resume the selected agent's task (or the scheduler)" },
  { name: "review", args: "[T-n]", desc: "checks, findings and files for a task" },
  { name: "diff", args: "[T-n]", desc: "full diff for a task" },
  { name: "accept", args: "[T-n]", desc: "merge a reviewed task into the integration branch" },
  { name: "reject", args: "<comment>", desc: "send the selected task back with a comment" },
  { name: "cancel", args: "[T-n]", desc: "cancel a task" },
  { name: "tasks", args: "", desc: "every task and its state" },
  { name: "usage", args: "", desc: "usage windows per tool, with source and reset time" },
  { name: "limits", args: "<route> <5h|7d|budget> <value>", desc: "cap a window or set a manual budget" },
  { name: "attach", args: "", desc: "take over the selected agent in its own CLI" },
  { name: "help", args: "", desc: "keys and commands" },
  { name: "quit", args: "", desc: "close the panel (agents keep working)" },
  { name: "stop", args: "", desc: "stop every agent and the daemon" },
];

export type Parsed = { kind: "empty" } | { kind: "command"; name: string; args: string; known: boolean };

export function parseInput(text: string): Parsed {
  const t = text.trim().replace(/^\//, "");
  if (!t) return { kind: "empty" };
  const m = /^(\S+)\s*([\s\S]*)$/.exec(t)!;
  const name = m[1]!.toLowerCase();
  const exact = COMMANDS.find((c) => c.name === name);
  const prefix = COMMANDS.filter((c) => c.name.startsWith(name));
  const hit = exact ?? (prefix.length === 1 ? prefix[0] : undefined);
  return { kind: "command", name: hit?.name ?? name, args: m[2]!.trim(), known: Boolean(hit) };
}

/** Commands matching the name typed so far (empty input lists all). */
export function completions(text: string): SlashCommand[] {
  const t = text.replace(/^\//, "");
  if (/\s/.test(t)) return [];
  return COMMANDS.filter((c) => c.name.startsWith(t.toLowerCase()));
}
