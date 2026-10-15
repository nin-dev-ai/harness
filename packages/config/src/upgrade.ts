import fs from "node:fs";
import path from "node:path";
import { parseDocument, isMap, type Document } from "yaml";
import { ROLE_GUIDES } from "@harness/core";
import { CONFIG_FILE, parseHarnessConfig } from "./load.js";
import { writeFileAtomic } from "./write.js";

export interface UpgradeOptions {
  /** Also pool every writing role across one route of each other vendor. Off by default: it changes where work runs. */
  pool?: boolean;
}

export interface UpgradeResult {
  text: string;
  changes: string[];
  /** Things worth doing that the upgrade will not do on its own. */
  hints: string[];
}

/**
 * Bring an older harness.yaml up to today's features without touching what
 * the person set: only missing pieces are added, comments and layout are
 * kept, and the result is validated before anyone writes it.
 */
export function upgradeConfigText(text: string, o: UpgradeOptions = {}): UpgradeResult {
  const config = parseHarnessConfig(text).config;
  const doc: Document = parseDocument(text);
  const changes: string[] = [];
  const hints: string[] = [];
  const roles = Object.entries(config.roles);

  for (const [name, role] of roles) {
    const guide = ROLE_GUIDES[name];
    if (!role.instructions.trim() && guide) {
      doc.setIn(["roles", name, "instructions"], guide);
      changes.push(`roles.${name}.instructions: what a ${name} agent is for`);
    }
  }

  if (!config.roles.lead) {
    const anchor = config.roles.planner ?? roles.find(([, r]) => r.mode === "readonly")?.[1] ?? roles[0]?.[1];
    if (anchor) {
      doc.setIn(["roles", "lead"], doc.createNode({ route: anchor.route, mode: "readonly", instructions: ROLE_GUIDES.lead }));
      changes.push(`roles.lead on ${anchor.route}: checks each finished round and sets follow-ups`);
    }
  }

  const limits = doc.getIn(["limits"]);
  if (!isMap(limits) || !limits.has("review_sizes")) {
    doc.setIn(["limits", "review_sizes"], doc.createNode(["M", "L"], { flow: true }));
    changes.push("limits.review_sizes: [M, L] (small tasks merge once checks pass)");
  }

  // One route per other vendor, for pooling.
  const byVendor = new Map<string, string>();
  for (const [rname, r] of Object.entries(config.routes)) if (r.vendor !== "fake" && !byVendor.has(r.vendor)) byVendor.set(r.vendor, rname);
  for (const [name, role] of roles) {
    if (role.mode !== "write" || role.pool.length) continue;
    const own = config.routes[role.route]?.vendor;
    const taken = new Set<string | undefined>([own, ...role.fallback_routes.map((f) => config.routes[f]?.vendor)]);
    const pool = [...byVendor.entries()].filter(([v]) => !taken.has(v)).map(([, r]) => r);
    if (!pool.length) continue;
    if (o.pool) {
      doc.setIn(["roles", name, "pool"], doc.createNode(pool, { flow: true }));
      changes.push(`roles.${name}.pool: [${pool.join(", ")}] (work goes to whichever has room)`);
    } else hints.push(`${name} could also use ${pool.join(", ")}: rerun with --pool, or add \`pool: [${pool.join(", ")}]\``);
  }

  if (!changes.length) return { text, changes, hints };
  const out = doc.toString({ lineWidth: 0 });
  parseHarnessConfig(out);
  return { text: out, changes, hints };
}

/** Upgrade harness.yaml in place (unless dryRun). */
export function upgradeHarnessConfig(projectRoot: string, o: UpgradeOptions & { dryRun?: boolean } = {}): UpgradeResult {
  const file = path.join(projectRoot, CONFIG_FILE);
  const r = upgradeConfigText(fs.readFileSync(file, "utf8"), o);
  if (!o.dryRun && r.changes.length) writeFileAtomic(file, r.text);
  return r;
}
