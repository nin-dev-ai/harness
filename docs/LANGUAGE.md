# Primary language

**TypeScript is the main development language in Harness.** The CLI, daemon, adapters, core state machines, TUI and scenario tests live in `apps/*/src` and `packages/*/src` as `.ts` and `.tsx` files. The repository also contains JavaScript build scripts, shell demos, YAML configuration, JSON fixtures and Markdown documentation.

The project uses strict TypeScript and Zod schemas at external boundaries, as required by `AGENTS.md`. To check the current file mix, run `rg --files | rg '\.(ts|tsx|js|mjs|sh)$'` from the repository root. Earlier per-language file and line counts were captured before later milestones and are not kept as fixed numbers here.
