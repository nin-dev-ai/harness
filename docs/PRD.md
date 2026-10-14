# PRD v4: Terminal Multi-Agent Harness (Build Spec)

Oct 14, 2026 · @Nigel

## Overview and how to use this document

**`harness` is a terminal application, like Claude Code, that sits on top of three coding-agent CLIs: Claude Code, Codex and Cursor's agent. You declare a project and its roles, assign each role a vendor and model, and the tool runs them as a team: one worker per role, each in its own git worktree and branch, with a live view of every agent in one terminal screen.**

It knows each plan's usage windows and reset times, so it can *burst*: send queued work while a window still has headroom, pause cleanly when a limit hits, and resume when the window resets. The loop that decides whether work is done (run, verify, repair, review) is built into the tool, but the signal it relies on, your tests and checks, lives in the target repo.

**What the tool does, in one paragraph.** You run `harness` inside a git repo. It scans the repo, checks that it has runnable checks, and opens a full-screen terminal UI. You define roles in `harness.yaml` (for example `frontend: codex`, `backend: claude`, `reviewer: cursor`). You add tasks by hand, or ask a planner agent to split a PRD into tasks and propose roles. The daemon assigns each ready task to a worker for its role, creates a worktree and branch, and launches the vendor CLI headless with structured output. A verification step then runs your checks independently of the agent. Failures go back to the same agent session as a bounded repair loop. Passing work is reviewed read-only and merged into a local integration branch. Nothing touches `main`.

**Working name:** `harness`. Use a neutral name in public; vendor names and logos stay out of the product name.

### Instructions for the coding agent building this

If you are Claude Code reading this to build the project, follow these rules.

1. **Build in the milestone order in *Build plan*.** Finish and test each milestone before starting the next. Don't skip ahead to the TUI.
2. **Build the fake adapter first** (milestone M1). It emits scripted event streams, rate-limit signals and crashes. Everything is developed and tested against it, so building this tool never spends vendor quota.
3. **Never hard-code a vendor CLI flag from memory.** Section *Vendor adapters* lists the invocation shapes we expect. Before writing each real adapter, run `<cli> --help`, record the real output under `fixtures/`, and write the adapter against the recorded fixtures. If a flag differs, the installed CLI wins and you update the doc.
4. **Deterministic code runs the system.** The scheduler, quota math, state machine, policy and verification contain no LLM calls. LLMs run only inside worker sessions and the planner.
5. **TypeScript strict, Zod for every external boundary** (config files, adapter output, daemon RPC, database rows). No `any` across package boundaries.
6. **One package, one job.** Dependencies point downward only: `core` → everything else. No package imports `tui` or `cli`.
7. **Every state change writes an event** (see *Data model*). If a behavior isn't visible in the event log, it didn't happen.
8. **Ask before deviating.** If the spec conflicts with what you find in a real CLI, stop and write the conflict into `docs/DECISIONS.md` before choosing.
9. **Definition of done for any milestone:** `pnpm typecheck && pnpm lint && pnpm test` pass, the milestone's acceptance scenarios pass against the fake adapter, and `docs/PROGRESS.md` is updated.

## Users, goals and principles

**The user is a developer who pays for more than one coding agent and wants to run them as a coordinated team from one terminal, seeing exactly who is doing what.**

**Primary user:** a solo developer or indie hacker with a git repo and at least two of Claude Code, Codex and Cursor installed and signed in. **Secondary:** a small team using the same tool on a shared repo, each on their own machine.

**Job story.** "When I have a feature that splits into frontend, backend and review work, I want to assign each part to the agent I trust for it, watch them all work from one screen, and have the tool keep them going right up to each plan's usage limit and pick them up again after the reset, so I spend my time deciding and reviewing, not babysitting terminals."

### Goals

- **G1 Roles to vendors.** The user declares roles and binds each to a vendor, model and permissions. The tool honors that binding exactly.
- **G2 One screen.** A full-screen terminal UI shows every worker, its tool, its task, status, live output, branch and usage.
- **G3 Burst and resume.** The tool uses available quota before a window resets, pauses at real limits, and resumes at the reset, with work checkpointed so nothing is lost.
- **G4 Isolation.** Every task runs in its own git worktree on its own branch. Nothing writes to `main`.
- **G5 A real loop.** Work isn't done until independent checks pass. Failures go back to the agent as a bounded repair loop, then to a human.
- **G6 Honest usage.** Every usage number shows its source (vendor, manual or inferred), and unknown is never shown as zero.
- **G7 Agents do the thinking.** The tool has no model of its own. Planning, role proposals and reviews run through the user's existing agents.

### Non-goals (v1)

- A hosted service, accounts or telemetry. Everything runs locally.
- Replacing Claude Code, Codex or Cursor as the place you code by hand.
- Rotating between several accounts of the same vendor to get past a limit, or reading, copying or sharing credentials.
- Auto-merging to `main`, deploying, or pushing to protected branches.
- More than three vendors. The adapter interface allows more later.
- A web dashboard or IDE extension. The terminal UI is the product.

### Design principles

1. Deterministic code runs the system; models run inside workers.
2. The agent's claim of success never counts. Independent checks do.
3. Every write is isolated, and every action is an event.
4. The user's assignment is law. The tool never silently swaps a role's vendor or model.
5. Show the source and freshness of every number.
6. Pause cleanly beats pushing through. A paused task resumes from a checkpoint.
7. The daemon owns state. The terminal UI is a view, so closing it never stops the work.

## Core concepts

**Eight terms carry the whole design. Use these names in code, config and UI so everything lines up.**

| Term | Meaning | Lives in |
| --- | --- | --- |
| **Project** | One git repo plus its `harness.yaml`. The tool operates on one project at a time. | `harness.yaml` |
| **Route** | A way to reach a model: vendor + auth method + model. Example: `claude / subscription / <model>`, `codex / api-key / <model>`. | `harness.yaml` → `routes` |
| **Role** | A named responsibility with a route, permissions and instructions. Example: `frontend`, `backend`, `reviewer`, `planner`. A role is configuration, not a process. | `harness.yaml` → `roles` |
| **Worker** | A running slot for a role. A role with `concurrency: 2` has up to two workers. Each worker has a stable id (`frontend-1`) and at most one active run. | database |
| **Task** | A unit of work with a spec, acceptance criteria, a role, dependencies and a state. | database + `.harness/tasks/*.md` |
| **Run** | One attempt by one worker on one task: a vendor CLI process, its event stream, its vendor session id and its result. A task can have many runs (initial, repairs, resumes). | database |
| **Window** | A usage limit with a reset time on a route's account: `5h`, `7d` or `unknown`. It has a used percentage (or unknown), a reset time (or unknown) and a source. | database |
| **Burst** | A period when the scheduler dispatches work to use a window's remaining headroom before it resets, then pauses at the limit and resumes after. | scheduler |

**Relationships.**

- A project has many roles, tasks and routes.
- A role binds to exactly one route. The user can also set an ordered fallback list of routes. Fallback only happens if `fallback: auto` is set on the role; otherwise the task waits (see *Policy*).
- A task belongs to one role. The planner can propose the role; the user's approval makes it final.
- A task has dependencies on other tasks, forming a graph (DAG).
- A worker runs one run at a time. A run belongs to one task.
- A route has one or more windows, depending on what the vendor exposes.

**Identity of things on disk.** Task ids are `T-001`, `T-002`, and so on, per project. Run ids are `R-<task>-<n>`. Branches: `harness/<role>/<task-id>-<slug>`. Worktrees: `.harness/worktrees/<task-id>/`. Worker ids: `<role>-<n>`.

## User walkthrough and CLI reference

**Running `harness` with no arguments opens the terminal UI. Every UI action also exists as a command, so everything can be scripted.**

### First run

1. `cd my-repo && harness init`. The tool checks that this is a git repo and creates `harness.yaml`, `.harness/` (git-ignored except `tasks/` and `checks.yaml`) and a global state directory at `~/.harness/`.
2. It detects installed vendor CLIs and their sign-in state: `claude`, `codex`, `agent` (Cursor). It never reads or prints tokens. A missing or signed-out CLI shows the exact command to fix it.
3. It scans the repo and proposes `.harness/checks.yaml` (test, lint, typecheck and build commands, detected from `package.json`, `pyproject.toml`, `Makefile` and similar). It prints a **readiness report**: which checks exist, whether any tests exist, and whether `AGENTS.md` exists. You edit and approve the file.
4. You choose roles. Either write them in `harness.yaml`, or run `harness roles propose`, which asks the planner role's agent to suggest roles and routes from the repo and its README or PRD. You approve or edit the proposal.
5. `harness` opens the terminal UI.

### Daily use

1. Add work: `harness task add "Add watchlist panel" --role frontend`, or `harness plan docs/prd.md` to have the planner split a PRD into tasks with roles and dependencies. The planner's output is a draft; nothing runs until you approve (`a` in the UI, or `harness approve T-004`).
2. Start the loop: `harness run` (or press `r` in the UI). The daemon starts if it isn't running.
3. Watch the UI. Open any worker's live output with Enter. Pause a role or a task with `p`.
4. Review what comes out: `harness review T-004` shows the diff, check results, reviewer findings and usage. Accept merges the task branch into the integration branch. Reject sends it back with a comment.
5. When the integration branch is ready, `harness pr` opens a draft pull request (through `gh`) from it. Merging to `main` is always your action.

### Command reference

| Command | What it does |
| --- | --- |
| `harness` | Open the terminal UI (starts the daemon if needed) |
| `harness init` | Set up the project: detect CLIs, scan the repo, write config, print the readiness report |
| `harness doctor` | Check CLIs, sign-in state, git, config, daemon health. Exit code 1 if anything blocks a run |
| `harness roles list` / `propose` / `set <role> --route <route>` | List roles, ask the planner for a proposal, or change a role's route |
| `harness routes list` / `add` / `remove` | Manage routes (vendor, auth method, model) |
| `harness plan <file>` | Planner splits a PRD or notes into draft tasks with roles and dependencies |
| `harness task add "<title>" [--role r] [--after T-001] [--spec file]` | Create a task by hand |
| `harness task list` / `show <id>` / `edit <id>` / `cancel <id>` | Inspect or change tasks |
| `harness approve <id>\|--all` | Approve draft tasks so they can be scheduled |
| `harness run [--role r] [--task id] [--until <time>]` | Start or resume the scheduler loop |
| `harness pause [--role r\|--task id\|--all]` / `resume` | Pause or resume; a paused run checkpoints first |
| `harness stop` | Cancel all runs, kill every child process group, stop the daemon |
| `harness status [--json] [--watch]` | Print workers, tasks and windows. `--json` is stable for scripts |
| `harness attach <worker\|task>` | Take over a worker interactively (see *Terminal UI*) |
| `harness logs <run-id> [--follow]` | Print a run's normalized events or raw output |
| `harness review <id>` | Show the diff and evidence; `--accept` or `--reject -m "..."` |
| `harness usage [--json]` | Show every window per route, with source, freshness and reset time |
| `harness limits set <route> --window 5h --budget <pct\|minutes>` | Set a manual budget where a vendor exposes no data, or a cap below the vendor's |
| `harness pr [--task id]` | Open a draft PR from the integration branch or from one task branch |
| `harness export [--since]` | Write the event log and run records as JSONL |
| `harness config check` | Validate `harness.yaml` and `checks.yaml` against their schemas |

**Global flags:** `--project <path>`, `--json`, `--no-color`, `--debug`. **Exit codes:** 0 ok, 1 failed or blocked, 2 usage error, 3 daemon unreachable.

## Terminal UI

**One full-screen view answers four questions at a glance: who is running, on what tool, doing which task, and how much quota is left before the next reset.** It is built with Ink (React for terminals) and reads everything from the daemon, so closing it never stops work.

```text
 harness · market-terminal                        mode: approved-scope · burst: ON · 12:41
┌ USAGE ─────────────────────────────────────────────────────────────────────────────┐
│ claude  5h ▓▓▓▓▓▓▓▓░░  78%  resets 14:05 (1h24m)   7d ▓▓▓░░░░░░░ 31%  resets Fri 09:00   [vendor] │
│ codex   5h ▓▓▓▓░░░░░░  40%  resets 15:30 (2h49m)   7d ▓▓░░░░░░░░ 18%  resets Sun 00:00   [vendor] │
│ cursor  budget ▓▓▓░░░░░░░  27% of 40 runs/day (manual)                                      [manual] │
└─────────────────────────────────────────────────────────────────────────────┘
┌ WORKERS ────────────────────────────────┐┌ OUTPUT: frontend-1 (codex) · T-004 · harness/frontend/T-004-watchlist ──┐
│ ▶ frontend-1  codex   RUNNING   ││ › editing src/panels/Watchlist.tsx                       │
│   T-004 Watchlist panel   12m    ││ › tool: run `pnpm test watchlist`                         │
│ ▶ backend-1   claude  RUNNING   ││ › 3 passed, 1 failed (stale-state.test.ts)                │
│   T-005 Quote feed adapter  7m   ││ › fixing freshness threshold...                           │
│ ⏸ reviewer-1  cursor PAUSED    ││                                                          │
│   waiting: T-004 gate            ││                                                          │
│ ○ planner-1   claude  IDLE      ││                                                          │
├ TASKS ─────────────────────────────┤│                                                          │
│ T-004 RUNNING   frontend  → T-006 ││                                                          │
│ T-005 RUNNING   backend   → T-006 ││                                                          │
│ T-006 BLOCKED   frontend  needs 4,5││                                                          │
│ T-003 PR_READY  backend   ✓ gate  ││                                                          │
└────────────────────────────────┘└────────────────────────────────────────────────┘
 ↑↓ select  ⏎ open output  a attach  p pause  r run  v review  b burst on/off  l limits  ? help  q quit
```

**Panels**

- **Usage bar (top).** One row per route. Shows each window's used percentage, reset time with a countdown, and a source tag: `[vendor]` (read from the vendor), `[manual]` (set by the user) or `[inferred]` (estimated from observed runs). Unknown shows as `unknown`, never `0%`. A stale reading (older than 10 minutes) is dimmed and marked.
- **Workers (left top).** One entry per worker: id, vendor, state (`RUNNING`, `PAUSED`, `IDLE`, `WAITING`, `FAILED`), the task and elapsed time. If a worker is waiting, the reason is shown (`waiting: window resets 14:05`, `waiting: T-004 gate`).
- **Tasks (left bottom).** Tasks sorted by state, with role and dependencies.
- **Output (right).** Live normalized events for the selected worker: messages, tool calls, check results. Toggle raw output with `t`. Scroll with PageUp and PageDown.
- **Footer.** Keybindings for the current view.

**Keybindings**

| Key | Action |
| --- | --- |
| ↑ ↓ / Tab | Move between workers and tasks |
| Enter | Open the selected worker's live output full screen |
| `a` | **Attach**: take over the worker interactively (see below) |
| `p` | Pause the selected worker, or press `P` for all |
| `r` | Start or resume the scheduler |
| `v` | Review the selected task (diff, checks, findings, accept or reject) |
| `b` | Toggle burst mode |
| `l` | Open the limits editor for the selected route |
| `n` | New task |
| `?` | Help · `q` quit the UI (daemon keeps running) · `Q` quit and stop everything |

**Attach and takeover.** `a` pauses that worker at a safe point, commits any uncommitted work to its branch as a `wip:` checkpoint, suspends the UI, and starts the vendor's normal interactive CLI inside the worker's worktree, resumed on the same vendor session (`claude --resume`, `codex resume`, and the Cursor equivalent where it exists). You work with the agent directly. When you exit it, the UI returns, the run is marked `TAKEN_OVER`, and the scheduler asks whether to resume automation or leave the task for you.

**Terminal sessions.** By default each worker is a headless process whose events render in its own panel. This is more reliable than screen-scraping a terminal and gives structured done and failed signals. An optional `ui.tmux: true` setting mirrors each worker into a real tmux pane in a session named after the project, for users who prefer native panes. tmux is optional, and the core never depends on it.

## System architecture

**Three kinds of process: the terminal UI and CLI (clients), one background daemon (owns all state and decisions), and the vendor CLIs it launches (workers).**

```text
CLIENTS (no state of their own)
  Terminal UI (Ink) | CLI commands | Attach (interactive vendor CLI)
        |  requests                      ^  events, snapshots
        v                                |
DAEMON (owns state, scheduling, decisions; no LLM inside)
  RPC server (Unix socket, event stream) | Scheduler | Quota and bursts
  Run supervisor | Outer loop (gate, repair, review, merge) | Policy engine
  SQLite + event log | Git workspace | Verify runner
        |  run requests                  ^  normalized events
        v                                |
ADAPTERS (one interface, normalized events)
  claude | codex | cursor | fake (tests)
        |  spawn, cancel                 ^  structured stream, exit
        v                                |
VENDOR CLIs (headless, one process group per run, in a task worktree)
  claude | codex | agent
```

Clients talk to the daemon over a local Unix socket and hold no state, so you can close the UI, reopen it, or run `harness status` from another terminal and see the same thing. The daemon's scheduler, quota logic, outer loop and policy are ordinary deterministic code. Model calls happen only in the vendor CLIs it launches, including the planner and reviewer runs.

## Repository file structure

**A pnpm monorepo of small packages with one rule: dependencies point down toward `core`, never up toward `cli` or `tui`.** Stack: Node 22 LTS or newer, TypeScript (strict), pnpm workspaces, Zod, `better-sqlite3`, `execa`, Ink, `yaml`, `commander`, Vitest, `tsup`.

```text
harness/
├─ package.json                 # workspace root scripts: build, typecheck, lint, test, e2e
├─ pnpm-workspace.yaml
├─ tsconfig.base.json           # strict, ES2023, NodeNext
├─ vitest.config.ts
├─ eslint.config.js
├─ AGENTS.md                    # conventions for coding agents working on THIS repo
├─ CLAUDE.md                    # one line: "Read AGENTS.md"
├─ README.md
├─ docs/
│  ├─ PRD.md                    # this document, exported
│  ├─ DECISIONS.md              # deviations and open decisions, append-only
│  ├─ PROGRESS.md               # milestone checklist, updated every milestone
│  └─ VENDORS.md                # recorded real CLI flags and behavior, with dates and versions
├─ fixtures/                    # recorded vendor CLI output used by adapter tests
│  ├─ claude/  (help.txt, stream-success.jsonl, stream-ratelimit.jsonl, statusline.json)
│  ├─ codex/   (help.txt, exec-success.jsonl, exec-ratelimit.jsonl)
│  └─ cursor/  (help.txt, stream-success.jsonl)
├─ apps/
│  └─ cli/
│     ├─ package.json           # bin: { "harness": "dist/main.js" }
│     └─ src/
│        ├─ main.ts             # entry: parse args, route to command or launch TUI
│        └─ commands/
│           ├─ init.ts  doctor.ts  roles.ts  routes.ts  plan.ts  task.ts
│           ├─ approve.ts  run.ts  pause.ts  stop.ts  status.ts  attach.ts
│           ├─ logs.ts  review.ts  usage.ts  limits.ts  pr.ts  export.ts  config.ts
│           └─ _client.ts      # shared helper: connect to daemon, start it if needed
├─ packages/
│  ├─ core/                     # no I/O, no dependencies except zod
│  │  └─ src/
│  │     ├─ ids.ts  errors.ts  time.ts      # id generation, typed errors, injectable clock
│  │     ├─ schemas/
│  │     │  ├─ config.ts    # harness.yaml, checks.yaml
│  │     │  ├─ task.ts  run.ts  worker.ts  window.ts
│  │     │  ├─ events.ts    # discriminated union of every event type
│  │     │  └─ rpc.ts       # daemon request and response types
│  │     └─ state/
│  │        ├─ task-machine.ts   # task state transitions, pure functions
│  │        └─ worker-machine.ts
│  ├─ config/                   # load, validate, merge defaults, write
│  │  └─ src/ load.ts  defaults.ts  write.ts  detect-checks.ts
│  ├─ storage/                  # SQLite and artifacts
│  │  └─ src/
│  │     ├─ db.ts  migrate.ts
│  │     ├─ migrations/  0001_init.sql  0002_windows.sql ...
│  │     └─ repos/  tasks.ts  runs.ts  workers.ts  windows.ts  events.ts
│  ├─ adapters/                 # one folder per vendor, all behind one interface
│  │  └─ src/
│  │     ├─ types.ts        # AgentAdapter interface and normalized event types
│  │     ├─ process.ts      # spawn in own process group, kill group, stream lines
│  │     ├─ fake/           # scripted adapter used by every test (build this first)
│  │     ├─ claude/  index.ts  parse.ts  usage.ts  detect.ts
│  │     ├─ codex/   index.ts  parse.ts  usage.ts  detect.ts
│  │     └─ cursor/  index.ts  parse.ts  usage.ts  detect.ts
│  ├─ workspace/                # git operations
│  │  └─ src/ git.ts  worktree.ts  branch.ts  checkpoint.ts  merge.ts  diff.ts
│  ├─ verify/                   # independent checks and the repo readiness report
│  │  └─ src/ runner.ts  readiness.ts  signature.ts  report.ts
│  ├─ quota/                    # windows, estimation and the burst planner
│  │  └─ src/ windows.ts  estimator.ts  burst.ts  weekly-pacing.ts  backoff.ts
│  ├─ policy/                   # what is allowed, checked outside any prompt
│  │  └─ src/ paths.ts  routes.ts  caps.ts  approvals.ts  commands.ts
│  ├─ planner/                  # prompts and schemas for LLM-backed planning
│  │  └─ src/ plan.ts  roles.ts  review.ts  prompts/*.md  validate.ts
│  ├─ daemon/                   # the long-running process that owns all state
│  │  └─ src/
│  │     ├─ server.ts       # Unix socket JSON-RPC with event subscriptions
│  │     ├─ scheduler.ts    # the loop: pick ready tasks, assign workers, honor windows
│  │     ├─ supervisor.ts   # starts runs, streams events, handles exit and crash
│  │     ├─ outer-loop.ts   # verify, repair, review, merge decisions
│  │     ├─ recovery.ts     # reconcile state after daemon restart
│  │     └─ lock.ts  pidfile.ts
│  ├─ github/                   # thin wrapper over the `gh` CLI
│  │  └─ src/ pr.ts  issues.ts
│  └─ tui/                      # Ink components; reads only from daemon RPC
│     └─ src/
│        ├─ App.tsx  store.ts  theme.ts
│        └─ components/ UsageBar.tsx  Workers.tsx  Tasks.tsx  Output.tsx
│                      Footer.tsx  ReviewView.tsx  LimitsEditor.tsx  Help.tsx
└─ tests/
   ├─ e2e/                      # scenario tests that run the daemon with the fake adapter
   │  ├─ burst-and-resume.test.ts  repair-loop.test.ts  crash-recovery.test.ts
   │  ├─ dependency-order.test.ts  takeover.test.ts  policy-denial.test.ts
   └─ helpers/  temp-repo.ts  fake-clock.ts  scenario.ts
```

**Files created inside a user's project** (not in this repo):

```text
my-repo/
├─ harness.yaml                 # committed: roles, routes, limits, policy
├─ AGENTS.md                    # committed: conventions every agent reads (the tool suggests one if missing)
└─ .harness/
   ├─ checks.yaml               # committed: the verification commands (see Configuration)
   ├─ tasks/                    # committed: one markdown file per task, T-004.md
   ├─ worktrees/                # git-ignored: one worktree per active task
   └─ runs/                     # git-ignored: raw output and artifacts per run
```

Global state lives in `~/.harness/`: `state.db` (SQLite), `daemon.sock`, `daemon.pid`, `logs/`. One database serves all projects; every row carries a `project_id`.

## Configuration

**Two committed files describe a project: `harness.yaml` (who does what, with which limits) and `.harness/checks.yaml` (what counts as done). Both are validated by Zod schemas in `packages/core/src/schemas/config.ts`, and `harness config check` reports errors with line numbers.**

### harness.yaml

```yaml
version: 1
project: market-terminal
integration_branch: harness/integration   # task branches merge here, never into main
base_branch: main                         # worktrees start from here

routes:                                   # ways to reach a model
  claude-sub:
    vendor: claude
    auth: subscription                    # subscription | api_key
    model: <model-id>                     # exact id passed to the CLI; blank = CLI default
  codex-sub:
    vendor: codex
    auth: subscription
    model: <model-id>
  cursor-key:
    vendor: cursor
    auth: api_key                         # reads CURSOR_API_KEY from the environment
    model: <model-id>

roles:
  planner:
    route: claude-sub
    mode: readonly                        # readonly | write
    instructions: "Split work into small, independently testable tasks."
  frontend:
    route: codex-sub
    mode: write
    concurrency: 1
    paths_allow: ["src/ui/**", "src/panels/**"]
    paths_deny: [".github/**", "**/.env*"]
    instructions: "React and TypeScript. Follow src/ui conventions."
  backend:
    route: claude-sub
    mode: write
    concurrency: 1
    paths_allow: ["src/server/**", "src/lib/**"]
  reviewer:
    route: cursor-key
    mode: readonly
    independent_of: [frontend, backend]   # warn if it shares a route with these
    fallback: ask                         # ask | auto | none (what to do if its route is unavailable)

limits:                                   # caps the tool enforces, on top of vendor limits
  max_attempts_per_task: 3                # initial run + repairs
  max_task_minutes: 60
  max_parallel_workers: 3
  max_tasks_per_burst: 6
  quiet_hours: "00:00-07:00"              # no new dispatch in this local time range; optional
  routes:
    claude-sub: { window_5h_cap_pct: 85, window_7d_cap_pct: 80 }   # leave the rest for the user
    codex-sub:  { window_5h_cap_pct: 90 }
    cursor-key: { manual_budget: { unit: runs, per: day, amount: 40 } }

burst:
  enabled: true
  resume_jitter_seconds: [5, 120]         # random delay after a reset before resuming
  safety_margin_pct: 5                    # stop dispatch when remaining headroom is below cost + margin
  weekly_reserve_pct: 10                  # never plan below this on a 7d window

policy:
  autonomy: approved-scope                # observe | assisted | approved-scope
  unattended:                             # may the scheduler dispatch when the user is away?
    claude-sub: ask                       # allow | ask | deny; default ask, see Policy
    codex-sub: ask
    cursor-key: allow
  require_approval: [protected_paths, new_dependencies, merge_to_main, budget_increase]
  protected_paths: [".github/**", "**/.env*", "harness.yaml", ".harness/checks.yaml"]

ui:
  tmux: false
```

**Rules the loader enforces**

- Every role's `route` must exist. A `write` role must have `paths_allow` or accept the default of the whole repo with a warning.
- `readonly` roles run with the vendor's read-only or plan permission mode and get no write tools.
- No route may be listed twice with the same vendor *and* the same account in a way that suggests rotation. A second route of the same vendor is allowed, but a role can't list more than one route of a vendor in its fallbacks.
- Unknown keys are errors, so typos don't pass silently.

### .harness/checks.yaml

```yaml
version: 1
checks:
  - id: typecheck
    argv: ["pnpm", "typecheck"]
    timeout_s: 300
    required: true
  - id: lint
    argv: ["pnpm", "lint"]
    timeout_s: 180
    required: true
  - id: unit
    argv: ["pnpm", "test", "--run"]
    timeout_s: 600
    required: true
    scope: changed        # all | changed (pass changed file list in HARNESS_CHANGED_FILES)
  - id: build
    argv: ["pnpm", "build"]
    timeout_s: 600
    required: false
setup:                    # run once in a fresh worktree before the agent starts
  - argv: ["pnpm", "install", "--frozen-lockfile"]
env_pass: ["CI", "NODE_ENV"]   # the only environment variables checks may see
```

Checks run as an argv array with no shell, in the task's worktree, with a clean environment limited to `env_pass`. The runner records the exit code, duration, the last 200 lines of output and a failure signature (see *Loop engineering*). A `required` check that fails, times out or can't start blocks the task.

## Roles, tasks and the git model

**Each task gets its own branch and worktree from the base branch. Passing tasks merge into a local integration branch, and dependent tasks start from it. `main` is never touched.**

### Task files

Each task is a markdown file with front matter, committed under `.harness/tasks/`, so tasks are reviewable and survive a database reset. The database mirrors them for fast queries.

```markdown
---
id: T-004
title: Watchlist panel with price freshness states
role: frontend
state: QUEUED            # managed by the tool; do not edit by hand
depends_on: [T-002]      # tasks that must be MERGED into the integration branch first
size: M                  # S | M | L, used for cost estimates
attempts_max: 3
acceptance:
  - Panel lists symbols from the watchlist store
  - A row shows FRESH, STALE or DELAYED based on quote age
  - Unit tests cover all three states
files_hint: [src/panels/Watchlist.tsx, src/panels/Watchlist.test.tsx]
contract_ref: docs/contracts/quotes.ts   # optional shared interface the task must follow
---

Free-form description the agent sees: context, constraints, links.
```

### Where tasks come from

- **By hand:** `harness task add`, or write the markdown file.
- **Planner:** `harness plan <file>` runs the planner role headless with a JSON schema. It returns tasks, roles, dependencies and sizes. The tool validates the JSON (Zod), writes the tasks in state `DRAFT`, and you approve them. An invalid plan is retried once with the validation errors, then fails.
- **GitHub issues (P1):** issues with a label become `DRAFT` tasks.

### Branch and worktree model

```text
main                                  (never written by the tool)
  └─ harness/integration            (created from main; receives passing task branches)
       ├─ harness/backend/T-002-contracts      → merged
       ├─ harness/frontend/T-004-watchlist     → running, worktree .harness/worktrees/T-004
       └─ harness/backend/T-005-quote-feed     → running, worktree .harness/worktrees/T-005
```

**Lifecycle of one task's git state**

1. **Create.** `git worktree add .harness/worktrees/T-004 -b harness/frontend/T-004-watchlist harness/integration` (from the integration branch, so it includes already-merged dependencies).
2. **Setup.** Run `setup` commands from `checks.yaml` in the worktree.
3. **Work.** The agent edits files only inside this worktree. Its sandbox and the policy engine reject writes outside it.
4. **Checkpoint.** When a run pauses, hits a limit or is taken over, the tool commits uncommitted work as `wip(T-004): checkpoint <run-id>`. WIP commits are squashed into the final commit on merge.
5. **Gate.** Checks run in the worktree. On pass, the reviewer runs read-only against the diff.
6. **Merge.** On accept, the tool rebases the task branch onto the integration branch, re-runs the required checks on the result, then fast-forward merges. If the rebase conflicts, the task goes to `NEEDS_HUMAN` with the conflicting files listed. The tool never auto-resolves conflicts in v1.
7. **Clean up.** Remove the worktree. Keep the branch until the PR is merged.

**Why integrate continuously rather than keeping long-lived role branches.** A long-lived `frontend` branch and a long-lived `backend` branch drift apart, and the merge at the end is where work gets lost. Short task branches merged into the integration branch after each gate keep every role working from current code.

### Dependencies and shared interfaces

- A task starts only when every task in `depends_on` is `MERGED`.
- **Contract-first rule.** When two roles must agree on an interface (frontend consumes what backend produces), the planner creates a first task that writes the shared type or API spec into `docs/contracts/`, owned by one role. Both dependent tasks list it in `depends_on` and `contract_ref`. Parallel work then starts from the same agreed interface. A task that changes a contract file after the fact needs approval, and marks every task using it `STALE`.
- **File ownership.** Roles' `paths_allow` globs define what each role may write. Two `RUNNING` tasks whose predicted `files_hint` overlap are not scheduled together; the later one waits. The hint is a prediction only, so the merge-time conflict check is the real protection.

## Loop engineering

**There are two loops. The inner loop happens inside the vendor agent: edit, run tests, fix. The outer loop is ours: assign, verify independently, send failures back, review, merge. The tool provides the outer loop, but its meaning comes from the repo's own checks, so the tool treats the repo as part of the system.**

|  | Inner loop | Outer loop |
| --- | --- | --- |
| Runs in | The vendor CLI session | The harness daemon (`outer-loop.ts`) |
| Decides | What to edit next | Whether the work counts as done |
| Signal | The agent's own test runs | `checks.yaml` run by the harness, never by the agent |
| Trusted? | No. The agent's claim of success is ignored | Yes |

### Repo readiness (runs at `harness init` and before the first run)

The tool grades the repo's ability to give a useful signal, and prints the result:

- **Checks exist:** test, lint, typecheck and build commands detected and runnable.
- **Tests exist:** at least one test file; counts of tests found.
- **Baseline is green:** required checks pass on the base branch right now. If they fail before any agent touches the repo, runs would be blamed for old failures, so the tool refuses to start and shows the failures.
- **Instructions exist:** `AGENTS.md` present. If missing, the tool offers to create a minimal one from the repo scan.

A score of "no tests" produces a warning and one suggestion: make the first task `Add test infrastructure and tests for <area>` before feature work. The tool can create that task as a draft. Without checks, the loop would pass work it can't verify.

### The outer loop for one task

1. **Dispatch.** The scheduler picks a ready task, a worker for its role and a route with headroom. It creates the worktree, runs `setup`, and builds the prompt (see below).
2. **Run.** The adapter launches the vendor CLI headless, streams normalized events, and records the vendor session id.
3. **Gate.** When the process exits cleanly, the runner executes the required checks in the worktree. Output: pass or fail per check, plus a **failure signature** for each failure: a hash of the check id plus normalized error lines (paths and line numbers stripped, test names kept).
4. **Repair.** On failure, the tool builds a repair prompt from the check id, the last 200 lines of its output and the diff summary, and **resumes the same vendor session** with it. It counts the attempt.
5. **Stall detection.** If the same failure signature appears in two consecutive attempts, or the diff is unchanged between attempts, or attempts reach `max_attempts_per_task`, the task moves to `NEEDS_HUMAN` with the evidence attached. The tool never loops indefinitely.
6. **Review.** When checks pass, the reviewer role runs **read-only** against the diff and acceptance criteria and returns structured findings: severity (`blocker`, `major`, `nit`), file, line and message. A `blocker` goes back to step 4 as a repair. Reviewers never edit files.
7. **Accept.** Passing, reviewed work enters `PR_READY`. In `approved-scope` mode with no protected paths touched, the tool merges it into the integration branch automatically. Otherwise it waits for `harness review --accept`.
8. **Merge.** Rebase onto the integration branch, re-run required checks on the result, fast-forward. Dependent tasks unblock.

### What the agent is told (prompt assembly)

Prompts are assembled by deterministic templates in `packages/planner/src/prompts/`, never written freehand by a model:

- Role instructions from `harness.yaml`, then the task spec and acceptance criteria.
- Pointers to `AGENTS.md`, the contract file, and the list of files the role may and may not write.
- The exact check commands, with the sentence: "The harness will run these independently. Your claim that they pass is not used."
- On a repair: the failing check's output and the previous attempt's summary only. No full transcript replay.

### Review independence

A reviewer on the same route as the implementer is allowed but flagged `same-route`, since evidence suggests a second opinion catches more when it comes from a different source. The tool never changes the user's role assignments to enforce this; it only warns.

### Task state machine

```text
Main path:   DRAFT -> QUEUED -> RUNNING -> GATING -> REVIEWING -> PR_READY -> MERGED
Limit:       RUNNING -> PAUSED (limit hit) ; PAUSED -> RUNNING (resume after reset)
Attach:      PAUSED -> TAKEN_OVER (attach) ; TAKEN_OVER -> QUEUED (resume automation)
Repair:      GATING -> REPAIRING (check fails) ; REPAIRING -> GATING (retest)
             REVIEWING -> REPAIRING (blocker finding)
Human:       REPAIRING -> NEEDS_HUMAN (stalled or out of attempts)
             PR_READY -> NEEDS_HUMAN (merge conflict)
Any state:   CANCELLED (user), STALE (a shared contract changed)
```

The main path runs left to right. A failed gate or a reviewer blocker sends the task to `REPAIRING` and back to `GATING`. A route limit sends it to `PAUSED`, and it resumes after the reset. `NEEDS_HUMAN` is the only place automation stops for a person, and it always carries the evidence.

## Vendor adapters

**Every vendor sits behind one interface. The scheduler and outer loop never know which CLI they're talking to. An adapter's job is to launch the CLI, translate its output into normalized events, report usage, and resume sessions.**

```ts
// packages/adapters/src/types.ts
export type Vendor = "claude" | "codex" | "cursor" | "fake";

export interface RunRequest {
  runId: string;
  cwd: string;                       // the task's worktree
  prompt: string;
  model?: string;
  mode: "readonly" | "write";
  resumeSessionId?: string;          // continue a previous vendor session
  allowedPaths: string[];            // enforced by policy and by the vendor sandbox where possible
  env: Record<string, string>;       // already filtered; never contains credentials
  timeoutMs: number;
  jsonSchema?: object;               // for planner and reviewer runs that must return structured output
}

export type AgentEvent =
  | { type: "started";      runId: string; sessionId?: string; pid: number }
  | { type: "message";      runId: string; text: string }
  | { type: "tool_call";    runId: string; tool: string; summary: string }
  | { type: "file_change";  runId: string; path: string }
  | { type: "usage";        runId: string; tokensIn?: number; tokensOut?: number; costUsd?: number }
  | { type: "rate_limit";   runId: string; window: "5h" | "7d" | "unknown"; resetsAt?: string }
  | { type: "result";       runId: string; ok: boolean; summary: string; structured?: unknown }
  | { type: "error";        runId: string; kind: ErrorKind; message: string; retryable: boolean }
  | { type: "exited";       runId: string; code: number | null; signal: string | null };

export type ErrorKind =
  | "auth" | "rate_limit" | "quota_exhausted" | "network"
  | "cli_missing" | "cli_version" | "bad_output" | "timeout" | "crashed" | "unknown";

export interface UsageSnapshot {
  route: string;
  window: "5h" | "7d" | "budget";
  usedPct: number | null;            // null = unknown, never 0
  resetsAt: string | null;           // ISO time, null = unknown
  source: "vendor" | "manual" | "inferred";
  observedAt: string;
}

export interface DetectResult {
  installed: boolean;
  version?: string;
  signedIn: "yes" | "no" | "unknown";
  fixHint?: string;                  // exact command the user should run
}

export interface AgentAdapter {
  readonly vendor: Vendor;
  detect(): Promise<DetectResult>;
  run(req: RunRequest): AsyncIterable<AgentEvent>;   // must end with "exited"
  cancel(runId: string): Promise<void>;               // kills the whole process group
  usage(route: string): Promise<UsageSnapshot[]>;    // best available, may be empty
  interactiveCommand(sessionId: string, cwd: string): { argv: string[] };  // for attach
}
```

**Adapter rules**

- Spawn each CLI in **its own process group** so `cancel` can kill children too. Verify no orphan processes remain after cancel (test in `adapters/process.test.ts`).
- Parse the vendor's structured stream line by line with a tolerant parser: unknown event types are logged as `message` with `raw`, never crash the run. A line that isn't valid JSON is kept as raw output.
- Map vendor-specific limit messages to a single `rate_limit` event, carrying the reset time if the vendor provides one. If the process exits non-zero with output matching a known limit pattern but no structured event, emit `rate_limit` with `window: "unknown"`.
- Never print, log or store credentials. Pass the parent environment through a filter that removes variables not on an allow-list, then adds only what the route needs (for an `api_key` route, the one key variable).
- Authentication is the vendor's own: the adapter checks sign-in state via `detect()` but never reads auth files.
- Contract tests in `adapters/*/parse.test.ts` run against the recorded `fixtures/`, plus the same shared test suite against the `fake` adapter.

### Expected invocations (verify against the installed CLI before coding)

These shapes come from vendor documentation as of October 2026. Treat them as the starting hypothesis; the recorded `--help` output in `fixtures/` is the authority, and any difference goes in `docs/VENDORS.md`.

| Vendor | Headless run | Resume | Read-only mode | Usage signal |
| --- | --- | --- | --- | --- |
| Claude Code (`claude`) | `claude -p "<prompt>" --output-format stream-json --verbose`, plus a permission-mode flag and an allowed-tools list | `--resume <session-id>` | Plan or read-only permission mode, with edit tools not allowed | The status-line JSON carries `rate_limits.five_hour` and `seven_day` with `used_percentage` and `resets_at` for Pro and Max. **Spike M5:** confirm whether headless `-p` runs expose it. If not, the adapter installs a status-line command that writes the JSON to `~/.harness/usage/claude.json`, and falls back to parsing limit errors |
| Codex (`codex`) | `codex exec --json "<prompt>"` with a sandbox setting such as workspace-write | `codex exec resume <session-id>` | Read-only sandbox setting | Plan limits are visible interactively through `/status`. **Spike M5:** check whether `exec` exposes them. If not, treat the 5h and 7d windows as `inferred` from rate-limit errors and observed consumption, and allow `limits set` |
| Cursor (`agent`, also `cursor-agent`) | `agent -p "<prompt>" --output-format stream-json` with `--force` to allow edits; auth by `CURSOR_API_KEY` | Resume or chat id if the CLI provides one | Run without `--force` (proposals only) | None exposed to third parties. Show `unknown`, plus the user's manual budget |

The `fake` adapter takes a **script** (JSON file or inline object) listing timed events: messages, file changes, a rate limit at step N with a reset time, a crash at step M, a result. It also exposes a controllable usage snapshot. Every scheduler, quota and outer-loop test uses it, so the system is built and tested without spending vendor quota.

## Quota, reset windows and the burst scheduler

**Quota inside a window is use-it-or-lose-it, so the scheduler's job is to spend a window's headroom on useful work before it resets, never start work that can't finish, pause cleanly at a real limit, and resume after the reset.** All of this is deterministic code in `packages/quota` and `packages/daemon/src/scheduler.ts`, with an injectable clock so every behavior is testable without waiting.

### Data: windows

Each route has zero or more windows. A window is a record, refreshed whenever a source reports it:

```ts
interface Window {
  route: string;
  kind: "5h" | "7d" | "budget";   // budget = user-defined manual limit (runs, minutes or pct per period)
  usedPct: number | null;         // null = unknown, displayed as "unknown"
  resetsAt: string | null;        // ISO; null = unknown
  source: "vendor" | "manual" | "inferred";
  observedAt: string;
  capPct: number;                 // the user's cap from harness.yaml, default 100
}
```

**Sources, in priority order:** `vendor` (read from the CLI's own data), then `inferred` (derived from observed rate-limit events and consumption), then `manual` (user-set budget). A reading older than 10 minutes is marked stale. When a vendor reading and the tool's own tally disagree by more than 10 points, the vendor reading wins and the discrepancy is logged as an event.

### The cost estimator

The scheduler needs to know whether a task will fit in the remaining headroom. After every finished run it records the change in `usedPct` on each affected window (where known), keyed by `(route, role, size)`. It keeps an exponentially weighted moving average and a spread, and predicts a **p80 cost** for a new task. With fewer than 3 samples it uses a conservative default per size (S: 6%, M: 12%, L: 25% of a 5h window; all configurable) and marks the estimate `cold`. On windows with no usage data, cost is estimated in run minutes against the manual budget.

### Usable headroom for a route

```text
headroom_5h = min(cap_5h, 100 - safety_margin) - used_5h
weekly_per_window = (min(cap_7d, 100 - weekly_reserve) - used_7d) / remaining_5h_windows_until_7d_reset
usable = min(headroom_5h, weekly_per_window)        # unknown parts are skipped, not treated as 0
```

The second term stops the scheduler from burning every 5-hour window to the maximum and exhausting the weekly allowance by midweek. `remaining_5h_windows_until_7d_reset` counts only windows outside quiet hours. If a window's used value is unknown, that term is skipped and the dispatch decision relies on the manual budget or a conservative per-window run cap, and the UI shows `unknown`.

### Dispatch rule (burst mode)

The scheduler runs on events (task ready, run finished, window updated) plus a 30-second tick. For each ready task, in priority order (dependency depth, then size, then age):

```text
if worker for role is free
 and route is not PAUSED_UNTIL a future time
 and policy.allowsNow(route)                 # unattended rule, quiet hours, caps
 and predicted_p80_cost(task) <= usable(route) - cost of runs already in flight on that route
then dispatch
else leave the task QUEUED with a typed reason: no_worker | window_exhausted | would_not_fit | policy | paused
```

**"Would not fit" is the key rule.** With 6% of a window left and a typical task costing 15%, the scheduler does not launch it, because it would be cut off mid-task. It prefers a smaller ready task if one fits, so leftover headroom is spent on small tasks near the end of a window. When nothing fits, the route idles until the reset.

### Handling a limit

When an adapter emits `rate_limit` or `quota_exhausted`:

1. **Checkpoint.** The run's worktree is committed as a `wip` checkpoint, and the vendor session id is stored.
2. **Stop the route, not the system.** Mark only the affected route `PAUSED_UNTIL <time>`. Runs on other routes continue. Tasks waiting on this route stay queued.
3. **Pick the resume time.** If the event carries `resetsAt`, use it plus jitter from `burst.resume_jitter_seconds`. Else if a `vendor` window has a `resetsAt`, use that. Else probe with exponential backoff: 15 min, 30 min, 1 h, 2 h, capped at 4 h, with a tiny low-cost probe request to see if the route answers. The UI shows `resume time unknown, probing`.
4. **Resume.** At the resume time, the scheduler dispatches paused tasks first, resuming their vendor sessions with a short prompt: "Continue from your last checkpoint." If the session can't be resumed (the vendor says it expired), start a fresh run on the same branch with a summary of the checkpoint diff.
5. **No false certainty.** A resume time that came from `inferred` or backoff is labeled as such, and a failed probe extends the pause, never forcing a run.

**Edge cases the scheduler must handle**

- **Reset happens while a run is in flight:** the window data updates mid-run, and later dispatch decisions use the new headroom.
- **Two workers on one route hit the limit together:** the first limit event pauses the route; the second run's checkpoint happens without a duplicate pause event.
- **Clock changes, sleep and wake:** on wake, the scheduler re-reads windows before dispatching. Timers use wall-clock times stored in the database, not in-memory delays.
- **Daemon restart during a pause:** `PAUSED_UNTIL` is persisted; recovery restores it.
- **User caps below the vendor's:** `capPct` is a hard ceiling. The tool stops dispatch at the cap even if the vendor would allow more, leaving that share for the user's own work.
- **Cursor with no data:** only the manual `budget` window applies. Display `unknown` for vendor usage.
- **Quiet hours:** no new dispatch in the configured range; in-flight runs finish.
- **Spread across routes:** when two roles could use different routes, the role's configured route is always used. Moving a task to another route happens only with `fallback: auto` on the role, or after the user confirms.

## Data model

**One SQLite database (WAL mode) at `~/.harness/state.db`, plus run artifacts on disk. The event log is the source of truth; other tables are projections that can be rebuilt from it.** Migrations are numbered SQL files in `packages/storage/src/migrations/`. Every table carries `project_id`.

```sql
CREATE TABLE projects (id TEXT PRIMARY KEY, path TEXT NOT NULL, name TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE tasks (
  id TEXT NOT NULL, project_id TEXT NOT NULL, title TEXT NOT NULL, role TEXT NOT NULL,
  state TEXT NOT NULL,                       -- see Task states
  size TEXT NOT NULL, depends_on TEXT NOT NULL DEFAULT '[]',     -- JSON array of task ids
  attempts INTEGER NOT NULL DEFAULT 0, attempts_max INTEGER NOT NULL,
  branch TEXT, worktree TEXT, spec_path TEXT NOT NULL,
  blocked_reason TEXT,                       -- typed reason, see dispatch rule
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE workers (
  id TEXT NOT NULL, project_id TEXT NOT NULL, role TEXT NOT NULL,
  state TEXT NOT NULL,                       -- IDLE | RUNNING | PAUSED | WAITING | FAILED
  current_run TEXT, heartbeat_at TEXT,
  PRIMARY KEY (project_id, id)
);

CREATE TABLE runs (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, task_id TEXT NOT NULL, worker_id TEXT NOT NULL,
  route TEXT NOT NULL, vendor TEXT NOT NULL, model TEXT,
  kind TEXT NOT NULL,                        -- initial | repair | resume | review | plan
  vendor_session_id TEXT, pid INTEGER,
  state TEXT NOT NULL,                       -- STARTING | RUNNING | PAUSED | TAKEN_OVER | SUCCEEDED | FAILED | CANCELLED
  started_at TEXT NOT NULL, ended_at TEXT, exit_code INTEGER, error_kind TEXT,
  usage_delta_json TEXT,                     -- measured change in each window, for the estimator
  artifact_dir TEXT NOT NULL                 -- .harness/runs/<run-id>/
);

CREATE TABLE check_results (
  id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, check_id TEXT NOT NULL,
  ok INTEGER NOT NULL, exit_code INTEGER, duration_ms INTEGER,
  signature TEXT, output_tail TEXT
);

CREATE TABLE findings (
  id INTEGER PRIMARY KEY, run_id TEXT NOT NULL, severity TEXT NOT NULL,
  file TEXT, line INTEGER, message TEXT NOT NULL, resolved INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE windows (
  project_id TEXT NOT NULL, route TEXT NOT NULL, kind TEXT NOT NULL,
  used_pct REAL, resets_at TEXT, source TEXT NOT NULL, observed_at TEXT NOT NULL,
  paused_until TEXT,                         -- set when a limit was hit
  PRIMARY KEY (project_id, route, kind)
);

CREATE TABLE cost_samples (                  -- for the estimator
  route TEXT NOT NULL, role TEXT NOT NULL, size TEXT NOT NULL, window_kind TEXT NOT NULL,
  delta_pct REAL NOT NULL, run_id TEXT NOT NULL, created_at TEXT NOT NULL
);

CREATE TABLE events (                        -- append-only, the source of truth
  seq INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT NOT NULL, project_id TEXT NOT NULL,
  type TEXT NOT NULL, task_id TEXT, run_id TEXT, worker_id TEXT, payload TEXT NOT NULL
);
CREATE INDEX events_task ON events(project_id, task_id, seq);
```

### Task states

`DRAFT` → `QUEUED` → `RUNNING` → `GATING` → `REVIEWING` → `PR_READY` → `MERGED`, with side states `REPAIRING` (back to `GATING`), `PAUSED` (route limit or user pause), `NEEDS_HUMAN`, `TAKEN_OVER`, `CANCELLED` and `STALE` (a contract it used changed). Transitions are pure functions in `core/state/task-machine.ts`, and an illegal transition throws. A diagram follows in *Loop engineering*.

### Event types

Every event has `ts`, `project_id` and a typed `payload` validated by Zod.

| Group | Types |
| --- | --- |
| Project | `project.initialized`, `config.changed`, `readiness.reported`, `baseline.checked` |
| Planning | `plan.requested`, `plan.drafted`, `plan.invalid`, `task.approved` |
| Tasks | `task.created`, `task.state_changed`, `task.blocked`, `task.needs_human` |
| Dispatch | `dispatch.considered` (with the reason it was or wasn't dispatched), `worker.assigned`, `worker.released` |
| Runs | `run.started`, `run.event` (normalized agent events), `run.checkpointed`, `run.resumed`, `run.taken_over`, `run.finished`, `run.crashed` |
| Verify | `check.started`, `check.finished`, `gate.passed`, `gate.failed`, `repair.requested`, `stall.detected` |
| Review | `review.started`, `review.finding`, `review.passed`, `review.blocked` |
| Git | `worktree.created`, `branch.merged`, `merge.conflict`, `pr.opened` |
| Quota | `window.updated`, `window.discrepancy`, `route.paused`, `route.resumed`, `probe.sent`, `budget.cap_reached` |
| Policy | `policy.denied`, `approval.requested`, `approval.granted`, `approval.denied` |
| System | `daemon.started`, `daemon.recovered`, `daemon.stopped` |

**Recovery on daemon start:** read all `RUNNING` and `PAUSED` runs; check whether each pid is alive; if a process is gone, mark the run `FAILED(crashed)`, checkpoint the worktree, and requeue the task as a resume. Never create a second commit or PR for a task that already has one: `pr.opened` and `branch.merged` events are checked first.

## Policy, safety and vendor routes

**The policy engine is plain code that sits between the scheduler and the adapters. Nothing an agent writes can change it, and every denial is an event.** It lives in `packages/policy` and is called before every dispatch, write, command and merge.

### What the engine enforces

| Rule | Enforcement |
| --- | --- |
| Write scope | A worker may only change files matching its role's `paths_allow` and not `paths_deny`. After each run, the tool diffs the worktree; any change outside scope fails the gate (`policy.denied`) and the files are reverted. |
| Protected paths | Changes to `protected_paths` (CI files, env files, `harness.yaml`, `checks.yaml`) need explicit approval, and are blocked in unattended mode. |
| Worktree isolation | The agent's working directory is its worktree. Where a vendor offers a sandbox mode, it is set to workspace-write limited to that directory. |
| Secrets | `.env*` and key files are never read into prompts. Child processes get a filtered environment. Logs are masked by known patterns and by known values. |
| New dependencies | A diff that adds a dependency (lockfile or manifest change) is a review blocker unless the task allows it. |
| Commands | The tool's own subprocesses (checks, git, `gh`) run as argv arrays with no shell. Network use by agents during a run follows the vendor's sandbox settings. |
| Branches | The tool never writes to `main` or any branch outside `harness/**`. Pushes happen only for `harness/**` branches, on `harness pr`, with user confirmation the first time. |
| Kill switch | `harness stop` and `Q` terminate every child process group, then verify none remain. |
| Prompt injection | Task files, issue text, READMEs and tool output are data. The planner is told so, and any plan that adds a task touching protected paths or secrets is blocked until a human approves it. |

### Approvals

An **approval** is a stored request with a context and a decision (`approval.requested`, `.granted`, `.denied`), shown in the UI as a banner. In `assisted` mode every task needs one before running; in `approved-scope` mode only the `require_approval` categories do. An approval applies to one task and one action; it is never reused later. Unattended mode never auto-approves.

### Autonomy levels

| Level | The tool will, without asking | A human must |
| --- | --- | --- |
| `observe` | Scan, plan, draft tasks. Run nothing. | Approve everything |
| `assisted` | Run tasks the user approved one by one | Approve each task and each merge |
| `approved-scope` | Run approved tasks, repair, review, merge task branches into the integration branch | Approve new scope, protected paths, new dependencies, budget increases, and any merge to `main` |

### Vendor routes and unattended use

**Each vendor sets its own rules for automated and unattended use of subscription plans, and those rules change. The tool never decides what a vendor allows. It gives the user an explicit, per-route setting, ships conservative defaults, and records the choice.**

- Every route has an `unattended` policy: `allow`, `ask` or `deny`. "Unattended" means the scheduler would dispatch while the user isn't present, for example overnight or after a reset while the UI is closed. A run you start and watch is attended.
- **Defaults:** subscription routes are `ask`: the scheduler stops at the point it would dispatch unattended and requires a confirmation from the user. API-key routes are `allow`, limited by the budget caps.
- Changing a subscription route to `allow` prints the vendor's current terms link and requires typing the route name to confirm. The decision is stored with a timestamp.
- `harness doctor` shows each route's auth type and unattended setting. Links to each vendor's terms: [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), and the Codex and Cursor pricing and usage pages.
- **Hard rules, not settings:** no credential extraction, copying or sharing; no switching between two accounts of the same vendor to get past a limit; no use of a vendor's session tokens outside the vendor's own CLI.
- **Product language:** "Use the plans you already have." The tool makes no claim about cost savings or beating limits.

The user can run several vendors side by side, each on their own plan or API key. The tool reports usage per route and spends within the caps the user set.

## Functional requirements

**P0 is the MVP: three adapters (or two plus the fake), the daemon, roles, worktrees, the outer loop, the burst scheduler and the terminal UI. P1 adds quality and convenience. P2 is later.** Each row has an acceptance check that a test or a scripted scenario can verify.

| ID | Requirement | Priority | Acceptance |
| --- | --- | --- | --- |
| FR-01 | `harness init` and `doctor`: detect vendor CLIs, versions and sign-in state; write config; print the readiness report | P0 | On a machine with a missing CLI, `doctor` exits 1 and prints the exact install or sign-in command; no token appears in any output |
| FR-02 | Config loading with Zod schemas for `harness.yaml` and `checks.yaml` | P0 | An unknown key, a missing route or a role with no route is rejected with a line number |
| FR-03 | Roles bound to routes; concurrency per role; the tool never changes a role's route silently | P0 | With a role's route paused, its task waits; no other route runs it unless `fallback: auto` |
| FR-04 | Task files, the DAG, and `depends_on` ordering | P0 | A task with an unmerged dependency is never dispatched; a cycle is rejected at approval |
| FR-05 | One git worktree and branch per task from the integration branch; no writes to `main` | P0 | After a full e2e run, `main` is unchanged and every task branch is under `harness/**` |
| FR-06 | Adapter interface with `fake`, Claude, Codex and Cursor implementations; process groups; cancellation | P0 | Cancelling a run leaves zero child processes; the shared adapter test suite passes for every adapter |
| FR-07 | Daemon with Unix socket RPC, event subscriptions, SQLite state and restart recovery | P0 | Killing the daemon mid-run and restarting resumes or requeues with no duplicate commit or PR |
| FR-08 | Outer loop: independent checks, failure signatures, repair via session resume, stall detection, `NEEDS_HUMAN` | P0 | A task that fails the same check twice stops; an agent that claims success with a failing check never reaches `PR_READY` |
| FR-09 | Read-only reviewer role with structured findings; blockers trigger a repair | P0 | The reviewer's worktree is unchanged after its run; a blocker causes a repair run |
| FR-10 | Windows data model, vendor and manual sources, staleness marking, `unknown` never shown as zero | P0 | With no vendor data, the UI and `usage --json` show `unknown` and the source |
| FR-11 | Cost estimator with a cold-start default and a p80 prediction | P0 | After 3 samples, predictions use measured values; with fewer, they are marked `cold` |
| FR-12 | Burst scheduler: would-not-fit rule, smaller task fills the tail, pause per route, checkpoint, resume at reset with jitter, probe backoff | P0 | In the e2e scenario, a limit at step N pauses only that route, checkpoints, and resumes at the scripted reset time with the same session id |
| FR-13 | Terminal UI with Usage, Workers, Tasks, Output panels and the keybindings in this document | P0 | UI snapshot tests render the layout; closing the UI leaves the daemon and runs untouched |
| FR-14 | Policy engine: write scope, protected paths, caps, approvals, unattended setting per route | P0 | A change outside `paths_allow` fails the gate and is reverted; an `ask` route stops before unattended dispatch |
| FR-15 | Attach and takeover with a `wip` checkpoint and resume of the same vendor session | P1 | After takeover, the run shows `TAKEN_OVER`; the worktree contains the checkpoint commit |
| FR-16 | `harness plan`: planner role returns schema-validated draft tasks, roles and dependencies | P1 | An invalid plan is retried once with the validation errors, then fails with a typed error |
| FR-17 | Merge to the integration branch: rebase, re-run checks, fast-forward; conflicts go to `NEEDS_HUMAN` | P1 | A seeded conflict produces `merge.conflict` with the files listed; nothing is auto-resolved |
| FR-18 | `harness pr`: draft PR through `gh` with an evidence block | P1 | The PR body lists the tasks, check results, findings and run usage; the tool never merges |
| FR-19 | Contract-first tasks and `STALE` propagation when a contract changes | P1 | Editing a contract file marks dependent merged-or-running tasks `STALE` |
| FR-20 | Optional tmux mirror of workers | P2 | With `ui.tmux: true`, each running worker appears in a named tmux pane; core works without tmux |
| FR-21 | GitHub issue intake | P2 | A labeled issue becomes exactly one `DRAFT` task, even across restarts |
| FR-22 | Adaptive routing suggestions from the run history | P2 | `harness roles suggest` explains its recommendation with the recorded results; it never changes roles itself |

## Build plan for the coding agent

**Build in this order. Each milestone ends with working, tested software, so the project is always runnable and the riskiest unknowns (real vendor behavior and quota data) are resolved early, in a spike, before anything depends on them.** Stop at the end of each milestone, run the checks, update `docs/PROGRESS.md`, and continue.

| # | Milestone | Packages touched | Done when |
| --- | --- | --- | --- |
| M0 | **Scaffold.** Monorepo, tsconfig, lint, Vitest, CI script, `AGENTS.md`, the `docs/` files, empty packages with their `package.json` dependency rules enforced by a lint rule | root, all | `pnpm typecheck && pnpm lint && pnpm test` run green on empty packages; an import from `core` to `cli` fails lint |
| M1 | **Core and fake adapter.** Zod schemas, ids, injectable clock, the task and worker state machines, the `AgentAdapter` interface, the `fake` adapter with scripted events, `process.ts` with process groups | `core`, `adapters` | State-machine tests cover every legal and illegal transition; the fake adapter passes the shared adapter test suite, including cancel with no orphan processes |
| M2 | **Storage and config.** SQLite schema and migrations, repos, event log, config loader and validator, checks detection | `storage`, `config` | Config errors report line numbers; the database can be rebuilt from the event log in a test |
| M3 | **Workspace.** Git wrapper, worktrees, branches, checkpoints, rebase-and-fast-forward merge, conflict detection | `workspace` | Tests on temp repos: create, checkpoint, merge, conflict, cleanup; `main` never changes |
| M4 | **Verify.** Checks runner (argv, timeout, clean env), failure signatures, readiness report, baseline check | `verify` | A failing check yields a stable signature across paths and line numbers; a red baseline blocks |
| M5 | **Vendor spikes.** *No product code.* For each real CLI installed on this machine: record `--help`, a successful headless run, a rate-limit failure if reproducible, and whether usage and reset data is visible in headless mode. Write the results to `fixtures/` and `docs/VENDORS.md`. List every difference from the *Expected invocations* table in `docs/DECISIONS.md` | `fixtures/`, `docs/` | `docs/VENDORS.md` answers: how does each CLI start headless, resume, run read-only, report usage, report limits? Unknowns are listed |
| M6 | **Real adapters.** Claude, Codex and Cursor adapters written against the M5 fixtures. `detect`, `run`, `cancel`, `usage`, `interactiveCommand` | `adapters` | Each adapter passes the shared suite against recorded fixtures; a live smoke test (`pnpm smoke:<vendor>`, off by default) runs one trivial prompt |
| M7 | **Daemon core.** Socket server, RPC types, event subscription, supervisor (start run, stream events, handle exit and crash), lock and pid file, recovery | `daemon` | e2e: killing the daemon mid-run and restarting recovers with no duplicate commit |
| M8 | **Outer loop.** Dispatch, gate, repair by session resume, stall detection, reviewer, accept and merge, `NEEDS_HUMAN` | `daemon`, `verify`, `planner` | e2e: pass, fail-then-repair, stall, reviewer blocker, and merge conflict scenarios against the fake adapter |
| M9 | **Quota and burst.** Windows, estimator, usable headroom, would-not-fit rule, limit handling with checkpoint, pause per route, resume with jitter, probe backoff, quiet hours, caps | `quota`, `daemon` | e2e: `burst-and-resume` scenario with the fake clock passes, including the edge cases listed in *Quota* |
| M10 | **Policy.** Write-scope enforcement, protected paths, approvals, unattended setting per route, caps | `policy`, `daemon` | e2e: out-of-scope change reverted and failed; `ask` route stops before unattended dispatch |
| M11 | **CLI.** All commands in the reference, JSON output stable, exit codes | `apps/cli` | Every command has a test; `status --json` matches a Zod schema |
| M12 | **Planner.** `plan` and `roles propose` with schema-validated output, retry once, draft tasks | `planner` | An invalid planner output is retried once, then fails with a typed error |
| M13 | **Terminal UI.** Ink app: Usage, Workers, Tasks, Output, Review, Limits editor, keybindings, attach and takeover | `tui` | Snapshot tests of each panel; attach and takeover e2e with the fake adapter |
| M14 | **GitHub.** `harness pr` through `gh`, evidence block | `github` | PR body generated from fixtures; the tool never calls merge |
| M15 | **Harden and document.** Install script, README quick start, an end-to-end demo script on a sample repo with the fake adapter, a live demo with one real vendor | all | A clean checkout installs and reaches a first merged task in under 30 minutes, following only the README |

**Rules while building**

- Do not start a milestone with failing checks from an earlier one.
- Commit at the end of each milestone with a message listing what was added and what was deliberately left out.
- If a milestone reveals the spec is wrong, write the finding to `docs/DECISIONS.md` first, then adjust the spec and continue.
- Small, reviewable commits. Public APIs between packages are typed and documented in a one-paragraph comment above each export.
- The first real-vendor usage in this project is milestone M5. Before that, nothing in the build should consume any vendor quota.

## Testing strategy

**Almost everything is tested against the fake adapter and a fake clock, so the whole system, including bursts, limits and crashes, can be exercised in seconds without touching a real vendor.** Real vendors are touched only in M5 spikes and in opt-in smoke tests.

**Test layers**

- **Unit (Vitest):** state machines, estimator math, headroom formula, failure signatures, config validation, policy rules. Pure functions, no I/O.
- **Adapter contract tests:** one shared suite run against `fake` and against each real adapter's recorded fixtures: events end with `exited`; cancel kills the process group; unknown lines don't crash; rate-limit output maps to a `rate_limit` event.
- **Integration:** workspace tests on temporary git repos; storage tests on temporary databases; verify tests running real commands in temp dirs.
- **End-to-end scenarios** (`tests/e2e/`): start a daemon in a temp home directory against a temp repo, with the fake adapter and a fake clock, then drive it through the CLI client.
- **UI snapshots:** render Ink components to strings with fixed data.
- **Smoke tests (opt-in):** `pnpm smoke:claude|codex|cursor` runs one trivial real prompt. Off in CI.

**Fake adapter scripts.** A script is a list of steps with a virtual time offset: `message`, `file_change`, `tool_call`, `usage`, `rate_limit {window, resetsAt}`, `crash`, `result {ok}`. The fake also exposes a controllable `UsageSnapshot`, and can simulate "session expired on resume".

**Required e2e scenarios**

| Scenario | What it proves |
| --- | --- |
| `happy-path` | Two tasks in two roles run in parallel worktrees, pass the gate, get reviewed and merge into the integration branch; `main` unchanged |
| `repair-loop` | A failing check triggers a repair by session resume; a second failure with the same signature moves the task to `NEEDS_HUMAN` |
| `false-success` | An agent reports success while a required check fails: the task never reaches `PR_READY` |
| `burst-and-resume` | Headroom is 20%; a task costing 15% dispatches and a second doesn't (would-not-fit); a limit event pauses that route only, checkpoints, and resumes at the scripted reset time with jitter and the same session id |
| `weekly-pacing` | With 7d usage high, dispatch stops early in a 5h window even though that window has room |
| `unknown-quota` | A route with no vendor data shows `unknown` and runs only within the manual budget |
| `crash-recovery` | Killing the daemon mid-run, then restarting, produces no duplicate commit or PR and resumes the task |
| `dependency-order` | A task with an unmerged dependency waits, then starts from the integration branch containing the dependency |
| `scope-violation` | A change outside `paths_allow` fails the gate and is reverted |
| `unattended-ask` | A route set to `ask` stops before an unattended dispatch and waits for confirmation |
| `takeover` | Attach pauses the worker, writes a `wip` checkpoint, and the resumed session sees the checkpoint |
| `merge-conflict` | A seeded conflict lands in `NEEDS_HUMAN` with the files listed; nothing is auto-resolved |
| `cancel-all` | `harness stop` leaves zero child processes |

**Determinism rules:** no real sleeps (use the fake clock), no network, no dependence on the user's git config (tests set their own), temp directories cleaned up, and test output free of any environment values.

## Success metrics, risks and open decisions

**Success is a developer who can define roles, run the team overnight, and wake up to merged-or-reviewable branches with a clear record of what happened, without ever being surprised by usage or by a vendor.**

### Metrics (MVP targets)

| Metric | Target | How measured |
| --- | --- | --- |
| Setup to first merged task | Under 30 minutes on a repo with existing checks | Timed by someone other than the author, README only |
| False successes | 0 tasks reach `PR_READY` with a failing required check | `false-success` e2e plus a seeded-failure suite |
| Restart safety | 0 duplicate commits or PRs across 20 forced daemon kills | `crash-recovery` repeated |
| Orphan processes | 0 after `stop` or cancel | Process-table check in e2e |
| Burst correctness | In the simulated suite, 0 dispatches that the headroom rule would have rejected; 100% of limits checkpoint before pause | Scenario assertions on the event log |
| Usage honesty | 0 places where `unknown` is rendered as `0` | UI and JSON snapshot tests |
| Scope safety | 100% of out-of-scope writes caught and reverted | `scope-violation` suite |
| Quality (measured on the user's repo) | Share of tasks that reach `MERGED` within 3 attempts, reported next to a one-agent baseline on the same tasks | Ledger from `harness export` |

These are targets for a first release, not current results. The quality metric is reported honestly, as a comparison, rather than as a promise.

### Risks

| Risk | Mitigation |
| --- | --- |
| A vendor CLI changes flags or output | Version-pinned fixtures; `detect()` records the version; contract tests; an adapter degrades to `unknown` instead of crashing |
| Usage and reset data isn't available in headless mode | M5 spike decides; fallbacks are `inferred` windows from limit errors and manual budgets; the UI always shows the source |
| A vendor restricts unattended use of subscriptions | The per-route `unattended` setting, conservative defaults, an API-key route always available; the setting and its terms link are shown in `doctor` |
| Agents overwrite each other or drift apart | Per-task worktrees, contract-first tasks, short task branches, merge-time re-check |
| Weak repo checks make the loop meaningless | Readiness report, green-baseline requirement, "add tests first" suggestion |
| Runaway loops or spend | Attempt cap, stall detection, task time limit, per-route caps, quiet hours, manual budgets, kill switch |
| Prompt injection through task files or repo content | Content treated as data, protected-path approvals, scope enforcement outside the model |
| Worktree setup is slow or flaky (installs, ports, databases) | `setup` commands per repo, a shared package cache, setup failures reported as their own state |
| Resuming a vendor session fails after a pause | Fallback to a fresh run on the same branch with a checkpoint summary |
| Trademark | Neutral product name; vendor names only descriptively |

### Open decisions

- [ ] **D1.** Build the three adapters directly (this spec), or use [Claudexor](https://github.com/razzant/claudexor) as an optional executor later behind the same `AgentAdapter` interface? The spec assumes direct adapters, which keep the scope small and the dependencies few; Claudexor's reach (more vendors, remote hosts) can come in as another adapter.
- [ ] **D2.** Are any of the three vendors' headless modes able to report usage and resets (M5 answers this)? If Claude's data only appears in interactive status lines, do we install a status-line helper, or rely on inferred windows?
- [ ] **D3.** Default `unattended` setting for subscription routes: `ask` as written, or `deny` until the user opts in during `init`?
- [ ] **D4.** Auto-merge into the integration branch in `approved-scope`, or require `review --accept` for every task at first?
- [ ] **D5.** Where do the first tasks come from: hand-written, or the planner? (Both are supported; which one to polish first.)
- [ ] **D6.** Default `safety_margin_pct`, caps and sizes for the cold-start estimator (6, 12 and 25 percent are placeholders to tune from M5 data).
- [ ] **D7.** First repo to run this on, and whether it has tests today (decides whether the first task is "add test infrastructure").
- [ ] **D8.** Packaging: npm global install only, or also a single-file binary?

### Sources

- [Red-team review](https://claude.ai/code/artifact/256b9b15-4119-44e8-9db0-aa5455b7777a) and [PRD v3](https://claude.ai/code/artifact/f83a1a58-4cfc-4a58-9933-124293010b2c) (earlier drafts of this document)
- [Claude Code legal and compliance](https://code.claude.com/docs/en/legal-and-compliance), [status line and rate limit fields](https://code.claude.com/docs/en/statusline), [agent teams](https://code.claude.com/docs/en/agent-teams)
- [Cursor CLI headless](https://cursor.com/docs/cli/headless), [Codex pricing and limits](https://learn.chatgpt.com/docs/pricing)
- [Bernstein: deterministic coordination](https://docs.bernstein.run/en/latest/blog/zero-llm-coordination/), [Agent Orchestrator research](https://rywalker.com/research/agent-orchestrator), [Claudexor](https://github.com/razzant/claudexor)
- [MAST: why multi-agent systems fail](https://arxiv.org/html/2503.13657v2), [cross-model review study](https://pith.science/paper/2607.21656)
