import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface TempRepo {
  root: string;
  git(...args: string[]): string;
  write(file: string, content: string): void;
  commit(message: string): string;
  cleanup(): void;
}

/** A throwaway git repo on `main` with its own identity and one initial commit. */
export function createTempRepo(files: Record<string, string> = { "README.md": "# temp\n" }): TempRepo {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "harness-repo-")));
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  git("init", "-q", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.com");
  git("config", "commit.gpgsign", "false");
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  };
  for (const [f, c] of Object.entries(files)) write(f, c);
  write(".gitignore", ".harness/worktrees/\n.harness/runs/\n");
  git("add", "-A");
  git("commit", "-q", "-m", "initial");
  return {
    root,
    git,
    write,
    commit: (message) => {
      git("add", "-A");
      git("commit", "-q", "-m", message);
      return git("rev-parse", "HEAD");
    },
    cleanup: () => {
      try {
        git("worktree", "prune");
      } catch {
        // ignore
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
