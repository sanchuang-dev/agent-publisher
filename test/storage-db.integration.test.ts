import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

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
    assert.equal(existsSync(databasePath), true);
    assert.deepEqual(readNames(first, "table"), [...expectedTables]);

    const indexNames = readNames(first, "index");
    for (const expectedIndex of expectedIndexes) {
      assert.equal(indexNames.includes(expectedIndex), true, `${expectedIndex} should exist`);
    }

    assert.equal(first.pragma("user_version", { simple: true }), 1);
    first.close();

    const second = openDatabase({ databasePath });
    assert.deepEqual(readNames(second, "table"), [...expectedTables]);
    assert.equal(second.pragma("user_version", { simple: true }), 1);
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

    assert.equal(db.pragma("foreign_keys", { simple: true }), 1);
    assert.equal(db.pragma("journal_mode", { simple: true }), "wal");
    assert.equal(db.pragma("busy_timeout", { simple: true }), 5000);

    assert.throws(
      () => {
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
      },
      /FOREIGN KEY constraint failed/,
    );

    db.close();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
