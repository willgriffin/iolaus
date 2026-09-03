/**
 * Product identity and deployment configuration for Iolaus.
 *
 * This module deliberately owns only non-secret configuration. Authentication
 * secrets remain in the environment and are never returned to routes or
 * diagnostics. A local profile is the safe default; any non-local profile
 * must opt into a complete, explicit OIDC configuration.
 */

export type RuntimeProfile = 'cloud' | 'local' | 'self-hosted';

export type AppConfigEnvironment = Readonly<Record<string, string | undefined>>;

export interface IolausAppConfig {
  agentClass: string;
  appId: string;
  appName: string;
  cliConfigDirectory: string;
  cliUserCodePrefix: string;
  loginNextCookieName: string;
  oidcNonceCookieName: string;
  oidcStateCookieName: string;
  oidcVerifierCookieName: string;
  runtimeProfile: RuntimeProfile;
  sessionCookieName: string;
  tenantName: string;
  tenantSlug: string;
}

export interface OidcConfiguration {
  adminEmails: string[];
  clientId: string;
  clientSecret?: string;
  realm: string;
  serverUrl: string;
}

export type AuthConfiguration =
  | { kind: 'local' }
  | { kind: 'self-hosted'; oidc: OidcConfiguration }
  | { kind: 'invalid'; message: string };

const DEFAULT_APP_ID = 'iolaus';
const DEFAULT_APP_NAME = 'Iolaus';
const PUBLIC_CONFIGURATION_MESSAGE =
  'Iolaus public authentication is incomplete. Configure the public URL, OIDC issuer, realm, client ID, and authorized administrator email addresses.';

function stringValue(value: string | undefined): string {
  return value?.trim() ?? '';
}

function appIdFrom(environment: AppConfigEnvironment): string {
  const configured = stringValue(environment.SMRT_APP_ID) || DEFAULT_APP_ID;
  if (!/^[a-z][a-z0-9-]{1,62}$/u.test(configured)) {
    throw new Error(
      'SMRT_APP_ID must be a lowercase, hyphenated application identifier.',
    );
  }
  return configured;
}

function appNameFrom(environment: AppConfigEnvironment): string {
  const configured =
    stringValue(environment.IOLAUS_APP_NAME) || DEFAULT_APP_NAME;
  const containsControlCharacter = [...configured].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
  if (configured.length > 80 || containsControlCharacter) {
    throw new Error('IOLAUS_APP_NAME must be a short display name.');
  }
  return configured;
}

function runtimeProfileFrom(environment: AppConfigEnvironment): RuntimeProfile {
  const configured = stringValue(environment.SMRT_RUNTIME_PROFILE) || 'local';
  if (
    configured === 'local' ||
    configured === 'self-hosted' ||
    configured === 'cloud'
  ) {
    return configured;
  }
  throw new Error('SMRT_RUNTIME_PROFILE must be local, self-hosted, or cloud.');
}

function cookieSegment(appId: string): string {
  return appId.replaceAll('-', '_');
}

/** Returns the typed, non-secret identity used by browser and server surfaces. */
export function getAppConfig(
  environment: AppConfigEnvironment = process.env,
): IolausAppConfig {
  const appId = appIdFrom(environment);
  const cookiePrefix = cookieSegment(appId);

  return {
    agentClass: `${appId}/owner`,
    appId,
    appName: appNameFrom(environment),
    cliConfigDirectory: appId,
    cliUserCodePrefix: appId.slice(0, 8).toUpperCase(),
    loginNextCookieName: `${cookiePrefix}_login_next`,
    oidcNonceCookieName: `${cookiePrefix}_oidc_nonce`,
    oidcStateCookieName: `${cookiePrefix}_oidc_state`,
    oidcVerifierCookieName: `${cookiePrefix}_oidc_code_verifier`,
    runtimeProfile: runtimeProfileFrom(environment),
    sessionCookieName: `${cookiePrefix}_session`,
    tenantName: appNameFrom(environment),
    tenantSlug: appId,
  };
}

function configuredPublicUrl(environment: AppConfigEnvironment): URL | null {
  const rawUrl = stringValue(environment.IOLAUS_PUBLIC_URL);
  if (!rawUrl) return null;

  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

function configuredOidcServerUrl(
  environment: AppConfigEnvironment,
): string | null {
  const rawUrl = stringValue(environment.IOLAUS_OIDC_SERVER_URL);
  if (!rawUrl) return null;

  try {
    const url = new URL(rawUrl);
    if (
      url.protocol !== 'https:' ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      return null;
    }
    return url.toString().replace(/\/$/u, '');
  } catch {
    return null;
  }
}

function configuredAdminEmails(environment: AppConfigEnvironment): string[] {
  const emails = stringValue(environment.IOLAUS_OIDC_ADMIN_EMAILS)
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  if (
    emails.length === 0 ||
    emails.some((email) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(email))
  ) {
    return [];
  }
  return [...new Set(emails)];
}

/**
 * Resolve local or public authentication without exposing configuration values.
 * Callers present `message` verbatim only as an operational recovery hint; it
 * never includes a hostname, client secret, or an administrator address.
 */
export function getAuthConfiguration(
  environment: AppConfigEnvironment = process.env,
): AuthConfiguration {
  const app = getAppConfig(environment);
  if (app.runtimeProfile === 'local') return { kind: 'local' };

  const publicUrl = configuredPublicUrl(environment);
  const serverUrl = configuredOidcServerUrl(environment);
  const realm = stringValue(environment.IOLAUS_OIDC_REALM);
  const clientId = stringValue(environment.IOLAUS_OIDC_CLIENT_ID);
  const adminEmails = configuredAdminEmails(environment);

  if (
    !publicUrl ||
    !serverUrl ||
    !realm ||
    !clientId ||
    adminEmails.length === 0
  ) {
    return { kind: 'invalid', message: PUBLIC_CONFIGURATION_MESSAGE };
  }

  return {
    kind: 'self-hosted',
    oidc: {
      adminEmails,
      clientId,
      clientSecret:
        stringValue(environment.IOLAUS_OIDC_CLIENT_SECRET) || undefined,
      realm,
      serverUrl,
    },
  };
}

/** A configured public origin, or null for a local-only runtime. */
export function getConfiguredPublicOrigin(
  environment: AppConfigEnvironment = process.env,
): string | null {
  if (getAppConfig(environment).runtimeProfile === 'local') return null;
  return configuredPublicUrl(environment)?.origin ?? null;
}

export function getSafeOutboundHeaderValue(
  value: string,
  fallback: string,
): string {
  const normalized = value
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
  return normalized || fallback;
}

/** An ASCII-only product label safe for fixed outbound HTTP client purposes. */
export function getConfiguredUserAgent(
  purpose: string,
  environment: AppConfigEnvironment = process.env,
): string {
  const config = getAppConfig(environment);
  return `${getSafeOutboundHeaderValue(config.appName, config.appId)} ${getSafeOutboundHeaderValue(
    purpose,
    'client',
  )}`;
}

/** A stable MCP server name derived from the configured application identity. */
export function getConfiguredMcpServerName(
  environment: AppConfigEnvironment = process.env,
): string {
  return `${getAppConfig(environment).appId}-employment-search`;
}

export function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, '');
  return ['127.0.0.1', '::1', 'localhost'].includes(normalized);
}

/** Treat IPv4-mapped IPv6 loopback peers as local, but never trust a host header. */
export function isLoopbackAddress(address: string): boolean {
  const normalized = address.trim().toLowerCase();
  if (isLoopbackHostname(normalized)) return true;
  return (
    normalized.startsWith('::ffff:') &&
    isLoopbackHostname(normalized.slice('::ffff:'.length))
  );
}
