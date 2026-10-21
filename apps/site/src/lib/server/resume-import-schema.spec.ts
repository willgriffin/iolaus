import { describe, expect, it, vi } from 'vitest';
import {
  getResumeImportSchemaStatus,
  resumeImportSchemaIsReady,
  resumeImportTables,
} from './resume-import-schema.js';

describe('resume import schema readiness', () => {
  it('requires the full native ingestion closure', async () => {
    const query = vi.fn(async () => ({
      rows: resumeImportTables
        .slice(0, -1)
        .map((table_name) => ({ table_name })),
    }));
    const status = await getResumeImportSchemaStatus({ query } as any);
    expect(status).toEqual({
      present: resumeImportTables.length - 1,
      total: 12,
    });
    expect(resumeImportSchemaIsReady(status)).toBe(false);
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('information_schema.tables'),
      [...resumeImportTables],
    );
  });
});
