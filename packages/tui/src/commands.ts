/** Slash commands for the chat bar. Pure: parsing and completion only; App runs them. */
export interface SlashCommand {
  name: string;
  args: string;
  desc: string;
}

export const COMMANDS: SlashCommand[] = [
  { name: "agents", args: "", desc: "who is doing what: tool, task, time, context, cost" },
  { name: "usage", args: "", desc: "usage limits per tool, with source and reset time" },
  { name: "switch", args: "<agent|team>", desc: "talk to one agent, or back to the whole team (or Tab)" },
  { name: "panes", args: "", desc: "every agent's live session side by side (esc back)" },
  { name: "zoom", args: "", desc: "the selected agent's live session full screen (esc back)" },
  { name: "windows", args: "", desc: "open a real terminal window per agent, each following its live session" },
  { name: "board", args: "", desc: "the team board (HARNESS.md): asks, who does what, what is done, notes" },
  { name: "fact", args: "[text | -n]", desc: "project facts every agent reads: list, add text, or -n to remove number n" },
  { name: "report", args: "", desc: "what the latest request cost per tool, and the quality ledger" },
  { name: "tasks", args: "", desc: "every task and its state" },
  { name: "task", args: "<title> [@agent]", desc: "add one task; harness picks the agent unless you name one" },
  { name: "plan", args: "<file.md>", desc: "split a document into draft tasks (no start)" },
  { name: "approve", args: "<T-n|A-n|all>", desc: "approve drafts or pending approvals" },
  { name: "run", args: "", desc: "start the scheduler" },
  { name: "pause", args: "[all]", desc: "pause the selected agent's task (or everything)" },
  { name: "resume", args: "[all]", desc: "resume the selected agent's task (or the scheduler)" },
  { name: "review", args: "[T-n]", desc: "checks, findings and files for a task" },
  { name: "diff", args: "[T-n]", desc: "full diff for a task" },
  { name: "accept", args: "[T-n]", desc: "merge a reviewed task into the integration branch" },
  { name: "land", args: "", desc: "bring finished work from the integration branch into your branch" },
  { name: "reject", args: "<comment>", desc: "send the selected agent's task back" },
  { name: "cancel", args: "[T-n]", desc: "cancel a task" },
  { name: "limits", args: "<route> <5h|7d|budget> <value>", desc: "cap a window or set a manual budget" },
  { name: "attach", args: "", desc: "open the selected agent in its real interactive CLI" },
  { name: "theme", args: "[neon|sunset|ocean|matrix|mono]", desc: "change the colors" },
  { name: "setup", args: "", desc: "rerun the agent setup wizard" },
  { name: "clear", args: "", desc: "clear this screen's notes" },
  { name: "help", args: "", desc: "how this works" },
  { name: "quit", args: "", desc: "close harness (agents keep working)" },
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
  const prefix = COMMANDS.filter((c) => c.name.startsWith(name));
  const hit = exact ?? (prefix.length === 1 ? prefix[0] : undefined);
  return { kind: "command", name: hit?.name ?? name, args: m[2]!.trim(), known: Boolean(hit) };
}

/** Commands matching what is typed so far ("/" alone lists all), while still typing the name. */
export function completions(text: string): SlashCommand[] {
  if (!text.startsWith("/") || /\s/.test(text)) return [];
  const p = text.slice(1).toLowerCase();
  return COMMANDS.filter((c) => c.name.startsWith(p));
}
