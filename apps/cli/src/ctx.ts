import path from "node:path";
import type { Command } from "commander";
import { formatTaskId, isTaskId } from "@harness/core";
import { style, type Style } from "./format.js";
import type { Io } from "./io.js";

export interface Globals {
  project?: string;
  json?: boolean;
  color?: boolean;
  debug?: boolean;
}

/** What every command gets: io, resolved globals and helpers. */
export interface Ctx {
  io: Io;
  program: Command;
  globals(): Globals;
  dir(): string;
  json(): boolean;
  s(): Style;
  print(text: string): void;
  printJson(v: unknown): void;
}

export function makeCtx(io: Io, program: Command): Ctx {
  const globals = () => program.opts<Globals>();
  return {
    io,
    program,
    globals,
    dir: () => path.resolve(io.cwd, globals().project ?? "."),
    json: () => Boolean(globals().json),
    s: () => style(io.color && globals().color !== false),
    print: (t) => io.out(t),
    printJson: (v) => io.out(JSON.stringify(v, null, 2)),
  };
}

/** Accept "T-004", "t-4" or "4". */
export function taskIdArg(s: string): string {
  const t = s.trim().toUpperCase();
  if (isTaskId(t)) return t;
  if (/^\d+$/.test(t)) return formatTaskId(Number(t));
  const m = /^T-(\d+)$/.exec(t);
  if (m) return formatTaskId(Number(m[1]));
  return s;
}

export const collect = (v: string, prev: string[] = []) => [...prev, ...v.split(",").map((x) => x.trim()).filter(Boolean)];
