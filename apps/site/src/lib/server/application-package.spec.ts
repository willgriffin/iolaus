import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  bulkUpdateOpportunityReviews,
  createDraftApplicationForOpportunity,
  generateApplicationPackage,
  normalizeOpportunityRating,
  updateOpportunityReview,
} from './application-package';

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
  return {
    create: vi.fn(async (payload: Record<string, unknown>) => {
      const created = record({
        id: `created-${records.length + 1}`,
        ...payload,
      });
      records.push(created);
      return created;
    }),
    delete: vi.fn(async (id: string) => {
      const index = records.findIndex((item) => item.id === id);
      if (index < 0) return false;
      records.splice(index, 1);
      return true;
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
}

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

  expect(thrown).toMatchObject({
    body: { message },
    status: 400,
  });
}

const mocks = vi.hoisted(() => ({
  assertOpportunityLifecycleLockIsActive: vi.fn(() => {}),
  archiveApplicationsForClosedPosting: vi.fn(async (opportunityId: string) => {
    const applications = mocks.collections.get('Application')?.records ?? [];
    for (const application of applications) {
      if (application.opportunityId !== opportunityId) continue;
      Object.assign(application, { status: 'archived' });
      await mocks.syncApplicationWorkflowTasks(application);
    }
  }),
  collections: new Map<string, ReturnType<typeof collection>>(),
  generateResumeAsset: vi.fn(async () => ({
    generatedAt: new Date('2026-06-05T12:00:00.000Z'),
    generatedPath: 'generated-resumes/resume-generated',
    htmlPath: 'generated-resumes/resume-generated/resume.html',
    id: 'resume-generated',
    markdownPath: 'generated-resumes/resume-generated/resume.md',
    outputSlug: 'variant-slug',
    pdfPath: 'generated-resumes/resume-generated/resume.pdf',
    tailoringId: 'tailoring-1',
    textPath: 'generated-resumes/resume-generated/resume.txt',
  })),
  publishedResume: { id: 'resume-default' },
  requireFreshPostingPreflight: vi.fn(
    async (_options?: { onClosed?: () => Promise<void> }) => ({
      evidence: {
        checkedAt: '2026-08-28T00:00:00.000Z',
        evidenceExcerpt: 'Verified test posting.',
        finalUrl: 'https://job-boards.greenhouse.io/acme/jobs/123',
        provider: 'greenhouse',
        redirected: false,
        responseStatus: 200,
      },
      outcome: 'live' as const,
      overridden: false,
      reason: 'verified_live' as const,
    }),
  ),
  tailoringConfig: {
    config: {
      emphasizeTags: ['typescript'],
      name: 'Base tailoring',
      outputSlug: 'base-tailoring',
      title: 'Base title',
    },
    configSlug: 'base-tailoring',
    id: 'tailoring-1',
    name: 'Base tailoring',
  },
  fsWrite: vi.fn<
    (
      path: string,
      content: unknown,
      options?: Record<string, unknown>,
    ) => Promise<void>
  >(async () => {}),
  fsExists: vi.fn(async () => false),
  fsRead: vi.fn(async () => ''),
  fsDelete: vi.fn(async () => {}),
  factEvidenceGetForFact: vi.fn<
    (factId: string) => Promise<Array<Record<string, unknown>>>
  >(async () => []),
  factSubjectGetForEntity: vi.fn<
    (entityType: string, entityId: string) => Promise<Array<{ factId: string }>>
  >(async () => []),
  persistApplicationFormSchema: vi.fn<
    (
      application: Record<string, unknown>,
    ) => Promise<{ ats: string; persisted: boolean; questionCount: number }>
  >(async () => ({ ats: '', persisted: false, questionCount: 0 })),
  processOpportunityIntelligence: vi.fn(async () => ({ status: 'processed' })),
  commitApplicationIfCurrent: vi.fn(
    async (
      application: Record<string, unknown>,
      updates: Record<string, unknown>,
    ) => {
      Object.assign(application, updates);
      return true;
    },
  ),
  commitResumeVariantIfCurrent: vi.fn(async () => true),
  recordAgentAudit: vi.fn(async () => ({ id: 'run-1' })),
  renderHtmlToPdf: vi.fn(async () => Buffer.from('%PDF-1.4 material\n')),
  resolveWritingAiProfileClient: vi.fn<() => Promise<unknown>>(
    async () => null,
  ),
  runWithFreshPostingPreflight: vi.fn(
    async (options: {
      onClosed?: () => Promise<void>;
      opportunity: Record<string, unknown>;
      run: (opportunity: Record<string, unknown>) => Promise<unknown>;
    }) => {
      await mocks.requireFreshPostingPreflight(options);
      return await options.run(options.opportunity);
    },
  ),
  runOpportunityLifecycleTransaction: vi.fn(
    async (action: (database: Record<string, unknown>) => Promise<unknown>) =>
      await action({}),
  ),
  syncApplicationWorkflowTasks: vi.fn(
    async (_application?: Record<string, unknown>) => ({ created: 0 }),
  ),
}));

vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(async (className: string) => {
    const found = mocks.collections.get(className);
    if (!found) throw new Error(`Missing collection ${className}`);
    return found;
  }),
  getRequestScopedSmrtOptions: vi.fn(() => ({})),
}));

vi.mock('./resume-data.js', () => ({
  getPublishedResumeAsset: vi.fn(async () => mocks.publishedResume),
  getResumeTailoringConfig: vi.fn(async (id: string) =>
    id === mocks.tailoringConfig.id ? mocks.tailoringConfig : null,
  ),
}));

vi.mock('./resume-admin.js', () => ({
  generateResumeAsset: mocks.generateResumeAsset,
}));

vi.mock('./resume-files.js', () => ({
  getResumeFilesystem: vi.fn(async () => ({
    delete: mocks.fsDelete,
    exists: mocks.fsExists,
    read: mocks.fsRead,
    write: mocks.fsWrite,
  })),
}));

vi.mock('./ats-form-schema.js', () => ({
  persistApplicationFormSchema: mocks.persistApplicationFormSchema,
}));

vi.mock('@happyvertical/pdf', () => ({
  renderHtmlToPdf: mocks.renderHtmlToPdf,
}));

vi.mock('./application-workflow.js', () => ({
  archiveApplicationsForClosedPosting:
    mocks.archiveApplicationsForClosedPosting,
  assertOpportunityLifecycleLockIsActive:
    mocks.assertOpportunityLifecycleLockIsActive,
  recordAgentAudit: mocks.recordAgentAudit,
  runWithFreshPostingPreflight: mocks.runWithFreshPostingPreflight,
  runOpportunityLifecycleTransaction: mocks.runOpportunityLifecycleTransaction,
  syncApplicationWorkflowTasks: mocks.syncApplicationWorkflowTasks,
}));

vi.mock('./posting-preflight.js', () => ({
  requireFreshPostingPreflight: mocks.requireFreshPostingPreflight,
}));

vi.mock('./application-concurrency.js', () => ({
  commitApplicationIfCurrent: mocks.commitApplicationIfCurrent,
}));

vi.mock('./resume-variant-concurrency.js', () => ({
  commitResumeVariantIfCurrent: mocks.commitResumeVariantIfCurrent,
}));

vi.mock('./opportunity-intelligence.js', () => ({
  processOpportunityIntelligence: mocks.processOpportunityIntelligence,
}));

vi.mock('./ai-config.js', () => ({
  resolveWritingAiProfileClient: mocks.resolveWritingAiProfileClient,
}));

vi.mock('@happyvertical/smrt-facts', () => ({
  FactSubjectCollection: {
    create: vi.fn(async () => ({
      getForEntity: mocks.factSubjectGetForEntity,
    })),
  },
  FactEvidenceCollection: {
    create: vi.fn(async () => ({ getForFact: mocks.factEvidenceGetForFact })),
  },
}));

function enableCoverLetterGeneration() {
  const resumeAssets = mocks.collections.get('ResumeAsset');
  resumeAssets?.records.push(
    record({
      id: 'resume-default',
      markdownPath: 'published/resume.md',
      title: 'Published resume',
    }),
  );
  mocks.fsExists.mockResolvedValue(true);
  mocks.fsRead.mockResolvedValue(
    'Example Candidate builds reliable AI and platform systems from verified experience.',
  );
  mocks.resolveWritingAiProfileClient.mockResolvedValue({
    aiClient: {
      chat: vi.fn(async () => ({
        content:
          'I build reliable AI and platform systems, and I would bring that practical experience to this role.',
      })),
    },
    model: 'test-writing-model',
    timeout: 1_000,
  });
}

describe('normalizeOpportunityRating', () => {
  it('allows blank ratings and integer ratings from 1 to 10', () => {
    expect(normalizeOpportunityRating('')).toBeNull();
    expect(normalizeOpportunityRating('10')).toBe(10);
    expect(normalizeOpportunityRating(1)).toBe(1);
  });

  it('rejects ratings outside the 1 to 10 range', () => {
    expect(() => normalizeOpportunityRating('11')).toThrow();
    expect(() => normalizeOpportunityRating('0')).toThrow();
    expect(() => normalizeOpportunityRating('2.5')).toThrow();
  });
});

describe('opportunity review and draft applications', () => {
  beforeEach(() => {
    mocks.collections.clear();
    mocks.collections.set(
      'Opportunity',
      collection([record({ id: 'opp-1', title: 'AI Engineer' })]),
    );
    mocks.collections.set('Application', collection());
    mocks.commitApplicationIfCurrent.mockReset();
    mocks.commitApplicationIfCurrent.mockImplementation(
      async (application, updates) => {
        Object.assign(application, updates);
        return true;
      },
    );
    mocks.commitResumeVariantIfCurrent.mockReset();
    mocks.commitResumeVariantIfCurrent.mockResolvedValue(true);
    mocks.recordAgentAudit.mockClear();
    mocks.archiveApplicationsForClosedPosting.mockClear();
    mocks.runWithFreshPostingPreflight.mockClear();
    mocks.requireFreshPostingPreflight.mockReset();
    mocks.requireFreshPostingPreflight.mockResolvedValue({
      evidence: {
        checkedAt: '2026-08-28T00:00:00.000Z',
        evidenceExcerpt: 'Verified test posting.',
        finalUrl: 'https://job-boards.greenhouse.io/acme/jobs/123',
        provider: 'greenhouse',
        redirected: false,
        responseStatus: 200,
      },
      outcome: 'live',
      overridden: false,
      reason: 'verified_live',
    });
    mocks.syncApplicationWorkflowTasks.mockClear();
  });

  it('stores Will review attribution separately from agent scores', async () => {
    const result = await updateOpportunityReview({
      humanRating: '9',
      humanReviewNotes: 'Strong fit',
      humanReviewStatus: 'apply',
      opportunityId: 'opp-1',
      user: { id: 'user-1' },
    });

    expect(result).toMatchObject({
      humanRating: 9,
      humanReviewNotes: 'Strong fit',
      humanReviewStatus: 'apply',
      reviewedByUserId: 'user-1',
    });
  });

  it('allows blank review status while storing a ten-point rating', async () => {
    const result = await updateOpportunityReview({
      humanRating: '7',
      humanReviewNotes: 'Needs another pass',
      humanReviewStatus: '',
      opportunityId: 'opp-1',
      user: { id: 'user-1' },
    });

    expect(result).toMatchObject({
      humanRating: 7,
      humanReviewNotes: 'Needs another pass',
      humanReviewStatus: '',
    });
  });

  it('bulk reviews selected opportunities without wiping existing ratings or notes', async () => {
    const opportunities = collection([
      record({
        humanRating: 8,
        humanReviewNotes: 'Keep this note',
        id: 'opp-1',
        reviewedByProfileId: 'profile-1',
        title: 'AI Engineer',
      }),
      record({
        humanRating: 5,
        humanReviewNotes: 'Keep this too',
        id: 'opp-2',
        title: 'Platform Engineer',
      }),
    ]);
    mocks.collections.set('Opportunity', opportunities);

    const result = await bulkUpdateOpportunityReviews({
      humanReviewStatus: 'apply',
      opportunityIds: ['opp-1', 'opp-2', 'opp-1'],
      user: { id: 'user-1' },
    });

    expect(result).toMatchObject({
      count: 2,
      status: 'updated',
    });
    expect(opportunities.records[0]).toMatchObject({
      humanRating: 8,
      humanReviewNotes: 'Keep this note',
      humanReviewStatus: 'apply',
      reviewedByProfileId: 'profile-1',
      reviewedByUserId: 'user-1',
    });
    expect(opportunities.records[1]).toMatchObject({
      humanRating: 5,
      humanReviewNotes: 'Keep this too',
      humanReviewStatus: 'apply',
      reviewedByUserId: 'user-1',
    });
  });

  it('creates a draft application with default resume and no generated cover letter', async () => {
    const opportunity = mocks.collections.get('Opportunity')?.records[0];

    const result = await createDraftApplicationForOpportunity({
      coverLetterMode: 'none',
      opportunityId: 'opp-1',
      resumeMode: 'default',
    });

    expect(result).toMatchObject({
      coverLetterMode: 'none',
      opportunityId: 'opp-1',
      resumeAssetId: 'resume-default',
      resumeMode: 'default',
      status: 'application_drafting',
    });
    expect(mocks.requireFreshPostingPreflight).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'create_application_draft',
        opportunity: expect.objectContaining({ id: 'opp-1' }),
      }),
    );
    expect(opportunity).toMatchObject({ status: 'apply' });
    expect(opportunity?.save).toHaveBeenCalled();
    expect(mocks.syncApplicationWorkflowTasks).toHaveBeenCalledWith(
      expect.objectContaining({ opportunityId: 'opp-1' }),
    );
  });

  it('archives an existing local draft when preflight finds the posting closed', async () => {
    const application = record({
      id: 'app-closed',
      opportunityId: 'opp-1',
      status: 'application_drafting',
    });
    const secondApplication = record({
      id: 'app-closed-second',
      opportunityId: 'opp-1',
      status: 'draft',
    });
    mocks.collections.set(
      'Application',
      collection([application, secondApplication]),
    );
    mocks.requireFreshPostingPreflight.mockImplementationOnce(
      async (options?: { onClosed?: () => Promise<void> }) => {
        await options?.onClosed?.();
        throw {
          body: {
            message:
              'This posting is closed and has been archived. Application work cannot continue.',
          },
          status: 409,
        };
      },
    );

    await expect(
      createDraftApplicationForOpportunity({
        coverLetterMode: 'none',
        opportunityId: 'opp-1',
        resumeMode: 'default',
      }),
    ).rejects.toMatchObject({ status: 409 });

    expect(mocks.archiveApplicationsForClosedPosting).toHaveBeenCalledWith(
      'opp-1',
    );
    expect(application).toMatchObject({ status: 'archived' });
    expect(secondApplication).toMatchObject({ status: 'archived' });
  });

  it('clears stale generated assets when planning switches to no generated materials', async () => {
    mocks.collections.set(
      'Application',
      collection([
        record({
          id: 'app-1',
          coverLetterAssetId: 'cover-old',
          opportunityId: 'opp-1',
          resumeAssetId: 'resume-old',
          status: 'draft',
        }),
      ]),
    );

    const result = await createDraftApplicationForOpportunity({
      coverLetterMode: 'none',
      opportunityId: 'opp-1',
      resumeMode: 'none',
    });

    expect(result).toMatchObject({
      coverLetterAssetId: '',
      coverLetterMode: 'none',
      resumeAssetId: '',
      resumeMode: 'none',
    });
  });

  it('invalidates approval when application planning changes', async () => {
    mocks.collections.set(
      'Application',
      collection([
        record({
          approvedAt: new Date('2026-06-04T10:00:00.000Z'),
          approvedByProfileId: 'profile-1',
          approvedByUserId: 'user-1',
          coverLetterMode: 'none',
          id: 'app-1',
          opportunityId: 'opp-1',
          resumeAssetId: 'resume-default',
          resumeMode: 'default',
          status: 'approved',
        }),
      ]),
    );

    const result = await createDraftApplicationForOpportunity({
      coverLetterMode: 'generate',
      opportunityId: 'opp-1',
      resumeMode: 'default',
    });

    expect(result).toMatchObject({
      approvedAt: null,
      approvedByProfileId: '',
      approvedByUserId: '',
      coverLetterMode: 'generate',
      status: 'awaiting_user',
    });
  });

  it('does not overwrite a concurrently changed application while updating planning', async () => {
    const application = record({
      coverLetterMode: 'none',
      id: 'app-1',
      opportunityId: 'opp-1',
      resumeMode: 'default',
      status: 'approved',
    });
    mocks.collections.set('Application', collection([application]));
    mocks.commitApplicationIfCurrent.mockResolvedValueOnce(false);

    await expect(
      createDraftApplicationForOpportunity({
        coverLetterMode: 'generate',
        opportunityId: 'opp-1',
        resumeMode: 'default',
      }),
    ).rejects.toMatchObject({
      body: {
        message:
          'Application changed while its planning was updated. Reload and review the current application.',
      },
      status: 409,
    });
    expect(application).toMatchObject({
      coverLetterMode: 'none',
      status: 'approved',
    });
    expect(application.save).not.toHaveBeenCalled();
    expect(mocks.syncApplicationWorkflowTasks).not.toHaveBeenCalled();
  });

  it('rejects unsupported application material modes', async () => {
    await expectHttpError(
      () =>
        createDraftApplicationForOpportunity({
          coverLetterMode: 'unsupported',
          opportunityId: 'opp-1',
          resumeMode: 'default',
        }),
      'Invalid cover letter mode.',
    );

    await expectHttpError(
      () =>
        createDraftApplicationForOpportunity({
          coverLetterMode: 'none',
          opportunityId: 'opp-1',
          resumeMode: 'maximalist',
        }),
      'Invalid resume mode.',
    );
  });
});

describe('generateApplicationPackage', () => {
  beforeEach(() => {
    mocks.collections.clear();
    mocks.collections.set(
      'Opportunity',
      collection([record({ id: 'opp-1', title: 'AI Engineer' })]),
    );
    mocks.collections.set('CandidateProfile', collection());
    mocks.collections.set('Fact', collection());
    mocks.collections.set('ResumeAsset', collection());
    mocks.collections.set('ResumeVariant', collection());
    mocks.fsWrite.mockClear();
    mocks.fsExists.mockReset();
    mocks.fsExists.mockResolvedValue(false);
    mocks.fsRead.mockReset();
    mocks.fsRead.mockResolvedValue('');
    mocks.fsDelete.mockClear();
    mocks.factEvidenceGetForFact.mockReset();
    mocks.factEvidenceGetForFact.mockResolvedValue([]);
    mocks.factSubjectGetForEntity.mockReset();
    mocks.factSubjectGetForEntity.mockResolvedValue([]);
    mocks.generateResumeAsset.mockClear();
    mocks.processOpportunityIntelligence.mockClear();
    mocks.commitApplicationIfCurrent.mockReset();
    mocks.commitApplicationIfCurrent.mockImplementation(
      async (application, updates) => {
        Object.assign(application, updates);
        return true;
      },
    );
    mocks.commitResumeVariantIfCurrent.mockReset();
    mocks.commitResumeVariantIfCurrent.mockResolvedValue(true);
    mocks.recordAgentAudit.mockClear();
    mocks.persistApplicationFormSchema.mockReset();
    mocks.persistApplicationFormSchema.mockResolvedValue({
      ats: '',
      persisted: false,
      questionCount: 0,
    });
    mocks.renderHtmlToPdf.mockClear();
    mocks.resolveWritingAiProfileClient.mockReset();
    mocks.resolveWritingAiProfileClient.mockResolvedValue(null);
    mocks.syncApplicationWorkflowTasks.mockClear();
    mocks.assertOpportunityLifecycleLockIsActive.mockReset();
    mocks.assertOpportunityLifecycleLockIsActive.mockImplementation(() => {});
  });

  it('auto-fills the published resume for a default-resume application', async () => {
    const candidateProfiles = collection([
      record({ id: 'profile-recent', isDefault: false }),
      record({ id: 'profile-default', isDefault: true }),
    ]);
    mocks.collections.set('CandidateProfile', candidateProfiles);
    mocks.collections.set(
      'Application',
      collection([
        record({
          coverLetterMode: 'none',
          id: 'app-1',
          opportunityId: 'opp-1',
          resumeMode: 'default',
        }),
      ]),
    );

    const result = await generateApplicationPackage('app-1');

    const packet = mocks.collections.get('ResumeAsset')?.records[0];
    expect(packet).toMatchObject({
      assetType: 'application_packet',
      status: 'generated',
    });
    expect(result).toMatchObject({
      packetAssetId: packet?.id,
      resumeAssetId: 'resume-default',
      status: 'awaiting_user',
    });
    expect(mocks.requireFreshPostingPreflight).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'generate_packet',
        opportunity: expect.objectContaining({ id: 'opp-1' }),
      }),
    );
    expect(mocks.fsWrite).toHaveBeenCalledTimes(4);
    expect(packet).toMatchObject({
      pdfBasename: 'application-packet-ai-engineer.pdf',
    });
    expect(packet?.htmlPath).toMatch(
      /^application-packages\/app-1\/packet-\d+-[\da-f-]+\.html$/,
    );
    expect(packet?.pdfPath).toMatch(
      /^application-packages\/app-1\/packet-\d+-[\da-f-]+\.pdf$/,
    );
    expect(mocks.processOpportunityIntelligence).toHaveBeenCalledWith(
      expect.objectContaining({
        applicationId: 'app-1',
        assertWriteAllowed: expect.any(Function),
        modes: ['plan'],
        opportunityId: 'opp-1',
        runLifecycleMutation: expect.any(Function),
        signal: undefined,
      }),
    );
    expect(
      mocks.processOpportunityIntelligence.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.fsWrite.mock.invocationCallOrder[0]);
    expect(mocks.recordAgentAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.objectContaining({ packetAssetId: packet?.id }),
        runType: 'application_packet',
        status: 'succeeded',
      }),
    );
    expect(candidateProfiles.list).toHaveBeenCalledWith({
      limit: 50,
      orderBy: 'updated_at DESC',
    });
  });

  it('keeps a SmrtObject accessor id in the packet concurrency fence', async () => {
    const application = record({
      coverLetterMode: 'none',
      id: 'app-accessor-id',
      opportunityId: 'opp-1',
      resumeMode: 'default',
    });
    Object.defineProperty(application, 'id', {
      configurable: true,
      enumerable: false,
      value: 'app-accessor-id',
      writable: true,
    });
    mocks.collections.set('Application', collection([application]));
    mocks.commitApplicationIfCurrent.mockImplementationOnce(
      async (snapshot, updates) => {
        if (!snapshot.id) return false;
        Object.assign(snapshot, updates);
        return true;
      },
    );

    await expect(
      generateApplicationPackage('app-accessor-id'),
    ).resolves.toMatchObject({ status: 'awaiting_user' });

    expect(mocks.commitApplicationIfCurrent).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'app-accessor-id' }),
      expect.any(Object),
      expect.anything(),
    );
  });

  it('keeps packet material generation inside the lifecycle-gated callback', async () => {
    mocks.collections.set(
      'Application',
      collection([
        record({
          coverLetterMode: 'none',
          id: 'app-locked-packet',
          opportunityId: 'opp-1',
          resumeMode: 'default',
        }),
      ]),
    );
    let lifecycleGateReleased = false;
    mocks.fsWrite.mockImplementationOnce(async () => {
      expect(lifecycleGateReleased).toBe(false);
    });
    mocks.runWithFreshPostingPreflight.mockImplementationOnce(
      async (gateOptions: {
        opportunity: Record<string, unknown>;
        run: (opportunity: Record<string, unknown>) => Promise<unknown>;
      }) => {
        const result = await gateOptions.run(gateOptions.opportunity);
        lifecycleGateReleased = true;
        return result;
      },
    );

    await generateApplicationPackage('app-locked-packet');

    expect(mocks.fsWrite).toHaveBeenCalled();
    expect(lifecycleGateReleased).toBe(true);
  });

  it('does not persist a packet asset after lifecycle lock loss during artifact generation', async () => {
    mocks.collections.set(
      'Application',
      collection([
        record({
          coverLetterMode: 'none',
          id: 'app-lost-packet-lock',
          opportunityId: 'opp-1',
          resumeMode: 'default',
        }),
      ]),
    );
    let lockActive = true;
    mocks.assertOpportunityLifecycleLockIsActive.mockImplementation(() => {
      if (lockActive) return;
      throw {
        body: {
          message:
            'The posting check connection was lost. Please try again before making application changes.',
        },
        status: 409,
      };
    });
    mocks.fsWrite.mockImplementationOnce(async () => {
      lockActive = false;
    });

    await expect(
      generateApplicationPackage('app-lost-packet-lock'),
    ).rejects.toMatchObject({ status: 409 });

    expect(mocks.fsWrite).toHaveBeenCalled();
    expect(mocks.fsDelete).toHaveBeenCalledTimes(4);
    expect(mocks.collections.get('ResumeAsset')?.records).toHaveLength(0);
    expect(mocks.recordAgentAudit).not.toHaveBeenCalled();
    expect(mocks.syncApplicationWorkflowTasks).not.toHaveBeenCalled();
  });

  it('compensates a packet asset if the lifecycle lock is lost during save', async () => {
    mocks.collections.set(
      'Application',
      collection([
        record({
          coverLetterMode: 'none',
          id: 'app-lost-packet-save-lock',
          opportunityId: 'opp-1',
          resumeMode: 'default',
        }),
      ]),
    );
    let lockActive = true;
    mocks.assertOpportunityLifecycleLockIsActive.mockImplementation(() => {
      if (lockActive) return;
      throw {
        body: {
          message:
            'The posting check connection was lost. Please try again before making application changes.',
        },
        status: 409,
      };
    });
    const resumeAssets = collection();
    resumeAssets.create.mockImplementationOnce(async (payload) => {
      const asset = record({ id: 'packet-asset', ...payload });
      asset.save.mockImplementationOnce(async () => {
        lockActive = false;
      });
      resumeAssets.records.push(asset);
      return asset;
    });
    mocks.collections.set('ResumeAsset', resumeAssets);

    await expect(
      generateApplicationPackage('app-lost-packet-save-lock'),
    ).rejects.toMatchObject({ status: 409 });

    expect(resumeAssets.delete).toHaveBeenCalledWith('packet-asset');
    expect(resumeAssets.records).toHaveLength(0);
    expect(mocks.fsDelete).toHaveBeenCalledTimes(4);
    expect(mocks.recordAgentAudit).not.toHaveBeenCalled();
    expect(mocks.syncApplicationWorkflowTasks).not.toHaveBeenCalled();
  });

  it('removes earlier material when the lifecycle lock drops during a later artifact', async () => {
    mocks.collections.set(
      'Application',
      collection([
        record({
          coverLetterMode: 'generate',
          id: 'app-lost-later-lock',
          opportunityId: 'opp-1',
          resumeMode: 'default',
        }),
      ]),
    );
    mocks.collections.set(
      'CandidateProfile',
      collection([record({ id: 'candidate-1', isDefault: true })]),
    );
    mocks.collections.set(
      'Fact',
      collection([
        record({
          id: 'candidate-active',
          status: 'active',
          textRefined: 'Verified candidate platform experience.',
        }),
      ]),
    );
    mocks.factSubjectGetForEntity.mockImplementation(
      async (entityType: string, entityId: string) =>
        entityType === 'CandidateProfile' && entityId === 'candidate-1'
          ? [{ factId: 'candidate-active' }]
          : [],
    );
    mocks.factEvidenceGetForFact.mockResolvedValue([
      { id: 'evidence-candidate', status: 'supports' },
    ]);
    enableCoverLetterGeneration();
    let lockActive = true;
    mocks.assertOpportunityLifecycleLockIsActive.mockImplementation(() => {
      if (lockActive) return;
      throw {
        body: {
          message:
            'The posting check connection was lost. Please try again before making application changes.',
        },
        status: 409,
      };
    });
    let writeCount = 0;
    mocks.fsWrite.mockImplementation(async () => {
      writeCount += 1;
      // A cover letter has finished and its asset is persisted before packet
      // rendering begins. This exercises cleanup beyond the latest asset.
      if (writeCount === 5) lockActive = false;
    });

    await expect(
      generateApplicationPackage('app-lost-later-lock'),
    ).rejects.toMatchObject({ status: 409 });

    expect(mocks.collections.get('ResumeAsset')?.records).toEqual([
      expect.objectContaining({ id: 'resume-default' }),
    ]);
    expect(mocks.fsDelete).toHaveBeenCalledTimes(8);
    expect(mocks.recordAgentAudit).not.toHaveBeenCalled();
    expect(mocks.syncApplicationWorkflowTasks).not.toHaveBeenCalled();
  });

  it('archives the local draft and closes its work when preflight finds a closed posting', async () => {
    const application = record({
      coverLetterMode: 'none',
      id: 'app-closed',
      opportunityId: 'opp-1',
      resumeMode: 'default',
      status: 'application_drafting',
    });
    mocks.collections.set('Application', collection([application]));
    mocks.requireFreshPostingPreflight.mockImplementationOnce(
      async (options?: { onClosed?: () => Promise<void> }) => {
        await options?.onClosed?.();
        throw {
          body: {
            message:
              'This posting is closed and has been archived. Application work cannot continue.',
          },
          status: 409,
        };
      },
    );

    await expect(
      generateApplicationPackage('app-closed'),
    ).rejects.toMatchObject({
      status: 409,
    });

    expect(application).toMatchObject({ status: 'archived' });
    expect(mocks.syncApplicationWorkflowTasks).toHaveBeenCalledWith(
      application,
    );
    expect(mocks.fsWrite).not.toHaveBeenCalled();
  });

  it('preserves application-owned resume assets when planning refreshes default resume mode', async () => {
    const application = record({
      coverLetterMode: 'none',
      id: 'app-owned-resume',
      opportunityId: 'opp-1',
      resumeAssetId: 'resume-app',
      resumeMode: 'default',
      status: 'awaiting_user',
    });
    mocks.collections.set('Application', collection([application]));
    mocks.processOpportunityIntelligence.mockImplementationOnce(async () => {
      application.resumeAssetId = 'resume-default';
      return { status: 'processed' };
    });

    const result = await generateApplicationPackage('app-owned-resume');

    expect(result).toMatchObject({
      packetAssetId: expect.any(String),
      resumeAssetId: 'resume-app',
      status: 'awaiting_user',
    });
    expect(application).toMatchObject({
      resumeAssetId: 'resume-app',
    });
    expect(mocks.recordAgentAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        output: expect.objectContaining({
          resumeAssetId: 'resume-app',
        }),
      }),
    );
  });

  it('generates a tailored resume variant when requested', async () => {
    mocks.collections.set(
      'Opportunity',
      collection([
        record({
          companyId: 'company-1',
          id: 'opp-1',
          title: 'AI Engineer',
        }),
      ]),
    );
    mocks.collections.set(
      'Application',
      collection([
        record({
          coverLetterMode: 'none',
          id: 'app-2',
          opportunityId: 'opp-1',
          resumeMode: 'generate_tailored',
        }),
      ]),
    );

    const result = await generateApplicationPackage('app-2');

    const variant = mocks.collections.get('ResumeVariant')?.records[0];
    expect(variant).toMatchObject({
      applicationId: 'app-2',
      companyId: 'company-1',
      generatedPath: 'generated-resumes/resume-generated',
      markdownPath: 'generated-resumes/resume-generated/resume.md',
      opportunityId: 'opp-1',
      outputSlug: 'variant-slug',
      pdfPath: 'generated-resumes/resume-generated/resume.pdf',
      resumeAssetId: 'resume-generated',
      status: 'generated',
      textPath: 'generated-resumes/resume-generated/resume.txt',
    });
    expect(result).toMatchObject({
      resumeAssetId: 'resume-generated',
      resumeVariantId: variant?.id,
    });
    expect(mocks.generateResumeAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        targetOpportunityId: 'opp-1',
        tailoringName: 'AI Engineer resume variant',
      }),
    );
  });

  it('passes existing resume variant overrides into tailored generation', async () => {
    mocks.collections.set(
      'ResumeVariant',
      collection([
        record({
          applicationId: 'app-variant',
          emphasizeTags: 'agentic\nplatform',
          excludePositionIds: 'legacy-role',
          id: 'variant-1',
          includePositionIds: 'anytown\nhappy-vertical',
          name: 'Existing variant',
          opportunityId: 'opp-1',
          outputSlug: 'existing-variant',
          status: 'draft',
          summaryOverride: 'Variant summary',
          tailoringConfigId: 'tailoring-1',
          titleOverride: 'Staff AI Engineer',
        }),
      ]),
    );
    mocks.collections.set(
      'Application',
      collection([
        record({
          coverLetterMode: 'none',
          id: 'app-variant',
          opportunityId: 'opp-1',
          resumeMode: 'generate_tailored',
          resumeVariantId: 'variant-1',
        }),
      ]),
    );

    await generateApplicationPackage('app-variant');

    expect(mocks.generateResumeAsset).toHaveBeenCalledWith(
      expect.objectContaining({
        tailoring: expect.objectContaining({
          emphasizeTags: ['agentic', 'platform'],
          excludePositionIds: ['legacy-role'],
          includePositionIds: ['anytown', 'happy-vertical'],
          name: 'Existing variant',
          outputSlug: 'existing-variant',
          summary: 'Variant summary',
          title: 'Staff AI Engineer',
        }),
        tailoringId: 'tailoring-1',
        tailoringName: 'Existing variant',
        tailoringSlug: 'existing-variant',
      }),
    );
  });

  it('does not overwrite an existing resume variant that changes during generation', async () => {
    const variants = collection([
      record({
        applicationId: 'app-variant-race',
        id: 'variant-race',
        opportunityId: 'opp-1',
        status: 'draft',
        updated_at: '2026-08-28T12:00:00.000Z',
      }),
    ]);
    mocks.collections.set('ResumeVariant', variants);
    mocks.collections.set(
      'Application',
      collection([
        record({
          coverLetterMode: 'none',
          id: 'app-variant-race',
          opportunityId: 'opp-1',
          resumeMode: 'generate_tailored',
          resumeVariantId: 'variant-race',
        }),
      ]),
    );
    mocks.commitResumeVariantIfCurrent.mockResolvedValueOnce(false);

    await expect(
      generateApplicationPackage('app-variant-race'),
    ).rejects.toMatchObject({
      body: {
        message:
          'Resume variant changed while materials were generated. Reload and review the current application.',
      },
      status: 409,
    });

    expect(variants.records[0]).toMatchObject({
      applicationId: 'app-variant-race',
      id: 'variant-race',
      opportunityId: 'opp-1',
      status: 'draft',
    });
    expect(variants.records[0]).not.toHaveProperty('resumeAssetId');
    expect(variants.records[0]?.save).not.toHaveBeenCalled();
    expect(mocks.collections.get('ResumeAsset')?.records).toHaveLength(0);
    expect(mocks.fsDelete).toHaveBeenCalledTimes(8);
    expect(mocks.recordAgentAudit).not.toHaveBeenCalled();
  });

  it('rejects preselected resume variants tied to another opportunity', async () => {
    mocks.collections.set(
      'ResumeVariant',
      collection([
        record({
          id: 'variant-other',
          opportunityId: 'opp-other',
        }),
      ]),
    );
    mocks.collections.set(
      'Application',
      collection([
        record({
          coverLetterMode: 'none',
          id: 'app-variant',
          opportunityId: 'opp-1',
          resumeMode: 'generate_tailored',
          resumeVariantId: 'variant-other',
        }),
      ]),
    );

    await expectHttpError(
      () => generateApplicationPackage('app-variant'),
      'Resume variant belongs to another opportunity.',
    );
    expect(mocks.generateResumeAsset).not.toHaveBeenCalled();
  });

  it('rejects preselected archived resume variants', async () => {
    mocks.collections.set(
      'ResumeVariant',
      collection([
        record({
          id: 'variant-archived',
          opportunityId: 'opp-1',
          status: 'archived',
        }),
      ]),
    );
    mocks.collections.set(
      'Application',
      collection([
        record({
          coverLetterMode: 'none',
          id: 'app-variant',
          opportunityId: 'opp-1',
          resumeMode: 'generate_tailored',
          resumeVariantId: 'variant-archived',
        }),
      ]),
    );

    await expectHttpError(
      () => generateApplicationPackage('app-variant'),
      'Resume variant is archived.',
    );
    expect(mocks.generateResumeAsset).not.toHaveBeenCalled();
  });

  it('does not reuse another application resume variant by opportunity fallback', async () => {
    const variants = collection([
      record({
        applicationId: 'app-old',
        id: 'variant-old',
        opportunityId: 'opp-1',
      }),
    ]);
    mocks.collections.set('ResumeVariant', variants);
    mocks.collections.set(
      'Application',
      collection([
        record({
          coverLetterMode: 'none',
          id: 'app-new',
          opportunityId: 'opp-1',
          resumeMode: 'generate_tailored',
        }),
      ]),
    );

    const result = await generateApplicationPackage('app-new');
    const newVariant = variants.records.find(
      (variant) => variant.id !== 'variant-old',
    );

    expect(
      variants.records.find((variant) => variant.id === 'variant-old'),
    ).toMatchObject({
      applicationId: 'app-old',
    });
    expect(newVariant).toMatchObject({
      applicationId: 'app-new',
      opportunityId: 'opp-1',
      resumeAssetId: 'resume-generated',
    });
    expect(result).toMatchObject({ resumeVariantId: newVariant?.id });
  });

  it('does not reuse archived resume variants by opportunity fallback', async () => {
    const variants = collection([
      record({
        id: 'variant-archived',
        opportunityId: 'opp-1',
        status: 'archived',
      }),
    ]);
    mocks.collections.set('ResumeVariant', variants);
    mocks.collections.set(
      'Application',
      collection([
        record({
          coverLetterMode: 'none',
          id: 'app-new',
          opportunityId: 'opp-1',
          resumeMode: 'generate_tailored',
        }),
      ]),
    );

    const result = await generateApplicationPackage('app-new');
    const newVariant = variants.records.find(
      (variant) => variant.id !== 'variant-archived',
    );

    expect(
      variants.records.find((variant) => variant.id === 'variant-archived'),
    ).toMatchObject({
      status: 'archived',
    });
    expect(newVariant).toMatchObject({
      applicationId: 'app-new',
      opportunityId: 'opp-1',
      resumeAssetId: 'resume-generated',
      status: 'generated',
    });
    expect(result).toMatchObject({ resumeVariantId: newVariant?.id });
  });

  it('does not reuse archived resume variants by application fallback', async () => {
    const variants = collection([
      record({
        applicationId: 'app-new',
        id: 'variant-archived',
        opportunityId: 'opp-1',
        status: 'archived',
      }),
    ]);
    mocks.collections.set('ResumeVariant', variants);
    mocks.collections.set(
      'Application',
      collection([
        record({
          coverLetterMode: 'none',
          id: 'app-new',
          opportunityId: 'opp-1',
          resumeMode: 'generate_tailored',
        }),
      ]),
    );

    const result = await generateApplicationPackage('app-new');
    const newVariant = variants.records.find(
      (variant) => variant.id !== 'variant-archived',
    );

    expect(newVariant).toMatchObject({
      applicationId: 'app-new',
      opportunityId: 'opp-1',
      resumeAssetId: 'resume-generated',
      status: 'generated',
    });
    expect(result).toMatchObject({ resumeVariantId: newVariant?.id });
  });

  it('writes a cover-letter asset when the cover letter mode is generate', async () => {
    const applications = collection([
      record({
        coverLetterMode: 'generate',
        id: 'app-3',
        opportunityId: 'opp-1',
        resumeAssetId: 'resume-default',
        resumeMode: 'default',
      }),
    ]);
    mocks.collections.set('Application', applications);
    mocks.collections.set(
      'CandidateProfile',
      collection([record({ id: 'candidate-1', isDefault: true })]),
    );
    mocks.collections.set(
      'Fact',
      collection([
        record({
          id: 'candidate-active',
          status: 'active',
          textRefined: 'Verified candidate platform experience.',
        }),
      ]),
    );
    mocks.factSubjectGetForEntity.mockImplementation(
      async (entityType: string, entityId: string) =>
        entityType === 'CandidateProfile' && entityId === 'candidate-1'
          ? [{ factId: 'candidate-active' }]
          : [],
    );
    mocks.factEvidenceGetForFact.mockResolvedValue([
      { id: 'evidence-candidate', status: 'supports' },
    ]);
    enableCoverLetterGeneration();

    const result = await generateApplicationPackage('app-3');

    // Cover letter and packet each write markdown + text + HTML + PDF.
    expect(mocks.fsWrite).toHaveBeenCalledTimes(8);
    const assets = mocks.collections.get('ResumeAsset')?.records ?? [];
    const coverLetter = assets.find(
      (asset) => asset.assetType === 'cover_letter',
    );
    const packet = assets.find(
      (asset) => asset.assetType === 'application_packet',
    );
    expect(coverLetter).toMatchObject({
      assetType: 'cover_letter',
      status: 'generated',
    });
    expect(packet).toMatchObject({
      assetType: 'application_packet',
      status: 'generated',
    });
    expect(coverLetter?.pdfPath).toMatch(
      /^application-packages\/app-3\/cover-letter-\d+-[\da-f-]+\.pdf$/,
    );
    expect(packet?.pdfPath).toMatch(
      /^application-packages\/app-3\/packet-\d+-[\da-f-]+\.pdf$/,
    );
    expect(result).toMatchObject({
      coverLetterAssetId: coverLetter?.id,
      packetAssetId: packet?.id,
    });
  });

  it('grounds generated cover letters only in verified candidate facts', async () => {
    const chat = vi.fn<
      (
        messages: Array<{ content: string; role: string }>,
        options: unknown,
      ) => Promise<{ content: string }>
    >(async () => ({ content: 'Evidence-backed letter.' }));
    mocks.collections.set(
      'Application',
      collection([
        record({
          coverLetterMode: 'generate',
          id: 'app-grounded-cover-letter',
          opportunityId: 'opp-1',
          resumeMode: 'default',
        }),
      ]),
    );
    mocks.collections.set(
      'CandidateProfile',
      collection([record({ id: 'candidate-1', isDefault: true })]),
    );
    mocks.collections.set(
      'Fact',
      collection([
        record({
          id: 'candidate-active',
          status: 'active',
          textRefined: 'Verified candidate platform experience.',
        }),
        record({
          id: 'candidate-pending',
          status: 'pending',
          textRefined: 'Unverified candidate claim.',
        }),
        record({
          id: 'opportunity-active',
          status: 'active',
          textRefined: 'Employer research, not candidate evidence.',
        }),
      ]),
    );
    mocks.factSubjectGetForEntity.mockImplementation(
      async (entityType: string, entityId: string) => {
        if (entityType === 'CandidateProfile' && entityId === 'candidate-1') {
          return [
            { factId: 'candidate-active' },
            { factId: 'candidate-pending' },
          ];
        }
        if (entityType === 'Opportunity' && entityId === 'opp-1') {
          return [{ factId: 'opportunity-active' }];
        }
        return [];
      },
    );
    mocks.factEvidenceGetForFact.mockImplementation(async (factId: string) =>
      factId === 'candidate-active'
        ? [{ id: 'evidence-candidate', status: 'supports' }]
        : [{ id: `evidence-${factId}`, status: 'supports' }],
    );
    enableCoverLetterGeneration();
    mocks.resolveWritingAiProfileClient.mockResolvedValue({
      aiClient: { chat },
      model: 'test-writing-model',
      timeout: 1_000,
    });

    await generateApplicationPackage('app-grounded-cover-letter');

    const prompt = String(chat.mock.calls[0]?.[0]?.[1]?.content ?? '');
    expect(prompt).toContain('Verified candidate platform experience.');
    expect(prompt).not.toContain('Unverified candidate claim.');
    expect(prompt).not.toContain('Employer research, not candidate evidence.');
    expect(prompt).not.toContain(
      'Example Candidate builds reliable AI and platform systems from verified experience.',
    );
    expect(prompt).not.toContain('senior AI/platform engineer');
    const coverLetter = (
      mocks.collections.get('ResumeAsset')?.records ?? []
    ).find((asset) => asset.assetType === 'cover_letter');
    expect(JSON.parse(String(coverLetter?.notes))).toMatchObject({
      factIds: ['candidate-active'],
    });
    const packet = (mocks.collections.get('ResumeAsset')?.records ?? []).find(
      (asset) => asset.assetType === 'application_packet',
    );
    expect(JSON.parse(String(packet?.notes))).toMatchObject({
      factIds: ['candidate-active'],
      linkedFactIds: expect.arrayContaining([
        'candidate-active',
        'candidate-pending',
        'opportunity-active',
      ]),
    });
    const packetMarkdown = mocks.fsWrite.mock.calls.find(
      ([path]) =>
        typeof path === 'string' &&
        path.includes('/packet-') &&
        path.endsWith('.md'),
    )?.[1];
    expect(packetMarkdown).toContain('### Verified candidate evidence');
    expect(packetMarkdown).toContain(
      'verified candidate evidence; status: active.',
    );
    expect(packetMarkdown).toContain(
      '### Additional linked context (not verified candidate evidence)',
    );
    expect(packetMarkdown).toContain(
      'linked context only; verify before use; status: pending.',
    );
  });

  it('reports an actionable error instead of binding generic cover-letter boilerplate', async () => {
    mocks.collections.set(
      'Application',
      collection([
        record({
          coverLetterMode: 'generate',
          id: 'app-cover-letter-unavailable',
          opportunityId: 'opp-1',
          resumeAssetId: 'resume-default',
          resumeMode: 'default',
        }),
      ]),
    );
    enableCoverLetterGeneration();

    await expect(
      generateApplicationPackage('app-cover-letter-unavailable'),
    ).rejects.toMatchObject({
      body: {
        message:
          'Could not generate a cover letter from verified candidate evidence. Add or verify the candidate facts and retry, or choose a different cover-letter mode.',
      },
      status: 422,
    });
    expect(mocks.collections.get('ResumeAsset')?.records).toEqual([
      expect.objectContaining({ id: 'resume-default' }),
    ]);
    expect(mocks.fsWrite).not.toHaveBeenCalled();
  });

  it('adds the fetched ATS questions to the packet before review artifacts are rendered', async () => {
    mocks.collections.set(
      'Application',
      collection([
        record({
          coverLetterMode: 'none',
          id: 'app-ats-questions',
          opportunityId: 'opp-1',
          resumeMode: 'default',
        }),
      ]),
    );
    mocks.persistApplicationFormSchema.mockImplementation(
      async (application) => {
        application.requiredQuestionsJson = JSON.stringify({
          ats: 'greenhouse',
          boardToken: 'acme',
          fetchedAt: '2026-08-28T00:00:00.000Z',
          jobId: '123',
          questions: [
            {
              id: 'why-this-role',
              label: 'Why this role?',
              required: true,
              type: 'textarea',
            },
          ],
        });
        return { ats: 'greenhouse', persisted: true, questionCount: 1 };
      },
    );

    await generateApplicationPackage('app-ats-questions');

    const packetMarkdown = mocks.fsWrite.mock.calls.find(
      ([path]) => typeof path === 'string' && path.endsWith('.md'),
    )?.[1];
    expect(packetMarkdown).toContain('### ATS application questions');
    expect(packetMarkdown).toContain(
      'Required: Why this role? — user input required; do not infer or submit without an answer.',
    );
    expect(
      mocks.persistApplicationFormSchema.mock.invocationCallOrder[0],
    ).toBeLessThan(mocks.fsWrite.mock.invocationCallOrder[0]);
  });

  it('does not present a stale ATS schema when the refresh is unavailable', async () => {
    const application = record({
      coverLetterMode: 'none',
      id: 'app-stale-ats-schema',
      opportunityId: 'opp-1',
      requiredQuestionsJson: JSON.stringify({
        ats: 'greenhouse',
        boardToken: 'old-board',
        fetchedAt: '2026-08-20T00:00:00.000Z',
        jobId: 'old-job',
        questions: [
          {
            id: 'old-question',
            label: 'Old required question',
            required: true,
            type: 'textarea',
          },
        ],
      }),
      resumeMode: 'default',
    });
    mocks.collections.set('Application', collection([application]));

    await generateApplicationPackage('app-stale-ats-schema');

    const packetMarkdown = mocks.fsWrite.mock.calls.find(
      ([path]) =>
        typeof path === 'string' &&
        path.includes('/packet-') &&
        path.endsWith('.md'),
    )?.[1];
    expect(packetMarkdown).toContain(
      'No supported ATS form schema was available while this packet was prepared.',
    );
    expect(packetMarkdown).not.toContain('Old required question');
    expect(application.requiredQuestionsJson).toBe('');
  });

  it('invalidates approval when generated materials are refreshed', async () => {
    mocks.collections.set(
      'Application',
      collection([
        record({
          approvedAt: new Date('2026-06-04T10:00:00.000Z'),
          approvedByProfileId: 'profile-1',
          approvedByUserId: 'user-1',
          coverLetterMode: 'none',
          id: 'app-4',
          opportunityId: 'opp-1',
          resumeAssetId: 'resume-default',
          resumeMode: 'default',
          status: 'approved',
        }),
      ]),
    );

    await expect(generateApplicationPackage('app-4')).rejects.toMatchObject({
      body: {
        message:
          'Clear final approval before regenerating application materials.',
      },
      status: 409,
    });
  });

  it('does not bind generated materials when the application changes mid-generation', async () => {
    const applications = collection([
      record({
        coverLetterMode: 'none',
        id: 'app-race',
        opportunityId: 'opp-1',
        resumeMode: 'default',
        status: 'awaiting_user',
      }),
    ]);
    mocks.collections.set('Application', applications);
    mocks.commitApplicationIfCurrent.mockResolvedValueOnce(false);

    await expect(generateApplicationPackage('app-race')).rejects.toMatchObject({
      body: {
        message:
          'Application changed while materials were generated. Reload and review the current application.',
      },
      status: 409,
    });
    expect(applications.records[0]?.packetAssetId).toBeUndefined();
    expect(applications.records[0]).toMatchObject({ status: 'awaiting_user' });
    expect(mocks.collections.get('ResumeAsset')?.records).toHaveLength(0);
    expect(mocks.fsDelete).toHaveBeenCalledTimes(4);
    expect(mocks.recordAgentAudit).not.toHaveBeenCalled();
  });

  it('rejects package generation after application materials are locked', async () => {
    mocks.collections.set(
      'Application',
      collection([
        record({
          coverLetterMode: 'none',
          id: 'app-5',
          opportunityId: 'opp-1',
          resumeMode: 'default',
          status: 'submitted',
        }),
      ]),
    );

    await expectHttpError(
      () => generateApplicationPackage('app-5'),
      'Submitted or closed applications cannot have their approved materials changed.',
    );
  });

  it('rejects when the application does not exist', async () => {
    mocks.collections.set('Application', collection());
    let status: number | undefined;
    try {
      await generateApplicationPackage('missing');
    } catch (thrown) {
      status = (thrown as { status?: number }).status;
    }
    expect(status).toBe(404);
  });
});
