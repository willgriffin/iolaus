import {
  exportBackup,
  parseFlagArgs,
  redactDatabaseUrl,
  resolveExportDatabaseUrl,
} from './db-snapshot.js';

const { flags } = parseFlagArgs(process.argv.slice(2));
const prod = Boolean(flags.prod);
const databaseUrl = resolveExportDatabaseUrl({
  databaseUrl:
    typeof flags.databaseUrl === 'string' ? flags.databaseUrl : undefined,
  prod,
});

const backupPath = await exportBackup({
  allowLocal: Boolean(flags.allowLocal),
  allowProduction: Boolean(flags.allowProduction),
  backupRoot: typeof flags.backupDir === 'string' ? flags.backupDir : undefined,
  databaseUrl,
  label:
    typeof flags.label === 'string' ? flags.label : prod ? 'prod' : 'current',
  prod,
  skipFiles: Boolean(flags.skipFiles),
});

console.log(`Backup written: ${backupPath}`);
console.log(`Database: ${redactDatabaseUrl(databaseUrl)}`);
