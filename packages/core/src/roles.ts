/**
 * What each well-known role is for. The setup wizard writes these into
 * harness.yaml as `instructions`, and the planner falls back to them when a
 * role has none, so work goes to the agent whose job it is.
 */
export const ROLE_GUIDES: Record<string, string> = {
  backend: "Servers, APIs, data models, storage, jobs and their tests. Not UI code.",
  frontend: "UI and client code: components, pages, styles, client state and their tests. Not server code.",
  fullstack: "Features that cross UI and server; owns both sides of a change.",
  tests: "Writes and fixes tests and test infrastructure. Does not change product code beyond what a test needs.",
  docs: "README, docs and code comments. Never changes code.",
  reviewer: "Reviews every change against its acceptance criteria. Never edits files.",
  planner: "Splits a request into small tasks for the team and assigns each to the agent whose job it is.",
};

/** A role's instructions, or the built-in guide for a well-known role name. */
export function roleGuide(name: string, instructions = ""): string {
  return instructions.trim() || ROLE_GUIDES[name] || "";
}
