import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db, sqlite } from './client.js';
import { logger } from '../lib/logger.js';

function main() {
  logger.info('Running migrations…');
  migrate(db, { migrationsFolder: './drizzle' });
  sqlite.close();
  logger.info('Migrations complete.');
}

try {
  main();
  process.exit(0);
} catch (err) {
  logger.error({ err }, 'Migration failed');
  process.exit(1);
}
