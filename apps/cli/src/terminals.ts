import { spawn } from "node:child_process";

/**
 * One real terminal window per agent, each running `harness watch <agent>`.
 * macOS only (Terminal or iTerm through osascript); elsewhere the commands are
 * returned for the person to run in their own terminals.
 */

const quoteSh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const quoteAs = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/** The shell command that follows one agent from the project folder. */
export function watchCommand(root: string, program: string[], agent: string): string {
  return `cd ${quoteSh(root)} && ${program.map(quoteSh).join(" ")} watch ${quoteSh(agent)}`;
}

/** AppleScript that opens one window running `cmd` in the given terminal app. */
export function terminalScript(app: "Terminal" | "iTerm", cmd: string): string {
  return app === "iTerm"
    ? `tell application "iTerm" to create window with default profile command ${quoteAs(`/bin/zsh -lc ${quoteSh(cmd)}`)}`
    : `tell application "Terminal"\n  do script ${quoteAs(cmd)}\n  activate\nend tell`;
}

export interface OpenWindowsResult {
  opened: string[];
  /** Commands to run by hand when windows cannot be opened here. */
  manual: string[];
}

export async function openAgentWindows(
  root: string,
  agents: string[],
  env: NodeJS.ProcessEnv = process.env,
  platform = process.platform,
  run: (args: string[]) => Promise<boolean> = osascript,
): Promise<OpenWindowsResult> {
  const program = [process.execPath, process.argv[1] ?? "harness"];
  const cmds = agents.map((a) => ({ agent: a, cmd: watchCommand(root, program, a) }));
  if (platform !== "darwin") return { opened: [], manual: cmds.map((c) => c.cmd) };
  const app = env.TERM_PROGRAM === "iTerm.app" ? "iTerm" : "Terminal";
  const opened: string[] = [];
  const manual: string[] = [];
  for (const c of cmds) {
    if (await run(["-e", terminalScript(app, c.cmd)])) opened.push(c.agent);
    else manual.push(c.cmd);
  }
  return { opened, manual };
}

function osascript(args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const p = spawn("osascript", args, { stdio: "ignore" });
    p.on("error", () => resolve(false));
    p.on("exit", (code) => resolve(code === 0));
  });
}
