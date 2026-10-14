import { execa } from "execa";
import path from "node:path";
import type { ProjectRuntime } from "./project.js";

/**
 * Optional mirror of each worker into a tmux pane (`ui.tmux: true`). Best
 * effort: if tmux is missing or fails, nothing else is affected.
 */
export class TmuxMirror {
  private available: boolean | undefined;
  private panes = new Map<string, string>();

  constructor(private p: ProjectRuntime) {}

  private session(): string {
    return `harness-${this.p.config.project}`.replace(/[^A-Za-z0-9_-]/g, "-");
  }

  private async tmux(args: string[]): Promise<string | undefined> {
    const r = await execa("tmux", args, { reject: false, stdin: "ignore" }).catch(() => undefined);
    return r && r.exitCode === 0 ? String(r.stdout) : undefined;
  }

  async isAvailable(): Promise<boolean> {
    this.available ??= (await this.tmux(["-V"])) !== undefined;
    return this.available;
  }

  /** Show a run's output in the worker's pane (replacing the previous run's). */
  async mirror(workerId: string, runId: string): Promise<void> {
    if (!this.p.config.ui.tmux || !(await this.isAvailable())) return;
    const s = this.session();
    if ((await this.tmux(["has-session", "-t", s])) === undefined) await this.tmux(["new-session", "-d", "-s", s, "-n", "harness"]);
    const old = this.panes.get(workerId);
    if (old) await this.tmux(["kill-pane", "-t", old]);
    const file = path.join(this.p.runDir(runId), "events.jsonl");
    const pane = await this.tmux(["split-window", "-t", s, "-P", "-F", "#{pane_id}", "-d", `printf '\\033]2;${workerId} ${runId}\\033\\\\'; touch '${file}'; tail -n +1 -f '${file}'`]);
    if (pane) {
      this.panes.set(workerId, pane.trim());
      await this.tmux(["select-layout", "-t", s, "tiled"]);
    }
  }
}
