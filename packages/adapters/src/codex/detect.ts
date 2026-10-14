import type { DetectResult } from "../types.js";
import { probe, which } from "../cli-adapter.js";

export const CODEX_BINARIES = ["codex"] as const;
export const CODEX_INSTALL_HINT = "npm install -g @openai/codex";

/** Installed? Version? Signed in (`codex login status` exits 0)? */
export async function detectCodex(auth: "subscription" | "api_key" = "subscription", bin?: string): Promise<DetectResult> {
  const path = bin ?? (await which(CODEX_BINARIES));
  if (!path) return { installed: false, signedIn: "unknown", fixHint: CODEX_INSTALL_HINT };
  const v = await probe([path, "--version"]);
  const version = v.stdout.trim().split("\n")[0];
  if (auth === "api_key") {
    const has = Boolean(process.env.OPENAI_API_KEY);
    return { installed: true, ...(version ? { version } : {}), signedIn: has ? "yes" : "no", ...(has ? {} : { fixHint: "export OPENAI_API_KEY=<your key>" }) };
  }
  const s = await probe([path, "login", "status"]);
  const text = `${s.stdout}\n${s.stderr}`;
  const signedIn = s.code === 0 && /logged in/i.test(text) ? "yes" : /not logged in/i.test(text) || s.code !== 0 ? "no" : "unknown";
  return { installed: true, ...(version ? { version } : {}), signedIn, ...(signedIn !== "yes" ? { fixHint: "codex login" } : {}) };
}
