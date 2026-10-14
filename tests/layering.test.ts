import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cwd: process.cwd() });

async function lint(code: string, filePath: string) {
  const [result] = await eslint.lintText(code, { filePath });
  return result?.messages.filter((m) => m.ruleId === "no-restricted-imports") ?? [];
}

describe("package layering", () => {
  it("rejects core importing cli", async () => {
    expect(await lint(`import "@harness/cli";\n`, "packages/core/src/x.ts")).toHaveLength(1);
  });
  it("rejects any package importing tui except cli", async () => {
    expect(await lint(`import "@harness/tui";\n`, "packages/daemon/src/x.ts")).toHaveLength(1);
    expect(await lint(`import "@harness/tui";\n`, "apps/cli/src/x.ts")).toHaveLength(0);
  });
  it("allows downward imports", async () => {
    expect(await lint(`import "@harness/core";\n`, "packages/quota/src/x.ts")).toHaveLength(0);
  });
  it("rejects sibling imports", async () => {
    expect(await lint(`import "@harness/storage";\n`, "packages/quota/src/x.ts")).toHaveLength(1);
  });
});
