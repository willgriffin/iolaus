import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { loadCurrentOpportunityScreeningProjections } from './opportunity-screening-projection.js';

vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(() => {
    throw new Error('Schema regression injects the owned profile boundary.');
  }),
}));
vi.mock('./db.js', () => ({ getDbConfig: () => ({}) }));

// This suite reads an already migrated native database. It creates no tables,
// receipts, profiles or source records, and makes no provider requests.
const postgresUrl = process.env.SCREENING_TEST_POSTGRES_URL?.trim();
describe.skipIf(!postgresUrl)(
  'screening projection on migrated PostgreSQL',
  () => {
    let database: DatabaseInterface;

    beforeAll(async () => {
      database = await getDatabase({
        type: 'postgres',
        url: postgresUrl ?? '',
        cache: false,
        max: 1,
      });
    });

    afterAll(async () => {
      await database?.close?.();
    });

    it('uses Result version columns and executes every native projection join', async () => {
      const versions = [
        'prompt_version',
        'output_schema_version',
        'prepared_payload_version',
      ];
      const schema = await database.query(
        `SELECT table_name, column_name FROM information_schema.columns
       WHERE table_schema = ANY(current_schemas(false))
       AND table_name IN (?, ?)
       AND column_name IN (?, ?, ?)`,
        [
          'opportunity_intelligence_requests',
          'opportunity_intelligence_results',
          ...versions,
        ],
      );
      expect(
        schema.rows.filter(
          (row) => row.table_name === 'opportunity_intelligence_requests',
        ),
      ).toEqual([]);
      expect(
        schema.rows
          .filter(
            (row) => row.table_name === 'opportunity_intelligence_results',
          )
          .map((row) => row.column_name)
          .sort(),
      ).toEqual([...versions].sort());

      const subject = {
        profileId: 'screening-schema-regression-profile',
        tenantId: 'screening-schema-regression-tenant',
        userId: 'screening-schema-regression-user',
      };
      // An impossible private tuple returns no data. PostgreSQL still resolves
      // every selected column and join against the actual registered schema.
      const result = await loadCurrentOpportunityScreeningProjections(
        {
          opportunities: [{ id: 'screening-schema-regression-no-record' }],
          subject,
        },
        {
          database,
          getProfile: async () => ({
            id: subject.profileId,
            tenantId: subject.tenantId,
            ownerUserId: subject.userId,
            active: true,
          }),
        },
      );
      expect(result.size).toBe(0);
    });
  },
);
