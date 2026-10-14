# Decisions and deviations (append-only)

## 2026-10-14 · Node version
**Spec:** Node 22 LTS or newer. **Found:** the build machine has Node 20.19.0.
**Decision:** target Node >=20.19 (`engines`). Nothing used so far needs 22. Revisit before release (D8 packaging).

## 2026-10-14 · Internal package resolution
Packages export a `source` condition pointing at `src/*.ts`. `tsconfig.base.json` sets `customConditions: ["source"]` and Vitest sets `resolve.conditions`, so typecheck and tests run without building. `tsup` builds `dist/` for the published CLI.

## 2026-10-14 · Layering enforcement
The allowed-imports map lives in `layers.js` and becomes `no-restricted-imports` rules in `eslint.config.js`. `tui` may import `daemon` (for the RPC client only); see the map for the rest.
