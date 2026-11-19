'use strict';

/**
 * The Capacitor configuration for the JobGenius shell, as a pure function of the
 * environment so the validator (and the web app's tests) can evaluate it
 * without the Capacitor CLI.
 *
 * The shell loads the web app: `server.url` is `https://jobgeni.us`. A
 * developer may point one build at a local server with
 * `JOBGENI_MOBILE_SERVER_URL`; it is never set by default and never written to
 * the repository. Cleartext is only enabled by an explicit http override that
 * names a local or private-network host.
 */

const PRODUCTION_URL = 'https://jobgeni.us/admin/career/';
const OVERRIDE_VARIABLE = 'JOBGENI_MOBILE_SERVER_URL';

const PRIVATE_HOST =
  /^(localhost|10\.0\.2\.2|127(\.\d{1,3}){3}|10(\.\d{1,3}){3}|192\.168(\.\d{1,3}){2}|172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}|[^.]+\.(local|localhost|test))$/;

/**
 * @param {string | undefined} value the raw override
 * @returns {{ url: string, host: string, cleartext: boolean }}
 */
function parseOverride(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${OVERRIDE_VARIABLE} is not a URL.`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw new Error(`${OVERRIDE_VARIABLE} must be an http or https URL.`);
  if (url.username || url.password)
    throw new Error(`${OVERRIDE_VARIABLE} must not carry credentials.`);
  if (url.search || url.hash || (url.pathname !== '/' && url.pathname !== ''))
    throw new Error(
      `${OVERRIDE_VARIABLE} must be an origin only: no path, query or fragment.`,
    );
  const cleartext = url.protocol === 'http:';
  if (cleartext && !PRIVATE_HOST.test(url.hostname))
    throw new Error(
      `${OVERRIDE_VARIABLE}: http is only allowed for localhost and private-network hosts.`,
    );
  return { url: url.origin, host: url.hostname, cleartext };
}

/** @param {Record<string, string | undefined>} [env] */
function buildConfig(env = {}) {
  const raw = (env[OVERRIDE_VARIABLE] ?? '').trim();
  const server = {
    url: PRODUCTION_URL,
    allowNavigation: ['jobgeni.us'],
    // Shown by the WebView when the remote load fails.
    errorPath: 'index.html',
  };
  if (raw) {
    const override = parseOverride(raw);
    server.url = override.url;
    if (!server.allowNavigation.includes(override.host))
      server.allowNavigation.push(override.host);
    if (override.cleartext) server.cleartext = true;
  }
  return {
    appId: 'us.jobgeni.app',
    appName: 'JobGenius',
    loggingBehavior: 'none',
    webDir: 'www',
    ios: { contentInset: 'always' },
    server,
  };
}

module.exports = {
  OVERRIDE_VARIABLE,
  PRODUCTION_URL,
  buildConfig,
  parseOverride,
};
