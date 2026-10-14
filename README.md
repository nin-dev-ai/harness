# harness

A terminal application that runs Claude Code, Codex and Cursor's agent as a coordinated team: one worker per role, each in its own git worktree, with independent checks, a repair loop, and usage-window-aware scheduling.

> Status: under construction. See `docs/PROGRESS.md`.

## Development

```sh
pnpm install
pnpm typecheck && pnpm lint && pnpm test
```

Spec: [`docs/PRD.md`](docs/PRD.md). Conventions: [`AGENTS.md`](AGENTS.md).
