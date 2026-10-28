import { beforeEach, describe, expect, it, vi } from 'vitest';

const services = vi.hoisted(() => ({
  acceptFactCandidate: vi.fn(async () => ({ accepted: true })),
  archiveApplicationForCleanup: vi.fn(async () => ({
    canceled: 2,
    status: 'archived',
  })),
  createFactIntakeFromText: vi.fn(async () => ({ intakeId: 'intake-1' })),
  enqueue: vi.fn(async () => ({
    job: { id: 'job-1' },
    sourceDependency: null,
    stage: 'assessment',
  })),
  ensureCompanyResearch: vi.fn(async () => ({
    careersSourceCreated: false,
    careersSourceId: '',
    researchTaskId: 'task-9',
  })),
  getPrivateRecord: vi.fn(),
  processRecommendationTask: vi.fn(async () => ({ decision: 'reject' })),
  sync: vi.fn(async () => ({ closed: 0, created: 1, existing: 2, scanned: 3 })),
  updateOpportunityReview: vi.fn(async () => ({ id: 'decision-1' })),
}));
const subject = {
  profileId: 'profile-1',
  tenantId: 'tenant-1',
  userId: 'user-1',
};

vi.mock('./application-workflow.js', () => ({
  archiveApplicationForCleanup: services.archiveApplicationForCleanup,
  ensureCompanyResearch: services.ensureCompanyResearch,
  processRecommendationTask: services.processRecommendationTask,
  syncRecommendedOpportunityDecisionTasks: services.sync,
}));
vi.mock('./application-package.js', () => ({
  updateOpportunityReview: services.updateOpportunityReview,
}));
vi.mock('./fact-workflow.js', () => ({
  acceptFactCandidate: services.acceptFactCandidate,
  createFactIntakeFromText: services.createFactIntakeFromText,
}));
vi.mock('./opportunity-intelligence-job.js', () => ({
  enqueueOpportunityIntelligenceWithStatus: services.enqueue,
  isOpportunityIntelligenceEnqueueError: (cause: unknown) =>
    cause instanceof Error && cause.message.startsWith('enqueue:'),
}));
vi.mock('./private-workspace.js', () => ({
  getPrivateRecord: services.getPrivateRecord,
}));
vi.mock('./workspace-resource-policy.js', () => ({
  requireCandidateWorkspaceSubject: () => subject,
}));

import {
  executeWorkflowTool,
  validateWorkflowToolArguments,
} from './workflow-tools.js';

const user = { id: 'user-1' };

describe('owner workflow tools call the page actions’ service functions with the context subject', () => {
  beforeEach(() => {
    for (const mock of Object.values(services)) mock.mockClear();
    services.getPrivateRecord.mockReset();
  });

  it('validates against the published schemas', () => {
    expect(
      validateWorkflowToolArguments('opportunity_review', {
        humanReviewStatus: 'maybe',
        opportunityId: 'opp-1',
      }).ok,
    ).toBe(true);
    expect(
      validateWorkflowToolArguments('opportunity_review', {
        humanReviewStatus: 'later',
        opportunityId: 'opp-1',
      }).ok,
    ).toBe(false);
    expect(
      validateWorkflowToolArguments('fact_intake_create', { rawText: '' }).ok,
    ).toBe(false);
    expect(
      validateWorkflowToolArguments('recommendation_task_process', {
        decision: ' accept_to_apply',
        taskId: 'task-1',
      }).ok,
    ).toBe(false);
    expect(validateWorkflowToolArguments('nope', {}).ok).toBe(false);
  });

  it('maps each tool to its service with the verified subject and user', async () => {
    await executeWorkflowTool(
      'opportunity_review',
      {
        humanRating: 4,
        humanReviewNotes: ' strong ',
        humanReviewStatus: 'apply',
        opportunityId: 'opp-1',
      },
      user,
    );
    expect(services.updateOpportunityReview).toHaveBeenCalledWith({
      humanRating: 4,
      humanReviewNotes: 'strong',
      humanReviewStatus: 'apply',
      opportunityId: 'opp-1',
      subject,
      user,
    });

    expect(
      await executeWorkflowTool(
        'opportunity_assess',
        { opportunityId: 'opp-1' },
        user,
      ),
    ).toEqual({
      jobId: 'job-1',
      sourceDependency: null,
      stage: 'assessment',
      status: 'queued',
    });
    expect(services.enqueue).toHaveBeenCalledWith('opp-1', {
      modes: 'assessment',
    });
    services.enqueue.mockRejectedValueOnce(new Error('enqueue: budget'));
    expect(
      await executeWorkflowTool(
        'opportunity_assess',
        { opportunityId: 'opp-1' },
        user,
      ),
    ).toEqual({ message: 'enqueue: budget', status: 'error' });

    expect(
      await executeWorkflowTool('recommendation_tasks_sync', {}, user),
    ).toMatchObject({ created: 1, status: 'synced' });
    expect(services.sync).toHaveBeenCalledWith(subject);

    await executeWorkflowTool(
      'recommendation_task_process',
      { decision: 'reject', reason: 'not now', taskId: 'task-1' },
      user,
    );
    expect(services.processRecommendationTask).toHaveBeenCalledWith({
      decision: 'reject',
      preflightOverrideReason: '',
      reason: 'not now',
      subject,
      taskId: 'task-1',
      user,
    });

    expect(
      await executeWorkflowTool(
        'company_research_request',
        { companyId: 'co-1', reason: 'why' },
        user,
      ),
    ).toMatchObject({ researchTaskId: 'task-9', status: 'queued' });
    expect(services.ensureCompanyResearch).toHaveBeenCalledWith({
      companyId: 'co-1',
      createdBy: 'owner',
      opportunityId: undefined,
      reason: 'why',
      subject,
    });

    await executeWorkflowTool(
      'fact_intake_create',
      { rawText: 'Led a migration', sourceKind: 'note' },
      user,
    );
    expect(services.createFactIntakeFromText).toHaveBeenCalledWith({
      intakeContext: undefined,
      rawText: 'Led a migration',
      sourceKind: 'note',
      subject,
      targetEntityId: undefined,
      targetEntityType: undefined,
    });

    await executeWorkflowTool(
      'fact_candidate_accept',
      { candidateId: 'fc-1' },
      user,
    );
    expect(services.acceptFactCandidate).toHaveBeenCalledWith({
      candidateId: 'fc-1',
      subject,
    });
  });

  it('archives only an owned application', async () => {
    services.getPrivateRecord.mockResolvedValueOnce(null);
    expect(
      await executeWorkflowTool(
        'application_archive',
        { applicationId: 'app-2' },
        user,
      ),
    ).toEqual({ message: 'Application not found.', status: 'error' });
    expect(services.archiveApplicationForCleanup).not.toHaveBeenCalled();
    const owned = { id: 'app-1' };
    services.getPrivateRecord.mockResolvedValueOnce(owned);
    expect(
      await executeWorkflowTool(
        'application_archive',
        { applicationId: 'app-1' },
        user,
      ),
    ).toEqual({ canceled: 2, status: 'archived' });
    expect(services.getPrivateRecord).toHaveBeenCalledWith(
      'Application',
      'app-1',
      subject,
    );
    expect(services.archiveApplicationForCleanup).toHaveBeenCalledWith(
      owned,
      subject,
    );
  });
});
