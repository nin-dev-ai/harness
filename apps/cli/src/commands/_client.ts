import { spawn } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DaemonClient, DaemonUnreachableError, harnessHome, homePaths, isAlive, readPid } from "@harness/daemon";
import { CliExit, EXIT, type Io } from "../io.js";

/** argv that starts the daemon: this same program with the hidden `__daemon` command. */
export function daemonCommand(env: NodeJS.ProcessEnv): string[] {
  if (env.HARNESS_DAEMON_CMD) return JSON.parse(env.HARNESS_DAEMON_CMD) as string[];
  const here = fileURLToPath(import.meta.url);
  const main = here.endsWith(".ts") ? path.join(path.dirname(here), "..", "main.ts") : path.join(path.dirname(here), "main.js");
  const entry = fs.existsSync(main) ? main : (process.argv[1] ?? main);
  if (entry.endsWith(".ts")) {
    const tsx = createRequire(import.meta.url).resolve("tsx/esm");
    return [process.execPath, "--conditions=source", "--import", pathToFileURL(tsx).href, entry, "__daemon"];
  }
  return [process.execPath, entry, "__daemon"];
}

/** Is the daemon running an older build of this same harness entry file? */
export function isStaleBuild(daemonBuild: { entry: string; mtimeMs: number } | undefined, myEntry: string | undefined, mtimeOf: (file: string) => number | undefined): boolean {
  if (!daemonBuild?.entry || !daemonBuild.mtimeMs || daemonBuild.entry !== myEntry) return false;
  const now = mtimeOf(daemonBuild.entry);
  return now !== undefined && now > daemonBuild.mtimeMs;
}

const mtimeOf = (file: string) => {
  try {
    return fs.statSync(file).mtimeMs;
  } catch {
    return undefined;
  }
};

/**
 * A daemon started from an older build of this same harness (you rebuilt or
 * pulled since it started) is restarted when no agent is mid-run, so you never
 * talk to old code. With runs in flight it keeps going and you are told.
 */
async function replaceIfStale(io: Io, client: DaemonClient): Promise<DaemonClient | undefined> {
  const info = await client.call<{ pid: number; build?: { entry: string; mtimeMs: number }; liveRuns?: number }>("ping").catch(() => undefined);
  if (!info || !isStaleBuild(info.build, daemonCommand(io.env).at(-2), mtimeOf)) return client;
  if (info.liveRuns) {
    io.err(`harness was updated, but ${info.liveRuns} agent run${info.liveRuns === 1 ? " is" : "s are"} in flight on the old daemon; run \`harness stop\` later to pick up the update.`);
    return client;
  }
  io.err("harness was updated; restarting its background daemon…");
  await client.call("daemon.stop").catch(() => undefined);
  client.close();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && isAlive(info.pid)) await new Promise((r) => setTimeout(r, 100));
  return undefined;
}

/** Connect to the daemon, starting it in the background if it is not running. */
export async function connect(io: Io, opts: { start?: boolean } = {}): Promise<DaemonClient> {
  const paths = homePaths(harnessHome(io.env));
  try {
    const c = await DaemonClient.connect(paths.sock, 1000);
    const kept = opts.start === false ? c : await replaceIfStale(io, c);
    if (kept) return kept;
  } catch (e) {
    if (!(e instanceof DaemonUnreachableError) || opts.start === false) throw new CliExit(EXIT.unreachable, (e as Error).message);
  }
  const pid = readPid(paths.pid);
  if (pid && isAlive(pid)) {
    // Starting up: wait for its socket below.
  } else {
    fs.mkdirSync(paths.logs, { recursive: true });
    const log = fs.openSync(path.join(paths.logs, "daemon.out"), "a");
    const [cmd, ...args] = daemonCommand(io.env);
    const child = spawn(cmd!, args, { detached: true, stdio: ["ignore", log, log], env: { ...io.env, HARNESS_ATTENDED_AT_START: "1" }, cwd: io.cwd });
    child.unref();
  }
  const deadline = Date.now() + Number(io.env.HARNESS_DAEMON_START_TIMEOUT_MS ?? 15_000);
  while (Date.now() < deadline) {
    try {
      return await DaemonClient.connect(paths.sock, 500);
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new CliExit(EXIT.unreachable, `daemon did not start; see ${path.join(paths.logs, "daemon.out")}`);
}

export interface ProjectSession {
  client: DaemonClient;
  projectId: string;
  /** Call a project method (adds projectId and marks the user present). */
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): void;
}

/** Connect and open the project containing `dir` (or --project). */
export async function openProject(io: Io, dir: string, opts: { start?: boolean } = {}): Promise<ProjectSession> {
  const client = await connect(io, opts);
  try {
    const p = await client.call<{ projectId: string }>("project.open", { path: dir, attended: true });
    return {
      client,
      projectId: p.projectId,
      call: (method, params = {}) => client.call(method, { ...params, projectId: p.projectId, attended: true }),
      close: () => client.close(),
    };
  } catch (e) {
    client.close();
    throw e;
  }
}
