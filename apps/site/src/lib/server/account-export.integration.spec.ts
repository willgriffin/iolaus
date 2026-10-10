import { randomUUID } from 'node:crypto';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { withTenant } from '@happyvertical/smrt-tenancy';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACCOUNT_EXPORT_FORMAT,
  accountExportFilename,
  accountExportSections,
  buildAccountExport,
  SCREENING_QUESTION_CATEGORY,
  unexportedOwnershipClasses,
} from './account-export';
import { insert } from './fixtures/account-seed.js';
import './smrt.js';
import type { PublicOpportunity } from '$lib/public-opportunity-contract.js';
import { createShortlistStore } from './shortlist-store.js';

type TestDatabase = Awaited<ReturnType<typeof getTestDatabase>>;

interface Principal {
  email: string;
  profileId: string;
  tenantId: string;
  userId: string;
}

const principal = (label: string): Principal => ({
  email: `${label}@example.invalid`,
  profileId: randomUUID(),
  tenantId: randomUUID(),
  userId: randomUUID(),
});

async function seed(db: TestDatabase, who: Principal, tag: string) {
  const own = {
    candidate_profile_id: who.profileId,
    owner_user_id: who.userId,
    tenant_id: who.tenantId,
  };
  await insert(db, 'candidate_profiles', {
    id: who.profileId,
    owner_user_id: who.userId,
    profile_key: 'default',
    tenant_id: who.tenantId,
    name: `${tag} profile`,
  });
  await insert(db, 'achievements', { ...own, title: `${tag} achievement` });
  await insert(db, 'applications', { ...own, notes: `${tag} application` });
  await insert(db, 'decisions', { ...own, reason: `${tag} decision` });
  await insert(db, 'candidate_answers', {
    ...own,
    label: `${tag} question`,
    label_key: `${tag}-question`,
    value: `${tag} answer`,
  });
  await insert(db, 'preference_rules', {
    ...own,
    category: 'work_style',
    name: `${tag} preference`,
  });
  await insert(db, 'preference_rules', {
    ...own,
    category: SCREENING_QUESTION_CATEGORY,
    name: `${tag} screening question`,
  });
  const assetId = randomUUID();
  await insert(db, 'resume_assets', {
    ...own,
    id: assetId,
    markdown_path: `generated-resumes/${assetId}/resume.md`,
    pdf_path: `generated-resumes/${assetId}/resume.pdf`,
    title: `${tag} resume`,
  });
  return assetId;
}

const classes = [
  ...new Set(Object.values(accountExportSections).flat()),
  'AdminAssistantTurn',
  'ShortlistEntryRecord',
  'ShortlistMutationReceipt',
];

describe('account export', () => {
  let db: TestDatabase | undefined;
  afterEach(async () => {
    await db?.close?.();
    db = undefined;
  });

  it('lists every candidate-owned class in the ownership manifest', () => {
    expect(unexportedOwnershipClasses()).toEqual([]);
  });

  it('exports only the signed-in user workspace: no other tenant, owner or profile', async () => {
    db = await getTestDatabase({ classes });
    const alice = principal('alice');
    const bob = principal('bob');
    const aliceAsset = await seed(db, alice, 'ALICE');
    await seed(db, bob, 'BOB');
    // A same-tenant row stamped for a different owner, and a second profile of
    // the same owner: neither may appear in the default-profile export.
    await insert(db, 'achievements', {
      candidate_profile_id: alice.profileId,
      owner_user_id: bob.userId,
      tenant_id: alice.tenantId,
      title: 'FOREIGN OWNER IN ALICE TENANT',
    });
    await insert(db, 'achievements', {
      candidate_profile_id: randomUUID(),
      owner_user_id: alice.userId,
      tenant_id: alice.tenantId,
      title: 'ALICE OTHER PROFILE',
    });

    const result = await withTenant(
      { tenantId: alice.tenantId, userId: alice.userId },
      async () =>
        await buildAccountExport(
          {
            profileId: alice.profileId,
            tenantId: alice.tenantId,
            userId: alice.userId,
          },
          { email: alice.email },
          {
            db,
            filesystem: {
              exists: async (path: string) => path.endsWith('.pdf'),
            },
            now: () => new Date('2026-10-06T00:00:00Z'),
            origin: 'https://app.example/',
          },
        ),
    );

    expect(result.format).toBe(ACCOUNT_EXPORT_FORMAT);
    expect(result.exportedAt).toBe('2026-10-06T00:00:00.000Z');
    expect(result.account.email).toBe(alice.email);
    expect(result.counts.Achievement).toBe(1);
    expect(result.counts.Application).toBe(1);
    expect(result.counts.Decision).toBe(1);
    expect(result.counts.CandidateAnswer).toBe(1);
    expect(result.counts.ResumeAsset).toBe(1);
    expect(result.counts.CandidateProfile).toBe(1);
    expect(result.publicProfile).toBeNull();

    // Screening questions are split out of the preference rules.
    expect(result.screeningQuestions).toHaveLength(1);
    expect(JSON.stringify(result.screeningQuestions)).toContain(
      'ALICE screening question',
    );
    expect(
      result.sections.preferences.PreferenceRule.map((rule) => rule.name),
    ).toEqual(['ALICE preference']);

    // Asset manifest and download link.
    expect(result.assets).toEqual([
      {
        downloadPath: `https://app.example/admin/resume-assets/${aliceAsset}/pdf`,
        files: [
          {
            kind: 'pdf',
            path: `generated-resumes/${aliceAsset}/resume.pdf`,
            present: true,
          },
          {
            kind: 'markdown',
            path: `generated-resumes/${aliceAsset}/resume.md`,
            present: false,
          },
        ],
        id: aliceAsset,
        recordType: 'ResumeAsset',
        title: 'ALICE resume',
      },
    ]);

    const serialised = JSON.stringify(result);
    expect(serialised).toContain('ALICE achievement');
    for (const leaked of [
      'BOB',
      bob.email,
      bob.userId,
      bob.tenantId,
      bob.profileId,
      'FOREIGN OWNER',
      'ALICE OTHER PROFILE',
    ]) {
      expect(serialised, `leaked ${leaked}`).not.toContain(leaked);
    }
  });

  it('exports only the authenticated owner publication settings, history, and private artifact manifest', async () => {
    db = await getTestDatabase({ classes });
    const alice = principal('alice');
    const bob = principal('bob');
    await seed(db, alice, 'ALICE');
    await seed(db, bob, 'BOB');
    const alicePath = `public-profiles/alice/revision/resume.pdf`;
    const result = await withTenant(
      { tenantId: alice.tenantId, userId: alice.userId },
      async () =>
        await buildAccountExport(
          alice,
          { email: alice.email },
          {
            db,
            publicProfileExport: async (owner) => {
              if (
                owner.tenantId !== alice.tenantId ||
                owner.userId !== alice.userId
              )
                return null;
              return {
                identity: {
                  candidateProfileId: alice.profileId,
                  currentRevisionId: 'revision',
                  deletedAt: null,
                  handle: 'alice-public',
                  revision: 2,
                },
                revisions: [
                  {
                    baseRevision: 1,
                    createdAt: '2026-10-06T00:00:00.000Z',
                    id: 'revision',
                    pdfBytes: 123,
                    pdfPath: alicePath,
                    pdfSha256: 'a'.repeat(64),
                    publishedRevision: 2,
                    snapshot: { name: 'Alice', version: 1 },
                    sourceProfileId: alice.profileId,
                    status: 'published',
                  },
                ],
              };
            },
          },
        ),
    );
    expect(result.publicProfile).toMatchObject({
      identity: { handle: 'alice-public', revision: 2 },
      revisions: [{ pdfPath: alicePath, status: 'published' }],
    });
    const serialised = JSON.stringify(result.publicProfile);
    expect(serialised).not.toContain(bob.userId);
    expect(serialised).not.toContain(bob.tenantId);
    expect(serialised).not.toContain('BOB');
  });

  it('returns an empty, well-formed export for a user with no profile yet', async () => {
    db = await getTestDatabase({ classes });
    const alice = principal('alice');
    await seed(db, alice, 'ALICE');
    const result = await withTenant(
      { tenantId: alice.tenantId, userId: alice.userId },
      async () =>
        await buildAccountExport(
          { tenantId: alice.tenantId, userId: alice.userId },
          { email: alice.email },
          { db },
        ),
    );
    expect(result.counts.Achievement).toBe(0);
    expect(result.assets).toEqual([]);
    expect(result.screeningQuestions).toEqual([]);
  });

  it.each([
    false,
    true,
  ])('exports account-wide shortlist with profile=%s without other owners or receipts', async (withProfile) => {
    db = await getTestDatabase({ classes });
    const alice = principal('alice');
    const bob = principal('bob');
    const store = createShortlistStore(db);
    const opportunity: PublicOpportunity = {
      id: 'opportunity-1',
      title: 'Alice saved role',
      normalized_title: 'role',
      company: null,
      location: { text: '', countries: [], remote: true, timezones: [] },
      seniority: 'mid',
      function: 'engineering',
      employment_type: 'full_time',
      work_mode: 'remote',
      skills: { required: [], preferred: [] },
      compensation: null,
      posted_at: null,
      updated_at: '2026-10-08T00:00:00.000Z',
      expires_at: null,
      analysis_version: 'v1',
      source_content_version: 1,
      posting_url: 'https://example.test/jobs/1',
      url: 'https://example.test/opportunities/1',
    };
    const mutationId = randomUUID();
    await store.mutate(
      alice,
      {
        mutationId,
        opportunityId: opportunity.id,
        expectedRevision: 0,
        decision: 'saved',
        opened: true,
      },
      opportunity,
    );
    for (const other of [
      bob,
      { ...bob, tenantId: alice.tenantId },
      { ...alice, tenantId: bob.tenantId },
    ]) {
      await store.mutate(
        other,
        {
          mutationId: randomUUID(),
          opportunityId: opportunity.id,
          expectedRevision: 0,
          decision: 'later',
        },
        { ...opportunity, title: 'FOREIGN shortlist' },
      );
    }
    const result = await withTenant(
      { tenantId: alice.tenantId, userId: alice.userId },
      () =>
        buildAccountExport(
          {
            tenantId: alice.tenantId,
            userId: alice.userId,
            ...(withProfile ? { profileId: alice.profileId } : {}),
          },
          { email: alice.email },
          { db, shortlistExport: (owner) => store.list(owner) },
        ),
    );
    expect(result.shortlist).toHaveLength(1);
    expect(result.shortlist[0]).toMatchObject({
      decision: 'saved',
      opportunity: { title: 'Alice saved role' },
    });
    expect(result.shortlist[0].openedAt).not.toBeNull();
    expect(result.counts.ShortlistEntryRecord).toBe(1);
    expect(JSON.stringify(result)).not.toContain('FOREIGN');
    expect(JSON.stringify(result)).not.toContain(mutationId);
    expect(JSON.stringify(result)).not.toContain('requestFingerprint');
  });

  it('names the download without any personal data', () => {
    expect(accountExportFilename(new Date('2026-10-06T12:00:00Z'))).toBe(
      'iolaus-export-2026-10-06.json',
    );
  });
});
