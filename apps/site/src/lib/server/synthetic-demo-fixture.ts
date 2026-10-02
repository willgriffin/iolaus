import type { FilesystemInterface } from '@happyvertical/files';
import { executeAsPrincipal } from '@happyvertical/smrt-agents';
import {
  MembershipCollection,
  MembershipStatus,
  UserCollection,
} from '@happyvertical/smrt-users';
import { applicationRuntime } from './application-runtime.js';
import { requireCandidateOnboardingSubject } from './candidate-onboarding.js';
import { getSmrtOptions } from './db.js';
import { getResumeFilesystem } from './resume-files.js';
import { getCollection } from './smrt.js';
import {
  resolveWorkspaceSubjectForProfile,
  verifyWorkspaceSubject,
  type WorkspaceSubject,
} from './workspace-subject.js';
import { workspaceWorkflowOperation } from './workspace-workflow-capabilities.js';

const FIXTURE_PREFIX = 'iolaus-demo-fictional';
const FIXTURE_RESUME_BASE_PATH = `generated-resumes/${FIXTURE_PREFIX}/resume`;

const FIXTURE_RESUME_MARKDOWN = `# Jordan Example

**Fictional Staff Software Engineer**
jordan.example@demo.invalid · Remote in Canada

> This is generated fictional demo content for Iolaus local QA. It is not a
> real person's resume and must never be submitted to an employer.

## Summary

Local-first product and platform engineer experienced in making complex
workflows reliable, understandable, and reviewable. Enjoys building calm
interfaces where people stay in control of agent-assisted work.

## Selected experience

### Example Orbit Labs — Fictional Staff Software Engineer

- Designed an agent-assisted opportunity triage workflow with explicit human
  review and no automatic external submissions.
- Built resilient TypeScript and Svelte interfaces backed by Node.js and
  PostgreSQL.
- Made source provenance, crawl progress, and decision notes visible to the
  person using the system.

## Skills

TypeScript · Svelte · Node.js · PostgreSQL · WebMCP · Accessible product design

## Demo boundary

All names, roles, contact details, and experience above are fictional. Review
this local artifact only; do not reuse it for a real application.`;

type FixtureFilesystem = Pick<FilesystemInterface, 'write'>;

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
  profileId: string;
  tenantId: string;
  userId: string;
  crawlId: string;
  created: boolean;
  opportunityId: string;
  sourceId: string;
  triageFollowupOpportunityId: string;
  triageOpportunityId: string;
}

export interface SyntheticDemoFixtureOptions {
  /**
   * Allows focused tests to capture the deterministic text artifacts without
   * touching the local runtime asset store.
   */
  filesystem?: FixtureFilesystem;
  /** Tests provide an explicit identity; production resolves a live native owner. */
  subject?: WorkspaceSubject;
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function syntheticResumeHtml(markdown: string): string {
  const escaped = markdown
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fictional demo resume</title></head><body><pre>${escaped}</pre></body></html>`;
}

async function writeSyntheticResumeArtifacts(
  filesystem: FixtureFilesystem,
  basePath: string,
): Promise<void> {
  await Promise.all([
    filesystem.write(`${basePath}.md`, FIXTURE_RESUME_MARKDOWN, {
      createParents: true,
    }),
    filesystem.write(`${basePath}.txt`, FIXTURE_RESUME_MARKDOWN, {
      createParents: true,
    }),
    filesystem.write(
      `${basePath}.html`,
      syntheticResumeHtml(FIXTURE_RESUME_MARKDOWN),
      { createParents: true },
    ),
  ]);
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

/** Resolve an existing local owner; the selector never creates or grants authority. */
export async function withSyntheticDemoOwnerContext<T>(
  work: (subject: WorkspaceSubject) => Promise<T>,
  environment: NodeJS.ProcessEnv = process.env,
): Promise<T> {
  assertSyntheticDemoFixtureEnabled(environment);
  const email = environment.IOLAUS_DEMO_OWNER_EMAIL?.trim();
  if (!email)
    throw new Error(
      'IOLAUS_DEMO_OWNER_EMAIL must select an existing authenticated local owner.',
    );
  const options = getSmrtOptions();
  const users = await UserCollection.create(options);
  const user = await users.findByEmail(email);
  if (!user?.id || !user.isActive())
    throw new Error(
      'Demo owner is unavailable. Complete local owner setup first.',
    );
  const memberships = await MembershipCollection.create(options);
  const active = await memberships.list({
    limit: 2,
    where: { userId: user.id, status: MembershipStatus.ACTIVE },
  });
  if (active.length !== 1 || !active[0]?.tenantId)
    throw new Error(
      'Demo owner must have exactly one live native workspace membership.',
    );
  const tenantId = active[0].tenantId;
  return await executeAsPrincipal(
    {
      ...options,
      action: 'demo.fixture.seed',
      onBehalfOfUserId: user.id,
      postgresRls: false,
      principal: { allowedTools: [], runAsUserId: user.id, tenantId },
    },
    async (run) => {
      const subject = await verifyWorkspaceSubject({ user, tenantId });
      if (!subject)
        throw new Error('Demo owner workspace could not be verified.');
      const operation = workspaceWorkflowOperation('profile.manage');
      await run.assertOperation(operation.collection, operation.action);
      return await work(subject);
    },
  );
}

function ownedCollection(
  collection: Collection,
  scope: Record<string, unknown>,
): Collection {
  return {
    create: async (payload) =>
      await collection.create({ ...payload, ...scope }),
    list: async (options = {}) =>
      await collection.list({
        ...options,
        where: {
          ...(options.where as Record<string, unknown> | undefined),
          ...scope,
        },
      }),
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
  options: SyntheticDemoFixtureOptions = {},
): Promise<SyntheticDemoFixtureResult> {
  assertSyntheticDemoFixtureEnabled(environment);
  if (!suppliedCollections) {
    return await withSyntheticDemoOwnerContext(async (subject) => {
      // An explicit profile selector must prove ownership in native storage.
      const verified = options.subject?.profileId
        ? await resolveWorkspaceSubjectForProfile(options.subject.profileId)
        : subject;
      return await seedSyntheticDemoFixture(
        await defaultCollections(),
        environment,
        {
          ...options,
          subject: verified,
          filesystem: options.filesystem ?? (await getResumeFilesystem()),
        },
      );
    }, environment);
  }
  const subject = requireCandidateOnboardingSubject(
    options.subject as WorkspaceSubject,
  );
  const ownerScope = {
    tenantId: subject.tenantId,
    ownerUserId: subject.userId,
  };
  const collections = { ...suppliedCollections };
  collections.candidateProfiles = ownedCollection(
    collections.candidateProfiles,
    ownerScope,
  );
  if (
    subject.profileId &&
    !(
      await collections.candidateProfiles.list({
        limit: 1,
        where: { id: subject.profileId },
      })
    )[0]
  ) {
    throw new Error('The selected demo profile is unavailable.');
  }
  const profile = await findOrCreate(
    collections.candidateProfiles,
    subject.profileId
      ? { id: subject.profileId }
      : { profileKey: `${FIXTURE_PREFIX}-candidate` },
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
  if (subject.profileId && profile.created)
    throw new Error('The selected demo profile is unavailable.');
  const profileId = stringValue(profile.record.id);
  if (!profileId) throw new Error('Demo profile is missing its id.');
  const privateScope = { ...ownerScope, candidateProfileId: profileId };
  for (const name of [
    'agentRuns',
    'applicationMaterialComments',
    'applications',
    'candidateAnswers',
    'decisions',
    'resumeAssets',
    'tasks',
  ] as const) {
    collections[name] = ownedCollection(collections[name], privateScope);
  }
  const basePath = `${FIXTURE_RESUME_BASE_PATH}-${subject.tenantId}-${subject.userId}-${profileId}`;
  const company = await findOrCreate(
    collections.companies,
    { companyKey: `${FIXTURE_PREFIX}-company` },
    {
      companyKey: `${FIXTURE_PREFIX}-company`,
      name: 'Example Orbit Labs (fictional demo)',
      hqLocation: 'Distributed (fictional demo)',
      productSummary:
        'Fictional local-first employment workspace used only to demonstrate Iolaus opportunity triage.',
      researchStatus: 'complete',
      remotePolicy: 'remote',
      technicalSummary:
        'Fictional product team working with TypeScript, Svelte, Node.js, and PostgreSQL.',
      whyInteresting:
        'Demo-only context: this record exists to make the local triage workflow legible.',
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
      name: 'Example Ashby board — fictional local demo (no live crawl)',
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
      compNotes:
        'Fictional CAD salary range for local triage only; it is not an offer or a real compensation signal.',
      currency: 'CAD',
      descriptionRaw:
        'Fictional Iolaus demo opportunity. No employer or external posting exists.\n\nLead a small platform team building a local-first employment workspace that people and agents can use together. Shape reliable workflows for collecting opportunities, comparing fit, and preparing reviewed applications.\n\nYou would work closely with product and design to turn agent-assisted steps into calm, understandable screens. This is demo content only: no role is open and no external action is possible.',
      descriptionSummary:
        'Lead platform work for a fictional local-first employment workspace, making agent-assisted job search reliable and understandable.',
      employmentType: 'full_time',
      externalId: `${FIXTURE_PREFIX}-opportunity`,
      locationNotes: 'Remote within Canada (fictional local demo)',
      locations: 'Canada',
      postingUrl: 'https://example.invalid/iolaus-demo-posting',
      preferredSkills: 'WebMCP\nAccessibility\nProduct design collaboration',
      qualifications:
        'Experience owning production web systems\nClear written communication\nComfort working across product and platform concerns',
      requiredSkills: 'TypeScript\nSvelte\nNode.js\nPostgreSQL',
      responsibilities:
        'Design durable agent-assisted workflows\nShip accessible Svelte interfaces\nImprove reliability and observability for local data',
      salaryMax: 195000,
      salaryMin: 165000,
      seniority: 'principal',
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
      compNotes:
        'Fictional CAD salary range for a safe, local triage demonstration only.',
      currency: 'CAD',
      descriptionRaw:
        'Fictional Iolaus triage opportunity. No employer or external posting exists.\n\nBuild the daily decision-making experience for people using an agent to find work. Turn messy listing data into concise, reviewable cards and make every recommendation easy to inspect, annotate, accept, defer, or reject.\n\nThis listing intentionally exercises the triage queue. It is fictional, has no employer contact, and cannot be submitted.',
      descriptionSummary:
        'Build the reviewable job-triage experience that helps people make informed decisions with an agent.',
      employmentType: 'full_time',
      externalId: `${FIXTURE_PREFIX}-triage-opportunity`,
      firstSeenAt: new Date('2026-09-03T00:02:00.000Z'),
      freshness: 'fresh',
      lastSeenAt: new Date('2026-09-03T00:01:00.000Z'),
      locationNotes:
        'Remote in Canada or the United States (fictional local demo)',
      locations: 'Canada\nUnited States',
      postingUrl: 'https://example.invalid/iolaus-demo-triage-posting',
      preferredSkills: 'WebMCP\nUX research\nData visualization',
      qualifications:
        'Experience delivering end-to-end product features\nStrong product judgment\nAbility to explain tradeoffs clearly',
      requiredSkills: 'TypeScript\nSvelte\nSQL\nProduct discovery',
      responsibilities:
        'Improve triage clarity and pacing\nDesign agent-visible decision context\nPartner with users on workflow feedback',
      salaryMax: 180000,
      salaryMin: 145000,
      seniority: 'staff',
      sourceId: stringValue(source.record.id),
      status: 'recommended',
      title: 'Fictional Staff Engineer — Iolaus Triage Demo',
      workMode: 'remote',
    },
  );
  // Keep a second undecided row behind the reviewed one. It proves that the
  // agent's recorded decision advances a real queue, while the browser can
  // still visibly render the existing triage modal afterwards.
  const triageFollowupOpportunity = await findOrCreate(
    collections.opportunities,
    { externalId: `${FIXTURE_PREFIX}-triage-followup-opportunity` },
    {
      applyInstructions: 'Fictional demo only. Never submit externally.',
      applyMethod: 'manual',
      applyUrl: 'https://example.invalid/iolaus-demo-triage-followup-apply',
      companyId: stringValue(company.record.id),
      compNotes:
        'Fictional CAD salary range for a safe, local triage demonstration only.',
      currency: 'CAD',
      descriptionRaw:
        "Second fictional Iolaus triage opportunity. No employer or external posting exists.\n\nBuild dependable integrations that turn public job-board content into a respectful, user-reviewed workflow. Focus on resilient ingestion, clear source provenance, and tools that let an agent assist without making decisions on a person's behalf.\n\nThis follow-up record exists to prove that a triage decision advances the queue. It is fictional and cannot contact or submit to an employer.",
      descriptionSummary:
        'Build reliable job-source integrations and transparent agent controls for a fictional local-first job-search workspace.',
      employmentType: 'full_time',
      externalId: `${FIXTURE_PREFIX}-triage-followup-opportunity`,
      firstSeenAt: new Date('2026-09-03T00:00:00.000Z'),
      freshness: 'fresh',
      lastSeenAt: new Date('2026-09-03T00:01:00.000Z'),
      locationNotes:
        'Remote within North American time zones (fictional local demo)',
      locations: 'Canada\nUnited States',
      postingUrl: 'https://example.invalid/iolaus-demo-triage-followup-posting',
      preferredSkills: 'WebMCP\nObservability\nDistributed systems',
      qualifications:
        'Experience with public-web integrations\nPragmatic approach to reliability\nRespect for user consent and provenance',
      requiredSkills: 'TypeScript\nNode.js\nPostgreSQL\nHTTP APIs',
      responsibilities:
        'Build resilient source connectors\nSurface crawl progress and provenance\nKeep agent actions user-reviewable',
      salaryMax: 175000,
      salaryMin: 140000,
      seniority: 'staff',
      sourceId: stringValue(source.record.id),
      status: 'recommended',
      title: 'Fictional Staff Engineer — Iolaus Triage Follow-up',
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
      newOpportunityCount: 3,
      pendingCount: 0,
      requestKey: `${FIXTURE_PREFIX}-crawl`,
      resultCount: 3,
      sourceId: stringValue(source.record.id),
      startedAt: new Date('2026-09-03T00:00:00.000Z'),
      status: 'completed',
      terminalCount: 3,
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
  await findOrCreate(
    collections.sourceCrawlItems,
    { attemptKey: `${FIXTURE_PREFIX}-triage-followup-opportunity-item` },
    {
      attemptKey: `${FIXTURE_PREFIX}-triage-followup-opportunity-item`,
      canonicalUrl:
        'https://example.invalid/iolaus-demo-triage-followup-posting',
      companyName: 'Example Orbit Labs (fictional demo)',
      contentFingerprint: `${FIXTURE_PREFIX}-triage-followup-opportunity-v1`,
      contentVersion: 1,
      externalId: `${FIXTURE_PREFIX}-triage-followup-opportunity`,
      matchStrategy: 'fixture_exact',
      opportunityId: stringValue(triageFollowupOpportunity.record.id),
      outcome: 'created',
      postingUrl: 'https://example.invalid/iolaus-demo-triage-followup-posting',
      reconciliationKey: `${FIXTURE_PREFIX}-triage-followup-opportunity`,
      reconciliationStatus: 'matched',
      sourceCrawlId: stringValue(crawl.record.id),
      status: 'seen',
      terminalAt: new Date('2026-09-03T00:01:00.000Z'),
      title: 'Fictional Staff Engineer — Iolaus Triage Follow-up',
    },
  );
  const resumePayload = {
    assetType: 'resume',
    candidateProfileId: stringValue(profile.record.id),
    generatedAt: new Date('2026-09-03T00:01:00.000Z'),
    generatedPath: basePath,
    htmlPath: `${basePath}.html`,
    markdownPath: `${basePath}.md`,
    notes:
      'Generated fictional demo resume. Local review only; no real candidate data or submission use.',
    // Keep the original stable key so prior local demos receive this safe
    // upgrade rather than a second fixture asset.
    outputSlug: `${FIXTURE_PREFIX}-resume-placeholder`,
    pdfBasename: '',
    pdfPath: '',
    status: 'generated',
    textPath: `${basePath}.txt`,
    title: 'Fictional demo resume — generated text',
  };
  const resume = await findOrCreate(
    collections.resumeAssets,
    { outputSlug: `${FIXTURE_PREFIX}-resume-placeholder` },
    resumePayload,
  );
  // A previous demo version seeded a placeholder. This one static, visibly
  // fictional asset may be refreshed in place: it never represents a user's
  // resume and makes existing local demo installations immediately reviewable.
  if (!resume.created) {
    Object.assign(resume.record, resumePayload);
    await resume.record.save();
  }
  const filesystem =
    options.filesystem ??
    (suppliedCollections ? undefined : await getResumeFilesystem());
  if (filesystem) {
    await writeSyntheticResumeArtifacts(filesystem, basePath);
  }
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
    profileId,
    tenantId: subject.tenantId,
    userId: subject.userId,
    applicationId: stringValue(application.record.id),
    created:
      profile.created ||
      company.created ||
      opportunity.created ||
      triageOpportunity.created ||
      triageFollowupOpportunity.created ||
      source.created ||
      crawl.created ||
      resume.created ||
      application.created,
    opportunityId: stringValue(opportunity.record.id),
    crawlId: stringValue(crawl.record.id),
    sourceId: stringValue(source.record.id),
    triageFollowupOpportunityId: stringValue(
      triageFollowupOpportunity.record.id,
    ),
    triageOpportunityId: stringValue(triageOpportunity.record.id),
  };
}
