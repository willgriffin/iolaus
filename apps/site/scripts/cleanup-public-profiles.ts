import { resolveDatabase } from '@happyvertical/smrt-core';
import { getDbConfig } from '../src/lib/server/db.js';
import {
  isSupportedPublicProfileCleanupProvider,
  reconcilePublicProfileOrphans,
} from '../src/lib/server/public-profile-cleanup.js';
import {
  getResumeFilesConfig,
  getResumeFilesystem,
} from '../src/lib/server/resume-files.js';

const argumentsSet = new Set(process.argv.slice(2));
const apply = argumentsSet.has('--apply');
const afterArgument = [...argumentsSet].find((argument) =>
  argument.startsWith('--after-path='),
);
const afterPath = afterArgument?.slice('--after-path='.length);

if (!argumentsSet.has('--confirm-offline') || !argumentsSet.has('--app-stopped')) {
  throw new Error(
    'Refusing cleanup. Pass --confirm-offline and --app-stopped; add --apply only after reviewing the dry run.',
  );
}
if (
  ![...argumentsSet].every(
    (argument) =>
      ['--confirm-offline', '--app-stopped', '--apply'].includes(argument) ||
      argument.startsWith('--after-path='),
  )
)
  throw new Error('Unknown cleanup option.');

const config = getResumeFilesConfig();
if (!isSupportedPublicProfileCleanupProvider(config.type))
  throw new Error(`Refusing cleanup for unsupported filesystem provider: ${String(config.type)}.`);

const result = await reconcilePublicProfileOrphans(
  await getResumeFilesystem(),
  await resolveDatabase(getDbConfig()),
  { afterPath, appStopped: true, dryRun: !apply, offlineConfirmed: true },
);
console.log(JSON.stringify(result, null, 2));
