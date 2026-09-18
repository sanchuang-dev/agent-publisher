import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import Database from "better-sqlite3";

import { runMigrations } from "./migrations/index.js";

export const DEFAULT_DATABASE_PATH = resolve("data", "app.db");
export const DATABASE_PATH_ENV = "DATABASE_SQLITE_PATH";

export interface OpenDatabaseOptions {
  readonly databasePath?: string;
}

export function resolveDatabasePath(databasePath?: string): string {
  return databasePath ?? process.env[DATABASE_PATH_ENV] ?? DEFAULT_DATABASE_PATH;
}

function ensureDatabaseDirectory(databasePath: string): void {
  if (databasePath === ":memory:") {
    return;
  }

  mkdirSync(dirname(databasePath), { recursive: true });
}

function configureDatabase(db: Database.Database): void {
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
}

export function openDatabase(options: OpenDatabaseOptions = {}): Database.Database {
  const databasePath = resolveDatabasePath(options.databasePath);
  ensureDatabaseDirectory(databasePath);

  const db = new Database(databasePath);

  try {
    configureDatabase(db);
    runMigrations(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
