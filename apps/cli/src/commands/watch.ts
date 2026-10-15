import type { Command } from "commander";
import type { HarnessEvent } from "@harness/core";
import type { StatusSnapshot } from "@harness/daemon";
import { toEntry, type Entry } from "@harness/tui";
import type { Ctx } from "../ctx.js";
import type { Style } from "../format.js";
import { CliExit, EXIT } from "../io.js";
import { openProject } from "./_client.js";

/** One agent session line, like the panel's live pane. */
const clipTo = (x: string, n: number) => (x.length > n ? `${x.slice(0, n - 1)}…` : x);

export function watchLine(e: Entry, s: Style): string {
  const t = e.ts.slice(11, 19);
  const text = clipTo(e.text.replace(/\s+/g, " ").trim(), e.kind === "say" ? 400 : 200);
  e = e.detail ? { ...e, detail: clipTo(e.detail.replace(/\s+/g, " "), 90) } : e;
  switch (e.kind) {
    case "say":
      return `${s.dim(t)} ${text}`;
    case "tool":
      return `${s.dim(t)} ${s.bold(`⏺ ${text}`)}${e.detail ? s.dim(` ${e.detail}`) : ""}`;
    case "edit":
      return `${s.dim(t)} ${s.green(`✎ ${text}`)}`;
    case "check":
      return `${s.dim(t)} ${text.startsWith("✓") ? s.green(text) : s.red(text)}${e.detail ? s.dim(` ${e.detail}`) : ""}`;
    case "ok":
      return `${s.dim(t)} ${s.green(`✓ ${text}`)}`;
    case "err":
      return `${s.dim(t)} ${s.red(`✗ ${text}`)}`;
    case "warn":
      return `${s.dim(t)} ${s.yellow(`! ${text}`)}`;
    case "run":
      return `${s.dim(t)} ${s.bold(`── ${text}`)}${e.detail ? s.dim(` ${e.detail}`) : ""}`;
    default:
      return `${s.dim(t)} ${s.dim(text)}`;
  }
}

export function register(program: Command, ctx: Ctx): void {
  program
    .command("watch <agent>")
    .description("Follow one agent's live session in this terminal (e.g. harness watch backend-1). Ctrl-C stops watching; the agent keeps working")
    .action(async (agent: string) => {
      const sess = await openProject(ctx.io, ctx.dir());
      const s = ctx.s();
      try {
        const snap = await sess.call<StatusSnapshot>("status");
        const w = snap.workers.find((x) => x.id === agent) ?? snap.workers.find((x) => x.role === agent);
        if (!w) throw new CliExit(EXIT.usage, `no agent "${agent}". Agents: ${snap.workers.map((x) => x.id).join(", ")}`);
        ctx.print(s.bold(`✦ harness · ${w.id}`) + s.dim(` · ${w.vendor}${w.route ? ` (${w.route})` : ""} · ${snap.project.name}`));
        // Its current (or most recent) task: show the story so far, then follow live.
        let task: string | null = w.taskId ?? [...snap.tasks].filter((t) => t.role === w.role).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id ?? null;
        const backlog = async (id: string) => {
          ctx.print(s.dim(`${id} · ${snap.tasks.find((t) => t.id === id)?.title ?? ""}`));
          for (const e of (await sess.call<HarnessEvent[]>("events.list", { taskId: id })).slice(-40)) {
            const en = toEntry(e);
            if (en) ctx.print(watchLine(en, s));
          }
        };
        if (task) await backlog(task);
        else ctx.print(s.dim("waiting for work…"));
        await new Promise<void>((resolve) => {
          sess.client.onEvent((e) => {
            if (e.type === "worker.assigned" && e.workerId === w.id && e.taskId && e.taskId !== task) {
              task = e.taskId;
              ctx.print(s.bold(`\n${task}`));
            }
            if (!task || e.taskId !== task) return;
            const en = toEntry(e);
            if (en) ctx.print(watchLine(en, s));
          });
          void sess.client.call("events.subscribe", { projectId: sess.projectId });
          process.once("SIGINT", () => resolve());
        });
      } finally {
        sess.close();
      }
    });
}
