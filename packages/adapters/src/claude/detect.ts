import type { DetectResult } from "../types.js";
import { probe, which } from "../cli-adapter.js";

export const CLAUDE_BINARIES = ["claude"] as const;
export const CLAUDE_INSTALL_HINT = "curl -fsSL https://claude.ai/install.sh | bash";

/** Installed? Version? Signed in (claude auth status → loggedIn)? Tokens are never read or printed. */
export async function detectClaude(auth: "subscription" | "api_key" = "subscription", bin?: string): Promise<DetectResult> {
  const path = bin ?? (await which(CLAUDE_BINARIES));
  if (!path) return { installed: false, signedIn: "unknown", fixHint: CLAUDE_INSTALL_HINT };
  const v = await probe([path, "--version"]);
  const version = v.stdout.trim().split("\n")[0];
  if (auth === "api_key") {
    const has = Boolean(process.env.ANTHROPIC_API_KEY);
    return { installed: true, ...(version ? { version } : {}), signedIn: has ? "yes" : "no", ...(has ? {} : { fixHint: "export ANTHROPIC_API_KEY=<your key>" }) };
  }
  const s = await probe([path, "auth", "status", "--json"]);
  let loggedIn: boolean | undefined;
  try {
    loggedIn = (JSON.parse(s.stdout) as { loggedIn?: boolean }).loggedIn;
  } catch {
    loggedIn = undefined;
  }
  const signedIn = loggedIn === true ? "yes" : loggedIn === false ? "no" : "unknown";
  return { installed: true, ...(version ? { version } : {}), signedIn, ...(signedIn !== "yes" ? { fixHint: "claude auth login" } : {}) };
}
