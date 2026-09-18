import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

const MIGRATIONS_DIR = path.join(__dirname, "migrations");

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL DEFAULT (unixepoch())
    )
  `);

  const applied = new Set<string>(
    (db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as { version: string }[]).map(
      (r) => r.version
    )
  );

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const version = file.replace(".sql", "");
    if (applied.has(version)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf-8");
    db.transaction(() => {
      db.exec(sql);
      db.prepare("INSERT INTO schema_migrations (version) VALUES (?)").run(version);
    })();
  }
}
