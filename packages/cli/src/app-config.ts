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

export function getCliServerUrl(
  argumentsList: readonly string[],
  environment: NodeJS.ProcessEnv,
): string {
  const selectors: string[] = [];
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (argument === '--server') {
      selectors.push(argumentsList[index + 1] ?? '');
      index += 1;
    } else if (argument.startsWith('--server=')) {
      selectors.push(argument.slice('--server='.length));
    }
  }
  if (selectors.length > 1) {
    throw new Error('Specify --server at most once.');
  }
  const target = selectors[0] ?? environment.IOLAUS_SERVER_URL?.trim();
  if (!target) return DEFAULT_SERVER_URL;
  return new URL(target).toString().replace(/\/$/u, '');
}

/**
 * Isolate CLI tokens per target server. Browser cookies cannot be port-scoped,
 * and a developer may run two local Iolaus instances on separate ports.
 */
export function getCliConfigDirectory(
  argumentsList = process.argv.slice(2),
  environment = process.env,
): string {
  const target = getCliServerUrl(argumentsList, environment);
  const fingerprint = createHash('sha256')
    .update(target)
    .digest('hex')
    .slice(0, 12);
  return `${getCliAppId(environment)}-${fingerprint}`;
}
