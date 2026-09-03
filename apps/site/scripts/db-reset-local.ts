import { getDatabaseUrl } from '../src/lib/server/db.js';
import {
  parseFlagArgs,
  redactDatabaseUrl,
  resetLocalDatabaseFromBackup,
} from './db-snapshot.js';

const { flags, positionals } = parseFlagArgs(process.argv.slice(2));
const backupPath =
  (typeof flags.from === 'string' ? flags.from : undefined) ?? positionals[0];

if (!backupPath) {
  throw new Error(
    'Usage: pnpm --filter @willgriffin/iolaus-site db:reset-local -- --from <backup-dir>',
  );
}

const databaseUrl =
  typeof flags.databaseUrl === 'string' ? flags.databaseUrl : getDatabaseUrl();

await resetLocalDatabaseFromBackup({
  backupPath,
  databaseUrl,
  skipDoctor: Boolean(flags.skipDoctor),
  skipFiles: Boolean(flags.skipFiles),
  skipMigrate: Boolean(flags.skipMigrate),
});

console.log(`Reset local database from backup: ${backupPath}`);
console.log(`Database: ${redactDatabaseUrl(databaseUrl)}`);
