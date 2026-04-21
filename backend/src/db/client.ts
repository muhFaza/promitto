import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { env } from '../config/env.js';
import * as schema from './schema.js';

const dbPath = resolve(env.DATABASE_PATH);
const dataDir = dirname(dbPath);

mkdirSync(dataDir, { recursive: true });
try {
  chmodSync(dataDir, 0o700);
} catch {
  // non-fatal — perms may fail on unusual filesystems
}

export const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('busy_timeout = 5000');

for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
  try {
    chmodSync(p, 0o600);
  } catch {
    // file may not exist yet (wal/shm are lazy)
  }
}

export const db = drizzle(sqlite, { schema });
export { schema };
