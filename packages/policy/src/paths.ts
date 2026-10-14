import picomatch from "picomatch";

const cache = new Map<string, (p: string) => boolean>();
function m(glob: string): (p: string) => boolean {
  let f = cache.get(glob);
  if (!f) {
    f = picomatch(glob, { dot: true });
    cache.set(glob, f);
  }
  return f;
}

export function matchesAny(file: string, globs: readonly string[]): boolean {
  return globs.some((g) => m(g)(file));
}

export interface ScopeResult {
  allowed: string[];
  /** Files outside paths_allow or inside paths_deny. */
  violations: { file: string; why: "not_allowed" | "denied" }[];
}

/**
 * Write scope: a file is in scope when it matches `allow` (or allow is
 * undefined = whole repo) and matches no `deny` glob.
 */
export function checkScope(files: readonly string[], allow: readonly string[] | undefined, deny: readonly string[]): ScopeResult {
  const out: ScopeResult = { allowed: [], violations: [] };
  for (const f of files) {
    if (matchesAny(f, deny)) out.violations.push({ file: f, why: "denied" });
    else if (allow && !matchesAny(f, allow)) out.violations.push({ file: f, why: "not_allowed" });
    else out.allowed.push(f);
  }
  return out;
}

/** Files that touch protected paths (CI, env files, harness config). */
export function protectedTouched(files: readonly string[], protectedPaths: readonly string[]): string[] {
  return files.filter((f) => matchesAny(f, protectedPaths));
}

/** Paths whose contents never go into prompts or reviews. */
export const SECRET_GLOBS = ["**/.env", "**/.env.*", "**/*.pem", "**/*.key", "**/id_rsa*", "**/id_ed25519*", "**/.npmrc", "**/.netrc", "**/credentials*.json"];

export function isSecretPath(file: string): boolean {
  return matchesAny(file, SECRET_GLOBS);
}
