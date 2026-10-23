import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { executeAsPrincipal } from '@happyvertical/smrt-agents';
import { createAssetRuntime } from '@happyvertical/smrt-assets';
import { getTestDatabase, ObjectRegistry } from '@happyvertical/smrt-core';
import { withSystemContext } from '@happyvertical/smrt-tenancy';
import {
  MembershipCollection,
  MembershipStatus,
  PermissionCatalogService,
  PermissionCollection,
  RoleCollection,
  RolePermissionCollection,
  TenantCollection,
  TenantStatus,
  UserCollection,
  UserStatus,
} from '@happyvertical/smrt-users';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  editableResumeImportFields,
  type ResumeImportEntry,
  type ResumeImportView,
} from '$lib/resume-import';
import {
  getPrivateRecord,
  requireWorkspaceSubject,
} from './private-workspace.js';
import {
  assembleResumeSourceFromRecords,
  type ResumeSourceRecords,
} from './resume-data.js';
import {
  createResumeImportHost,
  type ResumeImportHost,
} from './resume-import-host.js';
import './smrt.js';
import './workspace-workflow-capabilities.js';
import { type SmrtJob, TaskRunner } from '@happyvertical/smrt-jobs';
import { deleteAccount } from './account-deletion.js';
import { getDbConfig } from './db.js';
import {
  ResumeImportLifecycleBusyError,
  withResumeImportAccountFence,
} from './resume-import-account-fence.js';
import { RESUME_IMPORT_INGESTION_QUEUE } from './resume-import-job-schema.js';
import {
  purgeQuarantinedResumeOriginals,
  recoverQuarantinedResumeOriginal,
} from './resume-import-quarantine.js';
import {
  exportResumeImportReceipts,
  purgeExpiredResumeImportAssets,
  purgeResumeImportAccountData,
  resolveResumeImportReceiptSubject,
  runResumeImportIngestionJob,
} from './resume-import-runtime.js';
import { resumeImportStorageOptions } from './resume-import-storage.js';
import { getIolausUserAssetsRoot } from './runtime-paths.js';

const subject = () => ({
  tenantId: randomUUID(),
  userId: randomUUID(),
  profileId: randomUUID(),
});
const classes = [
  'ResumeImportWriteOperation',
  'ResumeImportQuarantine',
  'ResumeImportRecoveryAudit',
  'CandidateProfile',
  'Project',
  'Experience',
  'ExperienceCompany',
  'ExperienceRole',
  'Duty',
  'Education',
  'SkillGroup',
  'SkillGroupMember',
  'Tag',
  'Asset',
  'AssetAssociation',
  'PlaceAsset',
  'ProfileAsset',
  'AssetTag',
  'AssetType',
  'AssetStatus',
  'Folder',
  'SmrtJob',
  'SmrtJobEvent',
  'SmrtWorker',
  'IntakeItem',
  'IntakeEvidence',
  'IntakeAnalysis',
  'IntakeAnalysisAttempt',
  'IntakePlan',
  'IntakeAction',
  'IntakeProposal',
  'IntakeReviewDecision',
  'IntakeExecution',
  'IntakeFeedback',
  'IntakeDispatch',
  'IntakeDeletion',
  'AccountDeletionRecord',
  'ResumeImport',
  'ResumeImportJob',
  'Company',
  'Tenant',
  'User',
  'Profile',
  'Membership',
  'Role',
  'Permission',
  'MembershipOverride',
  'RolePermission',
  'Group',
  'GroupMember',
  'GroupRole',
  'TenantPermissionOverride',
];
const permissions = ['workflow.profile.manage', 'resumeimports.apply'];
const initialEntries: ResumeImportEntry[] = [
  {
    id: 'experience',
    kind: 'experience',
    fields: {
      company: 'Acme',
      title: 'Engineer',
      startDate: '2020-01',
      endDate: '2022',
      summary: 'Built useful tools',
      bullets: 'Shipped product\nHelped team',
    },
  },
  {
    id: 'education',
    kind: 'education',
    fields: {
      title: 'BSc',
      institution: 'Example College',
      startDate: '2016',
      endDate: '2019-06',
      detail: 'Computing',
    },
  },
  { id: 'skill', kind: 'skill', fields: { name: 'TypeScript' } },
  { id: 'profile', kind: 'profile', fields: { summary: 'Product engineer' } },
];

async function seedPrincipal(
  db: DatabaseInterface,
  owner: ReturnType<typeof subject>,
) {
  return await withSystemContext(async () => {
    await (await TenantCollection.create({ db })).create({
      id: owner.tenantId,
      name: 'Workspace',
      status: TenantStatus.ACTIVE,
    });
    const role = await (await RoleCollection.create({ db })).create({
      name: `member-${randomUUID()}`,
    });
    await (await UserCollection.create({ db })).create({
      id: owner.userId,
      email: `${owner.userId}@example.invalid`,
      status: UserStatus.ACTIVE,
    });
    await (await MembershipCollection.create({ db })).create({
      roleId: role.id!,
      status: MembershipStatus.ACTIVE,
      tenantId: owner.tenantId,
      userId: owner.userId,
    });
    await PermissionCatalogService.create({ db }).syncPermissionCatalog();
    const catalog = await PermissionCollection.create({ db });
    const grants = await RolePermissionCollection.create({ db });
    for (const slug of permissions) {
      const permission = await catalog.findBySlug(slug);
      if (!permission?.id) throw new Error(`Permission missing: ${slug}`);
      await grants.addPermission(role.id!, permission.id);
    }
    const profiles = await ObjectRegistry.getCollection('CandidateProfile', {
      db,
    });
    await profiles.create({
      id: owner.profileId,
      tenantId: owner.tenantId,
      ownerUserId: owner.userId,
      profileKey: 'default',
      name: 'Owner',
    });
    return role.id!;
  });
}

const postgresUrl =
  process.env.RESUME_IMPORT_POSTGRES_TEST_DATABASE_URL?.trim();
for (const dialect of ['sqlite', 'postgres'] as const) {
  describe.runIf(dialect === 'sqlite' || postgresUrl)(
    `resume import native ingestion (${dialect})`,
    { timeout: 30_000 },
    () => {
      let db: DatabaseInterface;
      let root: string;
      let owner: ReturnType<typeof subject>;
      let host: ResumeImportHost;
      let roleId: string;
      let entries: ResumeImportEntry[];
      let clock: Date;
      let control: DatabaseInterface | undefined;
      let databaseName: string | undefined;
      let assets: Awaited<ReturnType<typeof createAssetRuntime>>;

      async function makeHost(who = owner) {
        return createResumeImportHost({
          db,
          assets,
          subject: who,
          operationModel: '@willgriffin/iolaus-site:ResumeImport',
          // Real native permission resolution on the exact transaction supplied by
          // ingestion; only provider extraction is deterministic in this suite.
          authorize: async ({ db: executor }) =>
            await executeAsPrincipal(
              {
                db: executor,
                principal: {
                  runAsUserId: who.userId,
                  tenantId: who.tenantId,
                  allowedTools: [],
                },
                postgresRls: false,
                audit: () => {},
              },
              async (run) => {
                await run.assertOperation('workflow', 'profile.manage');
                await run.assertOperation('resumeimports', 'apply');
                const result = await executor.query(
                  'SELECT id FROM candidate_profiles WHERE id = ? AND tenant_id = ? AND owner_user_id = ?',
                  [who.profileId, who.tenantId, who.userId],
                );
                if (result.rows.length !== 1)
                  throw new Error('Profile ownership denied');
                return { permissions };
              },
            ),
          extract: async () => ({
            entries: structuredClone(entries),
            warnings: [],
            provider: 'deterministic-test',
            model: 'fixture',
            version: '1',
          }),
          now: () => clock,
        });
      }
      beforeEach(async () => {
        root = await realpath(
          await mkdtemp(join(tmpdir(), 'iolaus-resume-import-')),
        );
        clock = new Date();
        vi.stubEnv('SMRT_DATA_DIR', root);
        if (dialect === 'postgres') {
          const url = new URL(postgresUrl!);
          if (url.pathname !== '/iolaus_resume_import_qa')
            throw new Error(
              'Use the isolated iolaus_resume_import_qa control database.',
            );
          control = await getDatabase({
            cache: false,
            type: 'postgres',
            url: url.toString(),
          });
          databaseName = `iolaus_resume_${randomUUID().replaceAll('-', '')}`;
          await control.query(`CREATE DATABASE "${databaseName}"`);
          url.pathname = `/${databaseName}`;
          db = await getDatabase({
            cache: false,
            max: 5,
            connectionTimeoutMillis: 5_000,
            type: 'postgres',
            url: url.toString(),
          });
        } else {
          const config = getDbConfig();
          if (config.type !== 'sqlite' || !config.url.startsWith(root))
            throw new Error('Expected isolated local runtime database');
          await mkdir(dirname(config.url), { recursive: true });
          db = await getDatabase({ cache: false, ...config });
        }
        await getTestDatabase({ db, classes });
        owner = subject();
        roleId = await seedPrincipal(db, owner);
        assets = await createAssetRuntime({
          db,
          ...resumeImportStorageOptions(
            { type: 'local', basePath: getIolausUserAssetsRoot() },
            db,
          ),
        });
        entries = structuredClone(initialEntries);
        host = await makeHost();
      }, 30_000);
      afterEach(async () => {
        await db?.close?.();
        if (databaseName)
          await control?.query(
            `DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`,
          );
        await control?.close?.();
        control = undefined;
        databaseName = undefined;
        if (root) await rm(root, { recursive: true, force: true });
        vi.unstubAllEnvs();
      });
      const upload = async (suffix = 'fixture') => {
        const received = await host.receive({
          bytes: Buffer.from(`%PDF-1.4\n${suffix}`),
          filename: 'resume.pdf',
          requestId: randomUUID(),
        });
        return await host.process(received.id);
      };
      const decisions = (view: ResumeImportView, merge = false) => ({
        revision: view.revision,
        entries: view.entries.map((entry) => ({
          id: entry.id,
          action: (entry.kind === 'profile' || merge ? 'merge' : 'create') as
            | 'merge'
            | 'create',
          ...(entry.kind === 'profile' || merge
            ? { targetId: entry.candidateMatches![0].id }
            : {}),
          fields: entry.fields,
        })),
      });
      async function rows(table: string) {
        return (await db.query(`SELECT * FROM ${table}`)).rows as Record<
          string,
          unknown
        >[];
      }
      async function assertOwned() {
        for (const table of [
          'experiences',
          'experience_companies',
          'experience_roles',
          'duties',
          'education',
          'skill_groups',
        ]) {
          const result = await rows(table);
          expect(result.length, table).toBeGreaterThan(0);
          for (const row of result)
            expect(row).toMatchObject({
              tenant_id: owner.tenantId,
              owner_user_id: owner.userId,
              candidate_profile_id: owner.profileId,
            });
        }
        expect(await rows('companies')).toHaveLength(0);
        expect(await rows('tags')).toHaveLength(0);
        expect(await rows('skill_group_members')).toHaveLength(0);
      }

      it('admits source writes only for the owned candidate profile, independently of the person profile', async () => {
        const nativeUser = (
          await db.query('SELECT profile_id FROM users WHERE id = ?', [
            owner.userId,
          ])
        ).rows[0] as { profile_id: string | null };
        expect(nativeUser.profile_id).not.toBe(owner.profileId);
        await upload('candidate-profile-admission');
        expect(await rows('resume_import_write_operations')).toHaveLength(0);
        const other = subject();
        await seedPrincipal(db, other);
        const receive = () =>
          host.receive({
            bytes: Buffer.from('%PDF-other-owned-profile'),
            filename: 'resume.pdf',
            requestId: randomUUID(),
          });
        await db.query(
          'UPDATE candidate_profiles SET owner_user_id = ? WHERE id = ?',
          [other.userId, owner.profileId],
        );
        await expect(receive()).rejects.toThrow('unavailable');
        await db.query(
          'UPDATE candidate_profiles SET owner_user_id = ?, tenant_id = ? WHERE id = ?',
          [owner.userId, other.tenantId, owner.profileId],
        );
        await expect(receive()).rejects.toThrow('unavailable');
        await db.query('DELETE FROM candidate_profiles WHERE id = ?', [
          owner.profileId,
        ]);
        await expect(receive()).rejects.toThrow('unavailable');
        expect(await rows('intake_items')).toHaveLength(1);
        expect(await rows('resume_import_write_operations')).toHaveLength(0);
      });

      it('creates private reviewed data, deduplicates bytes and repeated apply, and deletes actual evidence', async () => {
        const review = await upload();
        expect(review.status).toBe('review');
        expect(JSON.stringify(review)).not.toContain('fingerprint');
        expect((await upload()).id).toBe(review.id);
        const evidence = (await host.service.getEvidence(review.id))[0];
        expect(
          Buffer.from(
            await host.service.readEvidence(review.id, evidence.id),
          ).toString(),
        ).toContain('%PDF');
        const input = decisions(review);
        expect((await host.apply(review.id, input)).status).toBe('applied');
        expect((await host.apply(review.id, input)).status).toBe('applied');
        expect(await rows('experiences')).toHaveLength(1);
        expect(
          (await rows('experience_companies'))[0].company_name_snapshot,
        ).toBe('Acme');
        expect((await rows('experience_roles'))[0].title_snapshot).toBe(
          'Engineer',
        );
        expect(await rows('duties')).toHaveLength(2);
        expect((await rows('education'))[0]).toMatchObject({
          title: 'BSc',
          institution: 'Example College',
          detail: 'Computing',
        });
        expect((await rows('skill_groups'))[0].label).toBe('TypeScript');
        expect((await rows('candidate_profiles'))[0].summary).toBe(
          'Product engineer',
        );
        await assertOwned();
        await host.delete(review.id);
        await expect(
          host.service.readEvidence(review.id, evidence.id),
        ).rejects.toThrow();
        expect((await rows('intake_deletions')).length).toBeGreaterThan(0);
        await expect(upload()).rejects.toThrow();
        const replacementInput = {
          bytes: Buffer.from('%PDF-1.4\nfixture'),
          filename: 'resume.pdf',
          requestId: 'replacement-1',
          newImport: true,
        };
        const replacementReceipt = await host.receive(replacementInput);
        const replacement = await host.process(replacementReceipt.id);
        expect(replacement.id).not.toBe(review.id);
        expect(replacement.status).toBe('review');
        expect((await host.receive(replacementInput)).id).toBe(replacement.id);
        await expect(
          host.service.readEvidence(review.id, evidence.id),
        ).rejects.toThrow();
      });

      it('accepts the browser DTO blank structured-field default for legacy bullets', async () => {
        entries = [
          {
            id: 'experience-1',
            kind: 'experience',
            fields: {
              company: 'Acme',
              title: 'Engineer',
              bullets: 'Legacy unsectioned duty',
            },
          },
        ];
        const review = await upload('legacy-bullet-dto');
        const fields = editableResumeImportFields(review.entries[0]);
        expect(fields.bulletSections).toBe('');
        await expect(
          host.apply(review.id, {
            revision: review.revision,
            entries: [{ id: 'experience-1', action: 'create', fields }],
          }),
        ).resolves.toMatchObject({ status: 'applied' });
        expect(await rows('duties')).toMatchObject([
          { title: '', body: 'Legacy unsectioned duty' },
        ]);
      });

      it('applies large reviewed bullet fields through the host transport and rejects overflow', async () => {
        const largeBullets = Array.from(
          { length: 26 },
          (_, index) => `${index}-${'x'.repeat(997)}`,
        ).join('\n');
        const largeSections = JSON.stringify([
          {
            title: 'Engineering',
            bullets: Array.from(
              { length: 22 },
              (_, index) => `${index}-${'y'.repeat(997)}`,
            ),
          },
        ]);
        entries = [
          {
            id: 'experience-1',
            kind: 'experience',
            fields: {
              company: 'Acme',
              title: 'Engineer',
              bullets: largeBullets,
            },
          },
        ];
        const accepted = await upload('large-reviewed-fields');
        await expect(
          host.apply(accepted.id, {
            revision: accepted.revision,
            entries: [
              {
                id: 'experience-1',
                action: 'create',
                fields: accepted.entries[0].fields,
              },
            ],
          }),
        ).resolves.toMatchObject({ status: 'applied' });
        expect(await rows('duties')).toHaveLength(26);

        entries = [
          {
            id: 'experience-1',
            kind: 'experience',
            fields: {
              company: 'Acme',
              title: 'Engineer',
              bulletSections: largeSections,
            },
          },
        ];
        const sectioned = await upload('large-reviewed-sections');
        await expect(
          host.apply(sectioned.id, {
            revision: sectioned.revision,
            entries: [
              {
                id: 'experience-1',
                action: 'create',
                fields: sectioned.entries[0].fields,
              },
            ],
          }),
        ).resolves.toMatchObject({ status: 'applied' });
        expect(await rows('duties')).toHaveLength(48);

        entries = [
          {
            id: 'experience-1',
            kind: 'experience',
            fields: { company: 'Acme', title: 'Engineer', bullets: 'Valid' },
          },
        ];
        const rejected = await upload('large-reviewed-fields-rejected');
        const decision = {
          revision: rejected.revision,
          entries: [
            {
              id: 'experience-1',
              action: 'create' as const,
              fields: rejected.entries[0].fields,
            },
          ],
        };
        await expect(
          host.apply(rejected.id, {
            ...decision,
            entries: [
              {
                ...decision.entries[0],
                fields: {
                  ...decision.entries[0].fields,
                  bullets: 'x'.repeat(50_001),
                },
              },
            ],
          }),
        ).rejects.toThrow('Invalid review fields');
        await expect(
          host.apply(rejected.id, {
            ...decision,
            entries: [
              {
                ...decision.entries[0],
                fields: {
                  ...decision.entries[0].fields,
                  bulletSections: JSON.stringify([
                    { title: 'Engineering', bullets: ['x'.repeat(512 * 1024)] },
                  ]),
                },
              },
            ],
          }),
        ).rejects.toThrow('Invalid review fields');
      });

      it('merges section duties by body, adopts legacy headings, and keeps each heading together', async () => {
        entries = [
          {
            id: 'experience-1',
            kind: 'experience',
            fields: {
              company: 'Acme',
              title: 'Engineer',
              bullets: 'Shared legacy duty\nExisting delivery duty',
            },
          },
        ];
        const first = await upload('section-merge-first');
        await host.apply(first.id, {
          revision: first.revision,
          entries: [
            {
              id: 'experience-1',
              action: 'create',
              fields: first.entries[0].fields,
            },
          ],
        });
        // This heading represents a prior user edit. It must not be replaced
        // by an incoming heading merely because the body is deduplicated.
        await db.query('UPDATE duties SET title = ? WHERE body = ?', [
          'Delivery',
          'Existing delivery duty',
        ]);
        entries = [
          {
            id: 'experience-1',
            kind: 'experience',
            fields: {
              company: 'Acme',
              title: 'Engineer',
              bulletSections: JSON.stringify([
                {
                  title: 'Leadership',
                  bullets: ['Shared legacy duty', 'New leadership duty'],
                },
                {
                  title: 'Delivery',
                  bullets: ['New delivery duty'],
                },
              ]),
            },
          },
        ];
        const second = await upload('section-merge-second');
        const experienceId = String((await rows('experiences'))[0].id);
        await host.apply(second.id, {
          revision: second.revision,
          entries: [
            {
              id: 'experience-1',
              action: 'merge',
              targetId: experienceId,
              fields: second.entries[0].fields,
            },
          ],
        });
        expect(
          (await rows('duties'))
            .sort(
              (left, right) =>
                Number(left.sort_order) - Number(right.sort_order),
            )
            .map((duty) => ({ title: duty.title, body: duty.body })),
        ).toEqual([
          { title: 'Leadership', body: 'Shared legacy duty' },
          { title: 'Leadership', body: 'New leadership duty' },
          { title: 'Delivery', body: 'Existing delivery duty' },
          { title: 'Delivery', body: 'New delivery duty' },
        ]);
      });

      it('merges every reviewed field without adding shared catalogue records', async () => {
        const first = await upload();
        await host.apply(first.id, decisions(first));
        entries = [
          {
            id: 'experience',
            kind: 'experience',
            fields: {
              company: 'Reviewed Company',
              title: 'Staff Engineer',
              startDate: '2021-02-03',
              endDate: '2024-05',
              summary: 'Reviewed summary',
              bullets: 'Shipped product\nNew achievement',
            },
          },
          {
            id: 'education',
            kind: 'education',
            fields: {
              title: 'MSc',
              institution: 'Reviewed University',
              startDate: '2020-09',
              endDate: '2022-07-08',
              detail: 'Reviewed detail',
            },
          },
          {
            id: 'skill',
            kind: 'skill',
            fields: { name: 'Systems engineering' },
          },
          {
            id: 'profile',
            kind: 'profile',
            fields: { summary: 'Reviewed profile summary' },
          },
        ];
        const review = await upload('second');
        expect(
          (await host.apply(review.id, decisions(review, true))).status,
        ).toBe('applied');
        expect((await rows('experiences'))[0]).toMatchObject({
          summary: 'Reviewed summary',
          start_precision: 'day',
          end_precision: 'month',
        });
        expect(
          (await rows('experience_companies'))[0].company_name_snapshot,
        ).toBe('Reviewed Company');
        expect((await rows('experience_roles'))[0]).toMatchObject({
          title_snapshot: 'Staff Engineer',
          summary: 'Reviewed summary',
          start_precision: 'day',
          end_precision: 'month',
        });
        expect((await rows('duties')).map((row) => row.body).sort()).toEqual([
          'Helped team',
          'New achievement',
          'Shipped product',
        ]);
        expect((await rows('education'))[0]).toMatchObject({
          title: 'MSc',
          institution: 'Reviewed University',
          detail: 'Reviewed detail',
          start_precision: 'month',
          end_precision: 'day',
        });
        expect((await rows('skill_groups'))[0].label).toBe(
          'Systems engineering',
        );
        expect((await rows('candidate_profiles'))[0].summary).toBe(
          'Reviewed profile summary',
        );
        await assertOwned();
      });

      it('persists section-heading duties and deduplicated server-pinned skill evidence', async () => {
        const quote = 'Built TypeScript services for the platform.';
        const skillEvidence = JSON.stringify([
          {
            proposalExperienceId: 'experience-1',
            usage: 'TypeScript services',
            depth: 'hands_on',
            quote,
            page: 1,
            startDate: '2021-03',
          },
        ]);
        entries = [
          {
            id: 'experience-1',
            kind: 'experience',
            fields: {
              company: 'Acme',
              title: 'Engineer',
              startDate: '2020-01',
              endDate: '2022',
              bulletSections: JSON.stringify([
                { title: 'Leadership', bullets: ['Mentored the team'] },
                { title: 'Engineering', bullets: [quote] },
              ]),
            },
            evidence: [{ page: 1, text: quote }],
          },
          {
            id: 'skill-1',
            kind: 'skill',
            fields: { name: 'TypeScript', skillEvidence },
          },
        ];
        const first = await upload('skill-evidence-first');
        await host.apply(first.id, {
          revision: first.revision,
          entries: [
            {
              id: 'experience-1',
              action: 'create',
              fields: first.entries[0].fields,
            },
            {
              id: 'skill-1',
              action: 'create',
              // The browser never re-submits server-pinned skill evidence.
              fields: { name: 'TypeScript' },
            },
          ],
        });
        expect(
          (await rows('duties')).map((row) => ({
            title: row.title,
            body: row.body,
          })),
        ).toEqual([
          { title: 'Leadership', body: 'Mentored the team' },
          { title: 'Engineering', body: quote },
        ]);
        const group = (await rows('skill_groups'))[0];
        const exportedGroup = (await getPrivateRecord(
          'SkillGroup',
          String(group.id),
          requireWorkspaceSubject(owner),
          { db },
        )) as { toJSON: () => Record<string, unknown> };
        // Account export serializes private records with toJSON(), so confirm
        // the sensitive source-backed observations survive that real path.
        expect(exportedGroup.toJSON()).toMatchObject({
          evidenceJson: String(group.evidence_json),
        });
        expect(JSON.parse(String(group.evidence_json))).toEqual([
          expect.objectContaining({
            proposalExperienceId: 'experience-1',
            experienceId: (await rows('experiences'))[0].id,
            company: 'Acme',
            role: 'Engineer',
            roleStartDate: '2020-01',
            roleEndDate: '2022',
            startDate: '2021-03',
          }),
        ]);

        const paraphrasedEvidence = JSON.stringify([
          {
            proposalExperienceId: 'experience-1',
            usage: 'Implemented reliable TypeScript platform systems',
            depth: 'leadership',
            quote,
            page: 1,
            startDate: '2021-03',
          },
        ]);
        entries = [
          entries[0],
          {
            id: 'skill-1',
            kind: 'skill',
            fields: { name: 'TypeScript', skillEvidence: paraphrasedEvidence },
          },
        ];
        const second = await upload('skill-evidence-second');
        const experienceId = String((await rows('experiences'))[0].id);
        await host.apply(second.id, {
          revision: second.revision,
          entries: [
            {
              id: 'experience-1',
              action: 'merge',
              targetId: experienceId,
              fields: second.entries[0].fields,
            },
            {
              id: 'skill-1',
              action: 'merge',
              targetId: String(group.id),
              fields: { name: 'TypeScript' },
            },
          ],
        });
        expect(
          JSON.parse(String((await rows('skill_groups'))[0].evidence_json)),
        ).toHaveLength(1);

        entries = [
          {
            id: 'experience-1',
            kind: 'experience',
            fields: {
              company: 'Second Acme',
              title: 'Engineer',
              startDate: '2023-01',
              bulletSections: JSON.stringify([
                { title: 'Engineering', bullets: [quote] },
              ]),
            },
            evidence: [{ page: 1, text: quote }],
          },
          {
            id: 'skill-1',
            kind: 'skill',
            fields: { name: 'TypeScript', skillEvidence },
          },
        ];
        const distinctRole = await upload('skill-evidence-distinct-role');
        await host.apply(distinctRole.id, {
          revision: distinctRole.revision,
          entries: [
            {
              id: 'experience-1',
              action: 'create',
              fields: distinctRole.entries[0].fields,
            },
            {
              id: 'skill-1',
              action: 'merge',
              targetId: String(group.id),
              fields: { name: 'TypeScript' },
            },
          ],
        });
        const accumulated = JSON.parse(
          String((await rows('skill_groups'))[0].evidence_json),
        ) as { experienceId: string }[];
        expect(accumulated).toHaveLength(2);
        expect(new Set(accumulated.map((item) => item.experienceId)).size).toBe(
          2,
        );

        const forged = await upload('skill-evidence-forged');
        await expect(
          host.apply(forged.id, {
            revision: forged.revision,
            entries: [
              {
                id: 'experience-1',
                action: 'merge',
                targetId: experienceId,
                fields: forged.entries[0].fields,
              },
              {
                id: 'skill-1',
                action: 'merge',
                targetId: String(group.id),
                fields: { name: 'TypeScript', skillEvidence: '[]' },
              },
            ],
          }),
        ).rejects.toThrow('Unknown skill field');

        entries = [
          entries[0],
          {
            id: 'skill-skipped-parent',
            kind: 'skill',
            fields: { name: 'Go', skillEvidence },
          },
        ];
        const skippedParent = await upload('skill-evidence-skipped-parent');
        await host.apply(skippedParent.id, {
          revision: skippedParent.revision,
          entries: [
            { id: 'experience-1', action: 'skip', fields: {} },
            {
              id: 'skill-skipped-parent',
              action: 'create',
              fields: { name: 'Go' },
            },
          ],
        });
        expect(
          JSON.parse(
            String(
              (await rows('skill_groups')).find((row) => row.label === 'Go')
                ?.evidence_json,
            ),
          ),
        ).toEqual([
          expect.objectContaining({
            proposalExperienceId: 'experience-1',
            quote,
          }),
        ]);
        expect(
          JSON.parse(
            String(
              (await rows('skill_groups')).find((row) => row.label === 'Go')
                ?.evidence_json,
            ),
          )[0],
        ).not.toHaveProperty('experienceId');
      });

      it('keeps punctuated skills and repeated company-title stints distinct in the canonical resume', async () => {
        entries = [
          {
            id: 'experience-1',
            kind: 'experience',
            fields: {
              company: 'Acme',
              title: 'Engineer',
              startDate: '2018',
              endDate: '2020',
            },
          },
          {
            id: 'experience-2',
            kind: 'experience',
            fields: {
              company: 'Acme',
              title: 'Engineer',
              startDate: '2022',
              endDate: '2024',
            },
          },
          { id: 'skill-cpp', kind: 'skill', fields: { name: 'C++' } },
          { id: 'skill-csharp', kind: 'skill', fields: { name: 'C#' } },
        ];
        const review = await upload('return-stints-and-punctuated-skills');
        await host.apply(review.id, {
          revision: review.revision,
          entries: review.entries.map((entry) => ({
            id: entry.id,
            action: 'create' as const,
            fields: entry.fields,
          })),
        });
        const experiences = await rows('experiences');
        expect(experiences).toHaveLength(2);
        expect(new Set(experiences.map((row) => row.experience_key)).size).toBe(
          2,
        );
        const groups = await rows('skill_groups');
        expect(groups.map((group) => group.label).sort()).toEqual([
          'C#',
          'C++',
        ]);
        expect(new Set(groups.map((group) => group.group_key)).size).toBe(2);

        const records = Object.fromEntries(
          'achievements achievementAttachments achievementTags attachments companies companyAttachments duties dutyTags education educationTags experienceCompanies experienceRoles experienceTags experiences otherRoles profileLinks profiles projects projectAttachments projectTags roles roleTags skillCategories skillCategoryMembers skillGroups skillGroupMembers tags'
            .split(' ')
            .map((key) => [key, []]),
        ) as unknown as ResumeSourceRecords;
        for (const [key, table] of Object.entries({
          profiles: 'candidate_profiles',
          experiences: 'experiences',
          experienceCompanies: 'experience_companies',
          experienceRoles: 'experience_roles',
          skillGroups: 'skill_groups',
        })) {
          (records as unknown as Record<string, unknown>)[key] = (
            await rows(table)
          ).map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([column, value]) => [
                column.replace(/_([a-z])/g, (_, letter: string) =>
                  letter.toUpperCase(),
                ),
                value,
              ]),
            ),
          );
        }
        const assembled = assembleResumeSourceFromRecords(records);
        expect(assembled?.experience.positions).toHaveLength(2);
        expect(
          assembled?.skills.skillGroups.map((group) => group.label).sort(),
        ).toEqual(['C#', 'C++']);
      });

      function projectEntries(): ResumeImportEntry[] {
        return [
          {
            id: 'project',
            kind: 'project',
            fields: {
              proposalExperienceId: 'experience',
              name: 'Launch Console',
              url: 'https://example.invalid/console',
              summary: 'A private delivery project',
              bullets: 'Built the deployment console\nReduced release time',
              startDate: '2021-03',
              endDate: '2022-04-05',
            },
          },
          {
            id: 'experience',
            kind: 'experience',
            fields: {
              company: 'Acme',
              title: 'Engineer',
              startDate: '2020',
              bullets: 'Mentored the engineering team',
            },
          },
        ];
      }

      it('creates linked owned projects after their parents and retains bullets without repeat-apply duplicates', async () => {
        entries = projectEntries();
        const review = await upload('projects-create');
        expect(review.status).toBe('review');
        const input = decisions(review);
        expect(input.entries[0].id).toBe('project');
        input.entries[0].fields = {
          ...input.entries[0].fields,
          proposalExperienceId: 'client-forged-parent',
        };
        expect((await host.apply(review.id, input)).status).toBe('applied');
        expect((await host.apply(review.id, input)).status).toBe('applied');
        const experience = (await rows('experiences'))[0];
        const projects = await rows('projects');
        expect(projects).toHaveLength(1);
        expect(projects[0]).toMatchObject({
          experience_id: experience.id,
          tenant_id: owner.tenantId,
          owner_user_id: owner.userId,
          candidate_profile_id: owner.profileId,
          name: 'Launch Console',
          url: 'https://example.invalid/console',
          summary: 'A private delivery project',
          start_precision: 'month',
          end_precision: 'day',
        });
        expect(new Date(projects[0].start_date as string).toISOString()).toBe(
          '2021-03-01T00:00:00.000Z',
        );
        expect(new Date(projects[0].end_date as string).toISOString()).toBe(
          '2022-04-05T00:00:00.000Z',
        );
        expect(await rows('experiences')).toHaveLength(1);
        expect((await rows('duties')).map((row) => row.body).sort()).toEqual([
          'Built the deployment console',
          'Mentored the engineering team',
          'Reduced release time',
        ]);
        const storedDuties = await rows('duties');
        expect(
          storedDuties.filter((row) => row.project_id === projects[0].id),
        ).toHaveLength(2);
        expect(
          storedDuties.filter((row) => !row.project_id).map((row) => row.body),
        ).toEqual(['Mentored the engineering team']);
        for (const duty of storedDuties)
          expect(duty).toMatchObject({
            experience_id: experience.id,
            tenant_id: owner.tenantId,
            owner_user_id: owner.userId,
            candidate_profile_id: owner.profileId,
          });
        expect(await rows('companies')).toHaveLength(0);
        expect(await rows('tags')).toHaveLength(0);
        const records = Object.fromEntries(
          'achievements achievementAttachments achievementTags attachments companies companyAttachments duties dutyTags education educationTags experienceCompanies experienceRoles experienceTags experiences otherRoles profileLinks profiles projects projectAttachments projectTags roles roleTags skillCategories skillCategoryMembers skillGroups skillGroupMembers tags'
            .split(' ')
            .map((key) => [key, []]),
        ) as unknown as ResumeSourceRecords;
        for (const [key, table] of Object.entries({
          profiles: 'candidate_profiles',
          experiences: 'experiences',
          experienceCompanies: 'experience_companies',
          experienceRoles: 'experience_roles',
          projects: 'projects',
          duties: 'duties',
        })) {
          (records as unknown as Record<string, unknown>)[key] = (
            await rows(table)
          ).map((row) =>
            Object.fromEntries(
              Object.entries(row).map(([column, value]) => [
                column.replace(/_([a-z])/g, (_, letter: string) =>
                  letter.toUpperCase(),
                ),
                value,
              ]),
            ),
          );
        }
        const assembled = assembleResumeSourceFromRecords(records);
        expect(assembled?.experience.positions).toHaveLength(1);
        expect(
          assembled?.experience.positions[0].duties?.map((duty) => duty.body),
        ).toEqual(['Mentored the engineering team']);
        expect(
          assembled?.experience.positions[0].projects?.[0].duties?.map(
            (duty) => duty.body,
          ),
        ).toEqual(['Built the deployment console', 'Reduced release time']);
      });

      it('creates and merges many same-heading project duties without duplicates', async () => {
        const section = (prefix: string) =>
          JSON.stringify([
            {
              title: 'Engineering',
              bullets: Array.from(
                { length: 22 },
                (_, index) => `${prefix} ${index} ${'x'.repeat(980)}`,
              ),
            },
          ]);
        entries = projectEntries();
        entries[0].fields = {
          ...entries[0].fields,
          bullets: '',
          bulletSections: section('Created'),
        };
        const first = await upload('project-section-create');
        await host.apply(first.id, decisions(first));
        const experience = (await rows('experiences'))[0];
        const project = (await rows('projects'))[0];
        const projectDuties = async () =>
          (await rows('duties'))
            .filter((duty) => duty.project_id === project.id)
            .sort(
              (left, right) =>
                Number(left.sort_order) - Number(right.sort_order),
            );
        expect(await projectDuties()).toHaveLength(22);
        expect(project.experience_id).toBe(experience.id);
        expect((await projectDuties()).map((duty) => duty.title)).toEqual(
          Array(22).fill('Engineering'),
        );

        entries[0].fields = {
          ...entries[0].fields,
          bulletSections: section('Merged'),
        };
        const second = await upload('project-section-merge');
        const secondProject = second.entries.find(
          (entry) => entry.id === 'project',
        );
        const secondExperience = second.entries.find(
          (entry) => entry.id === 'experience',
        );
        if (!secondProject || !secondExperience)
          throw new Error('Missing project review entries.');
        await host.apply(second.id, {
          revision: second.revision,
          entries: [
            {
              id: 'project',
              action: 'merge',
              targetId: String(project.id),
              fields: secondProject.fields,
            },
            {
              id: 'experience',
              action: 'merge',
              targetId: String(experience.id),
              fields: secondExperience.fields,
            },
          ],
        });
        expect(await projectDuties()).toHaveLength(22);
        expect((await projectDuties()).map((duty) => duty.title)).toEqual(
          Array(22).fill('Engineering'),
        );
        expect((await projectDuties()).map((duty) => duty.body)).toEqual(
          Array.from(
            { length: 22 },
            (_, index) => `Merged ${index} ${'x'.repeat(980)}`,
          ),
        );
        expect(
          (await projectDuties()).map((duty) => Number(duty.sort_order)),
        ).toEqual(Array.from({ length: 22 }, (_, index) => index));
        expect((await rows('projects'))[0].experience_id).toBe(experience.id);
      });

      it('links projects to merged parents and keeps an existing link when the parent is skipped', async () => {
        entries = projectEntries();
        const first = await upload('projects-first');
        await host.apply(first.id, decisions(first));
        const original = (await rows('projects'))[0];
        const second = await upload('projects-merge-parent');
        const secondInput = decisions(second);
        secondInput.entries[1] = {
          ...secondInput.entries[1],
          action: 'merge',
          targetId: String(original.experience_id),
        };
        secondInput.entries[0].fields = {
          ...secondInput.entries[0].fields,
          name: 'Second Console',
        };
        expect((await host.apply(second.id, secondInput)).status).toBe(
          'applied',
        );
        expect(await rows('experiences')).toHaveLength(1);
        expect(await rows('projects')).toHaveLength(2);
        for (const project of await rows('projects'))
          expect(project.experience_id).toBe(original.experience_id);
        expect(
          (await rows('duties'))
            .filter((row) => row.project_id === original.id)
            .map((row) => row.body)
            .sort(),
        ).toEqual(['Built the deployment console', 'Reduced release time']);
        expect(
          (await rows('duties')).filter((row) => !row.project_id),
        ).toHaveLength(1);
        const third = await upload('projects-skip-parent');
        const merged = {
          revision: third.revision,
          entries: [
            {
              id: 'project',
              action: 'merge',
              targetId: original.id,
              fields: {
                ...third.entries[0].fields,
                name: 'Reviewed Console',
                summary: 'Reviewed project detail',
              },
            },
            { id: 'experience', action: 'skip', fields: {} },
          ],
        };
        await host.apply(third.id, merged);
        expect(
          (await rows('projects')).find((row) => row.id === original.id),
        ).toMatchObject({
          name: 'Reviewed Console',
          summary: 'Reviewed project detail',
          experience_id: original.experience_id,
        });
        const fourth = await upload('projects-unlinked');
        await host.apply(fourth.id, {
          revision: fourth.revision,
          entries: [
            {
              id: 'project',
              action: 'create',
              fields: { ...fourth.entries[0].fields, name: 'Unlinked Console' },
            },
            { id: 'experience', action: 'skip', fields: {} },
          ],
        });
        expect(
          (await rows('projects')).find(
            (row) => row.name === 'Unlinked Console',
          )?.experience_id,
        ).toBe('');
        expect(await rows('duties')).toHaveLength(7);
      });

      it('rolls back parent and bullets on project write failure and rejects foreign project merge targets', async () => {
        entries = projectEntries();
        const review = await upload('projects-rollback');
        if (dialect === 'sqlite')
          await db.query(
            "CREATE TRIGGER project_test_failure BEFORE INSERT ON projects BEGIN SELECT RAISE(ABORT, 'project failure'); END",
          );
        else {
          await db.query(
            "CREATE FUNCTION project_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'project failure'; END; $$",
          );
          await db.query(
            'CREATE TRIGGER project_test_failure BEFORE INSERT ON projects FOR EACH ROW EXECUTE FUNCTION project_test_failure()',
          );
        }
        await expect(
          host.apply(review.id, decisions(review)),
        ).rejects.toThrow();
        for (const table of [
          'projects',
          'experiences',
          'experience_companies',
          'experience_roles',
          'duties',
        ])
          expect(await rows(table)).toHaveLength(0);
        expect((await rows('intake_executions'))[0].state).toBe('failed');
        if (dialect === 'sqlite')
          await db.query('DROP TRIGGER project_test_failure');
        else await db.query('DROP TRIGGER project_test_failure ON projects');
        await host.apply(review.id, decisions(review));
        expect(await rows('projects')).toHaveLength(1);
        const other = subject();
        await seedPrincipal(db, other);
        const foreign = await withSystemContext(async () =>
          (await ObjectRegistry.getCollection('Project', { db })).create({
            name: 'Foreign project',
            projectKey: 'foreign',
            tenantId: other.tenantId,
            ownerUserId: other.userId,
            candidateProfileId: other.profileId,
          }),
        );
        const next = await upload('projects-foreign');
        expect(
          next.entries[0].candidateMatches?.map((row) => row.id),
        ).not.toContain(foreign.id);
        await expect(
          host.apply(next.id, {
            revision: next.revision,
            entries: [
              {
                id: 'project',
                action: 'merge',
                targetId: foreign.id,
                fields: next.entries[0].fields,
              },
              { id: 'experience', action: 'skip', fields: {} },
            ],
          }),
        ).rejects.toThrow();
        expect(
          (await rows('projects')).find((row) => row.id === foreign.id)?.name,
        ).toBe('Foreign project');
        expect(await rows('experiences')).toHaveLength(1);
      });

      it('replaces only owned project duties atomically and keeps role duties on repeat apply', async () => {
        entries = projectEntries();
        const first = await upload('project-duty-first');
        await host.apply(first.id, decisions(first));
        const project = (await rows('projects'))[0];
        const other = subject();
        await seedPrincipal(db, other);
        await withSystemContext(async () =>
          (await ObjectRegistry.getCollection('Duty', { db })).create({
            body: 'Other owner duty',
            projectId: project.id,
            experienceId: project.experience_id,
            tenantId: other.tenantId,
            ownerUserId: other.userId,
            candidateProfileId: other.profileId,
          }),
        );
        const review = await upload('project-duty-replace');
        const input = {
          revision: review.revision,
          entries: [
            {
              id: 'project',
              action: 'merge',
              targetId: project.id,
              fields: {
                ...review.entries[0].fields,
                bullets: 'Replacement achievement',
                summary: 'Reviewed summary',
              },
            },
            { id: 'experience', action: 'skip', fields: {} },
          ],
        };
        if (dialect === 'sqlite')
          await db.query(
            "CREATE TRIGGER duty_test_failure BEFORE INSERT ON duties WHEN NEW.body = 'Replacement achievement' BEGIN SELECT RAISE(ABORT, 'duty failure'); END",
          );
        else {
          await db.query(
            "CREATE FUNCTION duty_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.body = 'Replacement achievement' THEN RAISE EXCEPTION 'duty failure'; END IF; RETURN NEW; END; $$",
          );
          await db.query(
            'CREATE TRIGGER duty_test_failure BEFORE INSERT ON duties FOR EACH ROW EXECUTE FUNCTION duty_test_failure()',
          );
        }
        await expect(host.apply(review.id, input)).rejects.toThrow();
        expect(
          (await rows('duties'))
            .filter((row) => row.owner_user_id === owner.userId)
            .map((row) => row.body)
            .sort(),
        ).toEqual([
          'Built the deployment console',
          'Mentored the engineering team',
          'Reduced release time',
        ]);
        expect((await rows('projects'))[0].summary).toBe(
          'A private delivery project',
        );
        if (dialect === 'sqlite')
          await db.query('DROP TRIGGER duty_test_failure');
        else await db.query('DROP TRIGGER duty_test_failure ON duties');
        await host.apply(review.id, input);
        await host.apply(review.id, input);
        const duties = await rows('duties');
        expect(
          duties
            .filter((row) => row.owner_user_id === owner.userId)
            .map((row) => row.body)
            .sort(),
        ).toEqual(['Mentored the engineering team', 'Replacement achievement']);
        expect(
          duties.find((row) => row.body === 'Replacement achievement'),
        ).toMatchObject({
          project_id: project.id,
          experience_id: project.experience_id,
          tenant_id: owner.tenantId,
          owner_user_id: owner.userId,
          candidate_profile_id: owner.profileId,
        });
        expect(
          duties
            .filter((row) => row.owner_user_id === other.userId)
            .map((row) => row.body),
        ).toEqual(['Other owner duty']);
      });

      it('rejects stale revisions and stale captured merge targets without writes', async () => {
        const review = await upload();
        await expect(
          host.apply(review.id, { ...decisions(review), revision: '99' }),
        ).rejects.toThrow('changed');
        expect(await rows('experiences')).toHaveLength(0);
        await db.query(
          'UPDATE candidate_profiles SET summary = ? WHERE id = ?',
          ['Manual edit', owner.profileId],
        );
        await expect(
          host.apply(review.id, decisions(review)),
        ).rejects.toThrow();
        expect(await rows('experiences')).toHaveLength(0);
        expect((await rows('candidate_profiles'))[0].summary).toBe(
          'Manual edit',
        );
      });

      it('rejects an experience merge when an owned duty section title changed after capture', async () => {
        entries = [
          {
            id: 'experience-1',
            kind: 'experience',
            fields: {
              company: 'Acme',
              title: 'Engineer',
              bulletSections: JSON.stringify([
                { title: 'Leadership', bullets: ['Mentored the team'] },
              ]),
            },
          },
        ];
        const first = await upload('section-title-first');
        await host.apply(first.id, {
          revision: first.revision,
          entries: [
            {
              id: 'experience-1',
              action: 'create',
              fields: first.entries[0].fields,
            },
          ],
        });
        const captured = await upload('section-title-captured');
        const experienceId = String((await rows('experiences'))[0].id);
        await db.query('UPDATE duties SET title = ? WHERE experience_id = ?', [
          'Manual title edit',
          experienceId,
        ]);
        await expect(
          host.apply(captured.id, {
            revision: captured.revision,
            entries: [
              {
                id: 'experience-1',
                action: 'merge',
                targetId: experienceId,
                fields: captured.entries[0].fields,
              },
            ],
          }),
        ).rejects.toThrow('could not be applied');
        expect((await rows('duties'))[0].title).toBe('Manual title edit');
      });

      it('fails malformed proposal evidence before it is available for review', async () => {
        entries = [
          {
            id: 'experience-1',
            kind: 'experience',
            fields: { company: 'Acme', title: 'Engineer' },
            evidence: [{ page: 0, text: '' }],
          },
        ];
        const result = await upload('malformed-proposal-evidence');
        expect(result.status).toBe('failed');
        expect(result.entries).toEqual([]);
        expect(await rows('experiences')).toEqual([]);
      });

      it('denies cross-owner evidence and apply, forged profile scope, and revoked native permission', async () => {
        const review = await upload();
        const other = subject();
        await seedPrincipal(db, other);
        const otherHost = await makeHost(other);
        await expect(otherHost.get(review.id)).rejects.toThrow();
        await expect(
          otherHost.apply(review.id, decisions(review)),
        ).rejects.toThrow();
        const evidence = (await host.service.getEvidence(review.id))[0];
        await expect(
          otherHost.service.readEvidence(review.id, evidence.id),
        ).rejects.toThrow();
        const forged = await makeHost({ ...other, profileId: owner.profileId });
        await expect(
          forged.receive({
            bytes: Buffer.from('%PDF-forged'),
            filename: 'x.pdf',
            requestId: 'forged',
          }),
        ).rejects.toThrow();
        await db.query('DELETE FROM role_permissions WHERE role_id = ?', [
          roleId,
        ]);
        await expect(host.get(review.id)).rejects.toThrow();
        await expect(
          host.apply(review.id, decisions(review)),
        ).rejects.toThrow();
        expect(await rows('experiences')).toHaveLength(0);
      });

      it('rolls back a real mid-write database failure, records failure and permits a clean retry', async () => {
        const review = await upload();
        if (dialect === 'sqlite')
          await db.query(
            "CREATE TRIGGER resume_test_failure BEFORE INSERT ON education BEGIN SELECT RAISE(ABORT, 'test mid-write failure'); END",
          );
        else {
          await db.query(
            "CREATE FUNCTION resume_test_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test mid-write failure'; END; $$",
          );
          await db.query(
            'CREATE TRIGGER resume_test_failure BEFORE INSERT ON education FOR EACH ROW EXECUTE FUNCTION resume_test_failure()',
          );
        }
        await expect(
          host.apply(review.id, decisions(review)),
        ).rejects.toThrow();
        for (const table of [
          'experiences',
          'experience_companies',
          'experience_roles',
          'duties',
          'education',
          'skill_groups',
        ])
          expect(await rows(table)).toHaveLength(0);
        expect((await rows('candidate_profiles'))[0].summary).toBe('');
        const failed = await host.service.listReviews(review.id);
        expect(failed.actions[0].review.state).toBe('failed');
        const execution = (await rows('intake_executions'))[0];
        expect(execution.state).toBe('failed');
        const failureData =
          typeof execution.data === 'string'
            ? JSON.parse(execution.data)
            : execution.data;
        expect(failureData).toMatchObject({
          error: 'domain_failure',
          rolledBack: true,
        });
        if (dialect === 'sqlite')
          await db.query('DROP TRIGGER resume_test_failure');
        else await db.query('DROP TRIGGER resume_test_failure ON education');
        expect((await host.apply(review.id, decisions(review))).status).toBe(
          'applied',
        );
        expect(await rows('experiences')).toHaveLength(1);
        await assertOwned();
      });

      it('rejects direct job execution without an authentic active runner context', async () => {
        const review = await upload();
        await expect(
          runResumeImportIngestionJob(
            { itemId: review.id, dispatchId: randomUUID(), revision: 1 },
            undefined,
            db,
          ),
        ).rejects.toThrow();
        expect(await rows('experiences')).toHaveLength(0);
      });

      it.runIf(dialect === 'postgres')(
        'rechecks a target after waiting for a concurrent committed edit',
        async () => {
          entries = [initialEntries[3]];
          const review = await upload();
          const second = await getDatabase({
            cache: false,
            type: 'postgres',
            url: db.url!,
          });
          let release!: () => void;
          let locked!: () => void;
          const lockHeld = new Promise<void>((resolve) => {
            locked = resolve;
          });
          const continueEdit = new Promise<void>((resolve) => {
            release = resolve;
          });
          if (!second.transaction)
            throw new Error('Native transactions required');
          const editing = second.transaction(async (transaction) => {
            await transaction.query(
              'UPDATE candidate_profiles SET summary = ? WHERE id = ?',
              ['Concurrent manual edit', owner.profileId],
            );
            locked();
            await continueEdit;
          });
          await lockHeld;
          const applying = host.apply(review.id, decisions(review)).then(
            (value) => ({ value }),
            (error) => ({ error }),
          );
          try {
            // Observe a real PostgreSQL lock wait instead of relying on a timer.
            let blocked = false;
            for (let attempt = 0; attempt < 200; attempt++) {
              const waiting = await control!.query(
                "SELECT pid FROM pg_stat_activity WHERE datname = ? AND wait_event_type = 'Lock' AND query LIKE '%candidate_profiles%'",
                [databaseName],
              );
              if (waiting.rows.length) {
                blocked = true;
                break;
              }
              await new Promise((resolve) => setTimeout(resolve, 10));
            }
            expect(blocked).toBe(true);
          } finally {
            release();
          }
          await editing;
          const result = await applying;
          expect(result).toHaveProperty('error');
          expect((await rows('candidate_profiles'))[0].summary).toBe(
            'Concurrent manual edit',
          );
          await second.close?.();
        },
      );

      it('production queued subject resolution binds the original receipt actor and profile', async () => {
        const review = await upload();
        expect(await resolveResumeImportReceiptSubject(db, review.id)).toEqual(
          owner,
        );
        await expect(
          resolveResumeImportReceiptSubject(db, randomUUID()),
        ).rejects.toThrow();
        const other = subject();
        await seedPrincipal(db, other);
        await db.query(
          'UPDATE candidate_profiles SET owner_user_id = ? WHERE id = ?',
          [other.userId, owner.profileId],
        );
        await expect(
          resolveResumeImportReceiptSubject(db, review.id),
        ).rejects.toThrow();
        expect(
          await exportResumeImportReceipts(db, {
            tenantId: owner.tenantId,
            userId: other.userId,
          }),
        ).toEqual([]);
        await db.query(
          'UPDATE candidate_profiles SET owner_user_id = ?, tenant_id = ? WHERE id = ?',
          [owner.userId, other.tenantId, owner.profileId],
        );
        await expect(
          resolveResumeImportReceiptSubject(db, review.id),
        ).rejects.toThrow();
      });

      it('production retention quarantines originals after the profile has been deleted', async () => {
        const review = await upload();
        await db.query('DELETE FROM candidate_profiles WHERE id = ?', [
          owner.profileId,
        ]);
        await db.query('UPDATE intake_items SET expires_at = ? WHERE id = ?', [
          '2000-01-01T00:00:00.000Z',
          review.id,
        ]);
        expect(await purgeExpiredResumeImportAssets(db)).toBe(1);
        expect((await rows('intake_items'))[0].visibility).toBe('expired');
        expect(await rows('assets')).toHaveLength(0);
      });

      it('production runtime exports and purges only the account owning each receipt profile', async () => {
        const ownReview = await upload();
        const ownEvidence = (await host.service.getEvidence(ownReview.id))[0];
        const other = subject();
        await seedPrincipal(db, other);
        const otherHost = await makeHost(other);
        const otherReview = await otherHost.receive({
          bytes: Buffer.from('%PDF-other-account'),
          filename: 'other.pdf',
          requestId: randomUUID(),
        });
        const otherEvidence = (
          await otherHost.service.getEvidence(otherReview.id)
        )[0];
        const exported = await exportResumeImportReceipts(db, owner);
        expect(exported.map((row) => row.id)).toEqual([ownReview.id]);
        expect(Object.keys(exported[0]).sort()).toEqual([
          'analysisRevision',
          'createdAt',
          'expiresAt',
          'id',
          'processingState',
          'receiptState',
          'visibility',
        ]);
        expect(
          (await exportResumeImportReceipts(db, other)).map((row) => row.id),
        ).toEqual([otherReview.id]);
        expect(
          await exportResumeImportReceipts(db, {
            tenantId: owner.tenantId,
            userId: other.userId,
          }),
        ).toEqual([]);
        const assetRoot = getIolausUserAssetsRoot();
        const files = async () => {
          const paths = await readdir(assetRoot, { recursive: true });
          return (
            await Promise.all(
              paths.map(async (path) => ({
                path,
                file: (await stat(join(assetRoot, path))).isFile(),
              })),
            )
          )
            .filter((entry) => entry.file)
            .map((entry) => entry.path);
        };
        const before = await files();
        expect(before.length).toBeGreaterThan(0);
        expect(
          await purgeResumeImportAccountData(db, {
            tenantId: owner.tenantId,
            userId: other.userId,
          }),
        ).toBe(0);
        await db.query('DELETE FROM candidate_profiles WHERE id = ?', [
          owner.profileId,
        ]);
        expect(await purgeResumeImportAccountData(db, owner)).toBe(1);
        await expect(
          host.service.readEvidence(ownReview.id, ownEvidence.id),
        ).rejects.toThrow();
        expect(
          Buffer.from(
            await otherHost.service.readEvidence(
              otherReview.id,
              otherEvidence.id,
            ),
          ).toString(),
        ).toBe('%PDF-other-account');
        expect((await files()).length).toBe(before.length);
        expect(await rows('resume_import_quarantines')).toHaveLength(1);
      });

      it.each([
        'deleted',
        'expired',
      ])('permits account deletion after a prewrite refusal to reupload an %s PDF', async (state) => {
        const received = await host.receive({
          bytes: Buffer.from('%PDF-prewrite-reupload'),
          filename: 'resume.pdf',
          requestId: randomUUID(),
        });
        if (state === 'deleted') await host.delete(received.id);
        else
          await db.query(
            'UPDATE intake_items SET expires_at = ? WHERE id = ?',
            ['2000-01-01T00:00:00.000Z', received.id],
          );
        await expect(
          host.receive({
            bytes: Buffer.from('%PDF-prewrite-reupload'),
            filename: 'resume.pdf',
            requestId: randomUUID(),
          }),
        ).rejects.toMatchObject({ code: 'expired_import' });
        expect(await rows('resume_import_write_operations')).toHaveLength(0);
        const result = await deleteAccount(owner, {
          database: db,
          dialect,
          environment: {
            IOLAUS_WORKSPACE_MODE: 'shared',
            SMRT_APP_ID: 'resume-delete-qa',
            SMRT_RUNTIME_PROFILE: 'self-hosted',
          },
          purgeResumeImports: async (executor, scope) =>
            await purgeResumeImportAccountData(
              executor as DatabaseInterface,
              scope,
            ),
        });
        expect(result.status).toBe('deleted');
        expect(await rows('users')).toHaveLength(0);
      });

      it('deletes an account with no imports without hosted provider configuration', async () => {
        vi.stubEnv('SMRT_RUNTIME_PROFILE', 'cloud');
        vi.stubEnv('IOLAUS_RESUME_IMPORT_STORAGE_JSON', undefined);
        const result = await deleteAccount(owner, {
          database: db,
          dialect,
          environment: {
            IOLAUS_WORKSPACE_MODE: 'shared',
            SMRT_APP_ID: 'resume-delete-qa',
            SMRT_RUNTIME_PROFILE: 'self-hosted',
          },
          purgeResumeImports: async (executor, scope) =>
            await purgeResumeImportAccountData(
              executor as DatabaseInterface,
              scope,
            ),
        });
        expect(result.status).toBe('deleted');
        expect(await rows('users')).toHaveLength(0);
      });

      it('drains a concurrent upload before account deletion and rejects uploads after a failed deletion starts', async () => {
        let signalEntered!: () => void;
        let releaseUpload!: () => void;
        const entered = new Promise<void>((resolve) => {
          signalEntered = resolve;
        });
        const released = new Promise<void>((resolve) => {
          releaseUpload = resolve;
        });
        const originalReceive = host.service.receive.bind(host.service);
        const receiveSpy = vi
          .spyOn(host.service, 'receive')
          .mockImplementation(async (input) => {
            signalEntered();
            await released;
            return await originalReceive(input);
          });
        const receiving = host.receive({
          bytes: Buffer.from('%PDF-concurrent-delete'),
          filename: 'resume.pdf',
          requestId: randomUUID(),
        });
        await entered;
        let recordCreated = false;
        let releasePurge!: () => void;
        const allowPurge = new Promise<void>((resolve) => {
          releasePurge = resolve;
        });
        let deletionRequested!: () => void;
        const requested = new Promise<void>((resolve) => {
          deletionRequested = resolve;
        });
        const deleting = (async () => {
          deletionRequested();
          return await deleteAccount(owner, {
            database: db,
            dialect,
            environment: {
              IOLAUS_WORKSPACE_MODE: 'shared',
              SMRT_APP_ID: 'resume-delete-qa',
              SMRT_RUNTIME_PROFILE: 'self-hosted',
            },
            purgeResumeImports: async (executor, scope) =>
              await purgeResumeImportAccountData(
                executor as DatabaseInterface,
                scope,
              ),
            afterPhase: async (phase) => {
              if (phase === 'record') {
                recordCreated = true;
                await allowPurge;
              }
            },
          });
        })();
        await requested;
        try {
          // Receive and the waiting deletion consume both max5 admissions.
          // A third owner is refused immediately, rather than queued on a pin.
          const independent = withResumeImportAccountFence(
            db,
            { ...owner, userId: randomUUID() },
            async () => {},
          );
          if (dialect === 'postgres')
            await expect(independent).rejects.toBeInstanceOf(
              ResumeImportLifecycleBusyError,
            );
          else await independent;
          expect(recordCreated).toBe(false);
        } finally {
          releaseUpload();
        }
        const uploaded = await receiving;
        receiveSpy.mockRestore();
        const evidence = (await host.service.getEvidence(uploaded.id))[0];
        const assetRoot = getIolausUserAssetsRoot();
        const privateFiles = (
          await readdir(assetRoot, { recursive: true })
        ).map((path) => join(assetRoot, path));
        const retainedFiles: string[] = [];
        for (const path of privateFiles)
          if ((await stat(path)).isFile()) retainedFiles.push(path);
        expect(retainedFiles.length).toBeGreaterThan(0);
        releasePurge();
        await expect(deleting).resolves.toMatchObject({ status: 'deleted' });
        for (const path of retainedFiles)
          expect((await stat(path)).isFile()).toBe(true);
        const quarantines = await rows('resume_import_quarantines');
        expect(quarantines).toHaveLength(1);
        const quarantine = quarantines[0];
        expect(
          await recoverQuarantinedResumeOriginal({
            db,
            storage: { type: 'local', basePath: assetRoot },
            quarantineId: String(quarantine.id),
            authority: {
              tenantId: owner.tenantId,
              actorId: 'test-operator',
              destinationAuthority: 'verified-deleted-owner-export',
              reason: 'explicit test rescue',
            },
            authorize: async () => true,
          }),
        ).toEqual(Buffer.from('%PDF-concurrent-delete'));
        expect(
          await purgeQuarantinedResumeOriginals(
            db,
            { type: 'local', basePath: assetRoot },
            {
              // PostgreSQL returns Date; String(Date) discards milliseconds and
              // can move this exact-boundary fixture before its real deadline.
              now:
                quarantine.purge_after instanceof Date
                  ? quarantine.purge_after
                  : new Date(String(quarantine.purge_after)),
            },
          ),
        ).toEqual({ purged: 1, failed: 0, pendingWrites: 0 });
        for (const path of retainedFiles)
          await expect(stat(path)).rejects.toThrow();
        expect(await rows('resume_import_quarantines')).toHaveLength(1);
        await expect(
          host.service.readEvidence(uploaded.id, evidence.id),
        ).rejects.toThrow();
        await expect(
          host.receive({
            bytes: Buffer.from('%PDF-after-delete'),
            filename: 'resume.pdf',
            requestId: randomUUID(),
          }),
        ).rejects.toThrow();

        const other = subject();
        await seedPrincipal(db, other);
        const otherHost = await makeHost(other);
        await expect(
          deleteAccount(other, {
            database: db,
            dialect,
            environment: {
              IOLAUS_WORKSPACE_MODE: 'shared',
              SMRT_APP_ID: 'resume-delete-qa',
              SMRT_RUNTIME_PROFILE: 'self-hosted',
            },
            purgeResumeImports: async () => {
              throw new Error('Storage unavailable');
            },
          }),
        ).rejects.toThrow('Storage unavailable');
        await expect(
          otherHost.receive({
            bytes: Buffer.from('%PDF-after-failed-delete'),
            filename: 'resume.pdf',
            requestId: randomUUID(),
          }),
        ).rejects.toThrow('Account deletion has started');
        expect(
          (await rows('intake_items')).filter(
            (row) => row.tenant_id === other.tenantId,
          ),
        ).toHaveLength(0);
      });

      it('production runtime retention quarantines expired originals even after native account suspension', async () => {
        const review = await upload();
        const evidence = (await host.service.getEvidence(review.id))[0];
        await db.query('UPDATE users SET status = ? WHERE id = ?', [
          'suspended',
          owner.userId,
        ]);
        await db.query('UPDATE intake_items SET expires_at = ? WHERE id = ?', [
          '2000-01-01T00:00:00.000Z',
          review.id,
        ]);
        expect(await purgeExpiredResumeImportAssets(db)).toBe(1);
        await expect(
          host.service.readEvidence(review.id, evidence.id),
        ).rejects.toThrow();
        expect((await rows('intake_items'))[0].visibility).toBe('expired');
        expect(await purgeExpiredResumeImportAssets(db)).toBe(0);
        expect(await rows('assets')).toHaveLength(0);
      });

      it.runIf(dialect === 'sqlite')(
        'production queued job reconstructs receipt ownership under a real TaskRunner context',
        async () => {
          // Keep only the external PDF/AI boundary deterministic. The receipt,
          // dispatch, principal reconstruction, processing and progress are native.
          const extractor = await import('./resume-import-extraction.js');
          const extraction = vi
            .spyOn(extractor, 'extractResumeImport')
            .mockImplementation(async (input) => {
              await input.authorize();
              await input.onProgress?.('reading_pdf');
              await input.onProgress?.('extracting_details');
              return {
                entries: structuredClone(entries),
                warnings: [],
                provider: 'deterministic-test',
                model: 'fixture',
                version: '1',
              };
            });
          const review = await host.receive({
            bytes: Buffer.from('%PDF-1.4\nqueued-fixture'),
            filename: 'resume.pdf',
            requestId: randomUUID(),
          });
          expect(review.status).toBe('processing');
          const runner = new TaskRunner({
            queues: [RESUME_IMPORT_INGESTION_QUEUE],
            concurrency: 1,
            pollInterval: 10,
            idlePollInterval: 50,
            heartbeatInterval: 50,
            leaseTickMs: 50,
            leaseTtlMs: 500,
            shutdownTimeout: 1000,
            retention: false,
          });
          await runner.initialize(db);
          try {
            const terminal = new Promise<{
              job: SmrtJob;
              result?: unknown;
              error?: Error;
            }>((resolve, reject) => {
              const timer = setTimeout(
                () => reject(new Error('Native resume job did not finish')),
                15_000,
              );
              runner.once('job:completed', (job, result) => {
                clearTimeout(timer);
                resolve({ job, result });
              });
              runner.once('job:failed', (job, error) => {
                clearTimeout(timer);
                resolve({ job, error });
              });
            });
            await runner.start();
            const result = await terminal;
            expect(result.error).toBeUndefined();
            expect(result.job.tenantId).toBe(owner.tenantId);
            expect(result.result).toMatchObject({
              result: { id: review.id, status: 'review' },
            });
            expect(extraction).toHaveBeenCalledTimes(1);
            const progress = await db.query(
              'SELECT stage FROM _smrt_job_events WHERE job_id=? AND tenant_id=?',
              [result.job.id, owner.tenantId],
            );
            expect(progress.rows.map((row) => row.stage)).toEqual(
              expect.arrayContaining([
                'reading_pdf',
                'extracting_details',
                'matching',
              ]),
            );
          } finally {
            await runner.stop();
            extraction.mockRestore();
          }
        },
      );

      it('expires retained source evidence through the native repair sweep', async () => {
        const review = await upload();
        const evidence = (await host.service.getEvidence(review.id))[0];
        clock = new Date(clock.getTime() + 31 * 24 * 60 * 60 * 1000);
        await host.repair();
        await expect(
          host.service.readEvidence(review.id, evidence.id),
        ).rejects.toThrow();
        await expect(
          host.apply(review.id, decisions(review)),
        ).rejects.toThrow();
        expect(await rows('experiences')).toHaveLength(0);
      });
    },
  );
}
