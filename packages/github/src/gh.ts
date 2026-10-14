import { execa } from "execa";

export interface GhResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Runs a command (argv, no shell). Injectable so tests never touch GitHub. */
export type Runner = (cmd: string, args: string[], opts: { cwd: string; input?: string }) => Promise<GhResult>;

/** Subcommands this package will never run: merging is always the user's action. */
const FORBIDDEN = [["pr", "merge"], ["repo", "delete"], ["api"]];

export const execaRunner: Runner = async (cmd, args, opts) => {
  const r = await execa(cmd, args, { cwd: opts.cwd, reject: false, ...(opts.input !== undefined ? { input: opts.input } : { stdin: "ignore" }) });
  return { stdout: String(r.stdout ?? ""), stderr: String(r.stderr ?? ""), exitCode: r.exitCode ?? 1 };
};

export class GhError extends Error {
  constructor(
    readonly args: string[],
    readonly result: GhResult,
  ) {
    super(`${args.join(" ")} failed: ${result.stderr.trim() || result.stdout.trim()}`);
  }
}

/** Run `gh` with a guard against forbidden subcommands. */
export async function gh(run: Runner, cwd: string, args: string[], input?: string): Promise<string> {
  for (const f of FORBIDDEN) if (f.every((x, i) => args[i] === x)) throw new Error(`refusing to run gh ${f.join(" ")}`);
  const r = await run("gh", args, { cwd, ...(input !== undefined ? { input } : {}) });
  if (r.exitCode !== 0) throw new GhError(["gh", ...args], r);
  return r.stdout.trim();
}

export async function ghAvailable(run: Runner, cwd: string): Promise<{ ok: boolean; detail: string }> {
  const v = await run("gh", ["--version"], { cwd }).catch(() => ({ exitCode: 127, stdout: "", stderr: "gh not found" }));
  if (v.exitCode !== 0) return { ok: false, detail: "gh is not installed (https://cli.github.com)" };
  const a = await run("gh", ["auth", "status"], { cwd });
  if (a.exitCode !== 0) return { ok: false, detail: "gh is not signed in: run `gh auth login`" };
  return { ok: true, detail: v.stdout.split("\n")[0] ?? "gh" };
}
