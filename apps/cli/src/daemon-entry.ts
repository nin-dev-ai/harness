import fs from "node:fs";
import path from "node:path";
import { Daemon, EnginePlugin, defaultGuards, harnessHome } from "@harness/daemon";

/** Run the daemon in this process until it is stopped. `harness __daemon` (hidden). */
export async function runDaemon(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const home = harnessHome(env);
  fs.mkdirSync(path.join(home, "logs"), { recursive: true });
  const plugin: EnginePlugin = new EnginePlugin((p, d, kick) => defaultGuards(() => plugin.isAttended())(p, d, kick));
  const daemon = new Daemon({ home, env }).use(plugin);
  const shutdown = (sig: string) => void daemon.stop(`signal ${sig}`).then(() => process.exit(0));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("uncaughtException", (e) => {
    fs.appendFileSync(path.join(home, "logs", "daemon.log"), `${new Date().toISOString()} uncaught: ${e.stack ?? e.message}\n`);
  });
  await daemon.start();
  fs.appendFileSync(path.join(home, "logs", "daemon.log"), `${new Date().toISOString()} started pid ${process.pid}\n`);
  await daemon.stopped();
  process.exit(0);
}
