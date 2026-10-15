import { describe, expect, it } from "vitest";
import { isStaleBuild } from "./_client.js";

describe("stale daemon detection", () => {
  const build = { entry: "/x/dist/main.js", mtimeMs: 1000 };
  it("is stale only when the same entry file is newer than when the daemon started", () => {
    expect(isStaleBuild(build, "/x/dist/main.js", () => 2000)).toBe(true);
    expect(isStaleBuild(build, "/x/dist/main.js", () => 1000)).toBe(false);
    expect(isStaleBuild(build, "/other/main.js", () => 2000)).toBe(false);
    expect(isStaleBuild(build, "/x/dist/main.js", () => undefined)).toBe(false);
    expect(isStaleBuild(undefined, "/x/dist/main.js", () => 2000)).toBe(false);
  });
});
