import fs from "node:fs";
import path from "node:path";
import { parseDocument, stringify } from "yaml";
import type { ChecksConfig } from "@harness/core";
import { CHECKS_FILE, CONFIG_FILE, parseHarnessConfig } from "./load.js";

/** Write a file atomically (temp file + rename). */
export function writeFileAtomic(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, file);
}

export function writeChecksConfig(projectRoot: string, checks: ChecksConfig): void {
  const body = stringify(
    {
      version: 1,
      checks: checks.checks.map((c) => ({ id: c.id, argv: c.argv, timeout_s: c.timeout_s, required: c.required, ...(c.scope !== "all" ? { scope: c.scope } : {}) })),
      setup: checks.setup.map((s) => ({ argv: s.argv })),
      env_pass: checks.env_pass,
    },
    { flow: false },
  );
  writeFileAtomic(path.join(projectRoot, CHECKS_FILE), `# Verification commands. The harness runs these itself; an agent's claim that they pass is never used.\n${body}`);
}

/**
 * Edit harness.yaml in place, keeping comments and layout. The result is
 * validated before it is written, so an edit can never leave an invalid file.
 */
export function editHarnessConfig(projectRoot: string, edit: (doc: ReturnType<typeof parseDocument>) => void): void {
  const file = path.join(projectRoot, CONFIG_FILE);
  const doc = parseDocument(fs.readFileSync(file, "utf8"));
  edit(doc);
  const text = doc.toString();
  parseHarnessConfig(text);
  writeFileAtomic(file, text);
}

export function setRoleRoute(projectRoot: string, role: string, route: string): void {
  editHarnessConfig(projectRoot, (doc) => {
    if (!doc.hasIn(["roles", role])) throw new Error(`unknown role "${role}"`);
    doc.setIn(["roles", role, "route"], route);
  });
}

export function addRoute(projectRoot: string, name: string, route: { vendor: string; auth: string; model?: string }): void {
  editHarnessConfig(projectRoot, (doc) => {
    if (doc.hasIn(["routes", name])) throw new Error(`route "${name}" already exists`);
    doc.setIn(["routes", name], doc.createNode(route));
  });
}

export function removeRoute(projectRoot: string, name: string): void {
  editHarnessConfig(projectRoot, (doc) => {
    if (!doc.deleteIn(["routes", name])) throw new Error(`unknown route "${name}"`);
  });
}

export function setRouteLimit(projectRoot: string, route: string, key: string, value: unknown): void {
  editHarnessConfig(projectRoot, (doc) => {
    doc.setIn(["limits", "routes", route, key], value);
  });
}

export function setUnattended(projectRoot: string, route: string, value: "allow" | "ask" | "deny"): void {
  editHarnessConfig(projectRoot, (doc) => {
    doc.setIn(["policy", "unattended", route], value);
  });
}
