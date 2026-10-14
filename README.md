# harness

Run Claude Code, Codex and Cursor's agent as **one coordinated team from one terminal**.

You declare roles (`frontend: codex`, `backend: claude`, `reviewer: cursor`), and harness runs one worker per role, each in its own git worktree and branch. It then:

- checks every task with **your own tests**, run independently of the agent;
- sends failures back to the same agent session as a bounded repair loop;
- has a read-only reviewer check the diff;
- merges passing work into a local `harness/integration` branch. It **never touches `main`**.

It knows each plan's usage windows, so it spends headroom before a reset, pauses cleanly at a limit, and resumes after the reset.

```
✦ harness · market-terminal                                                                        22:06
✻ claude-sub 5h ████░░ 62% ↺01:00   ◆ codex-sub 5h ██░░░░ 31% ↺03:12   ▲ cursor-key budget 3 of 40 runs/day
 ⠏ backend-1 ✻ claude · T-002   ⠏ frontend-1 ◆ codex · T-001   · reviewer-1 ▲ cursor   · planner-1 ✻ claude
✻ backend-1 · T-002 Quote feed adapter                                  ╭──────────────────────────────────╮
❯ use a constant for the poll interval                                  │ 📂 Files · T-002 +14 -2          │
· paused · user                                                         │   +12 -2   src/server/feed.ts    │
── resume run on claude-sub R-T-002-2 ───────────────────────────────   │   +2  -0   src/server/config.ts  │
⏺ Moving the interval into config.ts                                    │ 📋 Tasks                         │
⏺ Bash(npm test)                                                        │ ⚙ T-001 Watchlist panel          │
  ⎿ ✎ src/server/config.ts                                              │ ⚙ T-002 Quote feed adapter       │
  ⎿ ✓ unit 1.2s                                                         │ 📝 T-003 Wire panel to feed      │
╭────────────────────────────────────────────────────────────────────────────────────────────────────────╮
│ ❯  message backend-1 about T-002…   / for commands                                                     │
╰────────────────────────────────────────────────────────────────────────────────────────────────────────╯
 ✦ market-terminal  ⎇ harness/integration  ▶ running  ⚡ burst  ✅ 3  ⚙ 2  ⏳ 1     /help · Tab agents · Ctrl-C quit
```

## Quick start

You need Node.js 20.19 or newer, git, and at least one of `claude`, `codex` or `cursor-agent` installed and signed in.

```sh
git clone https://github.com/nin-dev-ai/harness && cd harness
bash scripts/install.sh            # installs deps, builds, puts `harness` in ~/.local/bin
```

Try it without spending any quota (fake agents, a sample repo, plan → run → merge → PR dry run):

```sh
pnpm demo
```

Then, in your own repo, just type `harness` (like `claude`). The first time it sets the repo up for you:

```sh
cd ~/code/my-repo
harness
```

Type what you want into the chat bar:

- **Plain text** goes to the selected agent. A busy agent pauses at a safe point, reads it and carries on. An idle agent turns it into a new task. The planner turns it into a plan.
- **`/`** opens a command menu: `/switch`, `/task`, `/plan`, `/approve`, `/run`, `/review`, `/diff`, `/accept`, `/usage`, `/theme`…
- **Tab** switches agents. **Ctrl-C** closes the screen (agents keep working); `/stop` stops everything.
- **`/theme neon|sunset|matrix|ocean|agnoster|mono`** changes the look. `agnoster` uses powerline arrows, like oh-my-zsh.

Everything is also a plain command, for scripts:

```sh
harness init           # detects CLIs and sign-in, proposes .harness/checks.yaml, prints a readiness report
harness doctor         # exits 1 if anything blocks a run, with the exact fix command
# edit harness.yaml: routes (vendor + auth + model) and roles (who writes where)
harness task add "Add a /health endpoint" --role backend --approve
#   or: harness plan docs/prd.md && harness approve --all
harness run            # the daemon keeps working even if you close the terminal
harness                # full-screen view of every worker, task and usage window
harness review T-001   # diff, checks, findings; --accept merges into harness/integration
harness pr             # draft PR from harness/integration (through gh). Merging is your call.
```

A real end-to-end run with Claude Code (spends a little quota): `bash scripts/live-demo.sh`.

## How work flows

```
DRAFT → QUEUED → RUNNING → GATING → REVIEWING → PR_READY → MERGED
                    │          │          │
                 PAUSED    REPAIRING ←────┘    (failed check or reviewer blocker)
             (limit hit)      │
                          NEEDS_HUMAN  (same failure twice, unchanged diff, or out of attempts)
```

- **Gate.** The checks in `.harness/checks.yaml` run in the task's worktree with a clean environment. An agent's claim that the tests pass is never used.
- **Repair.** The failing output goes back to the *same* vendor session. A stall stops the loop: the same failure twice, an unchanged diff, or no attempts left.
- **Review.** The `reviewer` role runs read-only and returns structured findings. A blocker means another repair. Anything the reviewer writes is reverted.
- **Merge.** Rebase onto `harness/integration`, re-run the required checks, then fast-forward. Conflicts go to you, with the conflicting files listed.
- **Limits.** A rate limit pauses only that route, and work is checkpointed as a `wip` commit. It resumes at the reset (plus jitter), or probes with backoff if the reset time is unknown. Every usage number shows its source (`[vendor]`, `[manual]` or `[inferred]`); unknown is never shown as 0%.
- **Policy.** Out-of-scope writes are reverted and fail the gate. Protected paths and new dependencies need approval. Subscription routes ask before dispatching while you're away (`harness routes unattended <route> allow|ask|deny`).
- **Takeover.** `a` in the UI (or `harness attach frontend-1`) pauses the worker, commits a checkpoint, and opens the vendor's own interactive CLI on the same session.

## Commands

| Command | What it does |
| --- | --- |
| `harness` | Open the terminal UI (starts the daemon if needed) |
| `harness init` / `doctor` | Set up the project, or check what blocks a run |
| `harness roles list` / `set` / `propose` / `suggest` | Roles and their routes |
| `harness routes list` / `add` / `remove` / `unattended` | Routes (vendor, auth, model) and unattended policy |
| `harness plan <file>` | Planner splits a PRD into draft tasks with roles and dependencies |
| `harness task add` / `list` / `show` / `edit` / `cancel` / `requeue` / `import-issues` | Tasks |
| `harness approve <T-n\|A-n>` / `--all` | Approve drafts or pending approvals |
| `harness run` / `pause` / `resume` / `stop` | Control the scheduler; `stop` kills every child process |
| `harness status [--json] [--watch]` / `usage` / `logs <run>` | See what is happening |
| `harness review <id> [--accept\|--reject -m]` | Evidence for a task, then merge or send back |
| `harness limits set <route> --window 5h --budget 85%` | Caps below the vendor's, or manual budgets |
| `harness pr [--task id]` / `export` | Draft PR with an evidence block / JSONL ledger |

Global flags: `--project <path>`, `--json`, `--no-color`, `--debug`. Exit codes: 0 ok, 1 failed or blocked, 2 usage error, 3 daemon unreachable.

## Development

```sh
pnpm install
pnpm check                 # typecheck + lint + tests (all against the fake adapter, no vendor quota)
pnpm harness <command>     # run the CLI from source
pnpm smoke:claude          # opt-in live smoke test for one vendor (spends quota)
```

- Spec: [`docs/PRD.md`](docs/PRD.md)
- Progress: [`docs/PROGRESS.md`](docs/PROGRESS.md)
- Deviations and decisions: [`docs/DECISIONS.md`](docs/DECISIONS.md)
- Recorded vendor CLI behavior: [`docs/VENDORS.md`](docs/VENDORS.md)
- Conventions for agents: [`AGENTS.md`](AGENTS.md)

Each vendor sets its own terms for automated use of subscription plans. harness never reads, copies or rotates credentials, and makes no claims about getting around limits. It uses the plans you already have, within the caps you set.
