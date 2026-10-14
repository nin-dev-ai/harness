import fs from "node:fs";
import path from "node:path";
import { useEffect, useMemo, useReducer, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { StatusSnapshot, WorkerView } from "@harness/daemon";
import { completions, parseInput } from "./commands.js";
import { AgentTable, type AgentRow } from "./components/AgentTable.js";
import { CommandLine } from "./components/CommandLine.js";
import { DetailPane, type DetailLine } from "./components/DetailPane.js";
import { Help } from "./components/Help.js";
import { ReviewView, type ReviewData } from "./components/ReviewView.js";
import { resetText } from "./format.js";
import type { TuiStore } from "./store.js";
import { C, stateColor } from "./theme.js";

/** Why the UI closed: the caller acts on it (attach runs a CLI, stop stops the daemon). */
export type UiExit = { action: "quit" } | { action: "stop" } | { action: "attach"; target: string };

export interface AppProps {
  store: TuiStore;
  onExit(r: UiExit): void;
  /** Fixed size for tests. */
  size?: { columns: number; rows: number };
  /** Shown once at the bottom when the panel opens. */
  welcome?: string;
}

type Overlay = { kind: "none" } | { kind: "help" } | { kind: "usage" } | { kind: "tasks" } | { kind: "review" | "diff"; data: ReviewData };

const taskId = (s: string) => {
  const m = /^T?-?(\d+)$/i.exec(s.trim());
  return m ? `T-${String(Number(m[1])).padStart(3, "0")}` : s.trim().toUpperCase();
};

const fmtTokens = (n: number | undefined) => (n === undefined ? "—" : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

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
  return { label: "idle", color: C.dim };
}

/**
 * The management panel: who is working on what, with what context. No
 * output stream here; enter opens the evidence for a task, `/` runs commands.
 */
export function App({ store, onExit, size, welcome }: AppProps) {
  const [, force] = useReducer((n: number) => n + 1, 0);
  useEffect(() => store.onChange(force), [store]);
  const snap: StatusSnapshot | null = store.snapshot;
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = size?.columns ?? stdout.columns ?? 120;
  const rows = size?.rows ?? stdout.rows ?? 40;

  const [sel, setSel] = useState(0);
  const [cmd, setCmd] = useState<string | null>(null);
  const [cursor, setCursor] = useState(0);
  const [menuIndex, setMenuIndex] = useState(0);
  const [history, setHistory] = useState<string[]>([]);
  const [histPos, setHistPos] = useState(-1);
  const [overlay, setOverlay] = useState<Overlay>({ kind: "none" });
  const [scroll, setScroll] = useState(0);
  const [message, setMessage] = useState<{ text: string; color?: string | undefined } | null>(welcome ? { text: welcome } : null);
  const [frame, setFrame] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFrame((f) => f + 1), 150);
    return () => clearInterval(id);
  }, []);

  const workers: WorkerView[] = useMemo(() => {
    const rank = (w: WorkerView) => (w.state === "RUNNING" ? 0 : w.role === "planner" ? 3 : w.role === "reviewer" ? 2 : 1);
    return [...(snap?.workers ?? [])].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id));
  }, [snap]);
  const worker = workers[Math.min(sel, Math.max(0, workers.length - 1))];
  const tasks = snap?.tasks ?? [];
  const nextFor = (w: WorkerView) => {
    if (w.role === "reviewer") return tasks.find((t) => t.state === "REVIEWING");
    return tasks.find((t) => t.role === w.role && ["QUEUED", "REPAIRING", "PAUSED"].includes(t.state));
  };
  const recentFor = (w: WorkerView) => {
    const id = store.taskForWorker(w.id);
    return id ? tasks.find((t) => t.id === id) : [...tasks].filter((t) => t.role === w.role && t.lastRunId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  };
  const focusTask = worker ? (tasks.find((t) => t.id === worker.taskId) ?? nextFor(worker) ?? recentFor(worker)) : undefined;

  useEffect(() => {
    if (!focusTask) return;
    void store.loadTask(focusTask.id);
    void store.loadDetail(focusTask.id);
  }, [focusTask?.id, store]);

  const say = (text: string, color?: string) => setMessage({ text, color });
  const call = async <T,>(method: string, params: Record<string, unknown> = {}): Promise<T | undefined> => {
    try {
      const r = await store.api.call<T>(method, params);
      void store.refresh();
      return r;
    } catch (e) {
      say((e as Error).message, C.bad);
      return undefined;
    }
  };
  const quit = (r: UiExit) => {
    onExit(r);
    exit();
  };
  const openReview = async (kind: "review" | "diff", id?: string) => {
    const tid = id ? taskId(id) : focusTask?.id;
    if (!tid) return say("no task for this agent yet", C.warn);
    const r = await call<ReviewData>("review.show", { id: tid });
    if (r) {
      setScroll(0);
      setOverlay({ kind, data: r });
    }
  };
  const writeRoles = [...new Set(workers.map((w) => w.role))].filter((r) => r !== "reviewer" && r !== "planner");

  async function run(raw: string): Promise<void> {
    const p = parseInput(raw);
    if (p.kind === "empty") return;
    if (!p.known) return say(`unknown command /${p.name} (type /help)`, C.warn);
    const a = p.args;
    const current = focusTask?.id;
    switch (p.name) {
      case "help":
        return setOverlay({ kind: "help" });
      case "usage":
        return setOverlay({ kind: "usage" });
      case "tasks":
        return setOverlay({ kind: "tasks" });
      case "quit":
        return quit({ action: "quit" });
      case "stop":
        return quit({ action: "stop" });
      case "task": {
        const m = /(?:^|\s)@([\w-]+)\s*$/.exec(a);
        const role = m?.[1] ?? (worker && writeRoles.includes(worker.role) ? worker.role : undefined);
        const title = (m ? a.slice(0, m.index) : a).trim();
        if (!title || !role) return say(`usage: /task <title> @role   (roles: ${writeRoles.join(", ")})`, C.warn);
        const r = await call<{ id: string }>("task.add", { title, role, approve: true });
        if (r) say(`${r.id} added for ${role}${snap?.scheduler.running ? "" : " (scheduler stopped: r to run)"}`);
        return;
      }
      case "plan": {
        if (!a) return say("usage: /plan <file.md>", C.warn);
        const file = path.resolve(snap?.project.root ?? ".", a);
        if (!fs.existsSync(file)) return say(`no such file: ${a}`, C.bad);
        say("planning…");
        const r = await call<{ tasks: { id: string }[] }>("plan", { document: fs.readFileSync(file, "utf8"), source: a });
        if (r) say(`${r.tasks.length} draft task(s): ${r.tasks.map((t) => t.id).join(", ")}. /approve all to start them`);
        return;
      }
      case "approve": {
        const arg = a.toLowerCase();
        if (!arg) return say("usage: /approve <T-n|A-n|all>", C.warn);
        if (/^a-\d+$/.test(arg)) {
          if ((await call("approval.grant", { id: arg.toUpperCase() })) !== undefined) say(`${arg.toUpperCase()} granted`);
          return;
        }
        const r = await call<{ approved?: string[] }>("task.approve", arg === "all" ? { all: true } : { ids: [taskId(arg)] });
        if (r) say(r.approved?.length ? `approved ${r.approved.join(", ")}` : "nothing to approve");
        return;
      }
      case "msg":
        if (!current || !a) return say("usage: /msg <text>   (sent to the selected agent's task)", C.warn);
        if ((await call("agent.message", { target: current, text: a })) !== undefined) say(`note sent to ${current}`);
        return;
      case "run":
        if ((await call("run")) !== undefined) say("scheduler running");
        return;
      case "pause":
        if (a === "all") return void (await call("pause", { all: true }), say("paused everything", C.warn));
        if (!current) return say("nothing to pause", C.warn);
        if ((await call("pause", { task: current })) !== undefined) say(`pausing ${current} (work is checkpointed first)`, C.warn);
        return;
      case "resume":
        if (a === "all" || !current) return void (await call("resume", { all: true }), say("scheduler running"));
        if ((await call("resume", { task: current })) !== undefined) say(`resumed ${current}`);
        return;
      case "review":
        return openReview("review", a || undefined);
      case "diff":
        return openReview("diff", a || undefined);
      case "accept": {
        const tid = a ? taskId(a) : current;
        if (!tid) return say("which task?", C.warn);
        const r = await call<{ state: string }>("review.accept", { id: tid });
        if (r) say(`${tid} ${r.state.toLowerCase()}`, r.state === "MERGED" ? undefined : C.warn);
        return;
      }
      case "reject":
        if (!current || !a) return say("usage: /reject <comment>", C.warn);
        if ((await call("review.reject", { id: current, comment: a })) !== undefined) say(`${current} sent back`);
        return;
      case "cancel": {
        const tid = a ? taskId(a) : current;
        if (!tid) return say("which task?", C.warn);
        if ((await call("task.cancel", { id: tid })) !== undefined) say(`${tid} cancelled`);
        return;
      }
      case "limits": {
        const [route, win, ...v] = a.split(/\s+/);
        if (!route || !win || !v.length) return say("usage: /limits <route> <5h|7d|budget> <85% | 40 runs/day>", C.warn);
        if ((await call("limits.set", { route, window: win, budget: v.join(" ") })) !== undefined) say(`${route} ${win} set to ${v.join(" ")}`);
        return;
      }
      case "attach":
        if (!current) return say("no task to take over", C.warn);
        return quit({ action: "attach", target: current });
    }
  }

  const closeCmd = () => {
    setCmd(null);
    setCursor(0);
    setMenuIndex(0);
    setHistPos(-1);
  };
  const submitCmd = (text: string) => {
    const menu = completions(text);
    let line = text;
    if (menu.length && !/\s/.test(text.trim())) {
      const c = menu[Math.min(menuIndex, menu.length - 1)]!;
      if (c.args && text.trim() !== c.name) {
        setCmd(`${c.name} `);
        setCursor(c.name.length + 1);
        return;
      }
      line = c.name;
    }
    if (line.trim()) setHistory((h) => [...h.filter((x) => x !== line), line].slice(-50));
    closeCmd();
    void run(line);
  };

  useInput((ch, key) => {
    // command line mode
    if (cmd !== null) {
      const menu = completions(cmd);
      if (key.escape || (key.ctrl && ch === "c")) return closeCmd();
      if (key.return) return submitCmd(cmd);
      if (key.tab && menu.length) {
        const c = menu[Math.min(menuIndex, menu.length - 1)]!;
        setCmd(`${c.name}${c.args ? " " : ""}`);
        setCursor(c.name.length + (c.args ? 1 : 0));
        return;
      }
      if (key.upArrow) {
        if (menu.length && cmd) return setMenuIndex((i) => Math.max(0, i - 1));
        if (!history.length) return;
        const pos = histPos < 0 ? history.length - 1 : Math.max(0, histPos - 1);
        setHistPos(pos);
        setCmd(history[pos]!);
        setCursor(history[pos]!.length);
        return;
      }
      if (key.downArrow) {
        if (menu.length && cmd) return setMenuIndex((i) => Math.min(menu.length - 1, i + 1));
        return;
      }
      if (key.leftArrow) return setCursor((c) => Math.max(0, c - 1));
      if (key.rightArrow) return setCursor((c) => Math.min(cmd.length, c + 1));
      if (key.backspace || key.delete) {
        if (cursor === 0) return cmd ? undefined : closeCmd();
        setCmd(cmd.slice(0, cursor - 1) + cmd.slice(cursor));
        setCursor((c) => c - 1);
        setMenuIndex(0);
        return;
      }
      if (key.ctrl || key.meta || !ch) return;
      const nl = ch.search(/[\r\n]/);
      if (nl >= 0) return submitCmd(cmd.slice(0, cursor) + ch.slice(0, nl) + cmd.slice(cursor));
      setCmd(cmd.slice(0, cursor) + ch + cmd.slice(cursor));
      setCursor((c) => c + ch.length);
      setMenuIndex(0);
      return;
    }
    // panel mode
    if (key.escape) {
      if (overlay.kind !== "none") return setOverlay({ kind: "none" });
      return setMessage(null);
    }
    if (ch === "/" || ch === ":") {
      setCmd("");
      setCursor(0);
      return;
    }
    if (ch === "q" || (key.ctrl && ch === "c")) return quit({ action: "quit" });
    if (ch === "?") return setOverlay({ kind: "help" });
    if (overlay.kind === "diff") {
      if (key.upArrow || ch === "k") return setScroll((s) => Math.max(0, s - 1));
      if (key.downArrow || ch === "j") return setScroll((s) => s + 1);
      if (key.pageUp) return setScroll((s) => Math.max(0, s - 20));
      if (key.pageDown) return setScroll((s) => s + 20);
      return;
    }
    if (key.upArrow || ch === "k") return setSel((i) => Math.max(0, i - 1));
    if (key.downArrow || ch === "j") return setSel((i) => Math.min(workers.length - 1, i + 1));
    if (key.return) return void openReview("review");
    if (ch === "r") return void run("run");
    if (ch === "p") return void run("pause");
    if (ch === "d") return void openReview("diff");
  });

  if (!snap) return <Text>{store.error ? `error: ${store.error}` : "connecting to the daemon…"}</Text>;

  // ── header ────────────────────────────────────────────────────────────
  const usage = snap.routes
    .map((r) => {
      const five = r.windows.find((w) => w.kind === "5h");
      const seven = r.windows.find((w) => w.kind === "7d");
      const budget = r.windows.find((w) => w.kind === "budget");
      const hot = [five, seven].some((w) => w && w.usedPct !== null && w.usedPct >= w.capPct * 0.9);
      const txt = r.pausedUntil
        ? `${r.vendor} paused until ${resetText(snap.now, r.pausedUntil).split(" ")[0]}`
        : budget
          ? `${r.vendor} ${budget.detail ?? budget.display}`
          : five || seven
            ? `${r.vendor} ${[five && `5h ${five.display}`, seven && `7d ${seven.display}`].filter(Boolean).join(" · ")}`
            : `${r.vendor} usage unknown`;
      return { txt, color: r.pausedUntil || hot ? C.warn : undefined };
    })
    .filter((u, i, all) => all.findIndex((x) => x.txt === u.txt) === i);
  const working = workers.filter((w) => w.state === "RUNNING").length;
  const idle = workers.filter((w) => w.state === "IDLE").length;
  const queued = tasks.filter((t) => ["QUEUED", "PAUSED", "REPAIRING"].includes(t.state)).length;
  const drafts = tasks.filter((t) => t.state === "DRAFT").length;
  const needs = tasks.filter((t) => t.state === "NEEDS_HUMAN");
  const ready = tasks.filter((t) => t.state === "PR_READY");

  // ── table ─────────────────────────────────────────────────────────────
  const routeModel = (route: string | null) => snap.routes.find((r) => r.route === route)?.model ?? "default";
  const tableRows: AgentRow[] = workers.map((w) => {
    const st = statusOf(w);
    const live = w.taskId ? tasks.find((t) => t.id === w.taskId) : undefined;
    const next = !live ? nextFor(w) : undefined;
    const ctxTask = live?.id ?? undefined;
    const cost = ctxTask ? store.cost.get(ctxTask)?.usd : undefined;
    return {
      id: w.id,
      tool: `${w.vendor}/${routeModel(w.route)}`,
      status: st.label,
      statusColor: st.color,
      busy: w.state === "RUNNING",
      task: live ? `${live.id} ${live.title}` : next ? `next: ${next.id} ${next.title}` : w.waitingReason && w.state !== "IDLE" ? w.waitingReason : "",
      taskDim: !live,
      elapsedMs: w.elapsedMs,
      context: ctxTask ? fmtTokens(store.context.get(ctxTask)) : "",
      cost: cost !== undefined && cost !== null ? `$${cost.toFixed(2)}` : ctxTask ? "—" : "",
    };
  });

  // ── detail ────────────────────────────────────────────────────────────
  const detailLines: DetailLine[] = [];
  let detailTitle = worker ? `${worker.id}` : "no agents";
  if (worker && focusTask) {
    const d = store.details.get(focusTask.id);
    const files = store.files.get(focusTask.id) ?? [];
    const lastChecks = [...(d?.runs ?? [])].reverse().find((r) => r.checks.length)?.checks ?? [];
    const act = store.lastActivity(focusTask.id);
    detailTitle = `${worker.id} · ${focusTask.id} ${focusTask.title}`;
    const brief = (d?.body ?? "").split("\n").map((l) => l.trim()).find((l) => l && !l.startsWith("<!--")) ?? focusTask.title;
    detailLines.push({ label: "state", value: `${focusTask.state.toLowerCase().replace("_", " ")}${worker.taskId !== focusTask.id ? (["QUEUED", "REPAIRING", "PAUSED"].includes(focusTask.state) ? " (up next)" : " (last task)") : ""}`, color: stateColor(focusTask.state) });
    detailLines.push({ label: "brief", value: brief });
    if (d?.acceptance.length) detailLines.push({ label: "accept", value: d.acceptance.map((x) => `· ${x}`).join("   ") });
    detailLines.push({ label: "files", value: files.length ? files.map((f) => `${f.path} +${f.insertions} -${f.deletions}`).join(" · ") : "no changes yet" });
    detailLines.push({
      label: "checks",
      value: `${lastChecks.length ? `last gate: ${lastChecks.map((c) => `${c.ok ? "✓" : "✗"} ${c.checkId}`).join(" ")}` : "not run yet"}   attempt ${Math.max(1, focusTask.attempts)}/${focusTask.attemptsMax}`,
      color: lastChecks.some((c) => !c.ok) ? C.warn : undefined,
    });
    if (focusTask.dependsOn.length) detailLines.push({ label: "after", value: focusTask.dependsOn.join(", ") });
    if (act && worker.taskId === focusTask.id) detailLines.push({ label: "now", value: act.kind === "tool" ? `${act.text} ${act.detail ?? ""}` : act.kind === "edit" ? `editing ${act.text}` : act.text });
    if (focusTask.branch) detailLines.push({ label: "branch", value: focusTask.branch, color: C.dim });
    if (focusTask.state === "NEEDS_HUMAN") detailLines.push({ label: "needs you", value: focusTask.needsHumanReason ?? "see /review", color: C.bad });
    const appr = snap.approvals.filter((x) => x.taskId === focusTask.id);
    for (const x of appr) detailLines.push({ label: "approval", value: `${x.id}: ${x.context}  (/approve ${x.id})`, color: C.warn });
  } else if (worker) {
    detailLines.push({ label: "state", value: worker.role === "reviewer" ? "idle: reviews start when a task passes its checks" : worker.role === "planner" ? "idle: /plan <file> to split a document into tasks" : `idle: /task <title> @${worker.role} to give it work`, color: C.dim });
  }

  // ── bottom ────────────────────────────────────────────────────────────
  const queueBits: string[] = [];
  for (const t of needs) queueBits.push(`${t.id} needs you`);
  for (const a of snap.approvals) queueBits.push(`${a.id} approval waiting`);
  for (const t of ready) queueBits.push(`${t.id} ready to merge (/accept ${t.id})`);
  if (drafts) queueBits.push(`${drafts} draft${drafts > 1 ? "s" : ""} (/approve all)`);

  const headerRows = 3;
  const tableHeight = tableRows.length + 1;
  const bottomRows = 2 + (cmd !== null ? 1 + Math.min(6, completions(cmd).length) : 0) + (queueBits.length ? 1 : 0);
  const midHeight = Math.max(5, rows - headerRows - tableHeight - bottomRows - 1);

  let body: React.ReactNode;
  if (overlay.kind === "help") body = <Help />;
  else if (overlay.kind === "review" || overlay.kind === "diff") body = <ReviewView data={overlay.data} showDiff={overlay.kind === "diff"} width={columns} height={midHeight} scroll={scroll} />;
  else if (overlay.kind === "usage")
    body = (
      <Box flexDirection="column">
        <Text color={C.dim}>── usage (source in brackets; unknown is never shown as 0%) ──</Text>
        {snap.routes.map((r) => (
          <Text key={r.route}>
            {" "}
            {r.route.padEnd(16)}
            {r.windows.length === 0 ? <Text color={C.dim}>unknown</Text> : r.windows.map((w) => `${w.kind} ${w.display}${w.detail ? ` (${w.detail})` : ""} resets ${resetText(snap.now, w.resetsAt)} [${w.source}]${w.stale ? " stale" : ""}`).join("   ")}
            {r.pausedUntil ? <Text color={C.warn}> paused until {resetText(snap.now, r.pausedUntil)}</Text> : null}
          </Text>
        ))}
      </Box>
    );
  else if (overlay.kind === "tasks")
    body = (
      <Box flexDirection="column">
        <Text color={C.dim}>── tasks ──</Text>
        {tasks.map((t) => (
          <Text key={t.id} wrap="truncate-end">
            {" "}
            {t.id} <Text color={stateColor(t.state)}>{t.state.toLowerCase().padEnd(12)}</Text> {t.role.padEnd(10)} {t.title}
            <Text color={C.dim}>{t.dependsOn.length ? `  after ${t.dependsOn.join(",")}` : ""}</Text>
          </Text>
        ))}
      </Box>
    );
  else body = <DetailPane title={detailTitle} lines={detailLines} width={columns} />;

  return (
    <Box flexDirection="column" width={columns}>
      <Box justifyContent="space-between" width={columns}>
        <Text>
          <Text bold>harness</Text>
          <Text color={C.dim}> · {snap.project.name}</Text>
        </Text>
        <Text>
          {usage.map((u, i) => (
            <Text key={i} color={u.color ?? C.dim}>
              {i ? "   " : ""}
              {u.txt}
            </Text>
          ))}
        </Text>
      </Box>
      <Text color={C.dim}>
        {working} working · {idle} idle · {queued} queued{needs.length ? "" : ""}
        {needs.length ? <Text color={C.bad}> · {needs.length} needs you</Text> : null} · scheduler {snap.scheduler.running ? "running" : <Text color={C.warn}>stopped (r to run)</Text>}
      </Text>
      <Text> </Text>
      <AgentTable rows={tableRows} selected={Math.min(sel, Math.max(0, tableRows.length - 1))} width={columns} frame={frame} />
      <Text> </Text>
      <Box height={midHeight} flexDirection="column" overflow="hidden">
        {body}
      </Box>
      {queueBits.length ? (
        <Text wrap="truncate-end" color={needs.length ? C.bad : C.warn}>
          {" "}
          {queueBits.join("  ·  ")}
        </Text>
      ) : null}
      {cmd !== null ? (
        <CommandLine value={cmd} cursor={cursor} menuIndex={menuIndex} width={columns} />
      ) : (
        <Text wrap="truncate-end" color={message?.color ?? C.dim}>
          {message ? ` ${message.text}` : " "}
        </Text>
      )}
      <Text color={C.dim} wrap="truncate-end">
        {cmd !== null
          ? " enter run · tab complete · ↑↓ choose · esc cancel"
          : overlay.kind !== "none"
            ? " esc back · / command · q quit"
            : " ↑↓ select · enter review · d diff · r run · p pause · / command · ? help · q quit"}
      </Text>
    </Box>
  );
}
