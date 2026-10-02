import { getDatabase } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import {
  eligibilityRefreshSelectSql,
  eligibilityRefreshUpdateSql,
  verifiedOpportunityEligibilityProjection,
} from './opportunity-eligibility-refresh.js';
import { fingerprintOpportunitySourceContent } from './opportunity-source-content.js';

const postgresUrl = process.env.TRIAGE_TEST_POSTGRES_URL?.trim();
for (const dialect of ['sqlite', 'postgres'] as const) {
  describe.skipIf(dialect === 'postgres' && !postgresUrl)(
    `eligibility refresh ${dialect}`,
    () => {
      it('previews an empty UUID cursor, paginates, and applies only unchanged source facts', async () => {
        const db = await getDatabase(
          dialect === 'sqlite'
            ? { type: 'sqlite', url: ':memory:' }
            : { type: 'postgres', url: postgresUrl! },
        );
        const id = '00000000-0000-4000-8000-000000000001';
        const source = {
          descriptionRaw: 'Candidates must be based in Canada.',
        };
        const fingerprint = fingerprintOpportunitySourceContent(source);
        // Postgres test uses only a connection-local temporary table, never a canonical table.
        await db.query(`CREATE ${dialect === 'postgres' ? 'TEMP ' : ''}TABLE opportunities (
        id ${dialect === 'postgres' ? 'UUID' : 'TEXT'} PRIMARY KEY, source_content_json TEXT,
        source_content_fingerprint TEXT, source_content_version INTEGER,
        posting_eligibility_json TEXT, eligibility_flags INTEGER, eligibility_source_fingerprint TEXT,
        eligibility_source_version INTEGER, human_review_notes TEXT)`);
        await db.query(
          `INSERT INTO opportunities VALUES (?, ?, ?, 1, '{}', 32, '', 0, 'owner decision')`,
          [id, JSON.stringify(source), fingerprint],
        );
        const initial = await db.query(eligibilityRefreshSelectSql, ['', 1]);
        expect(initial.rows).toHaveLength(1);
        expect(
          (await db.query(eligibilityRefreshSelectSql, [id, 1])).rows,
        ).toHaveLength(0);
        const projection = verifiedOpportunityEligibilityProjection({
          sourceContentJson: JSON.stringify(source),
          sourceContentFingerprint: fingerprint,
          sourceContentVersion: 1,
        });
        const values = [
          projection.postingEligibilityJson,
          projection.eligibilityFlags,
          projection.eligibilitySourceFingerprint,
          projection.eligibilitySourceVersion,
          id,
          fingerprint,
          fingerprint,
          1,
          1,
          JSON.stringify(source),
          JSON.stringify(source),
        ];
        expect(
          (await db.query(eligibilityRefreshUpdateSql, values)).rows,
        ).toHaveLength(1);
        expect(
          (
            await db.query(
              'SELECT eligibility_flags, human_review_notes FROM opportunities',
            )
          ).rows[0],
        ).toMatchObject({
          eligibility_flags: 1,
          human_review_notes: 'owner decision',
        });
        await db.query(
          'UPDATE opportunities SET source_content_version = 2 WHERE id = ?',
          [id],
        );
        expect(
          (await db.query(eligibilityRefreshUpdateSql, values)).rows,
        ).toHaveLength(0);
        const missingId = '00000000-0000-4000-8000-000000000002';
        await db.query(
          `INSERT INTO opportunities VALUES (?, NULL, NULL, NULL, '{}', 32, '', 0, 'preserved')`,
          [missingId],
        );
        expect(
          (
            await db.query(eligibilityRefreshUpdateSql, [
              '{}',
              32,
              '',
              0,
              missingId,
              null,
              null,
              null,
              null,
              null,
              null,
            ])
          ).rows,
        ).toHaveLength(1);
      });
    },
  );
}
