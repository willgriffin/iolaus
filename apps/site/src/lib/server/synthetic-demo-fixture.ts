import { applicationRuntime } from './application-runtime.js';
import { getCollection } from './smrt.js';

const FIXTURE_PREFIX = 'iolaus-demo-fictional';

type MutableRecord = Record<string, unknown> & {
  id?: string;
  save: () => Promise<void>;
};

type Collection = {
  create: (payload: Record<string, unknown>) => Promise<MutableRecord>;
  list: (options?: Record<string, unknown>) => Promise<MutableRecord[]>;
};

export interface SyntheticDemoFixtureCollections {
  agentRuns: Collection;
  applicationMaterialComments: Collection;
  applications: Collection;
  candidateAnswers: Collection;
  candidateProfiles: Collection;
  companies: Collection;
  decisions: Collection;
  opportunities: Collection;
  resumeAssets: Collection;
  sourceCrawlItems: Collection;
  sourceCrawls: Collection;
  sources: Collection;
  tasks: Collection;
}

export interface SyntheticDemoFixtureResult {
  applicationId: string;
  crawlId: string;
  created: boolean;
  opportunityId: string;
  sourceId: string;
  triageOpportunityId: string;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Demo records are deliberately opt-in. A production process is refused even
 * if an operator accidentally carries the enabling environment variable into
 * its deployment configuration.
 */
export function assertSyntheticDemoFixtureEnabled(
  environment: NodeJS.ProcessEnv = process.env,
  runtimeProfile: typeof applicationRuntime.profile = applicationRuntime.profile,
): void {
  // NODE_ENV describes the process mode, not the persistence target. The
  // resolved runtime profile is authoritative: every non-local profile uses a
  // deployed database and must never receive synthetic records.
  if (runtimeProfile !== 'local') {
    throw new Error(
      'Synthetic demo fixtures are disabled outside the local runtime profile.',
    );
  }
  if (environment.IOLAUS_ENABLE_DEMO_FIXTURES !== '1') {
    throw new Error(
      'Set IOLAUS_ENABLE_DEMO_FIXTURES=1 to seed visibly fictional local/demo data.',
    );
  }
}

async function findOrCreate(
  collection: Collection,
  where: Record<string, unknown>,
  payload: Record<string, unknown>,
): Promise<{ created: boolean; record: MutableRecord }> {
  const existing = await collection.list({ limit: 1, where });
  if (existing[0]) return { created: false, record: existing[0] };
  const record = await collection.create(payload);
  await record.save();
  return { created: true, record };
}

async function defaultCollections(): Promise<SyntheticDemoFixtureCollections> {
  const [
    candidateProfiles,
    companies,
    sources,
    sourceCrawls,
    sourceCrawlItems,
    opportunities,
    decisions,
    applications,
    candidateAnswers,
    resumeAssets,
    applicationMaterialComments,
    tasks,
    agentRuns,
  ] = await Promise.all([
    getCollection('CandidateProfile'),
    getCollection('Company'),
    getCollection('Source'),
    getCollection('SourceCrawl'),
    getCollection('SourceCrawlItem'),
    getCollection('Opportunity'),
    getCollection('Decision'),
    getCollection('Application'),
    getCollection('CandidateAnswer'),
    getCollection('ResumeAsset'),
    getCollection('ApplicationMaterialComment'),
    getCollection('Task'),
    getCollection('AgentRun'),
  ]);
  return {
    agentRuns: agentRuns as unknown as Collection,
    applicationMaterialComments:
      applicationMaterialComments as unknown as Collection,
    applications: applications as unknown as Collection,
    candidateAnswers: candidateAnswers as unknown as Collection,
    candidateProfiles: candidateProfiles as unknown as Collection,
    companies: companies as unknown as Collection,
    decisions: decisions as unknown as Collection,
    opportunities: opportunities as unknown as Collection,
    resumeAssets: resumeAssets as unknown as Collection,
    sourceCrawlItems: sourceCrawlItems as unknown as Collection,
    sourceCrawls: sourceCrawls as unknown as Collection,
    sources: sources as unknown as Collection,
    tasks: tasks as unknown as Collection,
  };
}

/**
 * Seed one complete, visibly fictional local workflow for demo and QA. It
 * creates no files, contacts no employer, and reuses the same records on
 * every invocation. This is intentionally separate from first-run onboarding
 * so real installs never receive demo candidate data by default.
 */
export async function seedSyntheticDemoFixture(
  suppliedCollections?: SyntheticDemoFixtureCollections,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SyntheticDemoFixtureResult> {
  assertSyntheticDemoFixtureEnabled(environment);
  const collections = suppliedCollections ?? (await defaultCollections());
  const profile = await findOrCreate(
    collections.candidateProfiles,
    { profileKey: `${FIXTURE_PREFIX}-candidate` },
    {
      active: true,
      email: 'jordan.example@demo.invalid',
      factsJson: JSON.stringify({
        facts: {
          name: { provenance: 'user_verified', value: 'Jordan Example' },
        },
        unresolvedQuestions: [],
        version: 1,
      }),
      isDefault: false,
      name: 'Jordan Example',
      profileKey: `${FIXTURE_PREFIX}-candidate`,
      summary: 'Fictional demo candidate. Not a real person or application.',
      title: 'Fictional Staff Software Engineer',
    },
  );
  const company = await findOrCreate(
    collections.companies,
    { companyKey: `${FIXTURE_PREFIX}-company` },
    {
      companyKey: `${FIXTURE_PREFIX}-company`,
      name: 'Example Orbit Labs (fictional demo)',
      productSummary: 'Fictional company for the Iolaus local demo.',
      researchStatus: 'complete',
      websiteUrl: 'https://example.invalid/iolaus-demo-company',
    },
  );
  // This is a visibly fictional Ashby-shaped root. It demonstrates the
  // provider/crawl contract without ever contacting Ashby or another service.
  const source = await findOrCreate(
    collections.sources,
    { url: 'https://example.invalid/iolaus-demo-ashby' },
    {
      isActive: true,
      name: 'Example Ashby board (fictional Iolaus demo)',
      provider: 'ashby',
      refreshCadence: 'manual',
      sourceRole: 'root',
      type: 'ashby',
      url: 'https://example.invalid/iolaus-demo-ashby',
    },
  );
  const opportunity = await findOrCreate(
    collections.opportunities,
    { externalId: `${FIXTURE_PREFIX}-opportunity` },
    {
      applyInstructions: 'Fictional demo only. Never submit externally.',
      applyMethod: 'manual',
      applyUrl: 'https://example.invalid/iolaus-demo-apply',
      companyId: stringValue(company.record.id),
      descriptionRaw:
        'Fictional Iolaus demo opportunity. No employer or external posting exists.',
      externalId: `${FIXTURE_PREFIX}-opportunity`,
      humanReviewStatus: 'reviewed',
      locationNotes: 'Remote (fictional demo)',
      postingUrl: 'https://example.invalid/iolaus-demo-posting',
      status: 'recommended',
      sourceId: stringValue(source.record.id),
      title: 'Fictional Principal Engineer — Iolaus Demo',
      workMode: 'remote',
    },
  );
  const triageOpportunity = await findOrCreate(
    collections.opportunities,
    { externalId: `${FIXTURE_PREFIX}-triage-opportunity` },
    {
      applyInstructions: 'Fictional demo only. Never submit externally.',
      applyMethod: 'manual',
      applyUrl: 'https://example.invalid/iolaus-demo-triage-apply',
      companyId: stringValue(company.record.id),
      descriptionRaw:
        'Fictional Iolaus triage opportunity. No employer or external posting exists.',
      externalId: `${FIXTURE_PREFIX}-triage-opportunity`,
      humanReviewStatus: 'needs_input',
      locationNotes: 'Remote (fictional demo)',
      organizationProfileId: stringValue(profile.record.id),
      postingUrl: 'https://example.invalid/iolaus-demo-triage-posting',
      sourceId: stringValue(source.record.id),
      status: 'recommended',
      title: 'Fictional Staff Engineer — Iolaus Triage Demo',
      workMode: 'remote',
    },
  );
  const crawl = await findOrCreate(
    collections.sourceCrawls,
    { requestKey: `${FIXTURE_PREFIX}-crawl` },
    {
      attemptCount: 2,
      crawlType: 'demo_fixture',
      finishedAt: new Date('2026-09-03T00:01:00.000Z'),
      integrationMethod: 'fictional_local_fixture',
      newOpportunityCount: 2,
      pendingCount: 0,
      requestKey: `${FIXTURE_PREFIX}-crawl`,
      resultCount: 2,
      sourceId: stringValue(source.record.id),
      startedAt: new Date('2026-09-03T00:00:00.000Z'),
      status: 'completed',
      terminalCount: 2,
    },
  );
  const crawlItem = await findOrCreate(
    collections.sourceCrawlItems,
    { attemptKey: `${FIXTURE_PREFIX}-opportunity-item` },
    {
      attemptKey: `${FIXTURE_PREFIX}-opportunity-item`,
      canonicalUrl: 'https://example.invalid/iolaus-demo-posting',
      companyName: 'Example Orbit Labs (fictional demo)',
      contentFingerprint: `${FIXTURE_PREFIX}-opportunity-v1`,
      contentVersion: 1,
      externalId: `${FIXTURE_PREFIX}-opportunity`,
      matchStrategy: 'fixture_exact',
      opportunityId: stringValue(opportunity.record.id),
      outcome: 'created',
      postingUrl: 'https://example.invalid/iolaus-demo-posting',
      reconciliationKey: `${FIXTURE_PREFIX}-opportunity`,
      reconciliationStatus: 'matched',
      sourceCrawlId: stringValue(crawl.record.id),
      status: 'seen',
      terminalAt: new Date('2026-09-03T00:01:00.000Z'),
      title: 'Fictional Principal Engineer — Iolaus Demo',
    },
  );
  await findOrCreate(
    collections.sourceCrawlItems,
    { attemptKey: `${FIXTURE_PREFIX}-triage-opportunity-item` },
    {
      attemptKey: `${FIXTURE_PREFIX}-triage-opportunity-item`,
      canonicalUrl: 'https://example.invalid/iolaus-demo-triage-posting',
      companyName: 'Example Orbit Labs (fictional demo)',
      contentFingerprint: `${FIXTURE_PREFIX}-triage-opportunity-v1`,
      contentVersion: 1,
      externalId: `${FIXTURE_PREFIX}-triage-opportunity`,
      matchStrategy: 'fixture_exact',
      opportunityId: stringValue(triageOpportunity.record.id),
      outcome: 'created',
      postingUrl: 'https://example.invalid/iolaus-demo-triage-posting',
      reconciliationKey: `${FIXTURE_PREFIX}-triage-opportunity`,
      reconciliationStatus: 'matched',
      sourceCrawlId: stringValue(crawl.record.id),
      status: 'seen',
      terminalAt: new Date('2026-09-03T00:01:00.000Z'),
      title: 'Fictional Staff Engineer — Iolaus Triage Demo',
    },
  );
  const resume = await findOrCreate(
    collections.resumeAssets,
    { outputSlug: `${FIXTURE_PREFIX}-resume-placeholder` },
    {
      assetType: 'resume',
      candidateProfileId: stringValue(profile.record.id),
      notes: 'Fictional placeholder only. No personal resume file is stored.',
      outputSlug: `${FIXTURE_PREFIX}-resume-placeholder`,
      pdfBasename: 'fictional-demo-resume-placeholder.pdf',
      status: 'placeholder',
      title: 'Fictional demo resume placeholder',
    },
  );
  await findOrCreate(
    collections.candidateAnswers,
    {
      profileKey: `${FIXTURE_PREFIX}-candidate`,
    },
    {
      active: true,
      answerType: 'text',
      label: 'Fictional demo work authorization',
      labelKey: `${FIXTURE_PREFIX}-work-authorization`,
      profileKey: `${FIXTURE_PREFIX}-candidate`,
      source: 'user',
      value:
        'Fictional demo answer only. Confirm the real answer with the user before applying.',
    },
  );
  const application = await findOrCreate(
    collections.applications,
    { sourceCrawlItemId: stringValue(crawlItem.record.id) },
    {
      applicationInstructions:
        'Fictional demo application. Human review is required; no submission is possible.',
      applyMethod: 'manual',
      applicationUrl: 'https://example.invalid/iolaus-demo-apply',
      opportunityId: stringValue(opportunity.record.id),
      requiredAnswersJson: '{}',
      requiredQuestionsJson: '{}',
      resumeAssetId: stringValue(resume.record.id),
      sourceCrawlId: stringValue(crawl.record.id),
      sourceCrawlItemId: stringValue(crawlItem.record.id),
      status: 'awaiting_user',
    },
  );
  await findOrCreate(
    collections.decisions,
    { sourceCrawlItemId: stringValue(crawlItem.record.id) },
    {
      applicationId: stringValue(application.record.id),
      decision: 'accept_to_apply',
      decisionBy: 'owner',
      newStatus: 'application_drafting',
      opportunityId: stringValue(opportunity.record.id),
      reason: 'Fictional demo decision. No external action was taken.',
      sourceCrawlId: stringValue(crawl.record.id),
      sourceCrawlItemId: stringValue(crawlItem.record.id),
    },
  );
  await findOrCreate(
    collections.applicationMaterialComments,
    { materialVersion: `${FIXTURE_PREFIX}-comment` },
    {
      applicationId: stringValue(application.record.id),
      body: 'Fictional demo review comment: verify details before any real application.',
      materialRecordId: stringValue(resume.record.id),
      materialRecordType: 'ResumeAsset',
      materialType: 'resume',
      materialVersion: `${FIXTURE_PREFIX}-comment`,
      status: 'open',
    },
  );
  await findOrCreate(
    collections.tasks,
    { externalTaskId: `${FIXTURE_PREFIX}-review-task` },
    {
      applicationId: stringValue(application.record.id),
      description:
        'Review this fictional demo application. It cannot be submitted.',
      externalTaskId: `${FIXTURE_PREFIX}-review-task`,
      opportunityId: stringValue(opportunity.record.id),
      status: 'open',
      taskType: 'review_application',
      title: 'Review fictional demo application',
    },
  );
  await findOrCreate(
    collections.agentRuns,
    { externalActionType: `${FIXTURE_PREFIX}-audit` },
    {
      externalActionType: `${FIXTURE_PREFIX}-audit`,
      inputJson: JSON.stringify({ fictional: true }),
      opportunityId: stringValue(opportunity.record.id),
      outputJson: JSON.stringify({ externalContact: false, fictional: true }),
      runType: 'demo_fixture',
      status: 'completed',
    },
  );

  return {
    applicationId: stringValue(application.record.id),
    created:
      profile.created ||
      company.created ||
      opportunity.created ||
      triageOpportunity.created ||
      source.created ||
      crawl.created ||
      resume.created ||
      application.created,
    opportunityId: stringValue(opportunity.record.id),
    crawlId: stringValue(crawl.record.id),
    sourceId: stringValue(source.record.id),
    triageOpportunityId: stringValue(triageOpportunity.record.id),
  };
}
