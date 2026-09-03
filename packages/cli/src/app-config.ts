import { createHash } from 'node:crypto';

const DEFAULT_APP_ID = 'iolaus';
const DEFAULT_SERVER_URL = 'http://localhost:5173';

/**
 * Returns the filesystem-safe Iolaus namespace shared with the browser app.
 * The default keeps a local installation isolated without making the CLI
 * depend on the SvelteKit application package.
 */
export function getCliAppId(environment = process.env): string {
  const appId = environment.SMRT_APP_ID?.trim() || DEFAULT_APP_ID;
  if (!/^[a-z][a-z0-9-]{1,62}$/u.test(appId)) {
    throw new Error(
      'SMRT_APP_ID must be a lowercase, hyphenated application identifier.',
    );
  }
  return appId;
}

function serverUrlFrom(
  argumentsList: readonly string[],
  environment: NodeJS.ProcessEnv,
): string {
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--server') return argumentsList[index + 1] ?? '';
    if (argument.startsWith('--server='))
      return argument.slice('--server='.length);
  }
  return environment.IOLAUS_SERVER_URL?.trim() || DEFAULT_SERVER_URL;
}

/**
 * Isolate CLI tokens per target server. Browser cookies cannot be port-scoped,
 * and a developer may run two local Iolaus instances on separate ports.
 */
export function getCliConfigDirectory(
  argumentsList = process.argv.slice(2),
  environment = process.env,
): string {
  const target = serverUrlFrom(argumentsList, environment);
  const fingerprint = createHash('sha256')
    .update(target)
    .digest('hex')
    .slice(0, 12);
  return `${getCliAppId(environment)}-${fingerprint}`;
}
