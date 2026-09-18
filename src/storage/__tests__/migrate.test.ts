import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";
import { runMigrations } from "../migrate";

function tmpDb(): { db: Database.Database; file: string } {
  const file = path.join(os.tmpdir(), `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  const db = new Database(file);
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  return { db, file };
}

describe("runMigrations", () => {
  let db: Database.Database;
  let file: string;

  beforeEach(() => {
    ({ db, file } = tmpDb());
  });

  afterEach(() => {
    db.close();
    for (const ext of ["", "-shm", "-wal"]) {
      try { fs.unlinkSync(file + ext); } catch { /* ignore */ }
    }
  });

  it("creates all 7 tables on a fresh database", () => {
    runMigrations(db);

    const tables = (
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
    ).map((r) => r.name);

    const expected = [
      "schema_migrations",
      "jobs",
      "job_steps",
      "action_requests",
      "browser_profiles",
      "assets",
      "evidence",
      "external_actions",
    ];

    for (const t of expected) {
      expect(tables, `table '${t}' should exist`).toContain(t);
    }
  });

  it("is idempotent — running migrations twice does not throw or duplicate", () => {
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();

    const count = (
      db.prepare("SELECT COUNT(*) as c FROM schema_migrations").get() as { c: number }
    ).c;
    expect(count).toBe(7);
  });

  it("records applied migrations in schema_migrations", () => {
    runMigrations(db);
    const rows = db
      .prepare("SELECT version FROM schema_migrations ORDER BY version")
      .all() as { version: string }[];
    expect(rows).toHaveLength(7);
    expect(rows[0].version).toBe("001_jobs");
    expect(rows[6].version).toBe("007_external_actions");
  });

  it("enforces foreign_keys pragma", () => {
    runMigrations(db);
    const fk = (db.pragma("foreign_keys") as { foreign_keys: number }[])[0]?.foreign_keys;
    expect(fk).toBe(1);
  });

  it("enforces WAL journal_mode", () => {
    runMigrations(db);
    const mode = (db.pragma("journal_mode") as { journal_mode: string }[])[0]?.journal_mode;
    expect(mode).toBe("wal");
  });

  it("sets busy_timeout to 5000", () => {
    runMigrations(db);
    const timeout = (db.pragma("busy_timeout") as { timeout: number }[])[0]?.timeout;
    expect(timeout).toBe(5000);
  });

  it("jobs table rejects duplicate primary key", () => {
    runMigrations(db);
    db.prepare(
      "INSERT INTO jobs (id, platform) VALUES ('j1', 'xiaohongshu')"
    ).run();
    expect(() =>
      db.prepare("INSERT INTO jobs (id, platform) VALUES ('j1', 'douyin')").run()
    ).toThrow();
  });

  it("job_steps foreign key rejects unknown job_id", () => {
    runMigrations(db);
    expect(() =>
      db
        .prepare(
          "INSERT INTO job_steps (id, job_id, name) VALUES ('s1', 'nonexistent', 'step1')"
        )
        .run()
    ).toThrow();
  });

  it("external_actions idempotency_key unique index works", () => {
    runMigrations(db);
    db.prepare(
      "INSERT INTO jobs (id, platform) VALUES ('j1', 'xiaohongshu')"
    ).run();
    db.prepare(
      "INSERT INTO external_actions (id, job_id, platform, action_type, idempotency_key) VALUES ('ea1', 'j1', 'xiaohongshu', 'publish', 'key1')"
    ).run();
    expect(() =>
      db
        .prepare(
          "INSERT INTO external_actions (id, job_id, platform, action_type, idempotency_key) VALUES ('ea2', 'j1', 'xiaohongshu', 'publish', 'key1')"
        )
        .run()
    ).toThrow();
  });
});
