import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Directory holding the *.md prompt templates. Overridable for bundled builds. */
export function promptsDir(): string {
  const g = globalThis as { __HARNESS_ASSETS__?: string };
  if (g.__HARNESS_ASSETS__) return path.join(g.__HARNESS_ASSETS__, "prompts");
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "prompts");
}

const cache = new Map<string, string>();

export function loadTemplate(name: string): string {
  let t = cache.get(name);
  if (t === undefined) {
    t = fs.readFileSync(path.join(promptsDir(), `${name}.md`), "utf8");
    cache.set(name, t);
  }
  return t;
}

/**
 * Fill `{{name}}` placeholders. Deterministic: no model writes prompts.
 * Unknown placeholders are an error so templates and code stay in sync.
 */
export function render(name: string, vars: Record<string, string | number>): string {
  const out = loadTemplate(name).replace(/\{\{(\w+)\}\}/g, (_, k: string) => {
    if (!(k in vars)) throw new Error(`prompt ${name}: missing variable ${k}`);
    return String(vars[k]);
  });
  return out.replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

export const bullet = (items: readonly string[], empty = "(none)") => (items.length ? items.map((i) => `- ${i}`).join("\n") : empty);
