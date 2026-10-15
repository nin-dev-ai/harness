# Decisions and deviations (append-only)

## 2026-10-14 · Node version
**Spec:** Node 22 LTS or newer. **Found:** the build machine has Node 20.19.0.
**Decision:** target Node >=20.19 (`engines`). Nothing used so far needs 22. Revisit before release (D8 packaging).

## 2026-10-14 · Internal package resolution
Packages export a `source` condition pointing at `src/*.ts`. `tsconfig.base.json` sets `customConditions: ["source"]` and Vitest sets `resolve.conditions`, so typecheck and tests run without building. `tsup` builds `dist/` for the published CLI.

## 2026-10-14 · Layering enforcement
The allowed-imports map lives in `layers.js` and becomes `no-restricted-imports` rules in `eslint.config.js`. `tui` may import `daemon` (for the RPC client only); see the map for the rest.

## 2026-10-14 · Task transitions beyond the PRD diagram
The PRD diagram lists the main path and side edges. These extra edges are needed by flows the PRD describes elsewhere:
- `QUEUED → PAUSED`, `PAUSED → QUEUED`: user pause of a queued task; resume requeues.
- `RUNNING → QUEUED`: crash recovery "requeues the task as a resume".
- `RUNNING → NEEDS_HUMAN`: a run fails in a way repair cannot fix (auth, CLI missing).
- `REPAIRING → PAUSED`, `PAUSED → REPAIRING`, `REVIEWING → PAUSED`, `PAUSED → REVIEWING`: limits can hit during repair or review runs.
- `REPAIRING → QUEUED`: requeue after a crash during repair.
- `PR_READY → REPAIRING`, `NEEDS_HUMAN → REPAIRING`: `harness review --reject -m` sends work back with a comment.
- `NEEDS_HUMAN → QUEUED`, `NEEDS_HUMAN → TAKEN_OVER`, `TAKEN_OVER → NEEDS_HUMAN`, `TAKEN_OVER → GATING`: human handling.
- `STALE → QUEUED`: re-run after a contract change.
"Any state → CANCELLED" excludes MERGED and CANCELLED; "any state → STALE" excludes DRAFT, CANCELLED and STALE.

## 2026-10-14 · ErrorKind `session_expired`
Added to the PRD's `ErrorKind` list so the outer loop can tell "resume failed, start fresh on the same branch" apart from a crash.

## 2026-10-14 · `started` event timing
The process runner emits `started` on the first output line (so it can carry the vendor session id, which every CLI prints first), or at exit if there was no output. It always carries the pid.

## 2026-10-14 · Storage: event-sourced projections
`Store.append` is the only write path: validate → insert into `events` → apply projection, in one transaction. Projections are a pure function of the log, so `Store.rebuild()` reproduces them exactly. Extra tables beyond the PRD schema: `route_state` (a route can be paused before any window is known), `approvals` (M10), `schema_migrations`. `cost_samples` gained `project_id`. Event payloads gained the fields projections need (`task.created.attemptsMax`, `run.started.artifactDir`, `worker.state_changed.role`, `check.finished.outputTail`) plus a `cost.sampled` event for the estimator.

## 2026-10-14 · Fallback routes
The PRD mentions "an ordered fallback list of routes" but its YAML example has no key for it. Added `roles.<r>.fallback_routes: [...]`. The loader rejects a list containing two routes of the same vendor.

## 2026-10-14 · Check environment
"A clean environment limited to `env_pass`" would leave checks without `PATH`, so nothing could start. Checks get `PATH, HOME, TMPDIR, LANG, SHELL, USER` plus `env_pass`, plus `CI=1`, `NO_COLOR=1`, `FORCE_COLOR=0`. No credentials or other variables pass through.

## 2026-10-14 · M5 findings vs. the "Expected invocations" table (D2 answered)
- **Claude usage is available headless.** `rate_limit_event` in `stream-json` carries both windows with utilization and reset times. No status-line helper is needed. Windows are source `vendor`.
- **Codex `exec --json` has no limit data.** Codex's own session log (`~/.codex/sessions/**/rollout-*-<thread>.jsonl`, not an auth file) records `rate_limits.primary/secondary`. The adapter reads the newest `token_count` entry for the thread it just ran and reports it as source `vendor`. If the file is missing, it falls back to `inferred`. Credentials are never read.
- **Codex resume** is `codex exec resume <id> <prompt>` and doesn't accept `-s`. The sandbox is passed as `-c sandbox_mode="…"`.
- **Codex and Cursor need stdin closed**, or they wait for input.
- **Cursor binary** is `cursor-agent` on this machine. The adapter tries `agent`, then `cursor-agent`.
- **Cursor resume of an unknown id** silently starts a fresh chat (exit 0), so `session_expired` can't be detected for Cursor. Resumed runs still get the checkpoint summary in the prompt, so a fresh chat has enough context.
- **Read-only Cursor** uses `--mode plan` rather than just leaving out `--force`.

## 2026-10-14 · `started` waits for the session id
Codex can print output before `thread.started`. The process runner holds events until a line gives a session id (or 20 lines pass, or the process exits), then emits `started` with the session id followed by the held events.

## 2026-10-14 · One adapter instance per route
`createAdapter(routeName, route)` builds an adapter per route, so `usage()` returns the windows that route's account last reported.

## 2026-10-14 · Outer loop details
- **Reviewer role** is the role named `reviewer`. With no such role, a task that passes the gate goes to `PR_READY` (through `REVIEWING`, with `review.passed {findings: 0}`).
- **Workers** are held from dispatch through the gate, then released. Review and repair are separate work items, picked by the scheduler when a worker of the right role is free (the implementer's worker for repairs, a reviewer worker for reviews).
- **Pause cause** is the reason on the transition into `PAUSED`: `limit:<route>` resumes automatically after the reset; `user` waits for `harness resume`.
- **Stall order:** unchanged diff is checked before same signature, since "the repair changed nothing" is the more specific diagnosis.
- **A crashed or timed-out run still goes to the gate.** Partial work is checkpointed, and only the checks decide. Auth, CLI-missing and CLI-version errors go straight to `NEEDS_HUMAN`.
- **A failed re-verification after rebase** goes to `NEEDS_HUMAN` (not an automatic repair), with the failing output as evidence.
- **`review --reject -m`** is stored as a denied approval carrying the comment, followed by `repair.requested {cause: human}`.
- **Attended** means a client command with `attended: true` within the last 10 minutes (used by the unattended policy in M10).

## 2026-10-14 · Quota details
- **Unknown usage with no manual budget:** at most 8 runs per route per rolling 5 hours (`UNKNOWN_RUNS_PER_5H`).
- **Burst off (`b`)** skips the would-not-fit rule but still stops at caps, exhausted windows and budgets.
- **Cost samples** are recorded only from `vendor` readings within one reset period, and divided by the most runs that overlapped on the route.
- **`max_tasks_per_burst`** counts new (initial) runs on a route since the scheduler started or the route last resumed.
- **Quiet hours** use the daemon's local time.

## 2026-10-14 · Policy details
- **New dependencies** surface as a failed synthetic `dependencies` check at the gate (an approval is requested at the same time), not as a reviewer finding. The effect is the same, a blocked task with a repair prompt that names the dependency, and it doesn't depend on the reviewer noticing. `allow_new_dependencies: true` in the task file, or a granted approval, allows them.
- **Protected paths:** while attended, a change to a protected path requests an approval and blocks auto-merge (`review --accept` grants it). While unattended, the change is reverted and fails a synthetic `protected-paths` check.
- **Unattended `ask`** approvals are scoped to one task, route, run kind and attempt, so they're never reused for a later dispatch.
- **`harness approve <id>`** approves a DRAFT task and also grants that task's pending approvals.
- The one-route-per-vendor fallback rule exempts the `fake` test vendor.
## 2026-10-14 · Long socket paths
macOS limits Unix socket paths to about 104 bytes. When `$HARNESS_HOME/daemon.sock` would be longer, the socket goes to `/tmp/harness-<hash of home>.sock`.

## 2026-10-14 · `a` in the UI
The PRD uses `a` for both "approve a draft" (Daily use) and "attach" (keybindings). In the UI, `a` on a **DRAFT task** in the Tasks panel approves it; anywhere else `a` attaches. `harness approve` and `harness attach` stay separate commands.

## 2026-10-14 · Burst toggle
`b` writes `burst.enabled` to harness.yaml (so the choice survives restarts) and reloads the project.

## 2026-10-14 · Headroom units (found in the live demo)
The PRD's `usable = min(headroom_5h, weekly_per_window)` compares a task cost in **% of the 5h window** with a weekly share in **% of the 7d window**. Those are different units. In the live Claude demo this blocked a review that needed about 12% of the 5h window, against 2.2% of the week left per window, even though the review costs far less than 2.2% of the week. Fix: each window is checked in its own units. The 5h p80 cost goes against 5h headroom, and the 7d p80 cost (learned from `cost.sampled` 7d deltas; cold default = 5h default × 0.2) goes against `weekly_per_window`. `usableHeadroom` still reports both terms.

## 2026-10-14 · D6 data point (live demo)
With a real Claude Pro account at 62% (5h) and 33% (7d) with ~5 days to the weekly reset, a 10% weekly reserve leaves 2.19% of the week per 5h window. The cold 7d estimate for an M task (12% × 0.2 = 2.4%) did not fit, so the scheduler waited. The run itself cost 4 points of the 5h window. Cold defaults stay as specified until more samples exist. The estimator replaces them after 3 measured runs per (route, role, size). Recovery now keeps REVIEWING and REPAIRING tasks in place instead of requeueing them, and reviews are estimated as size S.

## 2026-10-14 · Chat-first UI (user request)
The terminal UI is now chat-first, like Claude Code. A chat bar is always focused; `/` opens a slash-command menu; Tab switches agent tabs. Plain text goes to the selected agent: a running agent stops at a safe point (work checkpointed) and resumes on its same session with the message (`human.message` event, `message.md` prompt). An idle agent turns it into a new approved task, and the planner turns it into a plan. Themes (neon, sunset, matrix, ocean, agnoster with powerline glyphs, mono) are remembered in `~/.harness/ui.json`. Plain `harness` in a repo with no `harness.yaml` runs `init` itself before opening. The PRD's single-key bindings are replaced by slash commands, since every key now types into the chat bar.

## 2026-10-14 · Management panel instead of chat UI (user feedback)
The chat-first UI felt like a second Claude Code and its colors were distracting. The screen is now a management panel:
- an agent table (tool/model, status, task, time, context tokens, cost);
- a detail pane for the selected agent (brief, acceptance, files with +/-, last gate, attempt, current action, branch, needs-you and approvals);
- a one-line queue of things needing a person;
- a `/` command line.

There is no output stream on the main screen. The palette is neutral, with one accent for the selection and yellow/red only for waiting or problems. Setup is a first-run wizard (tools, agents, per-agent tool/model/write scope/count) that writes harness.yaml. `harness setup` reruns it. Messages to agents remain available as `/msg`.

## 2026-10-15 · Chat-with-your-team screen (user's concept)
Final shape of the UI, replacing the management panel: pick agents in a first-run wizard, then chat. A message with the team focused runs the `dispatch` RPC: the planner splits it into one mini prompt (task) per agent, tasks are approved and the scheduler starts. Tab focuses one agent so messages go straight to it. One live pane per agent in a balanced grid, in the tool's own color; `/agents`, `/usage`, `/zoom`, `/review`, `/diff`, `/attach` are slash commands. Color is for chrome (gradient logo, pane borders, status blocks); message text stays the default color.

"Terminal sessions" are live panes fed by each agent's structured headless run, so harness always knows when an agent finishes, fails or hits a limit (needed for checks, repair, review and merge). `/attach` opens the real interactive CLI on the same session. A tmux mirror exists behind `ui.tmux`. Typing keystrokes into real interactive CLIs was not chosen: harness could no longer reliably detect done/failed/usage.

## 2026-10-15 · Home screen like Claude Code
The home screen is a huge gradient HARNESS banner, a welcome card listing every agent with its tool and model, then the chat box and a one-line status bar. While agents work, one calm line per working agent shows its task and current action. Detail is behind slash commands: `/agents` (table), `/usage`, `/panes` (all live sessions side by side), `/zoom`, `/review`, `/diff`. Tab focuses an agent and switches the feed to that agent's live session. Once a conversation fills the screen the banner collapses to a one-line header with agent chips.

## 2026-10-15 · Chat dispatch: roles that mean something, work that runs in parallel
A live chat run planned two tasks for `frontend` (code, then a README chained after it) while `backend` sat idle, so everything ran serially (~11 min). Causes: wizard roles had no instructions, and chat used the full `plan` prompt (contract-first, test-infra tasks, follow-ups). Now: well-known roles get built-in guides (`ROLE_GUIDES` in core), written by the wizard and used as a fallback by the planner; chat uses a separate `dispatch` prompt that asks for one parallel task per agent, few dependencies and no invented follow-ups, and shows each role's folders and concurrency; after planning, `fitRoles` deterministically moves a task whose files lie outside its role's folders to a role that covers them (`plan.reassigned` event), since those edits would otherwise be reverted.

## 2026-10-15 · M17 Routing without tags
Users should not have to say which agent does what. A deterministic router (`@harness/planner` `routeWork`) scores write roles on keyword hints, words from the role's instructions, and mentioned file paths against `paths_allow` (a role that cannot write a mentioned file is out). A clear winner starts immediately with no planning run; signal for two roles, or none, goes to the planner (or the least busy writer when there is no planner). Rule 4 holds: the choice is code, and it is recorded as `task.routed` with its reason.

## 2026-10-15 · M18 Team board
Agents run in separate vendor sessions, so each one only knew its own task. One board, `.harness/HARNESS.md`, is now the shared memory: rebuilt from the event log on every relevant event (rule 4: no model writes it), and carried in every task prompt (capped at 6,000 characters). Agents contribute through `NOTE:` lines in their final summary, which harness lifts onto the board. It lives under `.harness/` so it never enters task branches or merges. `/board` and `harness board` show it.
