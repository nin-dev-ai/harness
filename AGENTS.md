# AGENTS.md — conventions for agents working on this repo

This repo builds `harness`, a terminal multi-agent harness. The spec is `docs/PRD.md`.

## Rules
1. Build in milestone order (`docs/PRD.md` → *Build plan*). Track progress in `docs/PROGRESS.md`.
2. Everything is developed against the `fake` adapter. Never spend vendor quota before M5.
3. Never hard-code a vendor CLI flag from memory. Record real `--help` output in `fixtures/` and `docs/VENDORS.md` first.
4. Deterministic code runs the system. No LLM calls in scheduler, quota, state machines, policy or verify.
5. TypeScript strict. Zod at every external boundary. No `any` across package boundaries.
6. Dependencies point down toward `core` (see `layers.js`; enforced by `pnpm lint`). Nothing imports `tui` or `cli`.
7. Every state change writes an event.
8. Spec conflicts go in `docs/DECISIONS.md` before you choose.

## Layout
- `packages/<name>/src` — one package, one job. Import other packages as `@harness/<name>`, never by relative path.
- `apps/cli` — the `harness` binary.
- `tests/e2e` — scenario tests running the daemon with the fake adapter and a fake clock.
- `fixtures/` — recorded vendor CLI output.

## Commands
- `pnpm typecheck && pnpm lint && pnpm test` — must pass before a milestone is done.
- Relative imports use `.js` extensions (NodeNext). Packages resolve to `src/` through the `source` export condition, so no build step is needed for typecheck or tests.

## Tests
- No real sleeps in scenario tests: use the injectable clock from `@harness/core`.
- No network. Tests set their own git identity. Temp dirs are cleaned up.
