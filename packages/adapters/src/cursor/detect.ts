import type { DetectResult } from "../types.js";
import { probe, which } from "../cli-adapter.js";

export const CURSOR_BINARIES = ["agent", "cursor-agent"] as const;
export const CURSOR_INSTALL_HINT = "curl https://cursor.com/install -fsS | bash";

/** Installed? Version? Signed in (`status --format json` → isAuthenticated, or CURSOR_API_KEY)? */
export async function detectCursor(auth: "subscription" | "api_key" = "api_key", bin?: string): Promise<DetectResult> {
  const path = bin ?? (await which(CURSOR_BINARIES));
  if (!path) return { installed: false, signedIn: "unknown", fixHint: CURSOR_INSTALL_HINT };
  const v = await probe([path, "--version"]);
  const version = v.stdout.trim().split("\n")[0];
  if (auth === "api_key" && process.env.CURSOR_API_KEY) return { installed: true, ...(version ? { version } : {}), signedIn: "yes" };
  const s = await probe([path, "status", "--format", "json"]);
  let ok: boolean | undefined;
  try {
    ok = (JSON.parse(s.stdout) as { isAuthenticated?: boolean }).isAuthenticated;
  } catch {
    ok = undefined;
  }
  const signedIn = ok === true ? "yes" : ok === false ? "no" : "unknown";
  const hint = auth === "api_key" ? "export CURSOR_API_KEY=<your key>" : `${path.split("/").pop()} login`;
  return { installed: true, ...(version ? { version } : {}), signedIn, ...(signedIn !== "yes" ? { fixHint: hint } : {}) };
}
