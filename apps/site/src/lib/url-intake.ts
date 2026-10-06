export type UrlIntakeKind = 'opportunity' | 'source';
export type UrlIntakeProvider =
  | 'ashby'
  | 'greenhouse'
  | 'lever'
  | 'generic-careers';
export interface UrlIntakeDetection {
  url: string;
  kind: UrlIntakeKind | 'choice';
  provider: UrlIntakeProvider;
  name: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_QUERY =
  /^(?:access_token|api[_-]?key|authorization|auth|password|secret|session|sessionid|signature|token)$/i;

/** URL-only detection is a hint; the server independently validates DNS and every fetch hop. */
export function detectUrlIntake(value: unknown): UrlIntakeDetection {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048)
    throw new Error('Enter a public HTTPS URL, up to 2,048 characters.');
  let parsed: URL;
  try {
    parsed = new URL(value.trim());
  } catch {
    throw new Error('Enter a valid HTTPS URL.');
  }
  const host = parsed.hostname.toLowerCase().replace(/\.+$/u, '');
  if (
    parsed.protocol !== 'https:' ||
    parsed.username ||
    parsed.password ||
    (parsed.port && parsed.port !== '443') ||
    !host.includes('.') ||
    host === 'localhost' ||
    /\.(?:local|internal|localhost)$/u.test(host) ||
    host.startsWith('[') ||
    /^[\d.]+$/u.test(host)
  )
    throw new Error(
      'Use a public HTTPS URL without credentials or a custom port.',
    );
  for (const key of parsed.searchParams.keys())
    if (SECRET_QUERY.test(key))
      throw new Error(
        'Use a public URL without sign-in tokens or credentials.',
      );
  parsed.hostname = host;
  parsed.hash = '';
  for (const key of [...parsed.searchParams.keys()])
    if (
      /^utm_/iu.test(key) ||
      ['ref', 'referrer', 'source'].includes(key.toLowerCase())
    )
      parsed.searchParams.delete(key);
  const parts = parsed.pathname.split('/').filter(Boolean);
  const organization = parts[0] ?? '';
  let provider: UrlIntakeProvider = 'generic-careers';
  let kind: UrlIntakeDetection['kind'] = 'choice';
  if (host === 'jobs.ashbyhq.com') provider = 'ashby';
  if (host === 'boards.greenhouse.io' || host === 'job-boards.greenhouse.io')
    provider = 'greenhouse';
  if (host === 'jobs.lever.co') provider = 'lever';
  if (provider !== 'generic-careers' && /^[\w-]{1,120}$/u.test(organization)) {
    if (parts.length === 1) kind = 'source';
    if (
      (provider === 'ashby' || provider === 'lever') &&
      UUID.test(parts[1] ?? '') &&
      (parts.length === 2 ||
        (parts.length === 3 &&
          ['application', 'apply'].includes(parts[2] ?? '')))
    )
      kind = 'opportunity';
    if (
      provider === 'greenhouse' &&
      parts.length === 3 &&
      parts[1] === 'jobs' &&
      /^\d+$/u.test(parts[2] ?? '')
    )
      kind = 'opportunity';
    if (kind !== 'choice') {
      parsed.search = '';
      parsed.pathname =
        kind === 'source'
          ? `/${organization}`
          : provider === 'greenhouse'
            ? `/${organization}/jobs/${parts[2]}`
            : `/${organization}/${parts[1]}`;
    }
  }
  return {
    url: parsed.toString(),
    kind,
    provider,
    name:
      organization && provider !== 'generic-careers'
        ? `${organization} careers`
        : host,
  };
}

export function resolveUrlIntake(
  value: unknown,
  choice: unknown,
): UrlIntakeDetection {
  if (
    choice !== undefined &&
    choice !== 'auto' &&
    choice !== 'opportunity' &&
    choice !== 'source'
  )
    throw new Error('Choose one opportunity or a job board/careers page.');
  const detection = detectUrlIntake(value);
  if (detection.kind !== 'choice') {
    if (choice && choice !== 'auto' && choice !== detection.kind)
      throw new Error(
        `This URL identifies ${detection.kind === 'source' ? 'a job board' : 'one opportunity'}.`,
      );
    return detection;
  }
  if (choice === 'opportunity' || choice === 'source')
    return { ...detection, kind: choice, provider: 'generic-careers' };
  return detection;
}
