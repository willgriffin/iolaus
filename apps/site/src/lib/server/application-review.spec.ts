import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  approveApplicationForSubmission,
  finalApplicationApprovalMaterialsAreCurrent,
  loadApplicationReviewPageData,
  markApplicationMaterialReviewed,
  requestApplicationMaterialTweaks,
} from './application-review';

type MockRecord = Record<string, unknown> & {
  id: string;
  save: ReturnType<typeof vi.fn>;
};

function record(data: Record<string, unknown>): MockRecord {
  return {
    id: String(data.id ?? 'record-1'),
    save: vi.fn(async () => {}),
    ...data,
  } as MockRecord;
}

function collection(records: MockRecord[] = []) {
  const api = {
    create: vi.fn(async (payload: Record<string, unknown>) => {
      const created = record({
        id: `created-${records.length + 1}`,
        ...payload,
      });
      records.push(created);
      return created;
    }),
    get: vi.fn(
      async (id: string) => records.find((item) => item.id === id) ?? null,
    ),
    list: vi.fn(async ({ where }: { where?: Record<string, unknown> } = {}) => {
      if (!where) return records;
      return records.filter((item) =>
        Object.entries(where).every(([key, value]) => item[key] === value),
      );
    }),
    records,
  };
  return api;
}

const mocks = vi.hoisted(() => ({
  collections: new Map<string, ReturnType<typeof collection>>(),
  databaseUpdate: vi.fn(async () => ({ affected: 1 })),
  exists: vi.fn<(path: string) => Promise<boolean>>(async () => true),
  read: vi.fn<
    (path: string, options?: { raw?: boolean }) => Promise<string | Buffer>
  >(async () => '# Material'),
  maybeEnqueueAutoSubmitOnApproval: vi.fn(async () => ({ enqueued: false })),
  recordAgentAudit: vi.fn(async () => ({})),
  syncApplicationWorkflowTasks: vi.fn(async () => ({ created: 1 })),
  write: vi.fn(async () => {}),
}));

vi.mock('@happyvertical/smrt-core', () => ({
  resolveDatabase: vi.fn(async () => ({ update: mocks.databaseUpdate })),
}));

vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(async (className: string) => {
    const found = mocks.collections.get(className);
    if (!found) throw new Error(`Missing collection ${className}`);
    return found;
  }),
}));

vi.mock('./resume-files.js', () => ({
  CURRENT_RESUME_PDF_BASENAME: 'resume.pdf',
  PUBLIC_RESUME_PDF_FILENAME: 'resume.pdf',
  getResumeFilesystem: vi.fn(async () => ({
    exists: mocks.exists,
    read: mocks.read,
    write: mocks.write,
  })),
}));

vi.mock('./application-workflow.js', () => ({
  recordAgentAudit: mocks.recordAgentAudit,
  recordApplicationSubmission: vi.fn(async () => ({})),
  recordApplicationSubmissionBlocker: vi.fn(async () => ({})),
  syncApplicationWorkflowTasks: mocks.syncApplicationWorkflowTasks,
}));

vi.mock('./auto-submit-application-job.js', () => ({
  maybeEnqueueAutoSubmitOnApproval: mocks.maybeEnqueueAutoSubmitOnApproval,
}));

async function expectHttpError(
  action: () => Promise<unknown>,
  message: string,
) {
  let thrown: unknown;
  try {
    await action();
  } catch (error) {
    thrown = error;
  }

  expect(thrown).toMatchObject({ body: { message }, status: 400 });
}

describe('application review materials', () => {
  beforeEach(() => {
    mocks.collections.clear();
    mocks.databaseUpdate.mockClear();
    mocks.databaseUpdate.mockResolvedValue({ affected: 1 });
    mocks.exists.mockReset();
    mocks.exists.mockResolvedValue(true);
    mocks.read.mockReset();
    mocks.read.mockResolvedValue('# Material');
    mocks.maybeEnqueueAutoSubmitOnApproval.mockClear();
    mocks.recordAgentAudit.mockClear();
    mocks.write.mockClear();
    mocks.syncApplicationWorkflowTasks.mockClear();
    mocks.collections.set('ApplicationMaterialComment', collection());
    mocks.collections.set('AgentRun', collection());
    mocks.collections.set('Company', collection());
    mocks.collections.set('Opportunity', collection());
    mocks.collections.set('ResumeVariant', collection());
    mocks.collections.set('Task', collection());
  });

  it('clones reused resume assets into application-owned derivatives before review', async () => {
    const applications = collection([
      record({
        id: 'app-1',
        opportunityId: '',
        resumeAssetId: 'resume-global',
        status: 'awaiting_user',
      }),
    ]);
    const assets = collection([
      record({
        applicationId: '',
        assetType: 'resume',
        id: 'resume-global',
        markdownPath: 'published/resume.md',
        pdfBasename: 'canonical-resume.pdf',
        pdfPath: 'published/resume.pdf',
        title: 'Published resume',
      }),
    ]);
    mocks.collections.set('Application', applications);
    mocks.collections.set('ResumeAsset', assets);

    const data = await loadApplicationReviewPageData('app-1');

    const clonedAsset = assets.records.find(
      (asset) => asset.id !== 'resume-global',
    );
    expect(clonedAsset).toMatchObject({
      applicationId: 'app-1',
      pdfBasename: 'canonical-resume.pdf',
      pdfPath: `application-packages/app-1/resume-${clonedAsset?.id}.pdf`,
      sourceAssetId: 'resume-global',
      title: 'Published resume',
    });
    expect(applications.records[0]).toMatchObject({
      resumeAssetId: clonedAsset?.id,
    });
    expect(mocks.write).toHaveBeenCalledWith(
      expect.stringContaining('application-packages/app-1/resume-'),
      '# Material',
      { createParents: true },
    );
    expect(
      data.materials.find((item) => item.materialType === 'resume'),
    ).toMatchObject({
      body: '# Material',
      materialRecordId: clonedAsset?.id,
      pdfHref: `/admin/resume-assets/${clonedAsset?.id}/pdf`,
    });
    expect(data.materials.map((item) => item.materialType)).not.toContain(
      'resume_variant',
    );
    expect(data.preflight).toEqual({ requiresOverride: false });
  });

  it('projects an inconclusive posting check as an owner-override requirement', async () => {
    const applications = collection([
      record({
        id: 'app-1',
        opportunityId: 'opportunity-1',
        resumeAssetId: 'resume-global',
        status: 'awaiting_user',
      }),
    ]);
    const assets = collection([
      record({
        applicationId: '',
        assetType: 'resume',
        id: 'resume-global',
        markdownPath: 'published/resume.md',
        title: 'Published resume',
      }),
    ]);
    mocks.collections.set('Application', applications);
    mocks.collections.set(
      'Opportunity',
      collection([record({ id: 'opportunity-1' })]),
    );
    mocks.collections.set('ResumeAsset', assets);
    mocks.collections.set(
      'AgentRun',
      collection([
        record({
          id: 'preflight-run-1',
          opportunityId: 'opportunity-1',
          outputJson: JSON.stringify({
            evidence: { checkedAt: '2026-09-04T12:00:00.000Z' },
            outcome: 'inconclusive',
          }),
          runType: 'posting_preflight',
        }),
      ]),
    );

    const data = await loadApplicationReviewPageData('app-1');

    expect(data.preflight).toEqual({ requiresOverride: true });
  });

  it('backfills missing pdf artifacts on existing application resume assets', async () => {
    const applications = collection([
      record({
        id: 'app-1',
        opportunityId: '',
        resumeAssetId: 'resume-app',
        status: 'awaiting_user',
      }),
    ]);
    const appAsset = record({
      applicationId: 'app-1',
      assetType: 'resume',
      id: 'resume-app',
      markdownPath: 'application-packages/app-1/resume.md',
      sourceAssetId: 'resume-global',
      title: 'Application resume',
    });
    const assets = collection([
      record({
        applicationId: '',
        assetType: 'resume',
        id: 'resume-global',
        pdfBasename: 'canonical-resume.pdf',
        pdfPath: 'published/resume.pdf',
        title: 'Published resume',
      }),
      appAsset,
    ]);
    mocks.collections.set('Application', applications);
    mocks.collections.set('ResumeAsset', assets);

    const data = await loadApplicationReviewPageData('app-1');

    expect(appAsset).toMatchObject({
      generatedPath: 'application-packages/app-1/resume-resume-app',
      pdfBasename: 'canonical-resume.pdf',
      pdfPath: 'application-packages/app-1/resume-resume-app.pdf',
    });
    expect(appAsset.save).toHaveBeenCalled();
    expect(assets.records).toHaveLength(2);
    expect(
      data.materials.find((item) => item.materialType === 'resume'),
    ).toMatchObject({
      materialRecordId: 'resume-app',
      pdfHref: '/admin/resume-assets/resume-app/pdf',
    });
  });

  it('recovers canonical resume pdfs when an application asset source id is stale', async () => {
    const applications = collection([
      record({
        id: 'app-1',
        opportunityId: '',
        resumeAssetId: 'resume-app',
        resumeMode: 'default',
        status: 'awaiting_user',
      }),
    ]);
    const appAsset = record({
      applicationId: 'app-1',
      assetType: 'resume',
      generatedPath: 'application-packages/app-1/resume-resume-app',
      id: 'resume-app',
      outputSlug: 'canonical',
      sourceAssetId: 'missing-source',
      title: 'Resume - Canonical resume',
    });
    const assets = collection([
      record({
        applicationId: '',
        assetType: 'resume',
        htmlPath: 'generated-resumes/legacy-current/resume.html',
        id: 'canonical-source',
        markdownPath: 'generated-resumes/legacy-current/resume.md',
        pdfBasename: 'resume.pdf',
        pdfPath: 'generated-resumes/legacy-current/resume.pdf',
        textPath: 'generated-resumes/legacy-current/resume.txt',
        title: 'Resume - canonical',
      }),
      appAsset,
    ]);
    mocks.collections.set('Application', applications);
    mocks.collections.set('ResumeAsset', assets);

    const data = await loadApplicationReviewPageData('app-1');

    expect(appAsset).toMatchObject({
      htmlPath: 'application-packages/app-1/resume-resume-app.html',
      markdownPath: 'application-packages/app-1/resume-resume-app.md',
      pdfBasename: 'resume.pdf',
      pdfPath: 'application-packages/app-1/resume-resume-app.pdf',
      textPath: 'application-packages/app-1/resume-resume-app.txt',
    });
    expect(appAsset.save).toHaveBeenCalled();
    expect(
      data.materials.find((item) => item.materialType === 'resume'),
    ).toMatchObject({
      materialRecordId: 'resume-app',
      pdfHref: '/admin/resume-assets/resume-app/pdf',
    });
  });

  it('recovers an application-owned resume when the stored default asset id is stale', async () => {
    const applications = collection([
      record({
        id: 'app-1',
        opportunityId: '',
        resumeAssetId: 'missing-canonical',
        resumeMode: 'default',
        status: 'awaiting_user',
      }),
    ]);
    const appAsset = record({
      applicationId: 'app-1',
      assetType: 'resume',
      id: 'resume-app',
      markdownPath: 'application-packages/app-1/resume-resume-app.md',
      pdfBasename: 'canonical-resume.pdf',
      pdfPath: 'application-packages/app-1/resume-resume-app.pdf',
      sourceAssetId: 'missing-canonical',
      title: 'Resume - Canonical resume',
    });
    const assets = collection([appAsset]);
    mocks.collections.set('Application', applications);
    mocks.collections.set('ResumeAsset', assets);

    const data = await loadApplicationReviewPageData('app-1');

    expect(applications.records[0]).toMatchObject({
      resumeAssetId: 'resume-app',
    });
    expect(mocks.databaseUpdate).toHaveBeenCalledWith(
      'applications',
      expect.objectContaining({
        id: 'app-1',
        resume_asset_id: 'missing-canonical',
      }),
      expect.objectContaining({ resume_asset_id: 'resume-app' }),
    );
    expect(assets.create).not.toHaveBeenCalled();
    expect(
      data.materials.find((item) => item.materialType === 'resume'),
    ).toMatchObject({
      body: '# Material',
      materialRecordId: 'resume-app',
      pdfHref: '/admin/resume-assets/resume-app/pdf',
    });
  });

  it('does not expose resume variants as separate review materials', async () => {
    const applications = collection([
      record({
        id: 'app-1',
        opportunityId: '',
        resumeAssetId: 'resume-app',
        resumeVariantId: 'variant-1',
        status: 'awaiting_user',
      }),
    ]);
    const assets = collection([
      record({
        applicationId: 'app-1',
        assetType: 'resume',
        id: 'resume-app',
        pdfPath: 'application-packages/app-1/resume.pdf',
        title: 'Generated resume',
      }),
    ]);
    const variants = collection([
      record({
        applicationId: 'app-1',
        id: 'variant-1',
        name: 'Internal tailoring record',
        pdfPath: 'application-packages/app-1/variant.pdf',
      }),
    ]);
    mocks.collections.set('Application', applications);
    mocks.collections.set('ResumeAsset', assets);
    mocks.collections.set('ResumeVariant', variants);

    const data = await loadApplicationReviewPageData('app-1');

    expect(data.materials.map((item) => item.materialType)).toEqual([
      'packet',
      'resume',
      'cover_letter',
      'answers',
    ]);
    expect(
      data.materials.find((item) => item.materialType === 'resume'),
    ).toMatchObject({
      materialRecordId: 'resume-app',
      pdfHref: '/admin/resume-assets/resume-app/pdf',
      title: 'Generated resume',
    });
  });

  it('labels an unrequested cover letter as not required instead of an empty artifact', async () => {
    const applications = collection([
      record({
        coverLetterMode: 'none',
        id: 'app-1',
        opportunityId: '',
        status: 'awaiting_user',
      }),
    ]);
    mocks.collections.set('Application', applications);
    mocks.collections.set('ResumeAsset', collection());

    const data = await loadApplicationReviewPageData('app-1');
    const coverLetter = data.materials.find(
      (material) => material.materialType === 'cover_letter',
    );

    expect(coverLetter).toMatchObject({
      availability: 'not_required',
      body: 'No cover letter is required for this application.',
      notice: 'No cover letter is required for this application.',
    });

    const form = new FormData();
    form.set('materialType', 'cover_letter');
    await expectHttpError(
      () =>
        markApplicationMaterialReviewed(
          'app-1',
          new Request('http://localhost/admin/applications/app-1', {
            body: form,
            method: 'POST',
          }),
          { id: 'user-1' },
        ),
      'No cover letter is required for this application.',
    );
  });

  it('does not allow final approval when a requested cover letter is missing', async () => {
    const applications = collection([
      record({
        coverLetterMode: 'generate',
        id: 'app-1',
        opportunityId: '',
        resumeAssetId: 'resume-app',
        status: 'awaiting_user',
      }),
    ]);
    mocks.collections.set('Application', applications);
    mocks.collections.set(
      'ResumeAsset',
      collection([
        record({
          applicationId: 'app-1',
          assetType: 'resume',
          id: 'resume-app',
          pdfPath: 'resume.pdf',
        }),
      ]),
    );

    const form = new FormData();
    form.set('finalSubmissionIntent', 'final_submission');
    await expectHttpError(
      () =>
        approveApplicationForSubmission(
          'app-1',
          new Request('http://localhost/admin/applications/app-1', {
            body: form,
            method: 'POST',
          }),
          { id: 'user-1' },
        ),
      'Final submission approval requires a readable requested cover letter.',
    );
    expect(mocks.recordAgentAudit).not.toHaveBeenCalled();
  });

  it('does not mistake cover-letter metadata for a readable review artifact', async () => {
    const applications = collection([
      record({
        coverLetterAssetId: 'cover-app',
        coverLetterMode: 'generate',
        id: 'app-1',
        opportunityId: '',
        resumeAssetId: 'resume-app',
        status: 'awaiting_user',
      }),
    ]);
    mocks.collections.set('Application', applications);
    mocks.collections.set(
      'ResumeAsset',
      collection([
        record({
          applicationId: 'app-1',
          assetType: 'resume',
          id: 'resume-app',
          pdfPath: 'resume.pdf',
        }),
        record({
          applicationId: 'app-1',
          assetType: 'cover_letter',
          id: 'cover-app',
          markdownPath: 'application-packages/app-1/cover-letter.md',
          notes: JSON.stringify({
            aiGenerated: true,
            model: 'writing-model',
          }),
          pdfPath: 'cover-letter.pdf',
        }),
      ]),
    );
    mocks.exists.mockImplementation(
      async (path: string) => path === 'resume.pdf',
    );
    mocks.read.mockImplementation(async () => Buffer.from('%PDF-1.4'));

    const data = await loadApplicationReviewPageData('app-1');
    expect(
      data.materials.find(
        (material) => material.materialType === 'cover_letter',
      ),
    ).toMatchObject({
      availability: 'needs_attention',
      body: expect.stringContaining('no reviewable artifact'),
    });

    const form = new FormData();
    form.set('finalSubmissionIntent', 'final_submission');
    await expectHttpError(
      () =>
        approveApplicationForSubmission(
          'app-1',
          new Request('http://localhost/admin/applications/app-1', {
            body: form,
            method: 'POST',
          }),
          { id: 'user-1' },
        ),
      'Final submission approval requires a readable requested cover letter.',
    );
  });

  it('loads review data when direct application lookup misses a serialized id', async () => {
    const applications = collection([
      record({
        applicationInstructions: 'Review the packet.',
        id: 'sample-application-packet',
        opportunityId: '',
        status: 'awaiting_user',
      }),
    ]);
    applications.get.mockResolvedValueOnce(null);
    mocks.collections.set('Application', applications);
    mocks.collections.set('ResumeAsset', collection());

    const data = await loadApplicationReviewPageData(
      'sample-application-packet',
    );

    expect(data.application).toMatchObject({
      id: 'sample-application-packet',
      status: 'awaiting_user',
    });
    const answersMaterial = data.materials.find(
      (item) => item.materialType === 'answers',
    );
    expect(answersMaterial).toMatchObject({
      materialRecordId: 'sample-application-packet',
    });
    expect(answersMaterial?.body).toContain('Instructions: Review the packet.');
    // The fingerprint digest closes the gap between the readable rendering
    // and the exact stored schema/answers payloads.
    expect(answersMaterial?.body).toMatch(
      /Answers fingerprint digest: [0-9a-f]{64}$/,
    );
    expect(applications.list).toHaveBeenCalledWith({
      limit: 1000,
      orderBy: 'updated_at DESC',
    });
  });

  it('saves material comments and moves applications back to drafting for tweaks', async () => {
    const applications = collection([
      record({
        approvedAt: new Date('2026-06-01T00:00:00.000Z'),
        approvedByUserId: 'user-old',
        id: 'app-1',
        resumeAssetId: 'resume-app',
        status: 'awaiting_user',
      }),
    ]);
    const assets = collection([
      record({
        applicationId: 'app-1',
        assetType: 'resume',
        id: 'resume-app',
        markdownPath: 'application-packages/app-1/resume.md',
        title: 'Application resume',
      }),
    ]);
    const comments = collection();
    mocks.collections.set('Application', applications);
    mocks.collections.set('ApplicationMaterialComment', comments);
    mocks.collections.set('ResumeAsset', assets);

    const form = new FormData();
    form.set('comment:resume', 'Tighten the opening summary.');
    const request = new Request('http://localhost/admin/applications/app-1', {
      body: form,
      method: 'POST',
    });

    await requestApplicationMaterialTweaks('app-1', request, { id: 'user-1' });

    expect(comments.records[0]).toMatchObject({
      applicationId: 'app-1',
      body: 'Tighten the opening summary.',
      materialRecordId: 'resume-app',
      materialType: 'resume',
      reviewerUserId: 'user-1',
      status: 'open',
    });
    expect(applications.records[0]).toMatchObject({
      approvedAt: null,
      approvedByUserId: '',
      status: 'application_drafting',
    });
    expect(mocks.syncApplicationWorkflowTasks).toHaveBeenCalledWith(
      applications.records[0],
    );
  });

  it('does not reopen submitted applications for material tweaks', async () => {
    const applications = collection([
      record({
        id: 'app-1',
        resumeAssetId: 'resume-app',
        status: 'submitted',
      }),
    ]);
    const assets = collection([
      record({
        applicationId: 'app-1',
        assetType: 'resume',
        id: 'resume-app',
        markdownPath: 'application-packages/app-1/resume.md',
        title: 'Application resume',
      }),
    ]);
    const comments = collection();
    mocks.collections.set('Application', applications);
    mocks.collections.set('ApplicationMaterialComment', comments);
    mocks.collections.set('ResumeAsset', assets);

    const form = new FormData();
    form.set('comment:resume', 'Please revise this.');
    const request = new Request('http://localhost/admin/applications/app-1', {
      body: form,
      method: 'POST',
    });

    await expect(
      requestApplicationMaterialTweaks('app-1', request, { id: 'user-1' }),
    ).rejects.toMatchObject({
      body: {
        message:
          'Submitted or closed applications cannot be reopened for material changes.',
      },
      status: 409,
    });
    expect(comments.records).toHaveLength(0);
  });

  it('does not reopen materials when the revision fence loses a race', async () => {
    const applications = collection([
      record({
        approvedAt: new Date('2026-06-01T00:00:00.000Z'),
        approvedByUserId: 'user-1',
        id: 'app-1',
        resumeAssetId: 'resume-app',
        status: 'awaiting_user',
      }),
    ]);
    const assets = collection([
      record({
        applicationId: 'app-1',
        assetType: 'resume',
        id: 'resume-app',
        markdownPath: 'application-packages/app-1/resume.md',
        title: 'Application resume',
      }),
    ]);
    mocks.collections.set('Application', applications);
    mocks.collections.set('ResumeAsset', assets);
    mocks.databaseUpdate.mockResolvedValueOnce({ affected: 0 });

    const form = new FormData();
    form.set('comment:resume', 'Please revise this.');
    const request = new Request('http://localhost/admin/applications/app-1', {
      body: form,
      method: 'POST',
    });

    await expect(
      requestApplicationMaterialTweaks('app-1', request, { id: 'user-1' }),
    ).rejects.toMatchObject({
      body: {
        message:
          'Application changed before material revisions could be requested. Reload and review the current application.',
      },
      status: 409,
    });
    expect(applications.records[0]).toMatchObject({ status: 'awaiting_user' });
  });

  it('records a material review without approving the application for submission', async () => {
    const applications = collection([
      record({
        id: 'app-1',
        opportunityId: '',
        resumeAssetId: 'resume-app',
        status: 'awaiting_user',
      }),
    ]);
    const assets = collection([
      record({
        applicationId: 'app-1',
        assetType: 'resume',
        id: 'resume-app',
        markdownPath: 'application-packages/app-1/resume.md',
      }),
    ]);
    const comments = collection();
    mocks.collections.set('Application', applications);
    mocks.collections.set('ApplicationMaterialComment', comments);
    mocks.collections.set('ResumeAsset', assets);

    const form = new FormData();
    form.set('materialType', 'resume');
    const result = await markApplicationMaterialReviewed(
      'app-1',
      new Request('http://localhost/admin/applications/app-1', {
        body: form,
        method: 'POST',
      }),
      { id: 'user-1' },
    );

    expect(result).toMatchObject({
      materialType: 'resume',
      status: 'material_reviewed',
    });
    expect(comments.records).toContainEqual(
      expect.objectContaining({
        applicationId: 'app-1',
        materialRecordId: 'resume-app',
        materialType: 'resume',
        materialVersion: expect.any(String),
        reviewerUserId: 'user-1',
        status: 'reviewed',
      }),
    );
    expect(applications.records[0]).toMatchObject({ status: 'awaiting_user' });
    expect(applications.records[0]).not.toHaveProperty('finalApprovalKind');
  });

  it('only treats a material review as current when its artifact fingerprint matches', async () => {
    const applications = collection([
      record({
        id: 'app-1',
        opportunityId: '',
        resumeAssetId: 'resume-app',
        status: 'awaiting_user',
      }),
    ]);
    const assets = collection([
      record({
        applicationId: 'app-1',
        assetType: 'resume',
        id: 'resume-app',
        markdownPath: 'application-packages/app-1/resume.md',
      }),
    ]);
    const comments = collection([
      record({
        applicationId: 'app-1',
        materialRecordId: 'resume-app',
        materialType: 'resume',
        materialVersion: 'old-material-version',
        status: 'reviewed',
      }),
    ]);
    mocks.collections.set('Application', applications);
    mocks.collections.set('ApplicationMaterialComment', comments);
    mocks.collections.set('ResumeAsset', assets);

    const initial = await loadApplicationReviewPageData('app-1');
    const initialResume = initial.materials.find(
      (material) => material.materialType === 'resume',
    );
    expect(initialResume?.reviewStatus).toBe('not_reviewed');

    comments.records.push(
      record({
        applicationId: 'app-1',
        materialRecordId: 'resume-app',
        materialType: 'resume',
        materialVersion: initialResume?.materialVersion,
        status: 'reviewed',
      }),
    );
    const reviewed = await loadApplicationReviewPageData('app-1');
    expect(
      reviewed.materials.find((material) => material.materialType === 'resume')
        ?.reviewStatus,
    ).toBe('reviewed');

    mocks.read.mockResolvedValueOnce('# Updated material');
    const updated = await loadApplicationReviewPageData('app-1');
    expect(
      updated.materials.find((material) => material.materialType === 'resume')
        ?.reviewStatus,
    ).toBe('not_reviewed');
  });

  it('rejects material-scoped text as final submission approval', async () => {
    const applications = collection([
      record({ id: 'app-1', opportunityId: '', status: 'awaiting_user' }),
    ]);
    mocks.collections.set('Application', applications);
    mocks.collections.set('ResumeAsset', collection());

    const form = new FormData();
    form.set('approvalScope', 'Résumé only');
    await expectHttpError(
      () =>
        approveApplicationForSubmission(
          'app-1',
          new Request('http://localhost/admin/applications/app-1', {
            body: form,
            method: 'POST',
          }),
          { id: 'user-1' },
        ),
      'Final submission approval requires the explicit final-submission action.',
    );

    expect(applications.records[0]).toMatchObject({
      status: 'awaiting_user',
    });
    expect(applications.records[0]?.save).not.toHaveBeenCalled();
  });

  it('requires readable selected resume bytes before final approval', async () => {
    const applications = collection([
      record({
        id: 'app-1',
        opportunityId: '',
        resumeAssetId: 'resume-app',
        status: 'awaiting_user',
      }),
    ]);
    mocks.collections.set('Application', applications);
    mocks.collections.set(
      'ResumeAsset',
      collection([record({ id: 'resume-app', pdfPath: 'missing.pdf' })]),
    );
    mocks.exists.mockResolvedValueOnce(false);

    const form = new FormData();
    form.set('finalSubmissionIntent', 'final_submission');
    await expectHttpError(
      () =>
        approveApplicationForSubmission(
          'app-1',
          new Request('http://localhost/admin/applications/app-1', {
            body: form,
            method: 'POST',
          }),
          { id: 'user-1' },
        ),
      'Final submission approval requires a readable selected resume PDF.',
    );
    // Read-only material preparation must not save the loaded application.
    expect(applications.records[0]?.save).not.toHaveBeenCalled();
    expect(mocks.recordAgentAudit).not.toHaveBeenCalled();
  });

  it('does not repair missing application assets while verifying final approval', async () => {
    const application = record({
      finalApprovalMaterialsJson: '[]',
      id: 'app-1',
      resumeAssetId: 'resume-app',
      status: 'approved',
    });
    const applicationAsset = record({
      applicationId: 'app-1',
      assetType: 'resume',
      id: 'resume-app',
      sourceAssetId: 'resume-global',
      title: 'Application resume',
    });
    mocks.collections.set('Application', collection([application]));
    mocks.collections.set(
      'ResumeAsset',
      collection([
        record({
          assetType: 'resume',
          id: 'resume-global',
          pdfPath: 'published/resume.pdf',
        }),
        applicationAsset,
      ]),
    );

    await expect(
      finalApplicationApprovalMaterialsAreCurrent('app-1'),
    ).resolves.toBe(false);

    expect(application.save).not.toHaveBeenCalled();
    expect(applicationAsset.save).not.toHaveBeenCalled();
    expect(mocks.write).not.toHaveBeenCalled();
  });

  it('requires the matching completed final-approval audit during verification', async () => {
    const application = record({
      id: 'app-1',
      opportunityId: '',
      resumeAssetId: 'resume-app',
      status: 'approved',
    });
    mocks.collections.set('Application', collection([application]));
    const resume = record({
      applicationId: 'app-1',
      assetType: 'resume',
      id: 'resume-app',
      pdfBasename: 'resume.pdf',
      pdfPath: 'resume.pdf',
    });
    mocks.collections.set('ResumeAsset', collection([resume]));

    const review = await loadApplicationReviewPageData('app-1');
    const materials = review.materials.map((material) => ({
      materialRecordId: material.materialRecordId,
      materialType: material.materialType,
      materialVersion: material.materialVersion,
      pdfDigest: material.pdfDigest,
      pdfFilename: material.pdfFilename,
    }));
    const finalApprovalAt = new Date('2026-08-26T16:00:00.000Z');
    Object.assign(application, {
      finalApprovalAt,
      finalApprovalKind: 'final_submission',
      finalApprovalMaterialsJson: JSON.stringify(materials),
      finalApprovedByUserId: 'user-1',
    });

    await expect(
      finalApplicationApprovalMaterialsAreCurrent('app-1'),
    ).resolves.toBe(false);

    mocks.collections.set(
      'AgentRun',
      collection([
        record({
          applicationId: 'app-1',
          approvalSnapshotJson: JSON.stringify({
            finalApprovalAt,
            finalApprovalKind: 'final_submission',
            finalApprovalMaterialsJson: application.finalApprovalMaterialsJson,
            finalApprovedByUserId: 'user-1',
          }),
          runType: 'application_final_approval',
          status: 'succeeded',
        }),
      ]),
    );

    await expect(
      finalApplicationApprovalMaterialsAreCurrent('app-1'),
    ).resolves.toBe(true);

    resume.pdfBasename = 'Renamed - Example Candidate - Programmer.pdf';
    await expect(
      finalApplicationApprovalMaterialsAreCurrent('app-1'),
    ).resolves.toBe(false);
  });

  it('records a final application approval only through the explicit action', async () => {
    const applications = collection([
      record({
        id: 'app-1',
        opportunityId: '',
        resumeAssetId: 'resume-app',
        status: 'awaiting_user',
      }),
    ]);
    mocks.collections.set('Application', applications);
    mocks.collections.set(
      'ResumeAsset',
      collection([
        record({
          applicationId: 'app-1',
          id: 'resume-app',
          pdfPath: 'resume.pdf',
        }),
      ]),
    );

    const form = new FormData();
    form.set('approvalNotes', 'Ready to send.');
    form.set('finalSubmissionIntent', 'final_submission');
    await approveApplicationForSubmission(
      'app-1',
      new Request('http://localhost/admin/applications/app-1', {
        body: form,
        method: 'POST',
      }),
      { id: 'user-1' },
    );

    expect(applications.records[0]).toMatchObject({
      approvalScope: 'final_submission',
      finalApprovalAt: expect.any(Date),
      finalApprovalKind: 'final_submission',
      finalApprovedByUserId: 'user-1',
      finalApprovalMaterialsJson: expect.any(String),
      status: 'approved',
    });
    expect(
      JSON.parse(String(applications.records[0].finalApprovalMaterialsJson)),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          materialType: 'resume',
          pdfDigest: expect.any(String),
          pdfFilename: expect.any(String),
        }),
      ]),
    );
    expect(mocks.recordAgentAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        application: applications.records[0],
        input: expect.objectContaining({
          materialSnapshotJson:
            applications.records[0].finalApprovalMaterialsJson,
        }),
        runType: 'application_final_approval',
        status: 'succeeded',
        user: { id: 'user-1' },
      }),
    );
    expect(mocks.maybeEnqueueAutoSubmitOnApproval).toHaveBeenCalledWith(
      applications.records[0],
      { user: { id: 'user-1' } },
    );
  });

  it('fails closed when materials change before the final-approval commit', async () => {
    const applications = collection([
      record({
        id: 'app-1',
        opportunityId: '',
        resumeAssetId: 'resume-app',
        status: 'awaiting_user',
      }),
    ]);
    mocks.collections.set('Application', applications);
    mocks.collections.set(
      'ResumeAsset',
      collection([
        record({
          applicationId: 'app-1',
          id: 'resume-app',
          pdfPath: 'resume.pdf',
        }),
      ]),
    );
    mocks.databaseUpdate.mockResolvedValueOnce({ affected: 0 });

    const form = new FormData();
    form.set('finalSubmissionIntent', 'final_submission');
    await expect(
      approveApplicationForSubmission(
        'app-1',
        new Request('http://localhost/admin/applications/app-1', {
          body: form,
          method: 'POST',
        }),
        { id: 'user-1' },
      ),
    ).rejects.toMatchObject({
      body: {
        message:
          'Application materials changed before final approval could be recorded. Reload and review the current materials.',
      },
      status: 409,
    });

    expect(applications.records[0]).toMatchObject({ status: 'awaiting_user' });
    expect(mocks.recordAgentAudit).toHaveBeenCalledTimes(1);
    expect(mocks.syncApplicationWorkflowTasks).not.toHaveBeenCalled();
  });

  it('does not persist final approval when its audit record cannot be saved', async () => {
    const applications = collection([
      record({
        id: 'app-1',
        opportunityId: '',
        resumeAssetId: 'resume-app',
        status: 'awaiting_user',
      }),
    ]);
    mocks.collections.set('Application', applications);
    mocks.collections.set(
      'ResumeAsset',
      collection([record({ id: 'resume-app', pdfPath: 'resume.pdf' })]),
    );
    mocks.recordAgentAudit.mockRejectedValueOnce(
      new Error('Audit storage unavailable.'),
    );

    const form = new FormData();
    form.set('finalSubmissionIntent', 'final_submission');
    await expect(
      approveApplicationForSubmission(
        'app-1',
        new Request('http://localhost/admin/applications/app-1', {
          body: form,
          method: 'POST',
        }),
        { id: 'user-1' },
      ),
    ).rejects.toThrow('Audit storage unavailable.');

    // The pending audit happens before the guarded approval commit, so an
    // audit failure leaves the application untouched.
    expect(applications.records[0]?.save).not.toHaveBeenCalled();
    expect(mocks.syncApplicationWorkflowTasks).not.toHaveBeenCalled();
  });

  it('does not record a final-approval success audit when its guarded commit fails', async () => {
    const applications = collection([
      record({
        id: 'app-1',
        opportunityId: '',
        resumeAssetId: 'resume-app',
        status: 'awaiting_user',
      }),
    ]);
    mocks.collections.set('Application', applications);
    mocks.collections.set(
      'ResumeAsset',
      collection([
        record({
          applicationId: 'app-1',
          id: 'resume-app',
          pdfPath: 'resume.pdf',
        }),
      ]),
    );

    const form = new FormData();
    form.set('finalSubmissionIntent', 'final_submission');
    mocks.databaseUpdate.mockRejectedValueOnce(
      new Error('Application storage unavailable.'),
    );
    await expect(
      approveApplicationForSubmission(
        'app-1',
        new Request('http://localhost/admin/applications/app-1', {
          body: form,
          method: 'POST',
        }),
        { id: 'user-1' },
      ),
    ).rejects.toThrow('Application storage unavailable.');

    expect(mocks.recordAgentAudit).toHaveBeenCalledTimes(1);
    expect(mocks.recordAgentAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        runType: 'application_final_approval_pending',
        status: 'pending',
      }),
    );
    expect(mocks.syncApplicationWorkflowTasks).not.toHaveBeenCalled();
  });

  it('keeps final approval pending when its success audit cannot be saved', async () => {
    const applications = collection([
      record({
        id: 'app-1',
        opportunityId: '',
        resumeAssetId: 'resume-app',
        status: 'awaiting_user',
      }),
    ]);
    mocks.collections.set('Application', applications);
    mocks.collections.set(
      'ResumeAsset',
      collection([record({ id: 'resume-app', pdfPath: 'resume.pdf' })]),
    );
    mocks.recordAgentAudit
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('Audit completion unavailable.'));

    const form = new FormData();
    form.set('finalSubmissionIntent', 'final_submission');
    await expect(
      approveApplicationForSubmission(
        'app-1',
        new Request('http://localhost/admin/applications/app-1', {
          body: form,
          method: 'POST',
        }),
        { id: 'user-1' },
      ),
    ).rejects.toThrow('Audit completion unavailable.');

    expect(applications.records[0]).toMatchObject({ status: 'approved' });
    expect(mocks.syncApplicationWorkflowTasks).not.toHaveBeenCalled();
    expect(mocks.maybeEnqueueAutoSubmitOnApproval).not.toHaveBeenCalled();
  });
});
