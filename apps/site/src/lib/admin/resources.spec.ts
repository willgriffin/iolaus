import { describe, expect, it } from 'vitest';
import {
  adminResources,
  displayFieldLabel,
  getAdminResource,
  referenceForField,
  referenceIsEditable,
} from './resources';

describe('adminResources', () => {
  it('uses app-owned profile and company source resources instead of legacy people', () => {
    expect(getAdminResource('people')).toBeUndefined();
    expect(getAdminResource('companies')?.className).toBe('Company');
    expect(getAdminResource('candidate-profiles')?.className).toBe(
      'CandidateProfile',
    );
    expect(getAdminResource('company-research')?.className).toBe(
      'CompanyResearch',
    );
  });

  it('keeps workflow resource labels aligned with the user-facing admin nav', () => {
    expect(getAdminResource('candidate-profiles')).toMatchObject({
      label: 'Profiles',
      singularLabel: 'profile',
    });
    expect(getAdminResource('fact-intakes')).toMatchObject({
      label: 'Notes',
      singularLabel: 'note',
    });
    expect(getAdminResource('fact-candidates')).toMatchObject({
      label: 'Review queue',
      singularLabel: 'review item',
    });
  });

  it('exposes profile, user, tag, and place IDs for agent-editable workflow data', () => {
    expect(
      getAdminResource('opportunities')?.fields.map((field) => field.key),
    ).toContain('organizationProfileId');
    expect(
      getAdminResource('opportunities')?.fields.map((field) => field.key),
    ).toEqual(
      expect.arrayContaining([
        'humanRating',
        'humanReviewStatus',
        'humanReviewNotes',
        'reviewedByUserId',
        'reviewedByProfileId',
        'reviewedAt',
      ]),
    );
    expect(
      getAdminResource('opportunities')?.fields.map((field) => field.key),
    ).toEqual(
      expect.arrayContaining([
        'companyId',
        'sourceId',
        'sourceContentFingerprint',
        'sourceContentVersion',
        'sourceContentJson',
        'sourceIntelligenceStatus',
        'sourceIntelligenceJobId',
        'locations',
        'requiredSkills',
        'preferredSkills',
        'domainTags',
        'roleTags',
      ]),
    );
    expect(
      getAdminResource('opportunities')?.fields.find(
        (field) => field.key === 'companyId',
      ),
    ).toMatchObject({
      combo: {
        className: 'Company',
        labelKey: 'name',
      },
      kind: 'combo',
    });
    expect(
      getAdminResource('opportunities')?.fields.find(
        (field) => field.key === 'sourceId',
      ),
    ).toMatchObject({
      combo: {
        allowCreate: false,
        className: 'Source',
        labelKey: 'name',
      },
      kind: 'combo',
    });
    expect(
      getAdminResource('applications')?.fields.map((field) => field.key),
    ).toEqual(
      expect.arrayContaining([
        'approvedByUserId',
        'approvedByProfileId',
        'approvalScope',
        'applyMethod',
        'resumeMode',
        'coverLetterMode',
        'applicationInstructions',
        'requiredAnswers',
        'dueAt',
        'packetAssetId',
        'resumeVariantId',
        'accountStatus',
        'accountLoginIdentity',
        'wardenReference',
      ]),
    );
    expect(getAdminResource('tasks')?.fields.map((field) => field.key)).toEqual(
      expect.arrayContaining([
        'applicationId',
        'assigneeRole',
        'blockerOwnerRole',
        'blockerReason',
        'kanbanColumn',
      ]),
    );
    expect(
      getAdminResource('opportunity-tags')?.fields.map((field) => field.key),
    ).toEqual(expect.arrayContaining(['opportunityId', 'tagId', 'tagRole']));
    expect(
      getAdminResource('opportunity-tags')?.fields.find(
        (field) => field.key === 'tagId',
      ),
    ).toMatchObject({
      combo: {
        allowCreate: false,
        className: 'Tag',
        displayKeys: ['context', 'name', 'slug'],
        valueKey: 'id',
      },
      kind: 'combo',
    });
    expect(
      getAdminResource('opportunity-places')?.fields.map((field) => field.key),
    ).toEqual(
      expect.arrayContaining(['opportunityId', 'placeId', 'placeRole']),
    );
    expect(
      getAdminResource('source-crawls')?.fields.map((field) => field.key),
    ).toEqual(
      expect.arrayContaining([
        'sourceId',
        'query',
        'tagsJson',
        'filtersJson',
        'preferenceSnapshotJson',
        'agentRunId',
        'jobId',
        'intelligenceEnqueueCap',
        'intelligenceEnqueuedCount',
        'intelligenceDuplicateCount',
        'intelligenceSkippedCount',
      ]),
    );
    expect(
      getAdminResource('skills')?.fields.map((field) => field.key),
    ).toEqual(expect.arrayContaining(['categoryId', 'tagId']));
    expect(
      getAdminResource('achievements')?.fields.map((field) => field.key),
    ).toEqual(
      expect.arrayContaining(['experienceId', 'projectId', 'resumePlacement']),
    );
  });

  it('exposes project URLs for admin editing and resume rendering', () => {
    const projects = getAdminResource('projects');

    expect(projects?.tableColumns).toEqual(expect.arrayContaining(['url']));
    expect(projects?.fields.find((field) => field.key === 'url')).toMatchObject(
      {
        kind: 'text',
        label: 'URL',
      },
    );
  });

  it('exposes experience URLs for admin editing and resume rendering', () => {
    const experience = getAdminResource('experience');

    expect(experience?.tableColumns).toEqual(expect.arrayContaining(['url']));
    expect(
      experience?.fields.find((field) => field.key === 'url'),
    ).toMatchObject({
      kind: 'text',
      label: 'URL',
    });
  });

  it('preserves provenance from crawl reconciliation through scores and decisions', () => {
    expect(
      getAdminResource('source-crawl-items')?.fields.map((field) => field.key),
    ).toEqual(
      expect.arrayContaining([
        'sourceCrawlId',
        'opportunityId',
        'duplicateOfSourceCrawlItemId',
        'reconciliationStatus',
        'reconciliationKey',
        'matchStrategy',
        'matchConfidence',
        'contentFingerprint',
        'contentVersion',
        'intelligenceEnqueueStatus',
        'intelligenceJobId',
      ]),
    );
    expect(
      getAdminResource('evaluation-scores')?.fields.map((field) => field.key),
    ).toEqual(
      expect.arrayContaining([
        'opportunityId',
        'sourceCrawlId',
        'sourceCrawlItemId',
      ]),
    );
    expect(
      getAdminResource('decisions')?.fields.map((field) => field.key),
    ).toEqual(
      expect.arrayContaining([
        'opportunityId',
        'sourceCrawlId',
        'sourceCrawlItemId',
        'evaluationScoreId',
        'decisionTags',
      ]),
    );
    expect(
      getAdminResource('applications')?.fields.map((field) => field.key),
    ).toEqual(
      expect.arrayContaining([
        'opportunityId',
        'applicationUrl',
        'sourceCrawlId',
        'sourceCrawlItemId',
        'evaluationScoreId',
        'decisionId',
      ]),
    );
  });

  it('exposes application-aware task workflow options', () => {
    expect(
      getAdminResource('tasks')?.fields.find(
        (field) => field.key === 'taskType',
      ),
    ).toMatchObject({
      options: expect.arrayContaining([
        'review_recommendation',
        'prepare_application_packet',
        'approve_application',
        'submit_application',
        'follow_up',
        'interview_prep',
      ]),
    });
    expect(
      getAdminResource('tasks')?.fields.find(
        (field) => field.key === 'kanbanColumn',
      ),
    ).toMatchObject({
      options: expect.arrayContaining([
        'needs_user_decision',
        'materials_drafting',
        'ready_for_user_review',
        'approved_to_submit',
        'follow_up',
        'blocked',
      ]),
    });
    expect(
      getAdminResource('decisions')?.fields.find(
        (field) => field.key === 'decision',
      ),
    ).toMatchObject({
      options: expect.arrayContaining([
        'accept_to_apply',
        'request_more_research',
        'revise_score',
      ]),
    });
  });

  it('describes reference fields without exposing raw UUIDs as form labels', () => {
    const applicationIdField = getAdminResource('tasks')?.fields.find(
      (field) => field.key === 'applicationId',
    );
    const sourceAssetField = getAdminResource('resume-assets')?.fields.find(
      (field) => field.key === 'sourceAssetId',
    );
    const reviewerUserField = getAdminResource(
      'application-material-comments',
    )?.fields.find((field) => field.key === 'reviewerUserId');
    const sourceOwnerField = getAdminResource('sources')?.fields.find(
      (field) => field.key === 'ownerProfileId',
    );
    const decisionUserField = getAdminResource('decisions')?.fields.find(
      (field) => field.key === 'deciderUserId',
    );
    const companyResearchField = getAdminResource(
      'opportunity-companies',
    )?.fields.find((field) => field.key === 'companyResearchId');

    if (
      !applicationIdField ||
      !sourceAssetField ||
      !reviewerUserField ||
      !sourceOwnerField ||
      !decisionUserField ||
      !companyResearchField
    ) {
      throw new Error('Expected reference field fixtures.');
    }

    expect(referenceForField(applicationIdField)).toMatchObject({
      className: 'Application',
      resourceSlug: 'applications',
    });
    expect(referenceForField(sourceAssetField)).toMatchObject({
      editable: false,
      resourceSlug: 'resume-assets',
    });
    expect(referenceForField(reviewerUserField)).toMatchObject({
      editable: false,
    });
    expect(referenceForField(sourceOwnerField)).toMatchObject({
      className: 'CandidateProfile',
      resourceSlug: 'candidate-profiles',
    });
    expect(referenceForField(decisionUserField)).toMatchObject({
      editable: false,
    });
    expect(referenceForField(companyResearchField)).toMatchObject({
      className: 'CompanyResearch',
      labelKeys: ['websiteUrl', 'researchStatus'],
      resourceSlug: 'company-research',
    });
    expect(displayFieldLabel(sourceOwnerField)).toBe('Owner profile');
    expect(referenceIsEditable(sourceAssetField)).toBe(false);
  });

  it('uses lifecycle-defined status options for opportunities and applications', () => {
    expect(
      getAdminResource('opportunities')?.fields.find(
        (field) => field.key === 'status',
      ),
    ).toMatchObject({
      options: [
        'found',
        'recommended',
        'apply',
        'applied',
        'interviewing',
        'offer',
        'rejected',
        'archived',
      ],
    });
    expect(
      getAdminResource('applications')?.fields.find(
        (field) => field.key === 'status',
      ),
    ).toMatchObject({
      options: [
        'draft',
        'application_drafting',
        'awaiting_user',
        'approved',
        'submitting',
        'manual_submission',
        'submitted',
        'interviewing',
        'offer',
        'rejected',
        'withdrawn',
        'archived',
      ],
    });
  });

  it('keeps company research HQ place optional until structured places are known', () => {
    expect(
      getAdminResource('company-research')?.fields.find(
        (field) => field.key === 'hqPlaceId',
      ),
    ).toMatchObject({ required: false });
    expect(
      getAdminResource('opportunity-places')?.fields.find(
        (field) => field.key === 'placeId',
      ),
    ).toMatchObject({ required: true });
  });

  it('exposes opportunity to company joins through organization profiles', () => {
    expect(
      getAdminResource('opportunity-companies')?.fields.map(
        (field) => field.key,
      ),
    ).toEqual(
      expect.arrayContaining([
        'opportunityId',
        'organizationProfileId',
        'companyResearchId',
        'legacyCompanyId',
        'companyRole',
        'isPrimary',
      ]),
    );
  });

  it('keeps the active MCP/admin surface tied to app-owned workflow resources', () => {
    expect(adminResources.map((resource) => resource.className)).toEqual(
      expect.arrayContaining([
        'AgentRun',
        'Achievement',
        'Application',
        'CandidateProfile',
        'Company',
        'CompanyResearch',
        'DecisionTag',
        'Experience',
        'EvaluationScore',
        'FactCandidate',
        'FactIntake',
        'Fact',
        'OpportunityCompany',
        'OpportunityPlace',
        'OpportunityRole',
        'OpportunityTag',
        'ResumeAsset',
        'ResumeVariant',
        'SourceCrawl',
        'SourceCrawlItem',
        'SkillCategoryMember',
        'SourceTag',
      ]),
    );
  });

  it('exposes source-version provenance on evaluation scores', () => {
    expect(
      getAdminResource('evaluation-scores')?.fields.map((field) => field.key),
    ).toEqual(
      expect.arrayContaining([
        'sourceId',
        'sourceCrawlId',
        'sourceCrawlItemId',
        'sourceContentFingerprint',
        'sourceContentVersion',
      ]),
    );
  });

  it('exposes resume variants as opportunity/company linked tailoring records', () => {
    const resource = getAdminResource('resume-variants');

    expect(resource).toMatchObject({
      className: 'ResumeVariant',
      slug: 'resume-variants',
    });
    expect(resource?.fields.map((field) => field.key)).toEqual(
      expect.arrayContaining([
        'applicationId',
        'opportunityId',
        'companyId',
        'resumeAssetId',
        'tailoringConfigId',
        'titleOverride',
        'summaryOverride',
        'emphasizeTags',
        'excludeTags',
        'includePositionIds',
        'excludePositionIds',
        'markdownPath',
        'textPath',
        'htmlPath',
        'pdfPath',
      ]),
    );
  });
});
