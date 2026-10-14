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

/** Connect to the daemon, starting it in the background if it is not running. */
export async function connect(io: Io, opts: { start?: boolean } = {}): Promise<DaemonClient> {
  const paths = homePaths(harnessHome(io.env));
  try {
    return await DaemonClient.connect(paths.sock, 1000);
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
