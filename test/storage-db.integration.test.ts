import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";

import { openDatabase } from "../src/storage/db.js";

const expectedTables = [
  "action_requests",
  "assets",
  "browser_profiles",
  "evidence",
  "external_actions",
  "job_steps",
  "jobs",
] as const;

const expectedIndexes = [
  "idx_action_requests_open",
  "idx_assets_job",
  "idx_evidence_job",
  "idx_job_steps_job",
  "idx_jobs_status_updated",
] as const;

interface SqliteNameRow {
  name: string;
}

function readNames(db: ReturnType<typeof openDatabase>, type: "table" | "index"): string[] {
  return db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = ? AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all(type)
    .map((row) => (row as SqliteNameRow).name);
}

test("initializes an empty database and safely re-runs migrations", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-publisher-db-"));
  const databasePath = join(root, "nested", "app.db");

  try {
    const first = openDatabase({ databasePath });
    expect(existsSync(databasePath)).toBe(true);
    expect(readNames(first, "table")).toEqual([...expectedTables]);

    const indexNames = readNames(first, "index");
    for (const expectedIndex of expectedIndexes) {
      expect(indexNames.includes(expectedIndex), `${expectedIndex} should exist`).toBe(true);
    }

    expect(first.pragma("user_version", { simple: true })).toBe(2);
    first.close();

    const second = openDatabase({ databasePath });
    expect(readNames(second, "table")).toEqual([...expectedTables]);
    expect(second.pragma("user_version", { simple: true })).toBe(2);
    second.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("enables the required SQLite pragmas", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-publisher-db-"));
  const databasePath = join(root, "app.db");

  try {
    const db = openDatabase({ databasePath });

    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("busy_timeout", { simple: true })).toBe(5000);

    expect(() => {
      db.prepare(
        `INSERT INTO job_steps (
             id, job_id, step_key, status, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        "step-1",
        "missing-job",
        "prepare",
        "pending",
        "2026-09-18T00:00:00.000Z",
        "2026-09-18T00:00:00.000Z",
      );
    }).toThrow(
      /FOREIGN KEY constraint failed/,
    );

    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a database schema newer than this build supports", () => {
  const root = mkdtempSync(join(tmpdir(), "agent-publisher-db-"));
  const databasePath = join(root, "app.db");

  try {
    const db = openDatabase({ databasePath });
    db.pragma("user_version = 3");
    db.close();

    expect(() => openDatabase({ databasePath })).toThrow(
      /Database schema version 3 is newer than supported version 2/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
