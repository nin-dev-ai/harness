/** Manifests and lockfiles: a change to one of these may add a dependency. */
export const MANIFESTS = ["package.json", "requirements.txt", "pyproject.toml", "Cargo.toml", "go.mod", "Gemfile", "composer.json"];
export const LOCKFILES = ["pnpm-lock.yaml", "package-lock.json", "yarn.lock", "bun.lock", "bun.lockb", "poetry.lock", "uv.lock", "Cargo.lock", "go.sum", "Gemfile.lock", "composer.lock"];

const base = (f: string) => f.split("/").pop() ?? f;

export function dependencyFiles(files: readonly string[]): string[] {
  return files.filter((f) => MANIFESTS.includes(base(f)) || LOCKFILES.includes(base(f)));
}

function pkgDeps(text: string | undefined): Set<string> {
  if (!text) return new Set();
  try {
    const j = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
    return new Set(["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"].flatMap((k) => Object.keys(j[k] ?? {})));
  } catch {
    return new Set();
  }
}

function lineDeps(text: string | undefined, re: RegExp): Set<string> {
  if (!text) return new Set();
  return new Set(text.split("\n").map((l) => re.exec(l.trim())?.[1]?.toLowerCase()).filter((x): x is string => Boolean(x)));
}

/** Dependency names added to a manifest between two versions of it. */
export function addedDependencies(file: string, before: string | undefined, after: string | undefined): string[] {
  const b = base(file);
  let pre: Set<string>;
  let post: Set<string>;
  if (b === "package.json" || b === "composer.json") [pre, post] = [pkgDeps(before), pkgDeps(after)];
  else if (b === "requirements.txt") [pre, post] = [lineDeps(before, /^([A-Za-z0-9_.-]+)/), lineDeps(after, /^([A-Za-z0-9_.-]+)/)];
  else if (b === "go.mod") [pre, post] = [lineDeps(before, /^(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/[^\s]+)\s+v/), lineDeps(after, /^(?:require\s+)?([a-z0-9.-]+\.[a-z]{2,}\/[^\s]+)\s+v/)];
  else if (b === "Cargo.toml" || b === "pyproject.toml" || b === "Gemfile") [pre, post] = [lineDeps(before, /^["']?([A-Za-z0-9_.-]+)["']?\s*[=(<>~^,]/), lineDeps(after, /^["']?([A-Za-z0-9_.-]+)["']?\s*[=(<>~^,]/)];
  else return [];
  return [...post].filter((d) => !pre.has(d)).sort();
}

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{10,}/g,
  /sk-[A-Za-z0-9_-]{20,}/g,
  /gh[pousr]_[A-Za-z0-9]{20,}/g,
  /github_pat_[A-Za-z0-9_]{20,}/g,
  /AKIA[0-9A-Z]{16}/g,
  /xox[abprs]-[A-Za-z0-9-]{10,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:key_|crsr_)[A-Za-z0-9]{24,}\b/g,
];

/** Values of credential-looking environment variables, for masking by value. */
export function secretValues(env: NodeJS.ProcessEnv): string[] {
  return Object.entries(env)
    .filter(([k, v]) => v && v.length >= 8 && /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(k))
    .map(([, v]) => v!);
}

/** Mask known secret patterns and known secret values. */
export function maskSecrets(text: string, values: readonly string[] = []): string {
  let out = text;
  for (const v of values) if (v) out = out.split(v).join("[masked]");
  for (const re of SECRET_PATTERNS) out = out.replace(re, "[masked]");
  return out;
}
