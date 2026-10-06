import '../scripts/jobs-worker-bootstrap.js';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { SmrtJobCollection, TaskRunner } from '@happyvertical/smrt-jobs';
import { getDbConfig, getSmrtOptions } from '../src/lib/server/db.js';
import { loadCurrentPartialOpportunityAssessmentProjections } from '../src/lib/server/opportunity-assessment-partial-projection.js';
import { enqueueOpportunityIntelligenceWithStatus } from '../src/lib/server/opportunity-intelligence-job.js';
import { prepareOpportunityPosting } from '../src/lib/server/opportunity-posting-preparation.js';
import { requirementCoverageContextForOpportunity } from '../src/lib/server/opportunity-requirement-coverage.js';
import {
  preflightRequirementCoverageAudit,
  preflightRequirementEvidenceAudit,
  prepareCapturedSourceCompositeRequirementEvidenceAudit,
  prepareRequirementCoverageAudit,
  prepareRequirementEvidenceAudit,
  prepareSourceEligibilityCompositeRequirementEvidenceAudit,
  readPartialOpportunityRequirementEvidence,
  readRecordedRequirementCoverageOutcome,
  readVerifiedOpportunitySourceEligibilityEvidence,
  validateVerifiedRequirementCoverage,
} from '../src/lib/server/opportunity-requirement-coverage-provider.js';
import { enqueueOpportunityRequirementCoverageSourceStage } from '../src/lib/server/opportunity-requirement-coverage-source-stage-job.js';
import { readCurrentOpportunityAssessmentScreen } from '../src/lib/server/opportunity-screening-provider.js';
import {
  fingerprintOpportunitySourceContent,
  opportunityWithSourceContent,
} from '../src/lib/server/opportunity-source-content.js';
import { loadCurrentSourceEligibilityProjections } from '../src/lib/server/opportunity-source-eligibility-projection.js';
import { loadWorkspaceCandidateEvidence } from '../src/lib/server/resume-data.js';
import { getCollection } from '../src/lib/server/smrt.js';
import { withSyntheticDemoOwnerContext } from '../src/lib/server/synthetic-demo-fixture.js';
import {
  resolveWorkspaceSubjectForProfile,
  withVerifiedWorkspaceSubject,
} from '../src/lib/server/workspace-subject.js';
import { startSourceStageProvider } from './source-stage-provider.js';

type Json = Record<string, unknown>;
const fixturePath = process.env.IOLAUS_E2E_FIXTURE;
if (
  !fixturePath ||
  process.env.SMRT_APP_ID !== 'iolaus-e2e' ||
  process.env.IOLAUS_E2E_SOURCE_COVERAGE !== '1'
)
  throw new Error('Stage fixture requires isolated opt-in runtime');
const root = realpathSync(dirname(fixturePath));
if (
  !basename(root).startsWith('iolaus-mobile-e2e-') ||
  realpathSync(String(process.env.SMRT_DATA_DIR)) !== root + '/runtime'
)
  throw new Error('Stage fixture refused daily runtime');
const localFetch = globalThis.fetch;
globalThis.fetch = async (input, options) => {
  const url = new URL(
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
  );
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1')
    throw new Error('Stage fixture refused external transport');
  return await localFetch(input, options);
};
const fixture = JSON.parse(readFileSync(fixturePath, 'utf8')) as {
  profileId: string;
  userId: string;
  tenantId: string;
};
const scenario = process.argv[2];
const screeningStage = scenario.startsWith('screen-');
const screeningVariant = screeningStage ? scenario.slice('screen-'.length) : '';
const privateStage = scenario.startsWith('private-');
const privateVariant = privateStage ? scenario.slice('private-'.length) : '';
const eligibilityStage = scenario.startsWith('eligibility-');
const capturedStage = scenario.startsWith('captured-');
const evidenceStage =
  privateStage ||
  scenario.startsWith('evidence-') ||
  eligibilityStage ||
  capturedStage;
const variant = privateStage
  ? 'fitting'
  : screeningStage
    ? 'fitting'
    : capturedStage
      ? scenario.slice('captured-'.length)
      : eligibilityStage
        ? scenario.slice('eligibility-'.length)
        : evidenceStage
          ? scenario.slice('evidence-'.length)
          : scenario;
if (
  (screeningStage &&
    !['mismatch', 'relevant', 'invalid-material'].includes(screeningVariant)) ||
  (privateStage &&
    !['fitting', 'stale-source', 'stale-candidate', 'foreign-proof'].includes(
      privateVariant,
    )) ||
  ![
    'fitting',
    'oversize',
    'orphan',
    'foreign',
    'conservative',
    'stale',
    'changed-contract',
    'failed-retry',
    'budget-history',
  ].includes(variant)
)
  throw new Error('Unknown source stage fixture case');
const db = await resolveDatabase(getDbConfig());
let jobId = '';
const provider = await startSourceStageProvider(
  async () =>
    (
      await db.query(
        'SELECT id, method, status, args, tenant_id, attempts FROM _smrt_jobs WHERE id = ?',
        [jobId],
      )
    ).rows?.[0] as Json | undefined,
  {
    failExtraction: variant === 'failed-retry',
    partialEvidence: evidenceStage,
    capturedRecovery: capturedStage,
    screeningOutcome: screeningStage
      ? (screeningVariant as 'mismatch' | 'relevant' | 'invalid-material')
      : undefined,
  },
);
process.env.HAVE_AI_BASE_URL = provider.url;
process.env.HAVE_AI_OPPORTUNITY_INTELLIGENCE_EXTRACTION_BASE_URL = provider.url;
const opportunities = await getCollection('Opportunity');
const large = variant === 'oversize';
const source = {
  title: screeningStage
    ? screeningVariant === 'mismatch'
      ? 'Staff Accountant'
      : 'Software Engineer at Fictional Accounting Co'
    : 'Fictional staged source ' + scenario,
  descriptionRaw: screeningStage
    ? screeningVariant === 'mismatch'
      ? 'Prepare tax returns and financial statements as an accountant.\nReconcile client ledgers and file tax documents.'
      : 'Build accessible TypeScript interfaces for an accounting software product.\nMaintain tested API integrations used by customers.'
    : capturedStage
      ? 'Role Summary\nRequirements\nYou must maintain tested API integrations.\nYou must build accessible TypeScript interfaces.'
      : 'Remote role.\nRequirements\n' +
        (large
          ? Array.from(
              { length: 90 },
              (_, i) =>
                'Must verify fixture case ' + String(i).padStart(3, '0') + '.',
            ).join('\n')
          : 'You must maintain tested API integrations.\nYou must build accessible TypeScript interfaces.'),
  ...(capturedStage ? { locationNotes: 'Remote in Canada' } : {}),
  workMode: capturedStage || screeningStage ? 'remote' : '',
  employmentType: '',
  postedAt: '2020-01-01T00:00:00.000Z',
};
const opportunity = await opportunities.create({
  ...source,
  sourceContentJson: JSON.stringify(source),
  sourceContentFingerprint: fingerprintOpportunitySourceContent(source),
  sourceContentVersion: 1,
  status: 'found',
  firstSeen: new Date(source.postedAt),
});
await opportunity.save();
const id = String(opportunity.id);
const rows = async (table: string, fields: string) =>
  (
    await db.query(
      'SELECT ' +
        fields +
        ' FROM ' +
        table +
        ' WHERE opportunity_id = ? ORDER BY created_at',
      [id],
    )
  ).rows ?? [];
const jobs = async () =>
  (
    await db.query(
      'SELECT id, method, status, tenant_id, args, attempts, last_error FROM _smrt_jobs WHERE object_id = ? ORDER BY created_at, id',
      [id],
    )
  ).rows ?? [];
const asOwner = async <T>(work: () => Promise<T>) =>
  await withSyntheticDemoOwnerContext(
    async () =>
      await withVerifiedWorkspaceSubject(
        await resolveWorkspaceSubjectForProfile(fixture.profileId),
        work,
      ),
  );
const current = async () => {
  const row = await opportunities.get({ id }, { cache: false });
  if (!row) throw new Error('Stage fixture record vanished');
  return row.toJSON();
};
const snapshot = async () => {
  const record = await current();
  return {
    record: {
      ...record,
      recomputedPreparedFingerprint: prepareOpportunityPosting(
        opportunityWithSourceContent(record),
      ).fingerprint,
      preparedPostingJson: JSON.parse(
        String(record.preparedPostingJson || '{}'),
      ),
    },
    jobs: await jobs(),
    receipts: await rows(
      'opportunity_intelligence_results',
      'owner_request_id, agent_run_id, feature, status, input_fingerprint, output_json, prompt_version, output_schema_version, model, tenant_id, owner_user_id, candidate_profile_id',
    ),
    requests: await rows(
      'opportunity_intelligence_requests',
      'request_id, agent_run_id, feature, status, model, accounting_basis, actual_total_tokens, reserved_input_tokens, requested_max_output_tokens, reserved_spend_micros, actual_spend_micros, error_code, tenant_id, owner_user_id, candidate_profile_id',
    ),
    agentRuns: await rows(
      'agent_runs',
      'id, status, intelligence_actual_calls, intelligence_actual_input_tokens, intelligence_actual_output_tokens, intelligence_actual_spend_micros',
    ),
    assessments: await rows(
      'opportunity_assessments',
      'id, tenant_id, owner_user_id, candidate_profile_id, status, match_readiness, assessment_json, projection_json, source_content_fingerprint, source_content_version, assessment_fingerprint, agent_run_id',
    ),
    applications: await rows('applications', 'id'),
    evaluationScores: await rows('evaluation_scores', 'id'),
    tasks: await rows('tasks', 'id'),
    coverage: await readRecordedRequirementCoverageOutcome(id, record),
    partial: await readPartialOpportunityRequirementEvidence(record),
    eligibility: await readVerifiedOpportunitySourceEligibilityEvidence(record),
  };
};
async function service() {
  const runner = new TaskRunner({
    concurrency: 1,
    queues: ['opportunity-intelligence'],
    pollInterval: 100,
    idlePollInterval: 100,
    retention: false,
    shutdownTimeout: 10_000,
  });
  runner.on('runner:error', (error) =>
    console.error('Stage native runner:', error.message),
  );
  await runner.initialize(db);
  await runner.start();
  try {
    const deadline = Date.now() + 90_000;
    while (
      (await jobs()).some((row) =>
        ['pending', 'running'].includes(String(row.status)),
      )
    ) {
      if (Date.now() > deadline)
        throw new Error('Stage native job did not settle');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  } finally {
    await runner.stop();
  }
}
if (screeningStage) {
  let screenEnqueue: Json | undefined;
  let screenRefusal = '';
  let screenReceipt: Json | undefined;
  const before = await snapshot();
  try {
    await asOwner(async () => {
      const candidates = await getCollection('CandidateProfile');
      const profile = await candidates.get(
        { id: fixture.profileId },
        { cache: false },
      );
      if (!profile) throw new Error('Screening fixture candidate missing');
      Object.assign(profile, {
        preferencesJson: JSON.stringify({
          targetRoles: ['Software Engineer'],
          workModes: ['remote'],
        }),
        targetWorkCountryJson:
          screeningVariant === 'invalid-material'
            ? '{invalid-native-country-json'
            : JSON.stringify({ code: 'CA', label: 'Canada' }),
        authorizedWorkCountriesJson: JSON.stringify([
          { country: { code: 'CA', label: 'Canada' }, scope: 'country' },
        ]),
        sponsorshipRequired: false,
      });
      await profile.save();
    });
    const queued = await asOwner(
      async () =>
        await enqueueOpportunityIntelligenceWithStatus(id, {
          modes: 'assessment',
        }),
    );
    screenEnqueue = {
      stage: queued.stage,
      sourceStatus: queued.sourceStatus,
      jobId: queued.job.id,
    };
    jobId = String(queued.job.id);
    await service();
    screenReceipt = (await asOwner(
      async () =>
        await readCurrentOpportunityAssessmentScreen({
          opportunityId: id,
          subject: {
            tenantId: fixture.tenantId,
            userId: fixture.userId,
            profileId: fixture.profileId,
          },
        }),
    )) as unknown as Json | undefined;
  } catch (error) {
    screenRefusal = error instanceof Error ? error.message : String(error);
  }
  const final = await snapshot();
  const resultPath = root + '/source-stage-result-' + id + '.json';
  writeFileSync(
    resultPath,
    JSON.stringify({
      scenario,
      id,
      owner: {
        tenantId: fixture.tenantId,
        userId: fixture.userId,
        profileId: fixture.profileId,
      },
      afterExtraction: before,
      providerEvents: provider.events,
      screenEnqueue,
      screenRefusal,
      screenReceipt,
      final,
    }),
    { mode: 0o600 },
  );
  console.log('IOLAUS_SOURCE_STAGE_RESULT:' + JSON.stringify({ resultPath }));
  await provider.close();
  process.exit(0);
}
let refusal = '';
let afterExtraction: Awaited<ReturnType<typeof snapshot>> | undefined;
let exact: Json | undefined;
let selectedRequestId = '';
let retryEventStart = 0;
let afterEvidence: Awaited<ReturnType<typeof snapshot>> | undefined;
let privateEnqueue: Json | undefined;
let candidateBefore: Json | undefined;
let privateRefusal = '';
let privateEventStart = 0;
let privateProjection: Json | undefined;
let privateProjectionReload: Json | undefined;
let privateProjectionAfterForge: Json | undefined;
let privateProjectionAfterForgeAttempted = false;
let sourceEligibilityProjection: Json | undefined;
try {
  const extractionJob = await asOwner(
    async () =>
      await enqueueOpportunityRequirementCoverageSourceStage(id, {
        stage: 'extract',
      }),
  );
  jobId = String(extractionJob.id);
  await service();
  afterExtraction = await snapshot();
  const extraction = afterExtraction.receipts.find(
    (row) => row.feature === 'opportunity-extraction-chunk-1',
  );
  if (variant !== 'failed-retry') {
    if (!extraction || extraction.status !== 'completed')
      throw new Error('Actual GLOBAL extraction checkpoint missing');
    selectedRequestId = String(extraction.owner_request_id);
    const record = await current();
    const prepared = JSON.parse(String(record.preparedPostingJson));
    const context = requirementCoverageContextForOpportunity(record);
    if (evidenceStage) {
      const audit = capturedStage
        ? prepareCapturedSourceCompositeRequirementEvidenceAudit(
            context,
            prepared.requirementCoverage,
            {
              sourceContentJson: String(record.sourceContentJson),
              extractionRequestId: selectedRequestId,
            },
          )
        : eligibilityStage
          ? prepareSourceEligibilityCompositeRequirementEvidenceAudit(
              context,
              prepared.requirementCoverage,
            )
          : prepareRequirementEvidenceAudit(
              context,
              prepared.requirementCoverage,
            );
      exact = {
        request: audit.request,
        inputFingerprint: audit.inputFingerprint,
        preflight: preflightRequirementEvidenceAudit(audit, {
          calls: 1,
          reservedTokens: 10096,
        }),
      };
    } else {
      const audit = prepareRequirementCoverageAudit(
        context,
        prepared.requirementCoverage,
      );
      exact = {
        request: audit.request,
        preflight: preflightRequirementCoverageAudit(audit),
      };
    }
    // These mutations are confined to the disposable native SQLite fixture.
    if (variant === 'orphan')
      await db.query(
        'DELETE FROM opportunity_intelligence_results WHERE owner_request_id = ?',
        [selectedRequestId],
      );
    if (variant === 'foreign')
      await db.query(
        'UPDATE opportunity_intelligence_results SET owner_user_id = ? WHERE owner_request_id = ?',
        ['foreign-fixture-owner', selectedRequestId],
      );
    if (variant === 'conservative')
      await db.query(
        'UPDATE opportunity_intelligence_requests SET accounting_basis = ? WHERE request_id = ?',
        ['conservative', selectedRequestId],
      );
    if (variant === 'budget-history')
      await db.query(
        'UPDATE opportunity_intelligence_requests SET reserved_input_tokens = ? WHERE request_id = ?',
        [79_000, selectedRequestId],
      );
  }
  retryEventStart = provider.events.length;
  try {
    const resume = await asOwner(
      async () =>
        await enqueueOpportunityRequirementCoverageSourceStage(
          id,
          variant === 'failed-retry'
            ? { stage: 'extract' }
            : {
                stage: evidenceStage
                  ? 'evidence_completed_extraction'
                  : 'audit_completed_extraction',
                extractionRequestId: selectedRequestId,
                ...(eligibilityStage
                  ? {
                      evidenceVersion:
                        'requirement-evidence-audit/v3-source-eligibility' as const,
                    }
                  : capturedStage
                    ? {
                        evidenceVersion:
                          'requirement-evidence-audit/v4-captured-source-recovery' as const,
                      }
                    : {}),
              },
        ),
    );
    jobId = String(resume.id);
    if (variant === 'stale') {
      const changed = {
        ...source,
        descriptionRaw:
          source.descriptionRaw + '\nMust retain source revision two.',
      };
      const latest = await opportunities.get({ id }, { cache: false });
      if (!latest) throw new Error('Stale fixture missing');
      Object.assign(latest, {
        descriptionRaw: changed.descriptionRaw,
        sourceContentJson: JSON.stringify(changed),
        sourceContentFingerprint: fingerprintOpportunitySourceContent(changed),
        sourceContentVersion: 2,
      });
      await latest.save();
    }
    if (variant === 'changed-contract') {
      const nativeJobs = await SmrtJobCollection.create(getSmrtOptions());
      const job = await nativeJobs.get(jobId);
      if (!job) throw new Error('Durable stage intent missing');
      job.args = {
        ...job.args,
        sourceCoverageStage: {
          ...(job.args.sourceCoverageStage as Json),
          contract: 'changed-fixture-contract',
        },
      };
      await job.save();
    }
    await service();
  } catch (error) {
    refusal = error instanceof Error ? error.message : String(error);
  }
  let final = await snapshot();
  if (capturedStage && variant === 'fitting') {
    sourceEligibilityProjection = await asOwner(async () => {
      const projections = await loadCurrentSourceEligibilityProjections({
        opportunities: [await current()],
        subject: {
          tenantId: fixture.tenantId,
          userId: fixture.userId,
          profileId: fixture.profileId,
        },
      });
      return projections.get(id);
    });
  }
  if (privateStage) {
    if (!final.partial?.acceptedRequirements.length)
      throw new Error('Native GLOBAL partial source proof missing');
    afterEvidence = final;
    await asOwner(async () => {
      const owner = {
        tenantId: fixture.tenantId,
        ownerUserId: fixture.userId,
        candidateProfileId: fixture.profileId,
      };
      const candidates = await getCollection('CandidateProfile');
      const profile = await candidates.get(
        { id: fixture.profileId },
        { cache: false },
      );
      if (!profile)
        throw new Error('Private candidate fixture profile missing');
      const summary =
        'I maintained tested API integrations and built accessible TypeScript interfaces in a fictional local QA project.';
      Object.assign(profile, { summary });
      await profile.save();
      const resumeProfiles = await getCollection('ResumeProfile');
      const resumeProfile = await resumeProfiles.create({
        ...owner,
        profileKey: 'default',
        name: 'Fictional Native Partial QA',
        summary,
        active: true,
      });
      await resumeProfile.save();
      const categories = await getCollection('ResumeSkillCategory');
      const category = await categories.create({
        ...owner,
        categoryId: 'native-partial-skill-category',
        label: 'Engineering',
      });
      await category.save();
      const skills = await getCollection('ResumeSkill');
      const skill = await skills.create({
        ...owner,
        skillId: 'api-integrations',
        categoryId: 'native-partial-skill-category',
        label: 'API integrations',
      });
      await skill.save();
      // The live candidate loader selects normalized resume records whenever
      // a CandidateProfile exists. Mirror the legacy skill in that model.
      const tags = await getCollection('Tag');
      const tag = await tags.create({
        slug: 'api-integrations',
        context: 'native-partial-fixture',
        name: 'API integrations',
        tenantId: fixture.tenantId,
      });
      await tag.save();
      const normalizedCategories = await getCollection('SkillCategory');
      const normalizedCategory = await normalizedCategories.create({
        ...owner,
        categoryKey: 'native-partial-skills',
        label: 'Engineering',
      });
      await normalizedCategory.save();
      const members = await getCollection('SkillCategoryMember');
      const member = await members.create({
        ...owner,
        categoryId: normalizedCategory.id,
        tagId: tag.id,
        label: 'API integrations',
        useOnResume: true,
      });
      await member.save();
      const candidate = await loadWorkspaceCandidateEvidence({
        tenantId: fixture.tenantId,
        userId: fixture.userId,
        profileId: fixture.profileId,
      });
      candidateBefore = {
        fingerprint: candidate.fingerprint,
        sources: candidate.evidence.map((row) => ({
          id: row.id,
          kind: row.kind,
          text: row.text,
        })),
      };
    });
    privateEventStart = provider.events.length;
    try {
      const queued = await asOwner(
        async () =>
          await enqueueOpportunityIntelligenceWithStatus(id, {
            modes: 'assessment',
          }),
      );
      privateEnqueue = {
        stage: queued.stage,
        sourceStatus: queued.sourceStatus,
        jobId: queued.job.id,
      };
      jobId = String(queued.job.id);
      if (privateVariant === 'stale-source') {
        const changed = {
          ...source,
          descriptionRaw: `${source.descriptionRaw}\nMust preserve source revision after private enqueue.`,
        };
        const latest = await opportunities.get({ id }, { cache: false });
        if (!latest) throw new Error('Private stale source fixture missing');
        Object.assign(latest, {
          descriptionRaw: changed.descriptionRaw,
          sourceContentJson: JSON.stringify(changed),
          sourceContentFingerprint:
            fingerprintOpportunitySourceContent(changed),
          sourceContentVersion: 2,
        });
        await latest.save();
      }
      if (privateVariant === 'stale-candidate') {
        await asOwner(async () => {
          const candidates = await getCollection('CandidateProfile');
          const profile = await candidates.get(
            { id: fixture.profileId },
            { cache: false },
          );
          if (!profile)
            throw new Error('Private stale profile fixture missing');
          Object.assign(profile, {
            summary: `${String(profile.toJSON().summary)} Candidate revision two.`,
          });
          await profile.save();
        });
      }
      if (privateVariant === 'foreign-proof')
        await db.query(
          'UPDATE opportunity_intelligence_results SET owner_user_id = ? WHERE owner_request_id = ?',
          ['foreign-fixture-owner', String(final.partial.audit.requestId)],
        );
      await service();
    } catch (error) {
      privateRefusal = error instanceof Error ? error.message : String(error);
    }
    final = await snapshot();
    const readProjection = async () =>
      await asOwner(async () => {
        const projections =
          await loadCurrentPartialOpportunityAssessmentProjections({
            opportunities: [await current()],
            subject: {
              tenantId: fixture.tenantId,
              userId: fixture.userId,
              profileId: fixture.profileId,
            },
          });
        return projections.get(id);
      });
    privateProjection = (await readProjection()) as Json | undefined;
    privateProjectionReload = (await readProjection()) as Json | undefined;
    if (privateVariant === 'fitting') {
      const paid = final.requests.find(
        (row) => row.feature === 'opportunity-assessment-partial',
      );
      if (!paid) throw new Error('Private native receipt fixture missing');
      await db.query(
        'UPDATE opportunity_intelligence_results SET output_schema_version = ? WHERE owner_request_id = ?',
        ['forged-fixture-contract', paid.request_id],
      );
      privateProjectionAfterForgeAttempted = true;
      privateProjectionAfterForge = (await readProjection()) as
        | Json
        | undefined;
    }
  }
  const prepared = final.record.preparedPostingJson as Json;
  const verified = prepared.requirementCoverage
    ? validateVerifiedRequirementCoverage(
        requirementCoverageContextForOpportunity(final.record),
        prepared.requirementCoverage as Parameters<
          typeof validateVerifiedRequirementCoverage
        >[1],
      )
    : undefined;
  const resultPath = root + '/source-stage-result-' + id + '.json';
  writeFileSync(
    resultPath,
    JSON.stringify({
      scenario,
      id,
      owner: {
        tenantId: fixture.tenantId,
        userId: fixture.userId,
        profileId: fixture.profileId,
      },
      selectedRequestId,
      afterExtraction,
      exact,
      retryEventStart,
      refusal,
      afterEvidence,
      privateEnqueue,
      candidateBefore,
      privateRefusal,
      privateEventStart,
      privateProjection,
      privateProjectionReload,
      privateProjectionAfterForge,
      privateProjectionAfterForgeAttempted,
      sourceEligibilityProjection,
      providerEvents: provider.events,
      final,
      verified,
    }),
    { mode: 0o600 },
  );
  console.log('IOLAUS_SOURCE_STAGE_RESULT:' + JSON.stringify({ resultPath }));
} catch (error) {
  console.log(
    'IOLAUS_SOURCE_STAGE_FAILURE:' +
      JSON.stringify({
        scenario,
        id,
        jobId,
        error: error instanceof Error ? error.message : String(error),
        providerEvents: provider.events,
        state: await snapshot(),
      }),
  );
  throw error;
} finally {
  await provider.close();
}
process.exit(0);
