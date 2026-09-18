import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";
import { getConfig } from "../config";
import { runMigrations } from "./migrate";

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (_db) return _db;

  const config = getConfig();
  const dbDir = path.dirname(config.dbPath);

  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  const db = new Database(config.dbPath);

  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");

  runMigrations(db);

  _db = db;
  return db;
}

export function closeDb(): void {
  if (_db) {
    _db.close();
    _db = null;
  }
}
