# Progress

Definition of done per milestone: `pnpm typecheck && pnpm lint && pnpm test` green, acceptance scenarios pass against the fake adapter, this file updated.

- [x] **M0 Scaffold** — pnpm monorepo, strict TS, ESLint with layering rules (`layers.js`), Vitest, `pnpm check`, AGENTS.md, docs/, stub packages. Layering test: `tests/layering.test.ts`.
- [x] **M1 Core and fake adapter** — Zod schemas (config, task, run, worker, window, events, rpc), ids, FakeClock, task/worker state machines with exhaustive transition tests, `AgentAdapter`, process-group runner, scripted fake agent, shared adapter contract suite (cancel leaves no orphans).
- [ ] M2 Storage and config
- [ ] M3 Workspace
- [ ] M4 Verify
- [ ] M5 Vendor spikes
- [ ] M6 Real adapters
- [ ] M7 Daemon core
- [ ] M8 Outer loop
- [ ] M9 Quota and burst
- [ ] M10 Policy
- [ ] M11 CLI
- [ ] M12 Planner
- [ ] M13 Terminal UI
- [ ] M14 GitHub
- [ ] M15 Harden and document
