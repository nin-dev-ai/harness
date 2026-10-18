# harness — multi-agent coding from one terminal

**harness** is a local terminal CLI that coordinates Claude Code, Codex, and Cursor on one Git repository. Describe the work in plain language; harness routes tasks to configured agents, isolates each writer in a Git worktree, and keeps a shared team board and review trail.

It is built for developers who want to run multiple coding agents without managing separate terminals, branches, handoffs, and verification by hand. It:

- checks every task with **your own tests**, run independently of the agent;
- sends failures back to the same agent session as a bounded repair loop;
- has a read-only reviewer check the diff;
- merges passing work into `harness/integration` and, with the default `land: auto`, delivers it to the configured base branch after checks pass.

It reads available usage windows, pauses at a limit, and resumes after the reset. A role can **pool** tools (`pool: [codex, cursor]`) and use model tiers (`models: { S: …, L: … }`) so tasks go to an available route at an appropriate cost.

[See a terminal session preview](docs/TERMINAL_PREVIEW.md).

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

Then, in your own repo, just type `harness` (like `claude`):

```sh
cd ~/code/my-repo
harness
```

**First time:** a short wizard lets you pick your agents (frontend, backend, full stack, tests, docs, reviewer, planner, or your own), which tool and model each one uses, and which folders it may write. It saves `harness.yaml` (edit it by hand any time; `/setup` reruns the wizard).

**Then you chat.** The home screen is like Claude Code's: a big banner, a card listing your agents (tool and model each), and the chat box. Detail is one `/` away:

- **Type a message.** Harness picks one primary writing agent from your roles and starts it. The same conversation keeps that primary across turns; it resumes the vendor session when possible and carries a bounded handoff when the route changes. The primary can delegate a few independent jobs. Use `/plan` when you want a draft split to approve yourself.
- **Tab** picks one agent: its live session shows and your messages go straight to it (a busy agent pauses at a safe point and reads it; an idle one starts a new task). Tab back to `team`.
- **`/`** opens commands: `/agents` (who is doing what: tool, time, context, cost), `/usage` (limits per tool), `/panes` (every live session side by side), `/zoom`, `/review`, `/diff`, `/accept`, `/attach` (the agent's real interactive CLI), `/theme`, `/help`.
- **`/board`** shows the team board (`.harness/HARNESS.md`): what you asked for, who is doing what, what each agent finished and changed, and the notes agents leave each other. Every agent prompt carries it.
- **`/windows`** opens one real terminal window per agent (macOS), each running `harness watch <agent>`; anywhere else, run `harness watch backend-1` in your own terminals.
- **`/land`** retries delivery if an automatic landing was blocked, or delivers work when you chose `land: manual`.
- **Ctrl-C** closes harness in one press and restores your previous terminal screen; the agents keep working. `/stop` stops them.

Everything is also a plain command, for scripts:

```sh
harness init           # detects CLIs and sign-in, proposes .harness/checks.yaml, prints a readiness report
harness setup --upgrade [--pool]   # bring an older harness.yaml up to date, keeping your edits
harness doctor         # exits 1 if anything blocks a run, with the exact fix command
# edit harness.yaml: routes (vendor + auth + model) and roles (who writes where)
harness task add "Add a /health endpoint" --approve   # harness picks the agent (or pass --role)
#   or: harness plan docs/prd.md && harness approve --all
harness run            # the daemon keeps working even if you close the terminal
harness                # full-screen view of every worker, task and usage window
harness review T-001   # diff, checks, findings; --accept merges into harness/integration
harness pr             # draft PR from harness/integration (through gh). Merging is your call.
```

A real end-to-end run with Claude Code (spends a little quota): `bash scripts/live-demo.sh`.
To verify all three subscriptions and automatic delivery in a disposable repository, run `pnpm build && bash scripts/phase3-live-demo.sh`. A rate-limited route hands its task to another route in the pool.

## Banner size and terminal text

The welcome screen picks the largest wordmark that fits: XL (12 rows), big (6 rows), small (3 rows), or none. Set `HARNESS_BANNER=xl|big|small|off` to cap the preferred size; Harness falls back to a smaller one if the window cannot fit it. For example, `HARNESS_BANNER=big harness` keeps the six-row logo in a large terminal.

To enlarge text throughout the UI, change your terminal's font size. On macOS Terminal or iTerm2, `Cmd-+` usually increases it. Harness cannot change the terminal's font size itself.

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
- **Delivery.** By default Harness lands each verified merge into `base_branch`. A task is delivered only when its commit is in that branch. Dirty or conflicting bases are left untouched and shown as blocked; `/land` retries after you resolve the blocker.
- **Limits.** A rate limit pauses only that route, and work is checkpointed as a `wip` commit. It resumes at the reset (plus jitter), or probes with backoff if the reset time is unknown. Every usage number shows its source (`[vendor]`, `[manual]` or `[inferred]`); unknown is never shown as 0%.
- **Policy.** Out-of-scope writes are reverted and fail the gate. Protected paths and new dependencies need approval. Subscription routes ask before dispatching while you're away (`harness routes unattended <route> allow|ask|deny`).
- **Takeover.** `a` in the UI (or `harness attach frontend-1`) pauses the worker, commits a checkpoint, and opens the vendor's own interactive CLI on the same session.

## How the team stays coordinated

- **Routing.** A deterministic router (no model call) scores writing roles on keyword hints, instructions, and mentioned paths. Each role can pool Claude, Codex and Cursor subscription routes. A viable prior route keeps the native session; otherwise the pool uses available headroom and skips missing or signed-out CLIs. Explicit `/plan` can split a larger request into draft tasks.
- **Team board.** `.harness/HARNESS.md` is rebuilt from the event log on every change. Agents read it in their prompt and add to it with `NOTE:` lines in their final summary.
- **Handoff.** A task that depends on others gets their summaries, changed files and notes. A session past `limits.fresh_session_after_tokens` is not resumed; the next run starts fresh from the board instead of a compacted context.
- **Lead.** When a batch of work settles, the read-only `lead` role compares it with your request, reports a status line in the chat, and may set a few follow-ups (`limits.lead_followups`, `limits.lead_rounds`).
- **Pools and tiers.** `pool: [codex, cursor]` on a role spreads its tasks across subscriptions by headroom (never two routes of one vendor). `models: { S, M, L }` on a route picks the model by task size; `limits.review_sizes` decides which sizes get a reviewer.

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
| `harness board` | The team board: asks, who does what, what is done, notes |
| `harness watch <agent>` | Follow one agent's live session in this terminal |
| `harness land` | Bring finished work from `harness/integration` into your branch |

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

## Help and project status

Read the [build progress](docs/PROGRESS.md) for what has been verified, or [open an issue](https://github.com/nin-dev-ai/harness/issues) for setup problems and bugs. Maintained by [nin-dev-ai](https://github.com/nin-dev-ai).
