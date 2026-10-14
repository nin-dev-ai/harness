import fs from "node:fs";
import path from "node:path";
import { isMap, isScalar, LineCounter, parseDocument, type Document } from "yaml";
import type { z } from "zod";
import {
  ChecksConfigSchema,
  HarnessConfigSchema,
  ValidationError,
  type ChecksConfig,
  type HarnessConfig,
  type ValidationIssue,
} from "@harness/core";

export const CONFIG_FILE = "harness.yaml";
export const CHECKS_FILE = ".harness/checks.yaml";

export interface Loaded<T> {
  config: T;
  warnings: ValidationIssue[];
}

/**
 * Line (1-based) for a config path: the line of the deepest key that exists.
 * Unknown or missing keys point at themselves or their nearest parent key.
 */
function lineOf(doc: Document, lc: LineCounter, p: (string | number)[]): number | undefined {
  for (let n = p.length; n >= 1; n--) {
    const parent = n > 1 ? doc.getIn(p.slice(0, n - 1), true) : doc.contents;
    const key = p[n - 1];
    if (isMap(parent)) {
      const pair = parent.items.find((it) => isScalar(it.key) && it.key.value === key);
      const range = (pair?.key as { range?: [number, number, number] } | undefined)?.range;
      if (range) return lc.linePos(range[0]).line;
    } else if (parent && typeof key === "number") {
      const node = doc.getIn(p.slice(0, n), true) as { range?: [number, number, number] } | undefined;
      if (node?.range) return lc.linePos(node.range[0]).line;
    }
  }
  const range = (doc.contents as { range?: [number, number, number] } | null)?.range;
  return range ? lc.linePos(range[0]).line : undefined;
}

function parseYaml(text: string, file: string): { doc: Document; lc: LineCounter; data: unknown } {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, prettyErrors: true });
  if (doc.errors.length) {
    throw new ValidationError(
      `${file}: invalid YAML`,
      doc.errors.map((e) => ({ path: "", message: e.message, file, line: e.linePos?.[0]?.line })),
    );
  }
  return { doc, lc, data: doc.toJS() };
}

function zodIssues(err: z.ZodError, doc: Document, lc: LineCounter, file: string): ValidationIssue[] {
  return err.issues.flatMap((iss) => {
    // Unknown keys are reported once per key so each gets its own line number.
    if (iss.code === "unrecognized_keys") {
      return iss.keys.map((k) => ({
        path: [...iss.path, k].join("."),
        message: `unknown key "${k}"`,
        file,
        line: lineOf(doc, lc, [...iss.path, k]),
      }));
    }
    return [{ path: iss.path.join("."), message: iss.message, file, line: lineOf(doc, lc, iss.path) }];
  });
}

function fail(file: string, issues: ValidationIssue[]): never {
  const lines = issues.map((i) => `  ${file}${i.line ? `:${i.line}` : ""} ${i.path ? `${i.path}: ` : ""}${i.message}`);
  throw new ValidationError(`${file} is invalid:\n${lines.join("\n")}`, issues);
}

/** Cross-field rules the schema alone cannot express. Errors throw; warnings are returned. */
function checkHarnessRules(c: HarnessConfig, doc: Document, lc: LineCounter, file: string): ValidationIssue[] {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const at = (p: (string | number)[], message: string): ValidationIssue => ({ path: p.join("."), message, file, line: lineOf(doc, lc, p) });
  const routes = c.routes;

  for (const [name, role] of Object.entries(c.roles)) {
    if (!routes[role.route]) errors.push(at(["roles", name, "route"], `route "${role.route}" is not defined in routes`));
    if (role.mode === "write" && !role.paths_allow) warnings.push(at(["roles", name], `write role "${name}" has no paths_allow; it may write anywhere in the repo`));
    const seenVendors = new Set<string>();
    const primary = routes[role.route];
    if (primary) seenVendors.add(primary.vendor);
    role.fallback_routes.forEach((fr, i) => {
      const r = routes[fr];
      if (!r) errors.push(at(["roles", name, "fallback_routes", i], `fallback route "${fr}" is not defined in routes`));
      else if (r.vendor !== "fake" && seenVendors.has(r.vendor)) errors.push(at(["roles", name, "fallback_routes", i], `role "${name}" lists more than one route of vendor ${r.vendor}; switching accounts of one vendor is not allowed`));
      else seenVendors.add(r.vendor);
    });
    if (role.fallback === "auto" && role.fallback_routes.length === 0) warnings.push(at(["roles", name, "fallback"], `fallback: auto with no fallback_routes has no effect`));
    for (const other of role.independent_of) {
      if (!c.roles[other]) errors.push(at(["roles", name, "independent_of"], `unknown role "${other}"`));
      else if (c.roles[other].route === role.route) warnings.push(at(["roles", name], `same-route: "${name}" shares route "${role.route}" with "${other}"`));
    }
  }
  for (const r of Object.keys(c.limits.routes)) if (!routes[r]) errors.push(at(["limits", "routes", r], `route "${r}" is not defined in routes`));
  for (const r of Object.keys(c.policy.unattended)) if (!routes[r]) errors.push(at(["policy", "unattended", r], `route "${r}" is not defined in routes`));
  const [lo, hi] = c.burst.resume_jitter_seconds;
  if (lo > hi) errors.push(at(["burst", "resume_jitter_seconds"], "min jitter is greater than max"));
  if (c.integration_branch === c.base_branch) errors.push(at(["integration_branch"], "integration_branch must differ from base_branch"));
  if (!c.integration_branch.startsWith("harness/")) errors.push(at(["integration_branch"], 'integration_branch must be under "harness/"'));

  if (errors.length) fail(file, errors);
  return warnings;
}

/** Parse and validate harness.yaml text. Errors carry line numbers. */
export function parseHarnessConfig(text: string, file = CONFIG_FILE): Loaded<HarnessConfig> {
  const { doc, lc, data } = parseYaml(text, file);
  const res = HarnessConfigSchema.safeParse(data);
  if (!res.success) fail(file, zodIssues(res.error, doc, lc, file));
  const warnings = checkHarnessRules(res.data, doc, lc, file);
  return { config: res.data, warnings };
}

/** Parse and validate .harness/checks.yaml text. */
export function parseChecksConfig(text: string, file = CHECKS_FILE): Loaded<ChecksConfig> {
  const { doc, lc, data } = parseYaml(text, file);
  const res = ChecksConfigSchema.safeParse(data);
  if (!res.success) fail(file, zodIssues(res.error, doc, lc, file));
  const ids = new Set<string>();
  const errors: ValidationIssue[] = [];
  res.data.checks.forEach((c, i) => {
    if (ids.has(c.id)) errors.push({ path: `checks.${i}.id`, message: `duplicate check id "${c.id}"`, file, line: lineOf(doc, lc, ["checks", i, "id"]) });
    ids.add(c.id);
  });
  if (errors.length) fail(file, errors);
  const warnings: ValidationIssue[] = res.data.checks.some((c) => c.required) ? [] : [{ path: "checks", message: "no required checks: the gate cannot fail", file }];
  return { config: res.data, warnings };
}

export function loadHarnessConfig(projectRoot: string): Loaded<HarnessConfig> {
  const file = path.join(projectRoot, CONFIG_FILE);
  return parseHarnessConfig(fs.readFileSync(file, "utf8"), CONFIG_FILE);
}

export function loadChecksConfig(projectRoot: string): Loaded<ChecksConfig> {
  const file = path.join(projectRoot, CHECKS_FILE);
  return parseChecksConfig(fs.readFileSync(file, "utf8"), CHECKS_FILE);
}

export interface ProjectConfig {
  root: string;
  harness: HarnessConfig;
  checks: ChecksConfig;
  warnings: ValidationIssue[];
}

/** Load both project files. */
export function loadProject(projectRoot: string): ProjectConfig {
  const h = loadHarnessConfig(projectRoot);
  const c = loadChecksConfig(projectRoot);
  return { root: projectRoot, harness: h.config, checks: c.config, warnings: [...h.warnings, ...c.warnings] };
}
