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
