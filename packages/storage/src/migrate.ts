import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Database } from "better-sqlite3";

/** SQL migrations directory; a bundled build points `__HARNESS_ASSETS__` at its copy. */
export const MIGRATIONS_DIR = (globalThis as { __HARNESS_ASSETS__?: string }).__HARNESS_ASSETS__
  ? path.join((globalThis as { __HARNESS_ASSETS__?: string }).__HARNESS_ASSETS__!, "migrations")
  : path.join(path.dirname(fileURLToPath(import.meta.url)), "migrations");

/** Apply numbered SQL migrations in order, each once, each in a transaction. Returns applied names. */
export function migrate(db: Database, dir = MIGRATIONS_DIR): string[] {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)");
  const done = new Set(db.prepare("SELECT name FROM schema_migrations").pluck().all() as string[]);
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = fs.readFileSync(path.join(dir, f), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (name, applied_at) VALUES (?, ?)").run(f, new Date().toISOString());
    })();
    applied.push(f);
  }
  return applied;
}
