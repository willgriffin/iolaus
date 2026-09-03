const DEFAULT_APP_ID = 'iolaus';

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
