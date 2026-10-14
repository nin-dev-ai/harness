import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { git, gitRaw } from "./git.js";

/** Merge base of `base` and the worktree's HEAD. */
export async function mergeBase(worktree: string, base: string): Promise<string> {
  return git(worktree, ["merge-base", base, "HEAD"]);
}

/**
 * Files changed in the worktree relative to its merge base with `base`:
 * committed, staged, unstaged and untracked, including deletions.
 */
export async function changedFiles(worktree: string, base: string): Promise<string[]> {
  const mb = await mergeBase(worktree, base);
  const tracked = await git(worktree, ["diff", "--name-only", "--no-renames", mb]);
  const untracked = await git(worktree, ["ls-files", "--others", "--exclude-standard"]);
  const all = new Set([...tracked.split("\n"), ...untracked.split("\n")].filter(Boolean));
  return [...all].sort();
}

/**
 * Hash of the full working state (tracked + untracked, ignoring .gitignored files)
 * without touching the real index. Equal hashes mean an unchanged diff.
 */
export async function workingTreeHash(worktree: string): Promise<string> {
  const tmp = path.join(os.tmpdir(), `harness-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  try {
    const env = { GIT_INDEX_FILE: tmp };
    await git(worktree, ["read-tree", "HEAD"], { env });
    await git(worktree, ["add", "-A"], { env });
    return await git(worktree, ["write-tree"], { env });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export interface DiffSummary {
  files: string[];
  /** Per-file line counts (binary files count 0). */
  fileStats: { path: string; insertions: number; deletions: number }[];
  insertions: number;
  deletions: number;
  stat: string;
}

/** Stat of all changes (including uncommitted) relative to the merge base. */
export async function diffSummary(worktree: string, base: string): Promise<DiffSummary> {
  const mb = await mergeBase(worktree, base);
  const files = await changedFiles(worktree, base);
  const untracked = (await git(worktree, ["ls-files", "--others", "--exclude-standard"])).split("\n").filter(Boolean);
  // Intent-to-add makes untracked files visible to diff without staging their content.
  if (untracked.length) await gitRaw(worktree, ["add", "-N", "--", ...untracked]);
  const numstat = await git(worktree, ["diff", "--numstat", mb]);
  const stat = await git(worktree, ["diff", "--stat", mb]);
  if (untracked.length) await gitRaw(worktree, ["reset", "-q", "--", ...untracked]);
  let insertions = 0;
  let deletions = 0;
  const fileStats: DiffSummary["fileStats"] = [];
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [a, d, p] = line.split("\t");
    insertions += Number(a) || 0;
    deletions += Number(d) || 0;
    if (p) fileStats.push({ path: p, insertions: Number(a) || 0, deletions: Number(d) || 0 });
  }
  return { files, fileStats, insertions, deletions, stat };
}

/** Unified diff relative to the merge base, truncated to `maxBytes`. */
export async function diffText(worktree: string, base: string, maxBytes = 200_000, exclude: readonly string[] = []): Promise<string> {
  const mb = await mergeBase(worktree, base);
  const untracked = (await git(worktree, ["ls-files", "--others", "--exclude-standard"])).split("\n").filter(Boolean);
  if (untracked.length) await gitRaw(worktree, ["add", "-N", "--", ...untracked]);
  const text = await git(worktree, ["diff", mb, ...(exclude.length ? ["--", ".", ...exclude.map((f) => `:(exclude)${f}`)] : [])]);
  if (untracked.length) await gitRaw(worktree, ["reset", "-q", "--", ...untracked]);
  return text.length > maxBytes ? `${text.slice(0, maxBytes)}\n... diff truncated (${text.length} bytes)` : text;
}

/** Restore files to their merge-base version (delete them if they did not exist there). */
export async function revertPaths(worktree: string, files: readonly string[], base: string): Promise<void> {
  if (!files.length) return;
  const mb = await mergeBase(worktree, base);
  for (const f of files) {
    const existed = (await gitRaw(worktree, ["cat-file", "-e", `${mb}:${f}`])).exitCode === 0;
    if (existed) await git(worktree, ["checkout", mb, "--", f]);
    else {
      await gitRaw(worktree, ["rm", "-q", "--cached", "--ignore-unmatch", "--", f]);
      fs.rmSync(path.join(worktree, f), { force: true });
    }
  }
}

/** Contents of a file at a ref, or undefined if absent. */
export async function showFile(cwd: string, ref: string, file: string): Promise<string | undefined> {
  const r = await gitRaw(cwd, ["show", `${ref}:${file}`]);
  return r.exitCode === 0 ? r.stdout : undefined;
}
