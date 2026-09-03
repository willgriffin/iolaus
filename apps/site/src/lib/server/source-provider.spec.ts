import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sourceProviderIds } from '../source-provider-ids.js';

const mocks = vi.hoisted(() => ({
  getCollection: vi.fn(),
}));

vi.mock('./smrt.js', () => ({
  getCollection: mocks.getCollection,
}));

import { getJobAdapterRegistry } from './opportunity-source-crawler.js';
import {
  backfillSourceProviders,
  getSourceProviderSchemaStatus,
  persistedSourceProvider,
  sourceProviderSchemaIsReady,
} from './source-provider.js';

const providerConstraintDefinition = `CHECK ((provider = ANY (ARRAY['unknown'::text, ${sourceProviderIds
  .map((provider) => `'${provider}'::text`)
  .join(', ')}])))`;

function providerMigrationDatabase(query: ReturnType<typeof vi.fn>) {
  return {
    query,
    transaction: async (work: (db: { query: typeof query }) => unknown) =>
      await work({ query }),
  };
}

function providerQuery() {
  return vi.fn(async (sql: string, _params?: unknown[]) => ({
    rows: sql.includes('constraint_present')
      ? [
          {
            constraint_definition: providerConstraintDefinition,
            constraint_present: true,
            constraint_type: 'c',
            constraint_validated: true,
            invalid_providers: '0',
            provider_required: true,
          },
        ]
      : [],
  }));
}

describe('source provider provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('accepts only bounded persisted adapter identities', () => {
    expect(persistedSourceProvider('Greenhouse')).toBe('greenhouse');
    expect(persistedSourceProvider('generic-careers')).toBe('generic-careers');
    expect(persistedSourceProvider('greenhosue')).toBe('unknown');
    expect(persistedSourceProvider('fake-provider')).toBe('unknown');
    expect(persistedSourceProvider('https://secret.example')).toBe('unknown');
    expect(persistedSourceProvider('')).toBe('unknown');
  });

  it('persists the adapter-declared generic fallback for bounded legacy roots', async () => {
    const source = {
      provider: 'unknown',
      save: vi.fn(async () => undefined),
      sourceRole: 'root',
      url: 'https://example.com/careers',
    };
    mocks.getCollection.mockResolvedValue({
      list: vi.fn(async () => [source]),
    });

    const query = providerQuery();
    await expect(
      backfillSourceProviders(providerMigrationDatabase(query) as never),
    ).resolves.toEqual({ classified: 1, truncated: false, unknown: 0 });
    expect(source.provider).toBe('generic-careers');
    expect(source.save).toHaveBeenCalledOnce();
    expect(
      query.mock.calls.some(([sql]) =>
        sql.includes("SET provider = 'unknown'"),
      ),
    ).toBe(true);
    expect(query.mock.calls.at(-2)?.[0]).toContain('sources_provider_check');
    expect(query.mock.calls.at(-1)?.[0]).toContain('constraint_present');
  });

  it('case-folds a legacy valid provider before URL fallback detection', async () => {
    const source = {
      provider: 'Greenhouse',
      save: vi.fn(async () => undefined),
      sourceRole: 'root',
      url: 'https://example.com/careers',
    };
    mocks.getCollection.mockResolvedValue({
      list: vi.fn(async () => [source]),
    });
    const query = providerQuery();

    await backfillSourceProviders(providerMigrationDatabase(query) as never);

    expect(query.mock.calls[0]?.[0]).toContain('LOWER(BTRIM(provider))');
    expect(source.save).not.toHaveBeenCalled();
  });

  it('rolls back the provider migration when the in-transaction guard attestation fails', async () => {
    let rolledBack = false;
    const query = vi.fn(async (sql: string) => ({
      rows: sql.includes('constraint_present')
        ? [
            {
              constraint_definition: `${providerConstraintDefinition.slice(0, -1)} OR TRUE)`,
              constraint_present: true,
              constraint_type: 'c',
              constraint_validated: true,
              invalid_providers: '0',
              provider_required: true,
            },
          ]
        : [],
    }));
    mocks.getCollection.mockResolvedValue({ list: vi.fn(async () => []) });
    const database = {
      query,
      transaction: async (work: (db: { query: typeof query }) => unknown) => {
        try {
          return await work({ query });
        } catch (error) {
          rolledBack = true;
          throw error;
        }
      },
    };

    await expect(backfillSourceProviders(database as never)).rejects.toThrow(
      'allowlist constraint is not ready',
    );
    expect(rolledBack).toBe(true);
    expect(query.mock.calls.at(-1)?.[0]).toContain('constraint_present');
  });

  it('keeps the durable provider allowlist aligned with declared adapters', () => {
    const registry = getJobAdapterRegistry();
    for (const provider of sourceProviderIds) {
      expect(registry.get(provider)?.type).toBe(provider);
    }
  });

  it('attests the physical provider allowlist guard and rejects invalid state', async () => {
    const constraintDefinition = providerConstraintDefinition;
    const ready = await getSourceProviderSchemaStatus({
      query: vi.fn(async () => ({
        rows: [
          {
            constraint_definition: constraintDefinition,
            constraint_present: true,
            constraint_type: 'c',
            constraint_validated: true,
            invalid_providers: '0',
            provider_required: true,
          },
        ],
      })),
    } as never);
    expect(sourceProviderSchemaIsReady(ready)).toBe(true);
    expect(sourceProviderSchemaIsReady({ ...ready, invalidProviders: 1 })).toBe(
      false,
    );
    expect(
      sourceProviderSchemaIsReady({
        ...ready,
        constraintDefinitionMatches: false,
      }),
    ).toBe(false);

    for (const weakenedDefinition of [
      `${constraintDefinition.slice(0, -1)} OR TRUE)`,
      constraintDefinition.replace("'unknown'::text, ", ''),
    ]) {
      const weakened = await getSourceProviderSchemaStatus({
        query: vi.fn(async () => ({
          rows: [
            {
              constraint_definition: weakenedDefinition,
              constraint_present: true,
              constraint_type: 'c',
              constraint_validated: true,
              invalid_providers: '0',
              provider_required: true,
            },
          ],
        })),
      } as never);
      expect(sourceProviderSchemaIsReady(weakened)).toBe(false);
    }
  });
});
