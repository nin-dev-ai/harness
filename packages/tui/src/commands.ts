/** Slash commands for the chat bar. Pure: parsing and completion only; App runs them. */
export interface SlashCommand {
  name: string;
  args: string;
  desc: string;
}

export const COMMANDS: SlashCommand[] = [
  { name: "help", args: "", desc: "everything you can type" },
  { name: "switch", args: "<agent|task>", desc: "show another agent or task (or Tab)" },
  { name: "agents", args: "", desc: "list agents and what they are doing" },
  { name: "task", args: "<title> [@role]", desc: "new task for the current (or @named) role, approved" },
  { name: "plan", args: "<file.md>", desc: "planner splits a PRD into draft tasks" },
  { name: "approve", args: "[T-n|A-n|all]", desc: "approve drafts or pending approvals" },
  { name: "run", args: "", desc: "start the scheduler" },
  { name: "pause", args: "[all]", desc: "pause this agent's task (or everything)" },
  { name: "resume", args: "[all]", desc: "resume this agent's task (or the scheduler)" },
  { name: "review", args: "[T-n]", desc: "checks, findings and changes for a task" },
  { name: "diff", args: "[T-n]", desc: "full diff for a task" },
  { name: "accept", args: "[T-n]", desc: "merge a reviewed task into the integration branch" },
  { name: "reject", args: "<comment>", desc: "send the current task back with a comment" },
  { name: "usage", args: "", desc: "every usage window, with source and reset time" },
  { name: "limits", args: "<route> <5h|7d|budget> <value>", desc: "cap a window or set a manual budget" },
  { name: "burst", args: "[on|off]", desc: "toggle burst mode" },
  { name: "attach", args: "", desc: "take over this agent in its own CLI" },
  { name: "cancel", args: "[T-n]", desc: "cancel a task" },
  { name: "theme", args: "<neon|sunset|matrix|ocean|agnoster|mono>", desc: "change the look" },
  { name: "clear", args: "", desc: "clear the screen's history" },
  { name: "quit", args: "", desc: "close the UI (agents keep working)" },
  { name: "stop", args: "", desc: "stop every agent and the daemon" },
];

export type Parsed = { kind: "empty" } | { kind: "command"; name: string; args: string; known: boolean } | { kind: "message"; text: string };

export function parseInput(text: string): Parsed {
  const t = text.trim();
  if (!t) return { kind: "empty" };
  if (!t.startsWith("/")) return { kind: "message", text: t };
  const m = /^\/(\S*)\s*([\s\S]*)$/.exec(t)!;
  const name = m[1]!.toLowerCase();
  const exact = COMMANDS.find((c) => c.name === name);
  const unique = exact ?? (COMMANDS.filter((c) => c.name.startsWith(name)).length === 1 ? COMMANDS.find((c) => c.name.startsWith(name)) : undefined);
  return { kind: "command", name: unique?.name ?? name, args: m[2]!.trim(), known: Boolean(unique) };
}

/** Commands matching what is typed so far ("/" alone lists all), while still typing the name. */
export function completions(text: string): SlashCommand[] {
  if (!text.startsWith("/") || /\s/.test(text)) return [];
  const p = text.slice(1).toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(p));
}
