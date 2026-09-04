import { isIP } from 'node:net';
import { getCollection } from './smrt.js';

const MAX_NAME_LENGTH = 160;
const rootSourceProviders = [
  'ashby',
  'generic-careers',
  'greenhouse',
  'lever',
] as const;
const sourceTypes = [
  'job_board',
  'company_careers',
  'contract_board',
  'recruiter',
  'search_query',
  'manual',
] as const;

export type RootSourceType = (typeof sourceTypes)[number];
type RootSourceProvider = (typeof rootSourceProviders)[number];

function sourceTypeLabel(value: RootSourceType): string {
  switch (value) {
    case 'company_careers':
      return 'Company careers page';
    case 'contract_board':
      return 'Contract board';
    case 'job_board':
      return 'Job board';
    case 'manual':
      return 'Other source';
    case 'recruiter':
      return 'Recruiter';
    case 'search_query':
      return 'Search results';
  }
}

export const rootSourceTypeOptions = sourceTypes.map((value) => ({
  label: sourceTypeLabel(value),
  value,
}));

export interface RootSourceSetupInput {
  active: boolean;
  name: string;
  provider: string;
  type: RootSourceType;
  url: string;
}

type MutableSource = Record<string, unknown> & {
  id?: unknown;
  save: () => Promise<unknown>;
};

interface SourceCollection {
  create: (payload: Record<string, unknown>) => Promise<MutableSource>;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function rootSourceUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Enter a valid HTTPS root URL.');
  }
  const hostname = parsed.hostname
    .toLowerCase()
    .replace(/^\[|\]$/gu, '')
    .replace(/\.+$/u, '');
  if (
    parsed.protocol !== 'https:' ||
    !hostname ||
    parsed.username ||
    parsed.password ||
    hostname === 'localhost' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    isIP(hostname) !== 0
  ) {
    throw new Error('Enter a public HTTPS root URL without credentials.');
  }
  parsed.hostname = hostname;
  parsed.hash = '';
  return parsed.toString();
}

function assertProviderRootUrl(
  provider: RootSourceProvider,
  url: string,
): void {
  const hostname = new URL(url).hostname;
  const providerHosts: Record<string, readonly string[]> = {
    ashby: ['jobs.ashbyhq.com'],
    greenhouse: ['boards.greenhouse.io', 'job-boards.greenhouse.io'],
    lever: ['jobs.lever.co'],
  };
  const allowedHosts = providerHosts[provider];
  if (allowedHosts && !allowedHosts.includes(hostname)) {
    throw new Error(
      `The selected ${provider} provider needs a matching board URL.`,
    );
  }
}

function rootSourceProvider(value: string): RootSourceProvider {
  if (rootSourceProviders.includes(value as RootSourceProvider)) {
    return value as RootSourceProvider;
  }
  throw new Error('Choose a provider available in this form.');
}

function sourceType(value: string): RootSourceType {
  if (sourceTypes.includes(value as RootSourceType)) {
    return value as RootSourceType;
  }
  throw new Error('Choose a supported source type.');
}

/**
 * Convert the small owner-facing form into the durable root-source contract.
 * This is deliberately pure: form validation must not crawl, resolve DNS, or
 * otherwise contact the configured provider.
 */
function parseRootSourceValues(values: {
  active: boolean;
  name: unknown;
  provider: unknown;
  type: unknown;
  url: unknown;
}): RootSourceSetupInput {
  const name = stringValue(values.name);
  if (!name) throw new Error('Enter a name for this source.');
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(
      `Source names must be ${MAX_NAME_LENGTH} characters or fewer.`,
    );
  }

  const provider = rootSourceProvider(
    stringValue(values.provider).toLowerCase(),
  );
  const url = rootSourceUrl(stringValue(values.url));
  assertProviderRootUrl(provider, url);

  return {
    active: values.active,
    name,
    provider,
    type: sourceType(stringValue(values.type) || 'job_board'),
    url,
  };
}

/**
 * Convert the small owner-facing form into the durable root-source contract.
 * This is deliberately pure: form validation must not crawl, resolve DNS, or
 * otherwise contact the configured provider.
 */
export function parseRootSourceSetup(form: FormData): RootSourceSetupInput {
  return parseRootSourceValues({
    active: form.get('active') === 'on',
    name: form.get('name'),
    provider: form.get('provider'),
    type: form.get('type'),
    url: form.get('url'),
  });
}

/**
 * Validate the explicit browser-agent root-source payload with the same
 * no-network rules as the owner form. Callers choose whether the new source
 * starts active; creating it never schedules or contacts a provider.
 */
export function parseRootSourceInput(
  input: Record<string, unknown>,
): RootSourceSetupInput {
  const active = input.active === undefined ? true : input.active;
  if (typeof active !== 'boolean') {
    throw new Error('active must be true or false.');
  }
  return parseRootSourceValues({
    active,
    name: input.name,
    provider: input.provider,
    type: input.type ?? 'company_careers',
    url: input.url,
  });
}

/**
 * Save one explicit operator-selected root. Activation and crawl are separate
 * WebMCP actions, so creating this record never schedules or contacts a board.
 */
export async function createRootSource(
  input: RootSourceSetupInput,
  dependencies: { sourceCollection?: SourceCollection } = {},
): Promise<{ id: string }> {
  const sources =
    dependencies.sourceCollection ??
    ((await getCollection('Source')) as unknown as SourceCollection);
  const source = await sources.create({
    isActive: input.active,
    name: input.name,
    parentSourceId: null,
    provider: input.provider,
    refreshCadence: 'ad_hoc',
    sourceRole: 'root',
    type: input.type,
    url: input.url,
  });
  await source.save();
  const id = typeof source.id === 'string' ? source.id : '';
  if (!id) throw new Error('The source was saved without an identifier.');
  return { id };
}
