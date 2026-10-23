import { describe, expect, it, vi } from 'vitest';
import { beginResumeImportWrite } from './resume-import-write-admission.js';

describe('private write admission storage validation', () => {
  it.each([
    undefined,
    '',
    ' ',
    'unknown-engine',
    'https://example.invalid/db',
    'storage.duckdb',
    'storage.json',
    'file:storage.duckdb',
  ])('refuses missing or unsupported storage %s before opening a transaction', async (url) => {
    const query = vi.fn(async () => ({ rows: [] }));
    const transaction = vi.fn();
    await expect(
      beginResumeImportWrite(
        { query, transaction, url },
        { tenantId: 'tenant', userId: 'user', profileId: 'candidate' },
        { sourceId: 'source', deliveryKey: 'delivery' },
      ),
    ).rejects.toThrow(/require/);
    expect(transaction).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
});
