import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObjectRegistry } from '@happyvertical/smrt-core';
import { getDDLStrategy } from '@happyvertical/smrt-core/schema';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  findOwnedMatchRecords,
  saveOwnedMatchRecord,
} from './opportunity-match-store.js';
import { listPrivateRecords } from './private-workspace.js';
import './smrt.js';

const postgres = process.env.MATCH_POSTGRES_TEST_DATABASE_URL;
for (const dialect of ['sqlite', 'postgres'] as const)
  describe.runIf(dialect === 'sqlite' || postgres)(
    `private matching ${dialect} native transaction/isolation`,
    () => {
      let db: DatabaseInterface,
        control: DatabaseInterface | undefined,
        directory: string,
        schema: string;
      const owner = {
        tenantId: '11111111-1111-4111-8111-111111111111',
        userId: '22222222-2222-4222-8222-222222222222',
        profileId: '33333333-3333-4333-8333-333333333333',
      };
      const key = {
        requirementHash: 'requirement',
        evidenceHash: 'evidence',
        candidateMaterialFingerprint: 'evidence',
        decisionVersion: 'v2',
        model: 'pinned',
      };
      beforeAll(async () => {
        if (dialect === 'sqlite') {
          directory = await mkdtemp(join(tmpdir(), 'match-native-'));
          db = await getDatabase({
            type: 'sqlite',
            url: join(directory, 'match.sqlite'),
            cache: false,
          });
        } else {
          control = await getDatabase({
            type: 'postgres',
            url: postgres!,
            cache: false,
            max: 1,
          });
          schema = `match_${randomUUID().replaceAll('-', '')}`;
          await control.query(`CREATE SCHEMA "${schema}"`);
          const url = new URL(postgres!);
          url.searchParams.set('options', `-c search_path=${schema},public`);
          db = await getDatabase({
            type: 'postgres',
            url: url.toString(),
            cache: false,
            max: 1,
          });
        }
        const ddl = getDDLStrategy(dialect);
        for (const tableName of [
          'requirement_evidence_decisions',
          'match_models',
          'opportunity_recommendation_ranks',
        ]) {
          const definition = Object.values(
            ObjectRegistry.getAllSchemasAsDefinitions(),
          ).find((s) => s.tableName === tableName)!;
          for (const sql of [
            ddl.generateCreateTable(definition),
            ...ddl.generateIndexes(definition),
            ...ddl.generateTriggers(definition),
          ])
            await db.query(sql);
        }
      });
      afterAll(async () => {
        await db?.close?.();
        if (control) {
          await control.query(`DROP SCHEMA "${schema}" CASCADE`);
          await control.close?.();
        }
        if (directory) await rm(directory, { recursive: true, force: true });
      });
      it('upserts one owner key, isolates same-tenant users/profiles and rolls back the whole pinned transaction', async () => {
        await withTenant(owner, async () => {
          await db.transaction?.(async (tx) => {
            await saveOwnedMatchRecord(
              'RequirementEvidenceDecision',
              owner,
              key,
              {
                decision: 'partial',
                confidence: 0.8,
                quote: 'private-sentinel',
              },
              tx,
            );
            await saveOwnedMatchRecord(
              'MatchModel',
              owner,
              { modelVersion: 'v1' },
              { weightsJson: '[1,2]' },
              tx,
            );
            await saveOwnedMatchRecord(
              'OpportunityRecommendationRank',
              owner,
              { opportunityId: '77777777-7777-4777-8777-777777777777' },
              {
                recommendationPercent: 70,
                projectionVersion: 'opportunity-recommendation-rank/v3',
              },
              tx,
            );
          });
          await db.transaction?.(async (tx) => {
            await saveOwnedMatchRecord(
              'RequirementEvidenceDecision',
              owner,
              key,
              { decision: 'meets', confidence: 1 },
              tx,
            );
          });
          const read = (subject = owner) =>
            findOwnedMatchRecords(
              'RequirementEvidenceDecision',
              subject,
              key,
              db,
            );
          expect(await read()).toHaveLength(1);
          expect(
            ((await read())[0] as unknown as { decision: string }).decision,
          ).toBe('meets');
          await expect(
            read({ ...owner, userId: '55555555-5555-4555-8555-555555555555' }),
          ).rejects.toThrow('workspace context');
          expect(
            await read({
              ...owner,
              profileId: '66666666-6666-4666-8666-666666666666',
            }),
          ).toEqual([]);
          await expect(
            db.transaction?.(async (tx) => {
              await saveOwnedMatchRecord(
                'RequirementEvidenceDecision',
                owner,
                key,
                { decision: 'no' },
                tx,
              );
              await saveOwnedMatchRecord(
                'OpportunityRecommendationRank',
                owner,
                { opportunityId: '77777777-7777-4777-8777-777777777777' },
                { recommendationPercent: 0 },
                tx,
              );
              throw new Error('rollback fixture');
            }),
          ).rejects.toThrow('rollback fixture');
          expect(
            ((await read())[0] as unknown as { decision: string }).decision,
          ).toBe('meets');
          expect(
            (
              await listPrivateRecords(
                'OpportunityRecommendationRank',
                owner,
                { cache: false },
                { db },
              )
            )[0].recommendationPercent,
          ).toBe(70);
        });
        const sibling = {
          ...owner,
          userId: '55555555-5555-4555-8555-555555555555',
        };
        await withTenant(sibling, async () => {
          await db.transaction?.(async (tx) => {
            await saveOwnedMatchRecord(
              'RequirementEvidenceDecision',
              sibling,
              key,
              { decision: 'unknown', quote: 'sibling-only' },
              tx,
            );
          });
          const rows = await findOwnedMatchRecords(
            'RequirementEvidenceDecision',
            sibling,
            key,
            db,
          );
          expect(rows).toHaveLength(1);
          expect((rows[0] as unknown as { quote: string }).quote).toBe(
            'sibling-only',
          );
        });
        await withTenant(owner, async () => {
          const rows = await findOwnedMatchRecords(
            'RequirementEvidenceDecision',
            owner,
            key,
            db,
          );
          expect(rows).toHaveLength(1);
          expect((rows[0] as unknown as { quote: string }).quote).toBe(
            'private-sentinel',
          );
        });
        await withTenant(
          {
            tenantId: '44444444-4444-4444-8444-444444444444',
            userId: '55555555-5555-4555-8555-555555555555',
          },
          async () => {
            expect(
              await listPrivateRecords(
                'RequirementEvidenceDecision',
                {
                  tenantId: '44444444-4444-4444-8444-444444444444',
                  userId: '55555555-5555-4555-8555-555555555555',
                  profileId: '66666666-6666-4666-8666-666666666666',
                },
                {},
                { db },
              ),
            ).toEqual([]);
          },
        );
      });
    },
  );
