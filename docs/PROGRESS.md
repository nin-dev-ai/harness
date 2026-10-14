# Progress

Definition of done per milestone: `pnpm typecheck && pnpm lint && pnpm test` green, acceptance scenarios pass against the fake adapter, this file updated.

- [x] **M0 Scaffold** — pnpm monorepo, strict TS, ESLint with layering rules (`layers.js`), Vitest, `pnpm check`, AGENTS.md, docs/, stub packages. Layering test: `tests/layering.test.ts`.
- [x] **M1 Core and fake adapter** — Zod schemas (config, task, run, worker, window, events, rpc), ids, FakeClock, task/worker state machines with exhaustive transition tests, `AgentAdapter`, process-group runner, scripted fake agent, shared adapter contract suite (cancel leaves no orphans).
- [x] **M2 Storage and config** — SQLite (WAL) with numbered migrations; `Store.append` validates, logs and projects every event in one transaction; projections rebuild from the log (tested); repos for tasks, runs, workers, windows, events, approvals. Config loader with line-numbered errors, cross-field rules (missing routes, same-vendor fallbacks, same-route warnings), comment-preserving edits, check detection (npm/pnpm/yarn/bun, Python, Go, Rust, Make), task files and cycle detection.
- [x] **M3 Workspace** — git wrapper (argv, no shell, isolated env), integration branch, idempotent per-task worktrees, WIP checkpoints, changed-files/diff/working-tree hash, revert of out-of-scope paths, rebase + squash + re-verify + fast-forward merge, conflicts listed and never resolved, writes refused outside `harness/**`.
- [x] **M4 Verify** — argv checks runner (no shell, process-group timeout, env limited to `env_pass` + PATH/HOME, last 200 lines), failure signatures stable across paths/line numbers/timings, gate outcome, setup runner, readiness report with red-baseline block.
- [x] **M5 Vendor spikes** — recorded help, auth status, headless success, resume and missing-session behavior for Claude Code 2.1.285, Codex 0.162.1 and Cursor agent 2026.10.14; usage data located (Claude stream, Codex session log, Cursor none). See docs/VENDORS.md.
- [x] **M6 Real adapters** — Claude, Codex and Cursor adapters on a shared `CliAdapter` base; parsers tested against recorded fixtures; each passes the shared contract suite via a fixture replayer; vendor usage from Claude `rate_limit_event` and the Codex session log; live smoke tests (`pnpm smoke:claude|codex|cursor`, off by default) passed for all three on 2026-10-14.
- [ ] M7 Daemon core
- [ ] M8 Outer loop
- [ ] M9 Quota and burst
- [ ] M10 Policy
- [ ] M11 CLI
- [ ] M12 Planner
- [ ] M13 Terminal UI
- [ ] M14 GitHub
- [ ] M15 Harden and document
