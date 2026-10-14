import { useState } from "react";
import { Box, Text, useApp, useInput } from "ink";
import { C } from "./theme.js";

export interface WizardTool {
  vendor: "claude" | "codex" | "cursor";
  installed: boolean;
  signedIn: "yes" | "no" | "unknown";
  version?: string | undefined;
  fixHint?: string | undefined;
}

export interface WizardResult {
  role: string;
  vendor: "claude" | "codex" | "cursor";
  model?: string;
  mode: "readonly" | "write";
  pathsAllow?: string[];
  concurrency?: number;
}

export interface WizardProps {
  project: string;
  tools: WizardTool[];
  /** Top-level folders of the repo, to suggest write scopes. */
  folders: string[];
  onDone(agents: WizardResult[]): void;
  onCancel(): void;
}

interface Preset {
  role: string;
  mode: "readonly" | "write";
  on: boolean;
  about: string;
}

const PRESETS: Preset[] = [
  { role: "backend", mode: "write", on: true, about: "servers, APIs, data" },
  { role: "frontend", mode: "write", on: true, about: "UI and client code" },
  { role: "tests", mode: "write", on: false, about: "writes and fixes tests" },
  { role: "docs", mode: "write", on: false, about: "docs and READMEs" },
  { role: "reviewer", mode: "readonly", on: true, about: "reviews every change, never edits" },
  { role: "planner", mode: "readonly", on: true, about: "splits a spec into tasks" },
];

const SCOPE_HINTS: Record<string, RegExp> = {
  backend: /^(server|api|backend|lib|services?|src\/server)$/i,
  frontend: /^(ui|web|client|frontend|app|components|pages|src\/ui)$/i,
  tests: /^(tests?|spec|__tests__)$/i,
  docs: /^(docs?|documentation)$/i,
};

/** A write scope suggestion for a role from the repo's folders. */
export function suggestScope(role: string, folders: string[]): string {
  const hit = folders.find((f) => SCOPE_HINTS[role]?.test(f));
  if (hit) return `${hit}/**`;
  if (role === "tests") return "test/**, tests/**, **/*.test.*";
  if (role === "docs") return "docs/**, **/*.md";
  return folders.includes("src") ? "src/**" : "**";
}

interface Draft {
  role: string;
  mode: "readonly" | "write";
  vendor: WizardTool["vendor"];
  model: string;
  scope: string;
  count: number;
}

type Step = { kind: "tools" } | { kind: "roles" } | { kind: "agent"; index: number } | { kind: "summary" };

/** First-run setup: which tools, which agents, which tool and folders per agent. Writes nothing itself. */
export function Wizard({ project, tools, folders, onDone, onCancel }: WizardProps) {
  const { exit } = useApp();
  const usable = tools.filter((t) => t.installed && t.signedIn !== "no").map((t) => t.vendor);
  const [step, setStep] = useState<Step>({ kind: "tools" });
  const [presets, setPresets] = useState<Preset[]>(PRESETS.map((p) => ({ ...p })));
  const [cursor, setCursor] = useState(0);
  const [custom, setCustom] = useState("");
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [field, setField] = useState(0);

  const finish = (fn: () => void) => {
    fn();
    exit();
  };

  const buildDrafts = (list: Preset[]): Draft[] => {
    const chosen = list.filter((p) => p.on);
    const writers = chosen.filter((p) => p.mode === "write");
    return chosen.map((p) => {
      const wi = writers.indexOf(p);
      let vendor = usable[0]!;
      if (p.mode === "write") vendor = usable[wi % usable.length]!;
      if (p.role === "reviewer") {
        const used = new Set(writers.map((_, i) => usable[i % usable.length]));
        vendor = usable.find((v) => !used.has(v)) ?? usable[usable.length - 1]!;
      }
      if (p.role === "planner") vendor = usable.includes("claude") ? "claude" : usable[0]!;
      return { role: p.role, mode: p.mode, vendor, model: "", scope: p.mode === "write" ? suggestScope(p.role, folders) : "", count: 1 };
    });
  };

  const fields = (d: Draft) => (d.mode === "write" ? ["tool", "model", "writes", "count"] : ["tool", "model"]);

  useInput((ch, key) => {
    if (key.ctrl && ch === "c") return finish(onCancel);
    if (step.kind === "tools") {
      if (key.return) {
        if (!usable.length) return finish(onCancel);
        setCursor(0);
        return setStep({ kind: "roles" });
      }
      if (key.escape) return finish(onCancel);
      return;
    }
    if (step.kind === "roles") {
      const n = presets.length + 1; // last row: add your own
      if (key.upArrow) return setCursor((c) => Math.max(0, c - 1));
      if (key.downArrow) return setCursor((c) => Math.min(n - 1, c + 1));
      if (key.escape) return setStep({ kind: "tools" });
      if (cursor === presets.length) {
        if (key.return) {
          const name = custom.trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
          if (name && /^[a-z]/.test(name) && !presets.some((p) => p.role === name)) {
            setPresets((ps) => [...ps.slice(0, -2), { role: name, mode: "write", on: true, about: "your own agent" }, ...ps.slice(-2)]);
            setCustom("");
            return;
          }
          if (!presets.some((p) => p.on && p.mode === "write")) return;
          setDrafts(buildDrafts(presets));
          setField(0);
          return setStep({ kind: "agent", index: 0 });
        }
        if (key.backspace || key.delete) return setCustom((v) => v.slice(0, -1));
        if (ch && !key.ctrl && !key.meta && ch !== " ") return setCustom((v) => v + ch);
        return;
      }
      if (ch === " ") return setPresets((ps) => ps.map((p, i) => (i === cursor ? { ...p, on: !p.on } : p)));
      if (key.return) {
        if (!presets.some((p) => p.on && p.mode === "write")) return;
        setDrafts(buildDrafts(presets));
        setField(0);
        return setStep({ kind: "agent", index: 0 });
      }
      return;
    }
    if (step.kind === "agent") {
      const d = drafts[step.index]!;
      const fs = fields(d);
      const f = fs[field]!;
      const update = (patch: Partial<Draft>) => setDrafts((ds) => ds.map((x, i) => (i === step.index ? { ...x, ...patch } : x)));
      if (key.escape) {
        setField(0);
        return setStep(step.index === 0 ? { kind: "roles" } : { kind: "agent", index: step.index - 1 });
      }
      if (key.upArrow) return setField((x) => Math.max(0, x - 1));
      if (key.downArrow || key.tab) return setField((x) => Math.min(fs.length - 1, x + 1));
      if (key.return) {
        setField(0);
        return setStep(step.index + 1 < drafts.length ? { kind: "agent", index: step.index + 1 } : { kind: "summary" });
      }
      if (f === "tool" && (key.leftArrow || key.rightArrow || ch === " ")) {
        const i = usable.indexOf(d.vendor);
        return update({ vendor: usable[(i + (key.leftArrow ? usable.length - 1 : 1)) % usable.length]! });
      }
      if (f === "count" && (key.leftArrow || key.rightArrow)) return update({ count: Math.max(1, Math.min(4, d.count + (key.leftArrow ? -1 : 1))) });
      if (f === "model" || f === "writes") {
        const k = f === "model" ? "model" : "scope";
        if (key.backspace || key.delete) return update({ [k]: d[k].slice(0, -1) });
        if (ch && !key.ctrl && !key.meta) return update({ [k]: d[k] + ch });
      }
      return;
    }
    if (step.kind === "summary") {
      if (key.escape) return setStep({ kind: "agent", index: drafts.length - 1 });
      if (key.return)
        return finish(() =>
          onDone(
            drafts.map((d) => ({
              role: d.role,
              vendor: d.vendor,
              mode: d.mode,
              ...(d.model.trim() ? { model: d.model.trim() } : {}),
              ...(d.mode === "write" ? { concurrency: d.count, pathsAllow: d.scope.split(",").map((s) => s.trim()).filter(Boolean) } : {}),
            })),
          ),
        );
    }
  });

  const title = (n: number, text: string) => (
    <Text>
      <Text bold>harness setup</Text>
      <Text color={C.dim}> · {project} · step {n} of 3 · </Text>
      {text}
    </Text>
  );

  if (step.kind === "tools")
    return (
      <Box flexDirection="column" paddingX={1}>
        {title(1, "tools on this machine")}
        <Text> </Text>
        {tools.map((t) => (
          <Text key={t.vendor}>
            {"  "}
            {t.installed && t.signedIn !== "no" ? "✓" : "·"} {t.vendor.padEnd(8)}
            <Text color={C.dim}>
              {t.installed ? `${t.version ?? "installed"}${t.signedIn === "no" ? " · not signed in" : ""}` : "not installed"}
              {t.fixHint && !(t.installed && t.signedIn !== "no") ? `  → ${t.fixHint}` : ""}
            </Text>
          </Text>
        ))}
        <Text> </Text>
        {usable.length ? (
          <Text>
            harness will run agents with <Text bold>{usable.join(", ")}</Text>. <Text color={C.dim}>enter continue · esc quit</Text>
          </Text>
        ) : (
          <Text color={C.warn}>No signed-in tool found. Install or sign in to one of them, then run harness again. (enter to exit)</Text>
        )}
      </Box>
    );

  if (step.kind === "roles")
    return (
      <Box flexDirection="column" paddingX={1}>
        {title(2, "which agents do you want?")}
        <Text> </Text>
        {presets.map((p, i) => (
          <Text key={p.role} color={i === cursor ? C.accent : undefined}>
            {i === cursor ? "▸ " : "  "}[{p.on ? "x" : " "}] {p.role.padEnd(10)}
            <Text color={C.dim}>
              {p.mode === "readonly" ? "read-only · " : ""}
              {p.about}
            </Text>
          </Text>
        ))}
        <Text color={cursor === presets.length ? C.accent : C.dim}>
          {cursor === presets.length ? "▸ " : "  "}+ add your own: {custom}
          {cursor === presets.length ? <Text inverse> </Text> : null}
        </Text>
        <Text> </Text>
        <Text color={C.dim}>↑↓ move · space toggle · type a name on the last line + enter to add · enter continue · esc back</Text>
      </Box>
    );

  if (step.kind === "agent") {
    const d = drafts[step.index]!;
    const fs = fields(d);
    const row = (name: string, value: string, hint: string) => {
      const on = fs[field] === name;
      return (
        <Text color={on ? C.accent : undefined}>
          {on ? "▸ " : "  "}
          {name.padEnd(8)} {value}
          {on && (name === "model" || name === "writes") ? <Text inverse> </Text> : null}
          <Text color={C.dim}>   {hint}</Text>
        </Text>
      );
    };
    return (
      <Box flexDirection="column" paddingX={1}>
        {title(3, `agent ${step.index + 1} of ${drafts.length}: ${d.role}`)}
        <Text> </Text>
        {row("tool", `◂ ${d.vendor} ▸`, "←→ to change")}
        {row("model", d.model || "(tool default)", "type a model id, or leave empty")}
        {d.mode === "write" ? row("writes", d.scope, "folders it may change, comma-separated") : <Text color={C.dim}>  read-only: never edits files</Text>}
        {d.mode === "write" ? row("count", `◂ ${d.count} ▸`, "how many of this agent at once") : null}
        <Text> </Text>
        <Text color={C.dim}>↑↓ field · enter next agent · esc back</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text bold>harness setup</Text>
        <Text color={C.dim}> · {project} · ready</Text>
      </Text>
      <Text> </Text>
      {drafts.map((d) => (
        <Text key={d.role}>
          {"  "}
          {d.role.padEnd(10)} {`${d.vendor}/${d.model || "default"}`.padEnd(20)}
          <Text color={C.dim}>{d.mode === "write" ? `writes ${d.scope}${d.count > 1 ? `  ×${d.count}` : ""}` : "read-only"}</Text>
        </Text>
      ))}
      <Text> </Text>
      <Text>
        enter saves harness.yaml <Text color={C.dim}>(you can edit it by hand any time) · esc back</Text>
      </Text>
    </Box>
  );
}
