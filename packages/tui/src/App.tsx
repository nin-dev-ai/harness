import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import type { StatusSnapshot } from "@harness/daemon";
import { Footer, type View } from "./components/Footer.js";
import { Help } from "./components/Help.js";
import { LIMIT_WINDOWS, LimitsEditor } from "./components/LimitsEditor.js";
import { Output } from "./components/Output.js";
import { ReviewView, type ReviewData } from "./components/ReviewView.js";
import { sortTasks, Tasks } from "./components/Tasks.js";
import { TextInput } from "./components/TextInput.js";
import { UsageBar } from "./components/UsageBar.js";
import { Workers } from "./components/Workers.js";
import type { TuiStore } from "./store.js";
import { theme } from "./theme.js";

/** Why the UI closed: the caller acts on it (attach runs a CLI, stop stops the daemon). */
export type UiExit = { action: "quit" } | { action: "stop" } | { action: "attach"; target: string };

export interface AppProps {
  store: TuiStore;
  onExit(r: UiExit): void;
  /** Fixed size for tests. */
  size?: { columns: number; rows: number };
}

function useSnapshot(store: TuiStore): StatusSnapshot | null {
  const [, setN] = useState(0);
  useEffect(() => store.onChange(() => setN((n) => n + 1)), [store]);
  return useSyncExternalStore(
    (cb) => store.onChange(cb),
    () => store.snapshot,
  );
}

export function App({ store, onExit, size }: AppProps) {
  const snap = useSnapshot(store);
  const { exit } = useApp();
  const { stdout } = useStdout();
  const columns = size?.columns ?? stdout.columns ?? 120;
  const rows = size?.rows ?? stdout.rows ?? 40;

  const [view, setView] = useState<View>("main");
  const [focus, setFocus] = useState<"workers" | "tasks">("workers");
  const [wSel, setWSel] = useState(0);
  const [tSel, setTSel] = useState(0);
  const [raw, setRaw] = useState(false);
  const [scroll, setScroll] = useState(0);
  const [message, setMessage] = useState<string | null>(null);
  const [review, setReview] = useState<ReviewData | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [limitWin, setLimitWin] = useState<(typeof LIMIT_WINDOWS)[number]>("5h");
  const [newRole, setNewRole] = useState(0);
  const [, tick] = useState(0);

  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const workers = snap?.workers ?? [];
  const tasks = useMemo(() => sortTasks(snap?.tasks ?? []), [snap]);
  const worker = workers[Math.min(wSel, workers.length - 1)];
  const task = tasks[Math.min(tSel, tasks.length - 1)];
  const writeRoles = [...new Set(workers.map((w) => w.role))].filter((r) => r !== "reviewer" && r !== "planner");

  const runId = focus === "workers" ? (worker ? store.runForWorker(worker.id) : undefined) : (task?.lastRunId ?? (task ? store.lastRunByTask.get(task.id) : undefined));
  useEffect(() => {
    if (runId) void store.load(runId);
  }, [runId, store]);
  const buf = runId ? store.buffer(runId) : undefined;
  const lines = buf ? (raw ? buf.raw : buf.lines) : [];
  const outTitle = focus === "workers" && worker ? `${worker.id} (${worker.vendor})${worker.taskId ? ` · ${worker.taskId}` : ""}` : task ? `${task.id} ${task.title}${task.branch ? ` · ${task.branch}` : ""}` : "";

  const call = async (method: string, params: Record<string, unknown> = {}, ok?: string) => {
    try {
      const r = await store.api.call(method, params);
      if (ok) setMessage(ok);
      await store.refresh();
      return r;
    } catch (e) {
      setMessage(`error: ${(e as Error).message}`);
      return undefined;
    }
  };
  const quit = (r: UiExit) => {
    onExit(r);
    exit();
  };
  const selectedRoute = () => {
    const role = focus === "workers" ? worker?.role : task?.role;
    const routeName = workers.find((w) => w.role === role)?.route;
    return snap?.routes.find((r) => r.route === routeName) ?? snap?.routes[0];
  };

  useInput(
    (ch, key) => {
      if (view === "help") {
        if (key.escape || ch === "?" || ch === "q") setView("main");
        return;
      }
      if (view === "output") {
        if (key.escape || key.return) setView("main");
        else if (ch === "t") setRaw((r) => !r);
        else if (key.pageUp) setScroll((s) => s + 10);
        else if (key.pageDown) setScroll((s) => Math.max(0, s - 10));
        return;
      }
      if (view === "review") {
        if (key.escape) setView("main");
        else if (ch === "d") setShowDiff((d) => !d);
        else if (ch === "A" && review) void call("review.accept", { id: review.task.id }, `${review.task.id} accepted`).then(() => setView("main"));
        else if (ch === "R" && review) setView("reject");
        return;
      }
      if (view !== "main") return; // text inputs own the keyboard
      if (ch === "q") return quit({ action: "quit" });
      if (ch === "Q") return quit({ action: "stop" });
      if (ch === "?") return setView("help");
      if (key.tab) return setFocus((f) => (f === "workers" ? "tasks" : "workers"));
      if (key.upArrow || ch === "k") {
        setScroll(0);
        return focus === "workers" ? setWSel((i) => Math.max(0, i - 1)) : setTSel((i) => Math.max(0, i - 1));
      }
      if (key.downArrow || ch === "j") {
        setScroll(0);
        return focus === "workers" ? setWSel((i) => Math.min(workers.length - 1, i + 1)) : setTSel((i) => Math.min(tasks.length - 1, i + 1));
      }
      if (key.return) return setView("output");
      if (key.pageUp) return setScroll((s) => s + 10);
      if (key.pageDown) return setScroll((s) => Math.max(0, s - 10));
      if (ch === "t") return setRaw((r) => !r);
      if (ch === "r") return void call("run", {}, "scheduler running");
      if (ch === "P") return void call("pause", { all: true }, "paused everything");
      if (ch === "p") {
        const tid = focus === "workers" ? worker?.taskId : task?.id;
        if (tid) return void call("pause", { task: tid }, `pausing ${tid}`);
        if (focus === "workers" && worker) return void call("pause", { role: worker.role }, `paused ${worker.role}`);
        return;
      }
      if (ch === "b") return void call("burst.set", { enabled: !snap?.scheduler.burst }, `burst ${snap?.scheduler.burst ? "off" : "on"}`);
      if (ch === "a") {
        if (focus === "tasks" && task?.state === "DRAFT") return void call("task.approve", { ids: [task.id] }, `approved ${task.id}`);
        const target = focus === "workers" ? (worker?.taskId ? worker.id : undefined) : task?.id;
        if (target) return quit({ action: "attach", target });
        return setMessage("nothing to attach to");
      }
      if (ch === "v" && task) {
        return void call("review.show", { id: task.id }).then((r) => {
          if (r) {
            setReview(r as ReviewData);
            setShowDiff(false);
            setView("review");
          }
        });
      }
      if (ch === "l") {
        setLimitWin("5h");
        return setView("limits");
      }
      if (ch === "n") {
        setNewRole(0);
        return setView("new");
      }
    },
    { isActive: true },
  );

  // Arrow keys and tab while a form is open.
  useInput(
    (_ch, key) => {
      if (view === "limits" && (key.leftArrow || key.rightArrow)) {
        const i = LIMIT_WINDOWS.indexOf(limitWin);
        setLimitWin(LIMIT_WINDOWS[(i + (key.rightArrow ? 1 : LIMIT_WINDOWS.length - 1)) % LIMIT_WINDOWS.length]!);
      }
      if (view === "new" && key.tab) setNewRole((i) => (i + 1) % Math.max(1, writeRoles.length));
    },
    { isActive: view === "limits" || view === "new" },
  );

  if (!snap) return <Text>{store.error ? `error: ${store.error}` : "connecting to the daemon..."}</Text>;

  const usageHeight = snap.routes.length + 3;
  const bodyHeight = Math.max(8, rows - usageHeight - 4);
  const leftWidth = Math.max(38, Math.floor(columns * 0.42));
  const rightWidth = columns - leftWidth;
  const header = (
    <Box justifyContent="space-between" width={columns}>
      <Text bold> harness · {snap.project.name}</Text>
      <Text>
        mode: {snap.project.autonomy} · scheduler: <Text color={snap.scheduler.running ? theme.ok : theme.dim}>{snap.scheduler.running ? "running" : "stopped"}</Text> · burst:{" "}
        {snap.scheduler.burst ? "ON" : "off"} · {new Date().toTimeString().slice(0, 5)}{" "}
      </Text>
    </Box>
  );

  let body;
  if (view === "help") body = <Help />;
  else if (view === "output") body = <Output title={outTitle} lines={lines} height={rows - 3} width={columns} scroll={scroll} raw={raw} />;
  else if ((view === "review" || view === "reject") && review)
    body = (
      <Box flexDirection="column">
        <ReviewView data={review} showDiff={showDiff} width={columns} height={rows - 4} />
        {view === "reject" && (
          <Box>
            <Text>reject comment: </Text>
            <TextInput
              onCancel={() => setView("review")}
              onSubmit={(v) => {
                if (!v.trim()) return;
                void call("review.reject", { id: review.task.id, comment: v }, `${review.task.id} sent back`).then(() => setView("main"));
              }}
            />
          </Box>
        )}
      </Box>
    );
  else if (view === "limits") {
    const route = selectedRoute();
    body = route ? (
      <LimitsEditor
        route={route}
        window={limitWin}
        onCancel={() => setView("main")}
        onSubmit={(v) => void call("limits.set", { route: route.route, window: limitWin, budget: v }, `${route.route} ${limitWin} set to ${v}`).then(() => setView("main"))}
      />
    ) : (
      <Text>no routes</Text>
    );
  } else if (view === "new")
    body = (
      <Box flexDirection="column" borderStyle="single" paddingX={1}>
        <Text bold>NEW TASK</Text>
        <Text>
          role: <Text color={theme.accent}>{writeRoles[newRole] ?? "(none)"}</Text> <Text color={theme.dim}>(tab to change)</Text>
        </Text>
        <Box>
          <Text>title: </Text>
          <TextInput
            placeholder="what should be done"
            onCancel={() => setView("main")}
            onSubmit={(v) => {
              if (!v.trim() || !writeRoles[newRole]) return;
              void call("task.add", { title: v.trim(), role: writeRoles[newRole] }, `created a draft task; select it and press a to approve`).then(() => setView("main"));
            }}
          />
        </Box>
      </Box>
    );
  else
    body = (
      <Box flexDirection="column">
        <UsageBar routes={snap.routes} now={snap.now} width={columns} />
        <Box flexDirection="row" height={bodyHeight}>
          <Box flexDirection="column" width={leftWidth} borderStyle="single">
            <Workers workers={workers} selected={wSel} focused={focus === "workers"} width={leftWidth - 2} />
            <Box flexGrow={1} />
            <Tasks tasks={tasks} selected={tSel} focused={focus === "tasks"} width={leftWidth - 2} height={Math.max(3, bodyHeight - workers.length * 2 - 5)} />
          </Box>
          <Box borderStyle="single" width={rightWidth}>
            <Output title={outTitle} lines={lines} height={bodyHeight - 2} width={rightWidth - 2} scroll={scroll} raw={raw} />
          </Box>
        </Box>
        {snap.approvals.length > 0 && (
          <Text color={theme.warn}>
            {" "}
            {snap.approvals.length} approval(s) waiting: {snap.approvals.map((a) => `${a.id} ${a.taskId ?? ""} ${a.category}`).join("; ")} (harness approve A-n)
          </Text>
        )}
      </Box>
    );

  return (
    <Box flexDirection="column" width={columns}>
      {header}
      {body}
      <Footer view={view} message={message ?? store.error} />
    </Box>
  );
}
