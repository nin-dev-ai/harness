// Allowed @harness/* imports per package. Dependencies point down toward core,
// never up toward cli or tui. eslint.config.js turns this into lint errors.
export const LAYERS = {
  core: [],
  config: ["core"],
  storage: ["core"],
  adapters: ["core"],
  workspace: ["core"],
  verify: ["core"],
  quota: ["core"],
  policy: ["core"],
  github: ["core"],
  planner: ["core"],
  daemon: ["core", "config", "storage", "adapters", "workspace", "verify", "quota", "policy", "planner", "github"],
  tui: ["core", "daemon"],
  cli: ["core", "config", "storage", "adapters", "workspace", "verify", "quota", "policy", "planner", "github", "daemon", "tui"],
};

export const ALL_PACKAGES = Object.keys(LAYERS);
