import { getDatabaseUrl } from '../src/lib/server/db.js';
import {
  parseFlagArgs,
  redactDatabaseUrl,
  restoreBackup,
} from './db-snapshot.js';

const { flags, positionals } = parseFlagArgs(process.argv.slice(2));
const backupPath =
  (typeof flags.from === 'string' ? flags.from : undefined) ?? positionals[0];

if (!backupPath) {
  throw new Error(
    'Usage: pnpm --filter @willgriffin/iolaus-site db:import -- --from <backup-dir> [--allow-installation-rebind]',
  );
}

const databaseUrl =
  typeof flags.databaseUrl === 'string' ? flags.databaseUrl : getDatabaseUrl();

await restoreBackup({
  allowInstallationRebind: flags.allowInstallationRebind === true,
  allowProduction: Boolean(flags.allowProduction),
  backupPath,
  databaseUrl,
  skipDoctor: Boolean(flags.skipDoctor),
  skipFiles: Boolean(flags.skipFiles),
  skipMigrate: Boolean(flags.skipMigrate),
});

console.log(`Imported backup: ${backupPath}`);
console.log(`Database: ${redactDatabaseUrl(databaseUrl)}`);
