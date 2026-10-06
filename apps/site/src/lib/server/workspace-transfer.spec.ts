import { describe, expect, it } from 'vitest';
import {
  bundleAssetPath,
  canonicalJson,
  catalogTables,
  ownedTables,
  safeAssetKey,
  sanitizeCatalogRow,
  skippedOwnerTables,
} from './workspace-transfer.js';

describe('workspace transfer manifest', () => {
  it('keeps catalog, owned and skipped tables disjoint', () => {
    const all = [...catalogTables, ...ownedTables, ...skippedOwnerTables];
    expect(new Set(all).size).toBe(all.length);
    expect(ownedTables).toContain('opportunity_recommendation_ranks');
    expect(catalogTables).not.toContain('company_research');
  });

  it('blanks private catalog fields without touching other columns or the input', () => {
    const row = { account_notes: 'x', id: 'a', login_identity: 'y', name: 'n' };
    expect(sanitizeCatalogRow('sources', row)).toEqual({
      account_notes: '',
      id: 'a',
      login_identity: '',
      name: 'n',
    });
    expect(row.account_notes).toBe('x');
    expect(sanitizeCatalogRow('tags', row)).toBe(row);
  });

  it('hashes canonical JSON independent of key order', () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 1, c: 2 }] })).toBe(
      canonicalJson({ a: [2, { c: 2, d: 1 }], b: 1 }),
    );
  });

  it('rejects asset keys that could escape the bundle or the store', () => {
    expect(safeAssetKey('generated-resumes/a/b.pdf')).toBe(
      'generated-resumes/a/b.pdf',
    );
    for (const bad of ['../x', 'a/../b', 'a//b', 'a\\b', '', 'a\0b']) {
      expect(safeAssetKey(bad), bad).toBeNull();
    }
    expect(() => bundleAssetPath('/tmp/bundle', '../../etc/passwd')).toThrow();
  });
});
