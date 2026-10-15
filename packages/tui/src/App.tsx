import fs from "node:fs";
import path from "node:path";
import { useEffect, useMemo, useReducer, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { StatusSnapshot, WorkerView } from "@harness/daemon";
import { completions, parseInput } from "./commands.js";
import { AgentTabs } from "./components/AgentTabs.js";
import { ChatBar } from "./components/ChatBar.js";
import { Help } from "./components/Help.js";
import { Banner, GradientText, pickBanner } from "./components/Logo.js";
import { ReviewView, type ReviewData } from "./components/ReviewView.js";
import { Sidebar } from "./components/Sidebar.js";
import { StatusLine } from "./components/StatusLine.js";
import { Stream } from "./components/Stream.js";
import { UsagePills } from "./components/UsagePills.js";
import { bar, resetText } from "./format.js";
import type { TuiStore } from "./store.js";
import { THEME_NAMES, THEMES, VENDOR, type Theme } from "./theme.js";

/** Why the UI closed: the caller acts on it (attach runs a CLI, stop stops the daemon). */
export type UiExit = { action: "quit" } | { action: "stop" } | { action: "attach"; target: string };

export interface AppProps {
  store: TuiStore;
  onExit(r: UiExit): void;
  /** Fixed size for tests. */
  size?: { columns: number; rows: number };
  theme?: string;
  onTheme?(name: string): void;
  /** Shown once in the stream when the UI opens (e.g. "set up harness.yaml for you"). */
  welcome?: string;
}

type Overlay = { kind: "none" } | { kind: "help" } | { kind: "usage" } | { kind: "review" | "diff"; data: ReviewData };

const taskId = (s: string) => {
  const t = s.trim().toUpperCase();
  const m = /^T?-?(\d+)$/.exec(t);
  return m ? `T-${String(Number(m[1])).padStart(3, "0")}` : t;
};

export function App({ store, onExit, size, theme: themeName, onTheme, welcome }: AppProps) {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => store.onChange(force), [store]);
  const snap: StatusSnapshot | null = store.snapshot;
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = size?.columns ?? stdout.columns ?? 120;
  const rows = size?.rows ?? stdout.rows ?? 40;

  const [t, setTheme] = useState<Theme>(THEMES[themeName ?? "neon"] ?? THEMES.neon!);
  const [sel, setSel] = useState(0);
  const [pinnedTask, setPinnedTask] = useState<string | undefined>();
  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [histPos, setHistPos] = useState(-1);
  const [scroll, setScroll] = useState(0);
  const [overlay, setOverlay] = useState<Overlay>({ kind: "none" });
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setFrame((f) => f + 1), 120);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (welcome) store.note("_welcome", "ok", welcome);
  }, [welcome, store]);

  const workers: WorkerView[] = useMemo(() => {
    const ws = snap?.workers ?? [];
    const rank = (w: WorkerView) => (w.role === "planner" ? 2 : w.role === "reviewer" ? 1 : 0);
    return [...ws].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  }, [snap]);
  // Start on whoever is busy, like opening Claude Code mid-task.
  const [picked, setPicked] = useState(false);
  useEffect(() => {
    if (picked || !workers.length) return;
    const busy = workers.findIndex((w) => w.state === "RUNNING");
    if (busy > 0) setSel(busy);
    setPicked(true);
  }, [workers, picked]);
  const worker = workers[Math.min(sel, Math.max(0, workers.length - 1))];
  const view = worker?.id ?? "_";
  const recentForRole = (role: string) =>
    [...(snap?.tasks ?? [])].filter((x) => x.role === role && x.lastRunId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.id;
  const currentTask = pinnedTask ?? (worker ? (store.taskForWorker(worker.id) ?? recentForRole(worker.role)) : undefined);
  useEffect(() => {
    if (currentTask) void store.loadTask(currentTask);
  }, [currentTask, store]);

  const menu = completions(input);
  const writeRoles = [...new Set(workers.map((w) => w.role))].filter((r) => r !== "reviewer" && r !== "planner");

  const note = (kind: Parameters<TuiStore["note"]>[1], text: string, detail?: string) => store.note(view, kind, text, detail);
  const call = async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T | undefined> => {
    try {
      const r = await store.api.call<T>(method, params);
      void store.refresh();
      return r;
    } catch (e) {
      note("err", (e as Error).message);
      return undefined;
    }
  };
  const quit = (r: UiExit) => {
    onExit(r);
    exit();
  };
  const select = (i: number) => {
    setSel(((i % Math.max(1, workers.length)) + workers.length) % Math.max(1, workers.length));
    setPinnedTask(undefined);
    setScroll(0);
  };
  const openReview = async (kind: "review" | "diff", id?: string) => {
    const tid = id ? taskId(id) : currentTask;
    if (!tid) return note("warn", "no task here yet");
    const r = await call<ReviewData>("review.show", { id: tid });
    if (r) {
      setScroll(0);
      setOverlay({ kind, data: r });
    }
  };

  async function run(raw: string): Promise<void> {
    const p = parseInput(raw);
    if (p.kind === "empty") return;
    if (p.kind === "message") return send(p.text);
    if (!p.known) return note("warn", `unknown command /${p.name}. Type /help`);
    const a = p.args;
    switch (p.name) {
      case "help":
        return setOverlay({ kind: "help" });
      case "usage":
        return setOverlay({ kind: "usage" });
      case "quit":
        return quit({ action: "quit" });
      case "stop":
        return quit({ action: "stop" });
      case "clear":
        store.local.delete(view);
        if (currentTask) store.entries.set(currentTask, []);
        return force();
      case "theme": {
        const name = a || THEME_NAMES[(THEME_NAMES.indexOf(t.name) + 1) % THEME_NAMES.length]!;
        const next = THEMES[name];
        if (!next) return note("warn", `themes: ${THEME_NAMES.join(", ")}`);
        setTheme(next);
        onTheme?.(name);
        return note("ok", `theme: ${name}${next.powerline ? " (needs a powerline font)" : ""}`);
      }
      case "switch": {
        if (!a) return select(sel + 1);
        const byWorker = workers.findIndex((w) => w.id === a || w.id.startsWith(a) || w.role === a);
        if (byWorker >= 0) return select(byWorker);
        const tid = taskId(a);
        const task = snap?.tasks.find((x) => x.id === tid);
        if (!task) return note("warn", `no agent or task "${a}"`);
        const wi = workers.findIndex((w) => w.role === task.role);
        if (wi >= 0) setSel(wi);
        setPinnedTask(tid);
        return setScroll(0);
      }
      case "agents":
        for (const w of workers) note("sys", `${w.id} (${w.vendor}) ${w.state}${w.taskId ? ` on ${w.taskId} ${w.taskTitle ?? ""}` : w.waitingReason ? ` · ${w.waitingReason}` : ""}`);
        return;
      case "task": {
        const m = /(?:^|\s)@([\w-]+)\s*$/.exec(a);
        const role = m?.[1] ?? (worker && writeRoles.includes(worker.role) ? worker.role : writeRoles[0]);
        const title = (m ? a.slice(0, m.index) : a).trim();
        if (!title || !role) return note("warn", "usage: /task <title> [@role]");
        return createTask(title, role, title);
      }
      case "plan": {
        if (!a) return note("warn", "usage: /plan <file.md>   (or type your idea to the planner)");
        const file = path.resolve(snap?.project.root ?? ".", a);
        if (!fs.existsSync(file)) return note("err", `no such file: ${a}`);
        return plan(fs.readFileSync(file, "utf8"), a);
      }
      case "approve": {
        const arg = a.toLowerCase();
        if (arg === "all") {
          const r = await call<{ approved: string[] }>("task.approve", { all: true });
          if (r) note("ok", r.approved?.length ? `approved ${r.approved.join(", ")} ✅` : "nothing to approve");
          return;
        }
        if (/^a-\d+$/.test(arg)) {
          if ((await call("approval.grant", { id: arg.toUpperCase() })) !== undefined) note("ok", `${arg.toUpperCase()} granted 🔓`);
          return;
        }
        const tid = a ? taskId(a) : (snap?.tasks.find((x) => x.id === currentTask && x.state === "DRAFT")?.id ?? snap?.approvals[0]?.taskId ?? undefined);
        if (!tid) return note("warn", "nothing to approve here");
        const r = await call<{ approved: string[] }>("task.approve", { ids: [tid] });
        if (r) note("ok", r.approved?.length ? `approved ${r.approved.join(", ")} ✅` : `${tid} has nothing pending`);
        return;
      }
      case "run":
        await call("run");
        return note("ok", "scheduler running 🚀");
      case "pause":
        if (a === "all") {
          await call("pause", { all: true });
          return note("warn", "paused everything");
        }
        if (!currentTask) return note("warn", "nothing to pause here");
        await call("pause", { task: currentTask });
        return note("warn", `pausing ${currentTask} (checkpointing first)`);
      case "resume":
        if (a === "all" || !currentTask) {
          await call("resume", { all: true });
          return note("ok", "scheduler running 🚀");
        }
        await call("resume", { task: currentTask });
        return note("ok", `resumed ${currentTask}`);
      case "review":
        return openReview("review", a || undefined);
      case "diff":
        return openReview("diff", a || undefined);
      case "accept": {
        const tid = a ? taskId(a) : currentTask;
        if (!tid) return note("warn", "which task?");
        const r = await call<{ state: string }>("review.accept", { id: tid });
        if (r) note(r.state === "MERGED" ? "ok" : "warn", `${tid} ${r.state}${r.state === "MERGED" ? " 🎉" : ""}`);
        return;
      }
      case "reject":
        if (!currentTask || !a) return note("warn", "usage: /reject <comment>  (on the task's agent)");
        await call("review.reject", { id: currentTask, comment: a });
        return note("warn", `sent ${currentTask} back`);
      case "cancel": {
        const tid = a ? taskId(a) : currentTask;
        if (!tid) return note("warn", "which task?");
        await call("task.cancel", { id: tid });
        return note("warn", `${tid} cancelled`);
      }
      case "burst": {
        const on = a ? a === "on" : !snap?.scheduler.burst;
        await call("burst.set", { enabled: on });
        return note("ok", `burst ${on ? "on ⚡" : "off"}`);
      }
      case "limits": {
        const [route, window, ...v] = a.split(/\s+/);
        if (!route || !window || !v.length) return note("warn", "usage: /limits <route> <5h|7d|budget> <85% | 40 runs/day>");
        if ((await call("limits.set", { route, window, budget: v.join(" ") })) !== undefined) note("ok", `${route} ${window} → ${v.join(" ")}`);
        return;
      }
      case "attach":
        if (!currentTask) return note("warn", "no task to take over here");
        return quit({ action: "attach", target: currentTask });
    }
  }

  async function createTask(title: string, role: string, body: string) {
    const short = title.split("\n")[0]!.slice(0, 80);
    note("you", body);
    const r = await call<{ id: string }>("task.add", { title: short, role, body: body === short ? "" : body, approve: true });
    if (!r) return;
    if (!snap?.scheduler.running) await call("run");
    note("ok", `✨ ${r.id} created for ${role} and started`);
    setPinnedTask(r.id);
  }

  async function plan(document: string, source: string) {
    note("you", source === "chat" ? document : `/plan ${source}`);
    note("sys", "the planner is thinking…");
    const r = await call<{ tasks: { id: string; title: string; role: string }[]; summary: string }>("plan", { document, source });
    if (!r) return;
    if (r.summary) note("say", r.summary);
    for (const x of r.tasks) note("sys", `📝 ${x.id} ${x.role}: ${x.title}`);
    note("ok", `${r.tasks.length} draft task(s). /approve all to start them`);
  }

  async function send(text: string) {
    if (!worker) return note("warn", "no agents configured");
    if (worker.role === "planner") return plan(text, "chat");
    const task = currentTask ? snap?.tasks.find((x) => x.id === currentTask) : undefined;
    if (task && !["MERGED", "CANCELLED", "DRAFT"].includes(task.state)) {
      const r = await call<{ delivery: string }>("agent.message", { target: task.id, text });
      if (r) note("sys", r.delivery === "now" ? `delivered to ${task.id} ✉️` : r.delivery === "sent-back" ? `${task.id} sent back with your note` : `${task.id} will read it on its next turn`);
      return;
    }
    if (worker.role === "reviewer") return note("sys", "the reviewer checks work automatically once its checks pass. Switch to an agent with Tab");
    return createTask(text, worker.role, text);
  }

  const submit = (override?: string) => {
    let text = override ?? input;
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
    if (key.ctrl && ch === "c") {
      if (input) {
        setInput("");
        setCursor(0);
      } else quit({ action: "quit" });
      return;
    }
    if (key.ctrl && ch === "d") return quit({ action: "quit" });
    if (key.ctrl && ch === "l") return void run("/clear");
    if (key.escape) {
      if (overlay.kind !== "none") return setOverlay({ kind: "none" });
      setInput("");
      setCursor(0);
      return;
    }
    if (key.pageUp) return setScroll((s) => s + 10);
    if (key.pageDown) return setScroll((s) => Math.max(0, s - 10));
    if (key.tab) {
      if (menu.length) {
        const c = menu[Math.min(menuIndex, menu.length - 1)]!;
        setInput(`/${c.name}${c.args ? " " : ""}`);
        setCursor(c.name.length + 1 + (c.args ? 1 : 0));
        return;
      }
      return select(sel + (key.shift ? -1 : 1));
    }
    if (key.return) return submit();
    if (key.upArrow) {
      if (menu.length) return setMenuIndex((i) => Math.max(0, i - 1));
      if (overlay.kind === "diff") return setScroll((s) => Math.max(0, s - 1));
      if (!history.length) return;
      const pos = histPos < 0 ? history.length - 1 : Math.max(0, histPos - 1);
      setHistPos(pos);
      setInput(history[pos]!);
      setCursor(history[pos]!.length);
      return;
    }
    if (key.downArrow) {
      if (menu.length) return setMenuIndex((i) => Math.min(menu.length - 1, i + 1));
      if (overlay.kind === "diff") return setScroll((s) => s + 1);
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
    if (nl >= 0) {
      const full = input.slice(0, cursor) + ch.slice(0, nl) + input.slice(cursor);
      if (/^\/\S*$/.test(full.trim()) && completions(full.trim()).length) {
        // a typed command name submits as-is (no menu completion surprise)
        setInput("");
        setCursor(0);
        setHistory((h) => [...h.filter((x) => x !== full), full].slice(-100));
        void run(full);
        return;
      }
      return submit(full);
    }
    setInput((v) => v.slice(0, cursor) + ch + v.slice(cursor));
    setCursor((c) => c + ch.length);
    setMenuIndex(0);
  });

  if (!snap) return <Text>{store.error ? `error: ${store.error}` : "✦ connecting to the daemon…"}</Text>;

  // ── layout ────────────────────────────────────────────────────────────
  const merged = snap.tasks.filter((x) => x.state === "MERGED").length;
  const active = snap.tasks.filter((x) => ["RUNNING", "GATING", "REPAIRING", "REVIEWING"].includes(x.state)).length;
  const queued = snap.tasks.filter((x) => ["QUEUED", "PAUSED"].includes(x.state)).length;
  const needs = snap.tasks.filter((x) => x.state === "NEEDS_HUMAN").length + snap.approvals.length;
  const toasts = store.toasts.filter((x) => Date.now() - x.at < 8000).slice(-2);
  const sidebar = columns >= 100;
  const sideWidth = sidebar ? Math.max(32, Math.floor(columns * 0.32)) : 0;
  const mainWidth = columns - sideWidth - 1;
  const menuRows = Math.min(menu.length, 8);
  const bottomRows = 4 + menuRows + toasts.length;
  const entries = store.stream(view, currentTask);
  const home = entries.length === 0 && overlay.kind === "none";
  const baseHeaderRows = 3 + Math.ceil(snap.routes.length / 2);
  // pickBanner's base layout reserves eight rows outside the stream. Adjust
  // its height budget when wrapped routes, menus or toasts use more space.
  const banner = pickBanner(columns, rows - (baseHeaderRows + bottomRows - 8), process.env.HARNESS_BANNER);
  const bannerRows = home ? (banner === "xl" ? 12 : banner === "big" ? 6 : banner === "small" ? 3 : 0) : 0;
  const headerRows = baseHeaderRows + bannerRows;
  const midRows = Math.max(2, rows - headerRows - bottomRows);
  const placeholder =
    worker?.role === "planner"
      ? "describe what you want built: the planner turns it into tasks"
      : currentTask && snap.tasks.find((x) => x.id === currentTask && !["MERGED", "CANCELLED"].includes(x.state))
        ? `message ${worker?.id} about ${currentTask}…   / for commands`
        : `tell ${worker?.id ?? "an agent"} what to build…   / for commands`;
  const v = worker ? (VENDOR[worker.vendor] ?? VENDOR.fake!) : VENDOR.fake!;
  const header = (
    <Box width={columns} justifyContent="space-between">
      <Text>
        <GradientText text="✦ harness" t={t} bold />
        <Text color={t.dim}> · {snap.project.name}</Text>
      </Text>
      <Text color={t.dim}>{new Date().toTimeString().slice(0, 5)}</Text>
    </Box>
  );
  const empty = (
    <Box flexDirection="column" paddingTop={1}>
      <Text> </Text>
      {(store.local.get("_welcome") ?? []).map((w, i) => (
        <Text key={i} color={t.ok}>
          ✔ {w.text}
        </Text>
      ))}
      <Text>
        <Text color={v.color}>{v.icon} </Text>
        {worker ? `${worker.id} is ${worker.state.toLowerCase()}.` : "No agents yet."} Type what you want and press Enter.
      </Text>
      <Text color={t.dim}>Tab switches agents · / opens commands · /help for everything</Text>
    </Box>
  );

  let main: React.ReactNode;
  if (overlay.kind === "help") main = <Help t={t} />;
  else if (overlay.kind === "usage")
    main = (
      <Box flexDirection="column" borderStyle="round" borderColor={t.accent} paddingX={1} width={mainWidth}>
        <Text bold>📊 usage (source in brackets; unknown is never 0%)</Text>
        {snap.routes.map((r) => (
          <Box key={r.route} flexDirection="column">
            <Text bold>
              {(VENDOR[r.vendor] ?? VENDOR.fake!).icon} {r.route} <Text color={t.dim}>({r.vendor}, {r.auth})</Text>
              {r.pausedUntil ? <Text color={t.warn}> paused until {resetText(snap.now, r.pausedUntil)}</Text> : null}
            </Text>
            {r.windows.length === 0 ? <Text color={t.dim}>  5h unknown · 7d unknown</Text> : null}
            {r.windows.map((w) => (
              <Text key={w.kind} dimColor={w.stale}>
                {"  "}
                {w.kind.padEnd(6)} <Text color={t.accent}>{bar(w.usedPct, 20)}</Text> {w.display.padStart(7)} {w.detail ? `(${w.detail}) ` : ""}resets {resetText(snap.now, w.resetsAt)} cap {w.capPct}% [{w.source}]
                {w.stale ? " stale" : ""}
              </Text>
            ))}
          </Box>
        ))}
        <Text color={t.dim}>Esc to close · /limits &lt;route&gt; &lt;window&gt; &lt;value&gt; to change caps</Text>
      </Box>
    );
  else if (overlay.kind === "review" || overlay.kind === "diff") main = <ReviewView data={overlay.data} showDiff={overlay.kind === "diff"} width={mainWidth} height={midRows} scroll={scroll} t={t} />;
  else
    main = (
      <Box flexDirection="column" width={mainWidth}>
        <Text wrap="truncate-end">
          <Text color={v.color} bold>
            {v.icon} {worker?.id ?? ""}
          </Text>
          <Text color={t.dim}>
            {currentTask ? ` · ${currentTask} ${snap.tasks.find((x) => x.id === currentTask)?.title ?? ""}` : " · idle"}
            {pinnedTask ? " (pinned; Tab to unpin)" : ""}
          </Text>
        </Text>
        <Stream entries={entries} width={mainWidth} height={midRows - 1} scroll={scroll} t={t} empty={empty} />
      </Box>
    );

  return (
    <Box flexDirection="column" width={columns}>
      {header}
      {home ? <Box paddingX={1} flexDirection="column"><Banner t={t} tier={banner} /></Box> : null}
      <UsagePills routes={snap.routes} now={snap.now} t={t} />
      <AgentTabs workers={workers} selected={sel} frame={frame} t={t} />
      <Box flexDirection="row" height={midRows}>
        {main}
        {sidebar ? (
          <Box marginLeft={1}>
            <Sidebar files={currentTask ? (store.files.get(currentTask) ?? []) : []} tasks={snap.tasks} current={currentTask} cost={currentTask ? store.cost.get(currentTask) : undefined} width={sideWidth} height={midRows} t={t} />
          </Box>
        ) : null}
      </Box>
      {toasts.map((x, i) => (
        <Text key={i} wrap="truncate-end" color={x.kind === "ok" ? t.ok : x.kind === "err" ? t.bad : x.kind === "warn" ? t.warn : t.accent}>
          {" "}
          {x.text}
        </Text>
      ))}
      <ChatBar value={input} cursor={cursor} menuIndex={menuIndex} placeholder={placeholder} width={columns} t={t} />
      <StatusLine
        t={t}
        width={columns}
        segments={[`✦ ${snap.project.name}`, `⎇ ${snap.project.integrationBranch}`, snap.scheduler.running ? "▶ running" : "■ stopped", `${snap.scheduler.burst ? "⚡ burst" : "burst off"}`, `✅ ${merged}  ⚙ ${active}  ⏳ ${queued}${needs ? `  🙋 ${needs}` : ""}`]}
        right="/help · Tab agents · Ctrl-C quit "
      />
    </Box>
  );
}
