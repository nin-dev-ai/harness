import { createHash } from "node:crypto";

// eslint-disable-next-line no-control-regex -- matching ANSI escapes is the point
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** Path-like tokens: optional dir parts then a file with an extension, optionally :line[:col]. */
const PATH = /(?:[A-Za-z]:)?(?:[\w.@~+-]*[\\/])+([\w.@+-]+\.[A-Za-z0-9]+)(?::\d+(?::\d+)?)?/g;
const BARE_LINE_COL = /\b([\w.@+-]+\.[A-Za-z0-9]+):\d+(?::\d+)?/g;
const LINE_WORD = /\bline \d+\b/gi;
const DURATION = /\b\d+(?:\.\d+)?\s?(?:ms|s|sec|seconds|m|min)\b/g;
const HEX = /\b0x[0-9a-f]+\b/gi;
const TIMESTAMP = /\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?/g;
const PARENS_POS = /\((\d+),\s*(\d+)\)/g;

/** Lines that describe a failure. Everything else is noise for the signature. */
const ERROR_LINE = /error|fail|✗|×|✕|assert|expected|received|exception|traceback|panic|cannot|undefined is not|not found|TS\d{4}/i;

/** Normalize one output line: no colors, no paths or line numbers, no timings. Test names survive. */
export function normalizeLine(line: string): string {
  return line
    .replace(ANSI, "")
    .replace(TIMESTAMP, "<ts>")
    .replace(PATH, "$1")
    .replace(BARE_LINE_COL, "$1")
    .replace(PARENS_POS, "")
    .replace(LINE_WORD, "line")
    .replace(DURATION, "")
    .replace(HEX, "<hex>")
    .replace(/\s+/g, " ")
    .trim();
}

/** The normalized error lines a signature is computed from. */
export function errorLines(output: string): string[] {
  const lines = output.split(/\r?\n/).map(normalizeLine).filter(Boolean);
  const errs = lines.filter((l) => ERROR_LINE.test(l));
  const chosen = errs.length ? errs : lines.slice(-20);
  return [...new Set(chosen)].sort();
}

/**
 * Failure signature: a hash of the check id plus normalized error lines.
 * The same failure at a different path or line number gives the same signature.
 */
export function failureSignature(checkId: string, output: string): string {
  return createHash("sha256").update(`${checkId}\n${errorLines(output).join("\n")}`).digest("hex").slice(0, 16);
}
