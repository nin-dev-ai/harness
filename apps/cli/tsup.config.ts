import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "tsup";

const root = path.resolve(import.meta.dirname, "../..");

/** One ESM file with every @harness package inlined; npm packages stay external. */
export default defineConfig({
  entry: { main: "src/main.ts" },
  format: ["esm"],
  platform: "node",
  target: "node20",
  bundle: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  noExternal: [/^@harness\//],
  esbuildOptions(o) {
    o.conditions = ["source"];
    o.jsx = "automatic";
  },
  banner: {
    js: [
      'import { createRequire as __harnessRequire } from "node:module";',
      "const require = __harnessRequire(import.meta.url);",
      'globalThis.__HARNESS_ASSETS__ = new URL("./assets", import.meta.url).pathname;',
    ].join("\n"),
  },
  async onSuccess() {
    const out = path.join(import.meta.dirname, "dist", "assets");
    const copy = (from: string, to: string) => fs.cpSync(path.join(root, from), path.join(out, to), { recursive: true });
    copy("packages/storage/src/migrations", "migrations");
    copy("packages/planner/src/prompts", "prompts");
    copy("packages/adapters/src/fake/agent.mjs", "fake/agent.mjs");
    fs.chmodSync(path.join(import.meta.dirname, "dist", "main.js"), 0o755);
  },
});
