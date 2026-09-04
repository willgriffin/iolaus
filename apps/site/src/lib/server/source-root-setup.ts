import { isIP } from 'node:net';
import { isSourceProviderId } from '../source-provider-ids.js';
import { getCollection } from './smrt.js';

const MAX_NAME_LENGTH = 160;
const sourceTypes = [
  'job_board',
  'company_careers',
  'contract_board',
  'recruiter',
  'search_query',
  'manual',
] as const;

export type RootSourceType = (typeof sourceTypes)[number];

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

function stringValue(value: FormDataEntryValue | null): string {
  return typeof value === 'string' ? value.trim() : '';
}

function rootSourceUrl(value: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('Enter a valid HTTPS root URL.');
  }
  const hostname = parsed.hostname.toLowerCase().replace(/\.+$/u, '');
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
export function parseRootSourceSetup(form: FormData): RootSourceSetupInput {
  const name = stringValue(form.get('name'));
  if (!name) throw new Error('Enter a name for this source.');
  if (name.length > MAX_NAME_LENGTH) {
    throw new Error(
      `Source names must be ${MAX_NAME_LENGTH} characters or fewer.`,
    );
  }

  const provider = stringValue(form.get('provider')).toLowerCase();
  if (!isSourceProviderId(provider)) {
    throw new Error('Choose a supported provider.');
  }

  return {
    active: form.get('active') === 'on',
    name,
    provider,
    type: sourceType(stringValue(form.get('type')) || 'job_board'),
    url: rootSourceUrl(stringValue(form.get('url'))),
  };
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
