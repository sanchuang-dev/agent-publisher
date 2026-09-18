import * as path from "path";

export interface Config {
  dbPath: string;
}

export function getConfig(): Config {
  return {
    dbPath: process.env.DB_PATH ?? path.join(process.cwd(), "data", "app.db"),
  };
}
