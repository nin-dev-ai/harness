import fs from "node:fs";
import path from "node:path";
import { systemClock, type Clock, type HarnessEvent } from "@harness/core";
import { Store } from "@harness/storage";
import { createAdapter } from "@harness/adapters";
import { isGitRepo, repoRoot } from "@harness/workspace";
import { acquireDaemonLock } from "./lock.js";
import { homePaths, type HomePaths } from "./paths.js";
import { ProjectRuntime, type AdapterFactory } from "./project.js";
import { recoverProject } from "./recovery.js";
import { RpcServer, type RpcHandler } from "./server.js";
import { Supervisor } from "./supervisor.js";

export const DAEMON_VERSION = "0.1.0";

export interface DaemonOptions {
  home: string;
  clock?: Clock;
  adapterFactory?: AdapterFactory;
  /** Environment runs inherit from (filtered). */
  env?: NodeJS.ProcessEnv;
  /** Skip the socket server (in-process tests). */
  noServer?: boolean;
}

/** Extension point: the engine (scheduler + outer loop) registers its RPC methods and lifecycle. */
export interface DaemonPlugin {
  handlers(d: Daemon): Record<string, RpcHandler>;
  onProjectOpen?(p: ProjectRuntime): void | Promise<void>;
  stop?(): Promise<void>;
}

/**
 * The long-running process that owns all state. Clients (CLI, UI) talk to it
 * over a Unix socket and hold no state; closing them never stops work.
 */
export class Daemon {
  readonly paths: HomePaths;
  readonly store: Store;
  readonly clock: Clock;
  readonly supervisor: Supervisor;
  readonly projects = new Map<string, ProjectRuntime>();
  private server?: RpcServer;
  private release?: () => void;
  private plugins: DaemonPlugin[] = [];
  private adapterFactory: AdapterFactory;
  private stopping = false;
  private stopWaiters: (() => void)[] = [];

  constructor(readonly opts: DaemonOptions) {
    this.paths = homePaths(opts.home);
    fs.mkdirSync(this.paths.home, { recursive: true });
    this.clock = opts.clock ?? systemClock;
    this.store = new Store(this.paths.db);
    this.supervisor = new Supervisor(opts.env ?? process.env);
    this.adapterFactory = opts.adapterFactory ?? ((name, route) => createAdapter(name, route));
  }

  use(plugin: DaemonPlugin): this {
    this.plugins.push(plugin);
    return this;
  }

  async start(): Promise<void> {
    if (!this.opts.noServer) this.release = acquireDaemonLock(this.paths.pid);
    this.emitSystem("daemon.started", { pid: process.pid, version: DAEMON_VERSION });
    // Reopen every project the log knows about, so recovery runs before anything else.
    for (const e of this.store.events.list({ types: ["project.initialized"] })) {
      if (e.type !== "project.initialized" || this.projects.has(e.projectId)) continue;
      if (fs.existsSync(path.join(e.payload.path, "harness.yaml"))) {
        try {
          await this.openProject(e.payload.path);
        } catch {
          // A project whose config no longer loads is skipped until opened again.
        }
      }
    }
    if (!this.opts.noServer) {
      this.server = new RpcServer(this.handlers(), (l) => this.store.subscribe(l));
      await this.server.listen(this.paths.sock);
    }
  }

  private emitSystem(type: "daemon.started" | "daemon.stopped", payload: Record<string, unknown>): void {
    const ts = this.clock.now().toISOString();
    this.store.append({ ts, projectId: "_system", type, payload } as HarnessEvent);
  }

  /** Open (or return) the project whose repo contains `dir`. Runs recovery on first open. */
  async openProject(dir: string): Promise<ProjectRuntime> {
    if (!(await isGitRepo(dir))) throw Object.assign(new Error(`${dir} is not a git repository`), { code: "VALIDATION" });
    const root = fs.realpathSync(await repoRoot(dir));
    for (const p of this.projects.values()) if (p.root === root) return p;
    const p = new ProjectRuntime(root, this.store, this.clock, this.adapterFactory);
    const existing = this.projects.get(p.id);
    if (existing) return existing;
    p.initialize();
    this.projects.set(p.id, p);
    await recoverProject(p);
    for (const pl of this.plugins) await pl.onProjectOpen?.(p);
    return p;
  }

  project(id: string): ProjectRuntime {
    const p = this.projects.get(id);
    if (!p) throw Object.assign(new Error(`project ${id} is not open`), { code: "NOT_FOUND" });
    return p;
  }

  /** Cancel every run, kill every child process group, close the socket. */
  async stop(reason = "requested"): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    for (const pl of this.plugins) await pl.stop?.();
    await this.supervisor.stopAll("cancel");
    this.emitSystem("daemon.stopped", { reason });
    await this.server?.close();
    this.store.close();
    this.release?.();
    for (const w of this.stopWaiters.splice(0)) w();
  }

  /** Resolves when the daemon stops (used by the daemon entry point). */
  stopped(): Promise<void> {
    return new Promise((r) => this.stopWaiters.push(r));
  }

  /** Test hook: drop everything on the floor like a SIGKILL would (no cleanup, children left running). */
  crashForTest(): void {
    this.stopping = true;
    void this.server?.close();
    this.store.close();
    this.release?.();
  }

  handlers(): Record<string, RpcHandler> {
    const base: Record<string, RpcHandler> = {
      ping: () => ({ version: DAEMON_VERSION, pid: process.pid, projects: [...this.projects.keys()] }),
      "events.subscribe": (params, ctx) => {
        const q = (params ?? {}) as { projectId?: string; afterSeq?: number; taskId?: string; runId?: string };
        const backlog = q.afterSeq !== undefined ? this.store.events.list({ ...(q.projectId ? { projectId: q.projectId } : {}), afterSeq: q.afterSeq }) : [];
        ctx.subscribe(
          (e) => (!q.projectId || e.projectId === q.projectId) && (!q.taskId || e.taskId === q.taskId) && (!q.runId || e.runId === q.runId),
          backlog,
        );
        return { subscribed: true, lastSeq: this.store.events.lastSeq() };
      },
      "daemon.stop": () => {
        setTimeout(() => void this.stop("daemon.stop requested"), 10);
        return { stopping: true };
      },
    };
    for (const pl of this.plugins) Object.assign(base, pl.handlers(this));
    return base;
  }
}
