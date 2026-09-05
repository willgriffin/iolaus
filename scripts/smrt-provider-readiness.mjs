import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** @typedef {'authentication' | 'assets' | 'secrets'} ProviderComponent */
/** @typedef {Record<string, string | undefined>} Environment */
/** @typedef {{clientId: string, issuer: string, realm: string, serverUrl: string}} OidcOptions */
/** @typedef {{profile: string, provider: string, oidc?: OidcOptions}} ProviderContext */
/** @typedef {{environment?: Environment, importModule?: (specifier: string) => Promise<any>, timeoutMs?: number, dependencies?: any}} ProbeOptions */

/** @type {Record<ProviderComponent, string>} */
const PROVIDER_SETTINGS = {
  authentication: 'SMRT_AUTH_READINESS_MODULE',
  assets: 'SMRT_ASSETS_READINESS_MODULE',
  secrets: 'SMRT_SECRETS_READINESS_MODULE',
};

/** @type {Record<ProviderComponent, string>} */
const SELF_HOSTED_DEFAULTS = {
  authentication: 'oidc',
  assets: 's3-compatible',
  secrets: 'environment',
};

const DEFAULT_TIMEOUT_MS = 3_000;

/** @param {string} packageName @param {string} relativePath */
function resolveSiteDependencyPath(packageName, relativePath) {
  let candidate = resolve(process.cwd());
  while (true) {
    for (const path of [
      resolve(candidate, 'apps/site/node_modules', packageName, relativePath),
      resolve(candidate, 'node_modules', packageName, relativePath),
    ]) {
      if (existsSync(path)) return realpathSync(path);
    }
    const parent = dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  throw new Error(`Unable to resolve ${packageName} from the site runtime.`);
}

function filesRequire() {
  // pnpm links the app dependency into its virtual store. Resolve that physical
  // package location lazily so SvelteKit build analysis never evaluates a
  // generated-server-relative path, while the SDK remains scoped to files.
  return createRequire(
    pathToFileURL(
      resolveSiteDependencyPath('@happyvertical/files', 'package.json'),
    ),
  );
}

/** @param {ProviderComponent} component */
function unavailable(component) {
  return new Error(`${component} provider readiness failed.`);
}

/** @param {Environment} environment @param {string} name */
function requiredString(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

/** @param {string} value @param {readonly string[]} protocols */
function validUrl(value, protocols) {
  try {
    const url = new URL(value);
    if (
      !protocols.includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

/** @param {string} value */
function validDatabaseUrl(value) {
  try {
    const url = new URL(value);
    return ['postgres:', 'postgresql:'].includes(url.protocol) &&
      Boolean(url.hostname)
      ? url
      : null;
  } catch {
    return null;
  }
}

/** @param {Environment} environment */
function assertHostedEnvironment(environment) {
  if (environment.SMRT_RUNTIME_PROFILE !== 'self-hosted') {
    throw new Error('unexpected runtime profile');
  }
  const appId = requiredString(environment, 'SMRT_APP_ID');
  if (!/^[a-z][a-z0-9-]{1,62}$/u.test(appId) || appId === 'iolaus') {
    throw new Error('invalid application identifier');
  }
  if (!validDatabaseUrl(requiredString(environment, 'DATABASE_URL'))) {
    throw new Error('invalid database configuration');
  }
}

/** @param {Environment} environment @returns {OidcOptions} */
function resolveRealmOidcOptions(environment) {
  const serverUrl = validUrl(
    requiredString(environment, 'IOLAUS_OIDC_SERVER_URL'),
    ['https:'],
  );
  const realm = requiredString(environment, 'IOLAUS_OIDC_REALM');
  const clientId = requiredString(environment, 'IOLAUS_OIDC_CLIENT_ID');
  if (
    !serverUrl ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/u.test(realm) ||
    realm === '.' ||
    realm === '..' ||
    clientId.length > 200 ||
    /[/?#\\]|[\p{Cc}\p{Cf}\p{Z}]/u.test(clientId)
  ) {
    throw new Error('invalid OIDC configuration');
  }
  const normalizedServerUrl = serverUrl.toString().replace(/\/$/u, '');
  return {
    clientId,
    issuer: `${normalizedServerUrl}/realms/${realm}`,
    realm,
    serverUrl: normalizedServerUrl,
  };
}

/** @param {Environment} environment @returns {OidcOptions} */
function resolveRootOidcOptions(environment) {
  const rawServerUrl = requiredString(environment, 'IOLAUS_OIDC_SERVER_URL');
  const serverUrl = validUrl(rawServerUrl, ['https:']);
  const clientId = requiredString(environment, 'IOLAUS_OIDC_CLIENT_ID');
  if (
    !serverUrl ||
    (serverUrl.pathname !== '' && serverUrl.pathname !== '/') ||
    /(?:^|\/)\.{1,2}(?:\/|$)|%2e/iu.test(rawServerUrl) ||
    environment.IOLAUS_OIDC_REALM?.trim() ||
    clientId.length > 200 ||
    /[/?#\\]|[\p{Cc}\p{Cf}\p{Z}]/u.test(clientId)
  ) {
    throw new Error('invalid root OIDC configuration');
  }
  return {
    clientId,
    issuer: serverUrl.origin,
    realm: '..',
    serverUrl: serverUrl.origin,
  };
}

/** @param {Environment} environment @param {OidcOptions | undefined} configuredOidc @returns {OidcOptions} */
function resolveOidcOptions(environment, configuredOidc) {
  assertHostedEnvironment(environment);
  if (configuredOidc) {
    const { clientId, issuer, realm, serverUrl } = configuredOidc;
    if (
      typeof clientId !== 'string' ||
      typeof issuer !== 'string' ||
      typeof realm !== 'string' ||
      typeof serverUrl !== 'string' ||
      !validUrl(issuer, ['https:']) ||
      !validUrl(serverUrl, ['https:'])
    ) {
      throw new Error('invalid OIDC configuration');
    }
    return { clientId, issuer, realm, serverUrl };
  }
  const mode = environment.IOLAUS_OIDC_ISSUER_MODE?.trim() || 'realm';
  if (mode === 'root') return resolveRootOidcOptions(environment);
  if (mode === 'realm') return resolveRealmOidcOptions(environment);
  throw new Error('unknown OIDC issuer mode');
}

/** @param {Environment} environment */
function resolveS3Options(environment) {
  assertHostedEnvironment(environment);
  let parsed;
  try {
    parsed = JSON.parse(requiredString(environment, 'RESUME_FILES_CONFIG_JSON'));
  } catch {
    throw new Error('invalid asset configuration');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('invalid asset configuration');
  }
  /** @type {Record<string, unknown>} */
  const options = parsed;
  const region = typeof options.region === 'string' ? options.region.trim() : '';
  const bucket = typeof options.bucket === 'string' ? options.bucket.trim() : '';
  const accessKeyId =
    typeof options.accessKeyId === 'string' ? options.accessKeyId.trim() : '';
  const secretAccessKey =
    typeof options.secretAccessKey === 'string'
      ? options.secretAccessKey.trim()
      : '';
  const endpoint =
    typeof options.endpoint === 'string'
      ? validUrl(options.endpoint.trim(), ['https:', 'http:'])
      : null;

  if (
    options.type !== 's3' ||
    !region ||
    !bucket ||
    !accessKeyId ||
    !secretAccessKey ||
    !endpoint ||
    (options.forcePathStyle !== undefined &&
      typeof options.forcePathStyle !== 'boolean')
  ) {
    throw new Error('invalid asset configuration');
  }
  return {
    accessKeyId,
    bucket,
    endpoint: endpoint.toString(),
    forcePathStyle: options.forcePathStyle,
    region,
    secretAccessKey,
  };
}

/** @param {unknown} document @param {string} issuer */
function hasDiscoveryEndpoints(document, issuer) {
  if (!document || typeof document !== 'object') {
    return false;
  }
  /** @type {Record<string, unknown>} */
  const values = /** @type {Record<string, unknown>} */ (document);
  if (values.issuer !== issuer) return false;
  return ['authorization_endpoint', 'token_endpoint', 'jwks_uri'].every(
    (field) =>
      typeof values[field] === 'string' &&
      Boolean(validUrl(values[field], ['https:'])),
  );
}

/** @param {ProviderComponent} component */
async function defaultDependencies(component) {
  if (component === 'authentication') {
    const auth = await import(
      pathToFileURL(
        resolveSiteDependencyPath('@happyvertical/auth', 'dist/index.js'),
      ).href,
    );
    return { getAuth: auth.getAuth };
  }
  if (component === 'assets') {
    const s3 = await import(filesRequire().resolve('@aws-sdk/client-s3'));
    return {
      HeadBucketCommand: s3.HeadBucketCommand,
      S3Client: s3.S3Client,
    };
  }
  return {};
}

/** @param {Environment} environment @param {OidcOptions | undefined} configuredOidc @param {number} timeoutMs @param {any} dependencies */
async function checkOidcReadiness(
  environment,
  configuredOidc,
  timeoutMs,
  dependencies,
) {
  const options = resolveOidcOptions(environment, configuredOidc);
  const auth = await dependencies.getAuth({
    clientId: options.clientId,
    maxRetries: 0,
    realm: options.realm,
    serverUrl: options.serverUrl,
    timeout: timeoutMs,
    type: 'keycloak',
  });
  const discovery = await auth.getDiscoveryDocument();
  if (!hasDiscoveryEndpoints(discovery, options.issuer)) {
    throw new Error('invalid discovery');
  }
}

/** @param {Environment} environment @param {number} timeoutMs @param {any} dependencies */
async function checkAssetsReadiness(environment, timeoutMs, dependencies) {
  const options = resolveS3Options(environment);
  const client = new dependencies.S3Client({
    credentials: {
      accessKeyId: options.accessKeyId,
      secretAccessKey: options.secretAccessKey,
    },
    endpoint: options.endpoint,
    forcePathStyle: options.forcePathStyle,
    region: options.region,
  });
  try {
    await client.send(new dependencies.HeadBucketCommand({ Bucket: options.bucket }), {
      abortSignal: AbortSignal.timeout(timeoutMs),
    });
  } finally {
    client.destroy?.();
  }
}

/** @param {ProviderComponent} component @param {ProviderContext} context @param {Environment} environment @param {(specifier: string) => Promise<any>} importModule */
async function runOverride(component, context, environment, importModule) {
  const specifier = environment[PROVIDER_SETTINGS[component]];
  if (!specifier) return false;
  const module = await importModule(specifier);
  const probe = module.checkReadiness || module.default;
  if (typeof probe !== 'function') throw new Error('invalid override');
  const result = await probe({ component, ...context });
  if (result !== true && result?.ready !== true) throw new Error('not ready');
  return true;
}

/**
 * Build a provider-owned readiness callback for the released SMRT runtime.
 * Explicit operator module selectors remain authoritative. Without a selector,
 * self-hosted OIDC, S3-compatible assets, and environment secrets use bounded
 * SDK probes. Callers may pass a validated `oidc` configuration in `context`.
 *
 * @param {ProviderComponent} component
 * @param {ProviderContext} context
 * @param {ProbeOptions} [options]
 */
export function createProviderReadinessProbe(component, context, options = {}) {
  return async () => {
    try {
      if (!Object.hasOwn(PROVIDER_SETTINGS, component)) throw unavailable(component);
      const environment = options.environment || process.env;
      const importModule = options.importModule || ((specifier) => import(specifier));
      const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
      if (await runOverride(component, context, environment, importModule)) return;
      if (
        context.profile !== 'self-hosted' ||
        context.provider !== SELF_HOSTED_DEFAULTS[component]
      ) {
        throw unavailable(component);
      }
      const dependencies =
        options.dependencies || (await defaultDependencies(component));
      if (component === 'authentication') {
        await checkOidcReadiness(
          environment,
          context.oidc,
          timeoutMs,
          dependencies,
        );
      } else if (component === 'assets') {
        await checkAssetsReadiness(environment, timeoutMs, dependencies);
      } else {
        assertHostedEnvironment(environment);
      }
    } catch {
      throw unavailable(component);
    }
  };
}
