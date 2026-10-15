import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { useEffect, useMemo, useReducer, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { StatusSnapshot, WorkerView } from "@harness/daemon";
import { completions, parseInput } from "./commands.js";
import { AgentTable, type AgentRow } from "./components/AgentTable.js";
import { ChatBar } from "./components/ChatBar.js";
import { Help } from "./components/Help.js";
import { BIG_BANNER, BIG_BANNER_WIDTH, GradientText, SMALL_BANNER } from "./components/Logo.js";
import { Activity, type ActivityItem } from "./components/Activity.js";
import { Welcome, type WelcomeAgent } from "./components/Welcome.js";
import { Pane, entryLine } from "./components/Pane.js";
import { ReviewView, type ReviewData } from "./components/ReviewView.js";
import { StatusLine } from "./components/StatusLine.js";
import { duration, resetText } from "./format.js";
import type { TuiStore } from "./store.js";
import { C, gradient, stateColor, THEME_NAMES, THEMES, VENDOR, type Theme } from "./theme.js";

/** Why the UI closed: the caller acts on it (attach runs a CLI, stop stops the daemon). */
export type UiExit = { action: "quit" } | { action: "stop" } | { action: "setup" } | { action: "attach"; target: string };

export interface AppProps {
  store: TuiStore;
  onExit(r: UiExit): void;
  /** Fixed size for tests. */
  size?: { columns: number; rows: number };
  theme?: string;
  onTheme?(name: string): void;
  /** Shown once in the team feed when the screen opens. */
  welcome?: string;
  version?: string;
  /** Open one real terminal window per agent (`harness watch <agent>`). */
  openWindows?(agents: string[]): Promise<{ opened: string[]; manual: string[] }>;
}

type Overlay = { kind: "none" } | { kind: "help" } | { kind: "usage" } | { kind: "agents" } | { kind: "tasks" } | { kind: "board"; text: string } | { kind: "panes" } | { kind: "zoom" } | { kind: "review" | "diff"; data: ReviewData };

const taskId = (s: string) => {
  const m = /^T?-?(\d+)$/i.exec(s.trim());
  return m ? `T-${String(Number(m[1])).padStart(3, "0")}` : s.trim().toUpperCase();
};
const fmtTokens = (n: number | undefined) => (n === undefined ? "—" : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
const TEAM = "team";

function statusOf(w: WorkerView): { label: string; color?: string | undefined } {
  if (w.state === "RUNNING") {
    if (w.waitingReason === "gating") return { label: "checking" };
    if (w.runKind === "repair") return { label: "fixing" };
    if (w.runKind === "review") return { label: "reviewing" };
    if (w.runKind === "plan") return { label: "planning" };
    return { label: "working" };
  }
  if (w.state === "WAITING") return { label: "waiting", color: C.warn };
  if (w.state === "PAUSED") return { label: "paused", color: C.warn };
  if (w.state === "FAILED") return { label: "failed", color: C.bad };
  return { label: "idle" };
}

/**
 * Chat with your team. One pane per agent shows its live session; the chat
 * bar sends your message to the primary agent or, after
 * Tab, straight to one agent.
 */
export function App({ store, onExit, size, theme: themeName, onTheme, welcome, version = "0.1.0", openWindows }: AppProps) {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => store.onChange(force), [store]);
  const snap: StatusSnapshot | null = store.snapshot;
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = size?.columns ?? stdout.columns ?? 120;
  const rows = size?.rows ?? stdout.rows ?? 40;

  const [t, setTheme] = useState<Theme>(THEMES[themeName ?? "neon"] ?? THEMES.neon!);
  const [focus, setFocus] = useState(0); // 0 = team, i = workers[i - 1]
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [histPos, setHistPos] = useState(-1);
  const [overlay, setOverlay] = useState<Overlay>({ kind: "none" });
  const [scroll, setScroll] = useState(0);
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setFrame((f) => f + 1), 150);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (welcome) store.note("_team", "ok", welcome);
  }, [welcome, store]);

  const workers: WorkerView[] = useMemo(() => {
    const rank = (w: WorkerView) => (w.role === "lead" ? 3 : w.role === "planner" ? 2 : w.role === "reviewer" ? 1 : 0);
    return [...(snap?.workers ?? [])].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  }, [snap]);
  const tasks = snap?.tasks ?? [];
  const focusWorker = focus > 0 ? workers[Math.min(focus - 1, workers.length - 1)] : undefined;

  const paneTask = (w: WorkerView) => {
    const id = w.taskId ?? store.taskForWorker(w.id);
    if (id) return tasks.find((x) => x.id === id);
    return [...tasks].filter((x) => x.role === w.role && x.lastRunId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  };
  const ids = workers.map((w) => paneTask(w)?.id ?? "").join(",");
  useEffect(() => {
    for (const id of ids.split(",").filter(Boolean)) {
      void store.loadTask(id);
      void store.loadDetail(id);
    }
  }, [ids, store]);

  const writeRoles = [...new Set(workers.map((w) => w.role))].filter((r) => r !== "reviewer" && r !== "planner");
  // Notes land in whatever feed is on screen: the team's, or the focused agent's.
  const viewKey = focusWorker ? focusWorker.id : "_team";
  const noteTeam = (kind: Parameters<TuiStore["note"]>[1], text: string, detail?: string) => store.note(viewKey, kind, text, detail);
  const call = async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T | undefined> => {
    try {
      const r = await store.api.call<T>(method, params);
      void store.refresh();
      return r;
    } catch (e) {
      noteTeam("err", (e as Error).message);
      return undefined;
    }
  };
  const quit = (r: UiExit) => {
    onExit(r);
    exit();
  };
  const cycle = (by: number) => {
    const n = workers.length + 1;
    setFocus((f) => (((f + by) % n) + n) % n);
  };
  const currentTask = focusWorker ? paneTask(focusWorker)?.id : undefined;
  const openReview = async (kind: "review" | "diff", id?: string) => {
    const tid = id ? taskId(id) : currentTask;
    if (!tid) return noteTeam("warn", "select an agent with a task first (Tab), or give a task id");
    const r = await call<ReviewData>("review.show", { id: tid });
    if (r) {
      setScroll(0);
      setOverlay({ kind, data: r });
    }
  };

  /** Chat to the primary agent; it may delegate independent jobs. */
  async function toTeam(text: string) {
    noteTeam("you", text);
    noteTeam("sys", "finding the primary agent for this…");
    const r = await call<{ summary: string; tasks: { id: string; title: string; role: string; dependsOn: string[] }[] }>("dispatch", { document: text, source: "chat" });
    store.local.set(viewKey, (store.local.get(viewKey) ?? []).filter((e) => !e.text.startsWith("finding the primary agent")));
    if (!r) return;
    if (r.summary) noteTeam("say", r.summary);
    for (const x of r.tasks) noteTeam("sys", `→ ${x.role}: ${x.title}${x.dependsOn.length ? ` (after ${x.dependsOn.join(", ")})` : ""}`);
    noteTeam("ok", `${r.tasks.length} task${r.tasks.length === 1 ? "" : "s"} started`);
  }

  /** Chat to one agent: a running agent gets a note; an idle one gets a new task. */
  async function toAgent(w: WorkerView, text: string) {
    if (w.role === "planner" || w.role === "lead") return toTeam(text);
    if (w.role === "reviewer") return store.note(w.id, "sys", "the reviewer checks work automatically once its checks pass");
    const task = paneTask(w);
    store.note(w.id, "you", text);
    if (task && !["MERGED", "CANCELLED", "DRAFT"].includes(task.state)) {
      const r = await call<{ delivery: string }>("agent.message", { target: task.id, text });
      if (r) store.note(w.id, "sys", r.delivery === "now" ? "delivered; it pauses safely and carries on" : r.delivery === "sent-back" ? "sent back with your note" : "it will read this on its next turn");
      return;
    }
    const r = await call<{ id: string }>("task.add", { title: text.split("\n")[0]!.slice(0, 80), role: w.role, body: text, approve: true });
    if (!r) return;
    await call("run");
    store.note(w.id, "ok", `${r.id} started`);
  }

  async function run(raw: string): Promise<void> {
    const p = parseInput(raw);
    if (p.kind === "empty") return;
    if (p.kind === "message") return focusWorker ? toAgent(focusWorker, p.text) : toTeam(p.text);
    if (!p.known) return noteTeam("warn", `unknown command /${p.name}. Type /help`);
    const a = p.args;
    const cur = currentTask;
    switch (p.name) {
      case "help":
        return setOverlay({ kind: "help" });
      case "usage":
        return setOverlay({ kind: "usage" });
      case "agents":
        return setOverlay({ kind: "agents" });
      case "tasks":
        return setOverlay({ kind: "tasks" });
      case "windows": {
        const agents = workers.filter((w) => w.role !== "planner" && w.role !== "lead").map((w) => w.id);
        if (!openWindows) return noteTeam("warn", `open a terminal per agent and run: ${agents.map((a) => `harness watch ${a}`).join(" · ")}`);
        const r = await openWindows(agents);
        if (r.opened.length) noteTeam("ok", `opened a terminal for ${r.opened.join(", ")}`);
        if (r.manual.length) noteTeam("sys", `run these in your own terminals:\n${r.manual.join("\n")}`);
        return;
      }
      case "land": {
        const r = await call<{ status: string; mode?: string; commits?: number; detail?: string; files?: string[]; into: string; from: string }>("land");
        if (!r) return;
        if (r.status === "landed") return noteTeam("ok", `landed ${r.commits} commit${r.commits === 1 ? "" : "s"} into ${r.into} (${r.mode})`);
        if (r.status === "conflict") return noteTeam("warn", `landing would conflict in ${r.files?.join(", ")}; nothing changed. Merge ${r.from} by hand.`);
        return noteTeam(r.status === "nothing" ? "sys" : "warn", r.detail ?? r.status);
      }
      case "fact": {
        const rm = /^-(\d+)$/.exec(a.trim());
        const r = await call<{ facts: string[] }>("facts", rm ? { remove: Number(rm[1]) } : a.trim() ? { add: a.trim() } : {});
        if (!r) return;
        return noteTeam("sys", r.facts.length ? `project facts:\n${r.facts.map((f, i) => `${i + 1}. ${f}`).join("\n")}` : "no project facts yet: /fact <something every agent should know>");
      }
      case "report":
      case "board": {
        const r = await call<{ text: string }>(p.name);
        if (r) {
          setScroll(0);
          setOverlay({ kind: "board", text: r.text });
        }
        return;
      }
      case "quit":
        return quit({ action: "quit" });
      case "stop":
        return quit({ action: "stop" });
      case "setup":
        return quit({ action: "setup" });
      case "clear":
        store.local.clear();
        return force();
      case "panes":
        return setOverlay({ kind: "panes" });
      case "zoom":
        if (!focusWorker) return noteTeam("warn", "Tab to an agent first, then /zoom");
        return setOverlay({ kind: "zoom" });
      case "theme": {
        const name = a || THEME_NAMES[(THEME_NAMES.indexOf(t.name) + 1) % THEME_NAMES.length]!;
        const next = THEMES[name];
        if (!next) return noteTeam("warn", `themes: ${THEME_NAMES.join(", ")}`);
        setTheme(next);
        onTheme?.(name);
        return noteTeam("ok", `theme: ${name}`);
      }
      case "switch": {
        if (!a || a.toLowerCase() === TEAM) return setFocus(0);
        const i = workers.findIndex((w) => w.id === a || w.id.startsWith(a) || w.role === a);
        if (i >= 0) return setFocus(i + 1);
        const task = tasks.find((x) => x.id === taskId(a));
        const wi = task ? workers.findIndex((w) => w.role === task.role) : -1;
        if (wi >= 0) return setFocus(wi + 1);
        return noteTeam("warn", `no agent "${a}". Try ${workers.map((w) => w.id).join(", ")}`);
      }
      case "task": {
        // @agent is optional: without it, the focused agent or harness's router picks.
        const m = /(?:^|\s)@([\w-]+)\s*$/.exec(a);
        const w = m ? workers.find((x) => x.role === m[1] || x.id === m[1]) : focusWorker;
        const role = w && writeRoles.includes(w.role) ? w.role : undefined;
        const title = (m ? a.slice(0, m.index) : a).trim();
        if (!title || (m && !role)) return noteTeam("warn", `usage: /task <title> [@agent]   (${writeRoles.join(", ")})`);
        const r = await call<{ id: string; role: string }>("task.add", { title, ...(role ? { role } : {}), approve: true });
        if (r) {
          await call("run");
          noteTeam("ok", `${r.id} → ${r.role}${role ? "" : " (picked for you)"}, started`);
        }
        return;
      }
      case "plan": {
        if (!a) return noteTeam("warn", "usage: /plan <file.md>   (or just type your idea)");
        const file = path.resolve(snap?.project.root ?? ".", a);
        if (!fs.existsSync(file)) return noteTeam("err", `no such file: ${a}`);
        noteTeam("sys", "planning…");
        const r = await call<{ tasks: { id: string; title: string; role: string }[] }>("plan", { document: fs.readFileSync(file, "utf8"), source: a });
        if (r) {
          for (const x of r.tasks) noteTeam("sys", `📝 ${x.id} ${x.role}: ${x.title}`);
          noteTeam("ok", `${r.tasks.length} draft task(s). /approve all to start them`);
        }
        return;
      }
      case "approve": {
        const arg = a.toLowerCase();
        if (!arg) return noteTeam("warn", "usage: /approve <T-n|A-n|all>");
        if (/^a-\d+$/.test(arg)) {
          if ((await call("approval.grant", { id: arg.toUpperCase() })) !== undefined) noteTeam("ok", `${arg.toUpperCase()} granted`);
          return;
        }
        const r = await call<{ approved?: string[] }>("task.approve", arg === "all" ? { all: true } : { ids: [taskId(arg)] });
        if (r) {
          if (r.approved?.length) await call("run");
          noteTeam("ok", r.approved?.length ? `approved ${r.approved.join(", ")}` : "nothing to approve");
        }
        return;
      }
      case "run":
        if ((await call("run")) !== undefined) noteTeam("ok", "scheduler running");
        return;
      case "pause":
        if (a === "all") {
          await call("pause", { all: true });
          return noteTeam("warn", "paused everything");
        }
        if (!cur) return noteTeam("warn", "Tab to an agent first, or /pause all");
        if ((await call("pause", { task: cur })) !== undefined) noteTeam("warn", `pausing ${cur} (work is checkpointed first)`);
        return;
      case "resume":
        if (a === "all" || !cur) {
          await call("resume", { all: true });
          return noteTeam("ok", "scheduler running");
        }
        if ((await call("resume", { task: cur })) !== undefined) noteTeam("ok", `resumed ${cur}`);
        return;
      case "review":
        return openReview("review", a || undefined);
      case "diff":
        return openReview("diff", a || undefined);
      case "accept": {
        const tid = a ? taskId(a) : cur;
        if (!tid) return noteTeam("warn", "which task? /accept T-1");
        const r = await call<{ state: string }>("review.accept", { id: tid });
        if (r) noteTeam(r.state === "MERGED" ? "ok" : "warn", `${tid} ${r.state.toLowerCase()}`);
        return;
      }
      case "reject":
        if (!cur || !a) return noteTeam("warn", "usage: /reject <comment>  (Tab to the agent first)");
        if ((await call("review.reject", { id: cur, comment: a })) !== undefined) noteTeam("warn", `${cur} sent back`);
        return;
      case "cancel": {
        const tid = a ? taskId(a) : cur;
        if (!tid) return noteTeam("warn", "which task? /cancel T-1");
        if ((await call("task.cancel", { id: tid })) !== undefined) noteTeam("warn", `${tid} cancelled`);
        return;
      }
      case "limits": {
        const [route, win, ...v] = a.split(/\s+/);
        if (!route || !win || !v.length) return noteTeam("warn", "usage: /limits <route> <5h|7d|budget> <85% | 40 runs/day>");
        if ((await call("limits.set", { route, window: win, budget: v.join(" ") })) !== undefined) noteTeam("ok", `${route} ${win} → ${v.join(" ")}`);
        return;
      }
      case "attach":
        if (!cur) return noteTeam("warn", "Tab to an agent with a task first");
        return quit({ action: "attach", target: cur });
    }
  }

  const submit = (override?: string) => {
    let text = override ?? input;
    const menu = text.startsWith("/") ? completions(text) : [];
    if (menu.length && /^\/\S*$/.test(text)) {
      const c = menu[Math.min(menuIndex, menu.length - 1)]!;
      if (c.args && text !== `/${c.name}`) {
        setInput(`/${c.name} `);
        setCursor(c.name.length + 2);
        return;
      }
      text = `/${c.name}`;
    }
    if (text.trim()) setHistory((h) => [...h.filter((x) => x !== text), text].slice(-100));
    setHistPos(-1);
    setInput("");
    setCursor(0);
    setMenuIndex(0);
    void run(text);
  };

  useInput((ch, key) => {
    if (key.ctrl && ch === "c") return quit({ action: "quit" });
    if (key.ctrl && ch === "d") return quit({ action: "quit" });
    if (key.escape) {
      if (overlay.kind !== "none") return setOverlay({ kind: "none" });
      setInput("");
      setCursor(0);
      return;
    }
    const menu = input.startsWith("/") ? completions(input) : [];
    if (key.tab) {
      if (menu.length) {
        const c = menu[Math.min(menuIndex, menu.length - 1)]!;
        setInput(`/${c.name}${c.args ? " " : ""}`);
        setCursor(c.name.length + 1 + (c.args ? 1 : 0));
        return;
      }
      return cycle(key.shift ? -1 : 1);
    }
    if (key.return) return submit();
    if (key.pageUp) return setScroll((s) => Math.max(0, s - 20));
    if (key.pageDown) return setScroll((s) => s + 20);
    if (key.upArrow) {
      if (menu.length) return setMenuIndex((i) => Math.max(0, i - 1));
      if (overlay.kind === "diff" || overlay.kind === "board") return setScroll((s) => Math.max(0, s - 1));
      if (!history.length) return;
      const pos = histPos < 0 ? history.length - 1 : Math.max(0, histPos - 1);
      setHistPos(pos);
      setInput(history[pos]!);
      setCursor(history[pos]!.length);
      return;
    }
    if (key.downArrow) {
      if (menu.length) return setMenuIndex((i) => Math.min(menu.length - 1, i + 1));
      if (overlay.kind === "diff" || overlay.kind === "board") return setScroll((s) => s + 1);
      if (histPos < 0) return;
      const pos = histPos + 1;
      if (pos >= history.length) {
        setHistPos(-1);
        setInput("");
        setCursor(0);
      } else {
        setHistPos(pos);
        setInput(history[pos]!);
        setCursor(history[pos]!.length);
      }
      return;
    }
    if (key.leftArrow) return setCursor((c) => Math.max(0, c - 1));
    if (key.rightArrow) return setCursor((c) => Math.min(input.length, c + 1));
    if (key.backspace || key.delete) {
      if (cursor === 0) return;
      setInput((v) => v.slice(0, cursor - 1) + v.slice(cursor));
      setCursor((c) => c - 1);
      setMenuIndex(0);
      return;
    }
    if (key.ctrl || key.meta || !ch) return;
    // Pasted text (or a fast terminal) can deliver characters and Enter in one chunk.
    const nl = ch.search(/[\r\n]/);
    if (nl >= 0) return submit(input.slice(0, cursor) + ch.slice(0, nl) + input.slice(cursor));
    setInput((v) => v.slice(0, cursor) + ch + v.slice(cursor));
    setCursor((c) => c + ch.length);
    setMenuIndex(0);
  });

  if (!snap) return <Text>{store.error ? `error: ${store.error}` : "connecting to the daemon…"}</Text>;

  // ── data ──────────────────────────────────────────────────────────────
  const routeModel = (route: string | null) => snap.routes.find((r) => r.route === route)?.model ?? "default";
  const working = workers.filter((w) => w.state === "RUNNING").length;
  const queued = tasks.filter((x) => ["QUEUED", "PAUSED", "REPAIRING"].includes(x.state)).length;
  const needs = tasks.filter((x) => x.state === "NEEDS_HUMAN").length + snap.approvals.length;
  const paused = snap.routes.filter((r) => r.pausedUntil).map((r) => r.vendor);
  const toasts = store.toasts.filter((x) => Date.now() - x.at < 8000).slice(-2);
  const teamFeed = store.local.get("_team") ?? [];
  const focusTaskId = focusWorker ? paneTask(focusWorker)?.id : undefined;
  const feedList = focusWorker ? store.stream(focusWorker.id, focusTaskId) : teamFeed;
  // The banner greets every launch, like Claude Code, until you start talking or pick an agent.
  const fresh = teamFeed.length === 0 && !focusWorker;
  const home = overlay.kind === "none";
  const menuRows = input.startsWith("/") ? Math.min(7, completions(input).length) : 0;

  const rowsFor = (): AgentRow[] =>
    workers.map((w) => {
      const st = statusOf(w);
      const live = w.taskId ? tasks.find((x) => x.id === w.taskId) : undefined;
      const next = !live ? tasks.find((x) => (w.role === "reviewer" ? x.state === "REVIEWING" : x.role === w.role && ["QUEUED", "REPAIRING", "PAUSED"].includes(x.state))) : undefined;
      const cost = live ? store.cost.get(live.id)?.usd : undefined;
      return {
        id: w.id, tool: `${w.vendor}/${routeModel(w.route)}`, status: st.label, statusColor: st.color, busy: w.state === "RUNNING",
        task: live ? `${live.id} ${live.title}` : next ? `next: ${next.id} ${next.title}` : "", taskDim: !live, elapsedMs: w.elapsedMs,
        context: live ? fmtTokens(store.context.get(live.id)) : "", cost: cost !== undefined && cost !== null ? `$${cost.toFixed(2)}` : live ? "—" : "",
      };
    });

  const paneFor = (w: WorkerView, width: number, height: number, focused: boolean, zoomed: boolean) => {
    const st = statusOf(w);
    const task = paneTask(w);
    const live = Boolean(w.taskId);
    const files = task ? (store.files.get(task.id) ?? []) : [];
    const ins = files.reduce((n, f) => n + f.insertions, 0);
    const del = files.reduce((n, f) => n + f.deletions, 0);
    const ctx = task ? store.context.get(task.id) : undefined;
    const d = task ? store.details.get(task.id) : undefined;
    const lastChecks = [...(d?.runs ?? [])].reverse().find((r) => r.checks.length)?.checks ?? [];
    const extra = zoomed && task
      ? [
          { label: "brief", value: (d?.body ?? "").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("<!--")) ?? task.title },
          ...(d?.acceptance.length ? [{ label: "accept", value: d.acceptance.map((x) => `· ${x}`).join("  ") }] : []),
          { label: "files", value: files.length ? files.map((f) => `${f.path} +${f.insertions} -${f.deletions}`).join(" · ") : "no changes yet" },
          { label: "checks", value: lastChecks.length ? `${lastChecks.map((c) => `${c.ok ? "✓" : "✗"} ${c.checkId}`).join(" ")}  attempt ${Math.max(1, task.attempts)}/${task.attemptsMax}` : "not run yet", color: lastChecks.some((c) => !c.ok) ? C.warn : undefined },
          ...(task.branch ? [{ label: "branch", value: task.branch }] : []),
        ]
      : [];
    return (
      <Pane
        key={w.id}
        id={w.id}
        vendor={w.vendor}
        model={routeModel(w.route)}
        status={st.label}
        statusColor={st.color}
        busy={w.state === "RUNNING"}
        frame={frame}
        subtitle={task ? `${task.id} ${task.title}${live ? "" : ` · ${task.state.toLowerCase().replace("_", " ")}`}` : w.role === "reviewer" ? "reviews tasks when their checks pass" : w.role === "planner" ? "splits explicit /plan requests" : w.role === "lead" ? "checks each finished round and sets follow-ups" : `waiting for work`}
        meta={task ? `${w.elapsedMs !== null ? `${duration(w.elapsedMs)} · ` : ""}${files.length ? `${files.length} file${files.length === 1 ? "" : "s"} +${ins} -${del}` : "no changes"}${ctx ? ` · ${fmtTokens(ctx)} ctx` : ""}` : ""}
        entries={store.stream(w.id, task?.id)}
        extra={extra}
        idleHint={w.role === "reviewer" || w.role === "planner" || w.role === "lead" ? "" : "type here after Tab, or message the team"}
        width={width}
        height={height}
        focused={focused}
        t={t}
      />
    );
  };


  const homeAgents: WelcomeAgent[] = workers.map((w) => {
    const st = statusOf(w);
    return { id: w.id, vendor: w.vendor, model: routeModel(w.route), status: st.label, statusColor: st.color, focused: focusWorker?.id === w.id };
  });
  const maxAgents = 8;
  const welcomeRows = 2 + 3 + Math.min(homeAgents.length, maxAgents) + (homeAgents.length > maxAgents ? 1 : 0);
  const bigBanner = columns >= BIG_BANNER_WIDTH + 2 && rows >= BIG_BANNER.length + welcomeRows + 12;
  const bannerRows = bigBanner ? BIG_BANNER.length : SMALL_BANNER.length;
  const activity: ActivityItem[] = workers
    .filter((w) => w.state === "RUNNING")
    .slice(0, 5)
    .map((w) => {
      const task = paneTask(w);
      const act = task ? store.lastActivity(task.id) : undefined;
      const now = act ? (act.kind === "tool" ? `${act.text} ${act.detail ?? ""}`.trim() : act.kind === "edit" ? `editing ${act.text}` : act.kind === "check" ? act.text : act.text.replace(/\s+/g, " ")) : "";
      return { id: w.id, vendor: w.vendor, what: task ? `${task.id} ${task.title}` : statusOf(w).label, now: now.slice(0, 60), time: duration(w.elapsedMs), focused: focusWorker?.id === w.id };
    });
  const fullHeader = home && fresh && rows >= bannerRows + welcomeRows + 10;
  const headerRows = fullHeader ? bannerRows + 1 + welcomeRows + 2 : 1;
  const bottomRows = 3 + menuRows + 1 + toasts.length + (home ? activity.length : 0);
  const areaHeight = Math.max(8, rows - headerRows - bottomRows);
  const feedRows = Math.max(0, Math.min(feedList.length, focusWorker ? 12 : 8, areaHeight));

  // ── the main area: panes, or an overlay ───────────────────────────────
  let area: React.ReactNode;
  if (overlay.kind === "help") area = <Help t={t} />;
  else if (overlay.kind === "review" || overlay.kind === "diff") area = <ReviewView data={overlay.data} showDiff={overlay.kind === "diff"} width={columns} height={areaHeight} scroll={scroll} />;
  else if (overlay.kind === "agents")
    area = (
      <Box flexDirection="column">
        <Text color={C.dim}>── who is doing what ──</Text>
        <AgentTable rows={rowsFor()} selected={Math.max(0, focus - 1)} width={columns} frame={frame} />
      </Box>
    );
  else if (overlay.kind === "usage")
    area = (
      <Box flexDirection="column">
        <Text color={C.dim}>── usage (source in brackets; unknown is never shown as 0%) ──</Text>
        {snap.routes.map((r) => (
          <Text key={r.route} wrap="truncate-end">
            {" "}
            {r.route.padEnd(18)}
            {r.windows.length === 0 ? <Text color={C.dim}>unknown</Text> : r.windows.map((w) => `${w.kind} ${w.display}${w.detail ? ` (${w.detail})` : ""} resets ${resetText(snap.now, w.resetsAt)} [${w.source}]${w.stale ? " stale" : ""}`).join("   ")}
            {r.pausedUntil ? <Text color={C.warn}> paused until {resetText(snap.now, r.pausedUntil)}</Text> : null}
          </Text>
        ))}
      </Box>
    );
  else if (overlay.kind === "tasks")
    area = (
      <Box flexDirection="column">
        <Text color={C.dim}>── tasks ──</Text>
        {tasks.map((x) => (
          <Text key={x.id} wrap="truncate-end">
            {" "}
            {x.id} <Text color={stateColor(x.state)}>{x.state.toLowerCase().padEnd(12)}</Text> {x.role.padEnd(10)} {x.title}
            <Text color={C.dim}>{x.dependsOn.length ? `  after ${x.dependsOn.join(",")}` : ""}</Text>
          </Text>
        ))}
      </Box>
    );
  else if (overlay.kind === "board") {
    const lines = overlay.text.split("\n");
    area = (
      <Box flexDirection="column">
        {lines.slice(scroll, scroll + areaHeight).map((l, i) => (
          <Text key={i} wrap="truncate-end" color={l.startsWith("#") ? t.accent : l.startsWith("_") ? C.dim : undefined} bold={l.startsWith("#")}>
            {l.replace(/\*\*/g, "").replace(/`/g, "") || " "}
          </Text>
        ))}
      </Box>
    );
  } else if (overlay.kind === "zoom" && focusWorker) area = paneFor(focusWorker, columns, areaHeight, true, true);
  else if (overlay.kind === "panes") {
    const n = Math.max(1, workers.length);
    // Balance the grid: 5 agents on a wide screen are 3 + 2, not 4 + 1.
    const maxCols = Math.max(1, Math.min(n, Math.floor(columns / 36)));
    const rowCount = Math.ceil(n / maxCols);
    const cols = Math.ceil(n / rowCount);
    const h = Math.max(7, Math.floor(areaHeight / rowCount));
    const w = Math.floor(columns / cols);
    area = (
      <Box flexDirection="column">
        {Array.from({ length: rowCount }, (_, r) => (
          <Box key={r} flexDirection="row">
            {workers.slice(r * cols, (r + 1) * cols).map((x) => paneFor(x, w, h, focusWorker?.id === x.id, false))}
          </Box>
        ))}
      </Box>
    );
  }

  const target = focusWorker ? focusWorker.id : TEAM;
  const placeholder = focusWorker
    ? focusWorker.role === "planner"
      ? "describe what you want built"
      : focusWorker.role === "reviewer"
        ? "the reviewer works on its own; Tab to another agent"
        : `message ${focusWorker.id}…`
    : workers.length
      ? "tell your team what to build…"
      : "no agents yet: /setup";

  const shortFolder = snap.project.root.replace(os.homedir(), "~");
  const header = fullHeader ? (
    <Box flexDirection="column">
      {(bigBanner ? BIG_BANNER : SMALL_BANNER).map((l, i) => (
        <Text key={i}>
          {gradient(l, t.gradient).map((g, k) => (
            <Text key={k} color={g.color} bold>
              {g.ch}
            </Text>
          ))}
        </Text>
      ))}
      <Text> </Text>
      <Welcome t={t} version={version} project={snap.project.name} folder={shortFolder} branch={snap.project.integrationBranch} agents={homeAgents} width={columns} maxAgents={maxAgents} unlanded={store.unlanded} />
      <Text color={C.dim}> Describe what you want built and I'll split it across your agents.  <Text color={t.accent}>/agents</Text> who is doing what · <Text color={t.accent}>/usage</Text> limits · <Text color={t.accent}>Tab</Text> pick an agent</Text>
    </Box>
  ) : (
    <Text wrap="truncate-end">
      <GradientText text="✦ harness" t={t} bold />
      <Text color={C.dim}> {snap.project.name}  </Text>
      {homeAgents.map((a) => {
        const v = VENDOR[a.vendor] ?? VENDOR.fake!;
        return (
          <Text key={a.id} color={a.focused ? undefined : C.dim} bold={a.focused}>
            <Text color={v.color}>{v.icon}</Text> {a.id}
            {"  "}
          </Text>
        );
      })}
    </Text>
  );

  const feedNode = (
    <Box flexDirection="column">
      {focusWorker && feedList.length === 0 ? (
        <Text color={C.dim}> {focusWorker.id} has no session yet. Message it, or give the team work.</Text>
      ) : null}
      {feedList.slice(-feedRows).map((e, i) => {
        const l = entryLine(e, t);
        return l ? (
          <Text key={i} wrap="truncate-end">
            {" "}
            <Text color={l.prefixColor} dimColor={l.dim}>
              {l.prefix}
            </Text>
            <Text color={l.color} dimColor={l.dim}>
              {l.text}
            </Text>
          </Text>
        ) : null;
      })}
    </Box>
  );

  return (
    <Box flexDirection="column" width={columns}>
      {header}
      {home ? (
        <Box flexDirection="column" flexGrow={1}>
          {focusWorker ? (
            <Text color={C.dim}>
              {" "}
              ── {focusWorker.id} · {statusOf(focusWorker).label}
              {paneTask(focusWorker) ? ` · ${paneTask(focusWorker)!.id} ${paneTask(focusWorker)!.title}` : ""} ──
            </Text>
          ) : null}
          {feedNode}
          <Activity items={activity} frame={frame} />
        </Box>
      ) : (
        <Box height={areaHeight} flexDirection="column" overflow="hidden">
          {area}
        </Box>
      )}
      {toasts.map((x, i) => (
        <Text key={i} wrap="truncate-end" color={x.kind === "err" ? C.bad : x.kind === "warn" ? C.warn : C.dim}>
          {" "}
          {x.text}
        </Text>
      ))}
      <ChatBar value={input} cursor={cursor} menuIndex={menuIndex} placeholder={placeholder} target={target} width={columns} t={t} />
      <StatusLine
        t={t}
        width={columns}
        segments={[
          `✦ ${snap.project.name}`,
          snap.scheduler.running ? "▶ running" : "■ stopped",
          `${working} working · ${queued} queued${needs ? ` · ${needs} need you` : ""}${paused.length ? ` · ${paused.join(", ")} paused` : ""}`,
        ]}
        right="/agents · /usage · /help · Tab · ^C quit "
      />
    </Box>
  );
}
