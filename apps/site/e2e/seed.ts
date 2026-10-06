import { writeFileSync } from 'node:fs';
import { renderHtmlToPdf } from '@happyvertical/pdf';
import { executeAsPrincipal } from '@happyvertical/smrt-agents';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { withSystemContext } from '@happyvertical/smrt-tenancy';
import {
  DEFAULT_ROLE_SLUGS,
  MembershipCollection,
  MembershipStatus,
  RoleCollection,
  SessionService,
  TenantCollection,
  TenantStatus,
  UserCollection,
  UserStatus,
} from '@happyvertical/smrt-users';
import { saveCandidateOnboarding } from '../src/lib/server/candidate-onboarding.js';
import { getDbConfig, getSmrtOptions } from '../src/lib/server/db.js';
import {
  ensureOpportunityIntelligenceControl,
  ensureOpportunityIntelligenceGovernanceSchema,
  setOpportunityIntelligenceControl,
} from '../src/lib/server/opportunity-intelligence-governance.js';
import { ensureOpportunityIntelligenceJobDedupe } from '../src/lib/server/opportunity-intelligence-job-schema.js';
import { fingerprintOpportunitySourceContent } from '../src/lib/server/opportunity-source-content.js';
import { getResumeFilesystem } from '../src/lib/server/resume-files.js';
import { getCollection } from '../src/lib/server/smrt.js';
import {
  assertSyntheticDemoFixtureEnabled,
  seedSyntheticDemoFixture,
  withSyntheticDemoOwnerContext,
} from '../src/lib/server/synthetic-demo-fixture.js';
import { resolveWorkspaceSubjectForProfile } from '../src/lib/server/workspace-subject.js';

assertSyntheticDemoFixtureEnabled();
if (process.env.IOLAUS_E2E_SOURCE_COVERAGE === '1') {
  // Explicit fixture migration, before any queued workflow. Runtime workers
  // receive no database argument and only verify this installed native index.
  const db = await resolveDatabase(getDbConfig());
  await ensureOpportunityIntelligenceJobDedupe(db);
  await ensureOpportunityIntelligenceGovernanceSchema(db);
  await ensureOpportunityIntelligenceControl();
  await setOpportunityIntelligenceControl({
    enabled: true,
    reason: 'fictional_local_browser_qa',
    inputTokenThreshold: 1_000_000,
    requestThreshold: 100,
  });
}
const sessionCookieName = process.env.IOLAUS_E2E_SESSION_COOKIE_NAME;
if (!sessionCookieName)
  throw new Error('E2E native server session cookie name missing.');
await withSyntheticDemoOwnerContext(async (identity) => {
  // This is the ordinary verified onboarding workflow in the isolated runtime.
  // Refuse to alter an existing personal profile if setup isolation ever regresses.
  if (identity.profileId)
    throw new Error('E2E runtime already has a candidate profile.');
  const onboarding = await saveCandidateOnboarding(
    {
      name: 'Jordan Example',
      email: 'jordan.example@demo.invalid',
      title: 'Fictional Staff Software Engineer',
      summary: 'Fictional browser test candidate. Never submit externally.',
    },
    identity,
  );
  const profileId = String(onboarding.profile.id ?? '');
  const subject = await resolveWorkspaceSubjectForProfile(profileId);
  const fixture = await seedSyntheticDemoFixture(undefined, process.env, {
    subject,
  });
  const resumeAssets = await getCollection('ResumeAsset');
  const publishedFixture = await resumeAssets.get(fixture.resumeAssetId);
  if (!publishedFixture)
    throw new Error('Fictional default resume fixture missing.');
  const filesystem = await getResumeFilesystem();
  const fictionalResume = publishedFixture as unknown as Record<
    string,
    unknown
  >;
  const html = String(await filesystem.read(String(fictionalResume.htmlPath)));
  const pdfPath = `${String(fictionalResume.generatedPath)}.pdf`;
  await filesystem.write(pdfPath, Buffer.from(await renderHtmlToPdf(html)), {
    createParents: true,
  });
  Object.assign(publishedFixture, {
    pdfPath,
    pdfBasename: 'fictional-qa-resume.pdf',
    isPublished: true,
    publishedAt: new Date(),
    status: 'published',
  });
  await publishedFixture.save();
  const applyingOpportunities: Record<string, string> = {};
  const sourceCoverageOpportunities: Record<
    string,
    Record<string, string>
  > = {};
  const publicOpportunities = await getCollection('Opportunity');
  for (const project of [
    'android-portrait',
    'android-landscape',
    'android-narrow',
    'desktop-control',
  ]) {
    const descriptionRaw =
      'Fictional local QA role in Canada. Build accessible TypeScript interfaces and reliable integrations. No employer, live posting, or outreach exists.';
    const opportunity = await publicOpportunities.create({
      applyInstructions:
        'Fictional local browser QA only. Never submit externally.',
      applyMethod: 'other',
      companyId: '',
      currency: 'CAD',
      descriptionRaw,
      descriptionSummary:
        'Fictional application preparation for accessible TypeScript software.',
      requiredSkills: 'TypeScript\nAccessible interfaces',
      salaryMin: 155000,
      salaryMax: 175000,
      sourceContentJson: JSON.stringify({ descriptionRaw }),
      sourceContentFingerprint: fingerprintOpportunitySourceContent({
        descriptionRaw,
      }),
      sourceContentVersion: 1,
      status: 'found',
      title: `Applying readiness ${project} fictional engineer`,
      workMode: 'remote',
    });
    await opportunity.save();
    if (!opportunity.id)
      throw new Error('Applying readiness opportunity missing id.');
    applyingOpportunities[project] = opportunity.id;
    if (process.env.IOLAUS_E2E_SOURCE_COVERAGE === '1') {
      sourceCoverageOpportunities[project] = {};
      for (const [scenario, marker] of [
        ['ready', ''],
        ['provider-failure', '[qa:source-provider-failure]'],
        ['audit-malformed', '[qa:source-audit-malformed]'],
      ] as const) {
        const sourceContent = {
          title: `Source coverage ${project} ${scenario} fictional engineer`,
          descriptionRaw: [
            'Requirements',
            `You must build TypeScript interfaces for this fictional ${project} local QA role. ${marker}`.trim(),
          ].join('\n'),
          workMode: 'remote',
          employmentType: 'full_time',
          postedAt: '2020-01-01T00:00:00.000Z',
        };
        const posting = await publicOpportunities.create({
          ...sourceContent,
          // Keep this dedicated workflow fixture outside Overview's new-posting
          // window so its eventual private scores do not alter independent QA.
          firstSeenAt: new Date('2020-01-01T00:00:00.000Z'),
          postedAt: new Date('2020-01-01T00:00:00.000Z'),
          status: 'found',
          sourceContentJson: JSON.stringify(sourceContent),
          sourceContentFingerprint:
            fingerprintOpportunitySourceContent(sourceContent),
          sourceContentVersion: 1,
        });
        await posting.save();
        if (!posting.id)
          throw new Error('Fictional source coverage posting missing its id');
        sourceCoverageOpportunities[project][scenario] = posting.id;
      }
    }
  }
  const ownership = {
    tenantId: subject.tenantId,
    ownerUserId: subject.userId,
    candidateProfileId: subject.profileId,
  };
  const decisions = await getCollection('Decision');
  const privateCollection = async (name: string) => {
    const collection = await getCollection(name);
    return {
      create: async (payload: Record<string, unknown>) =>
        await collection.create({ ...payload, ...ownership }),
    };
  };
  const recordReview = async (
    opportunityId: string | null | undefined,
    status: string,
  ) => {
    if (!opportunityId)
      throw new Error('Review fixture opportunity is missing.');
    const decision = await decisions.create({
      ...ownership,
      opportunityId,
      decision: status === 'reject' ? 'reject' : 'clear_review',
      decisionBy: 'owner',
    });
    await decision.save();
  };
  const sources = await getCollection('Source');
  // Long, synthetic descriptions exercise the triage body's real touch scrolling.
  const opportunities = await getCollection('Opportunity');
  const applications = await privateCollection('Application');
  for (const id of [
    fixture.triageOpportunityId,
    fixture.triageFollowupOpportunityId,
  ]) {
    const opportunity = (await opportunities.get(id)) as unknown as {
      descriptionRaw: string;
      save: () => Promise<unknown>;
    } | null;
    if (!opportunity) throw new Error('Synthetic triage fixture is missing.');
    opportunity.descriptionRaw = Array.from(
      { length: 24 },
      (_, index) =>
        `Fictional responsibility ${index + 1}: Build accessible software and dependable integrations. This synthetic posting is for mobile layout testing only; no employer or external action exists.`,
    ).join('\n\n');
    await opportunity.save();
  }
  // These rows drive the inactive-source sweep through the real SvelteKit action
  // and local database. Keep every label visibly fictional so the browser suite
  // cannot be mistaken for a live employment workflow.
  const activeSweepSource = await sources.create({
    isActive: true,
    name: 'Fictional active source — sweep E2E',
    provider: 'manual',
    refreshCadence: 'manual',
    sourceRole: 'root',
    type: 'manual',
    url: 'https://example.invalid/iolaus-e2e-active-source',
  });
  await activeSweepSource.save();
  const activeSweepSourceId = activeSweepSource.id;
  if (!activeSweepSourceId)
    throw new Error('Synthetic active sweep source is missing its id.');
  const sweepOpportunity = async (
    title: string,
    sourceId: string,
    overrides: Record<string, unknown> = {},
  ) => {
    const { humanReviewStatus, ...publicOverrides } = overrides;
    const record = await opportunities.create({
      currency: 'CAD',
      descriptionRaw:
        'Fictional local browser test opportunity. No employer or external action exists.',
      lastSeenAt: new Date('2020-01-01T00:00:00.000Z'),
      sourceId,
      status: 'found',
      title,
      workMode: 'remote',
      ...publicOverrides,
    });
    await record.save();
    if (humanReviewStatus)
      await recordReview(record.id, String(humanReviewStatus));
    return record;
  };
  const sweepNotSeenDaysByProject = {
    'android-portrait': 120,
    'android-landscape': 90,
    'android-narrow': 60,
    'desktop-control': 30,
  } as const;
  for (const [project, notSeenDays] of Object.entries(
    sweepNotSeenDaysByProject,
  )) {
    const inactiveSweepSource = await sources.create({
      isActive: false,
      name: `Fictional inactive source — sweep E2E ${project}`,
      provider: 'manual',
      refreshCadence: 'manual',
      sourceRole: 'root',
      type: 'manual',
      url: `https://example.invalid/iolaus-e2e-inactive-source-${project}`,
    });
    await inactiveSweepSource.save();
    const inactiveSweepSourceId = inactiveSweepSource.id;
    if (!inactiveSweepSourceId)
      throw new Error(`Synthetic sweep source ${project} is missing its id.`);
    // Test projects share one local database. Descending thresholds make each
    // project archive only its own eligible cohort, even after prior projects
    // have completed their destructive confirmation.
    const staleAt = new Date(Date.now() - (notSeenDays + 1) * 86_400_000);
    await sweepOpportunity(
      `Fictional sweep ${project} eligible`,
      inactiveSweepSourceId,
      { lastSeenAt: staleAt },
    );
    await sweepOpportunity(
      `Fictional sweep ${project} active-source protected`,
      activeSweepSourceId,
      { lastSeenAt: staleAt },
    );
    await sweepOpportunity(
      `Fictional sweep ${project} recently-seen protected`,
      inactiveSweepSourceId,
      {
        lastSeenAt: new Date(),
      },
    );
    await sweepOpportunity(
      `Fictional sweep ${project} decided protected`,
      inactiveSweepSourceId,
      {
        lastSeenAt: staleAt,
        humanReviewStatus: 'reject',
      },
    );
    const applicationProtectedOpportunity = await sweepOpportunity(
      `Fictional sweep ${project} application-linked protected`,
      inactiveSweepSourceId,
      { lastSeenAt: staleAt },
    );
    const application = await applications.create({
      applicationInstructions:
        'Fictional local browser-test application. No submission is possible.',
      applyMethod: 'manual',
      opportunityId: applicationProtectedOpportunity.id,
      status: 'awaiting_user',
    });
    await application.save();
  }
  // Independent rows per viewport keep persisted decisions from leaking between projects.
  for (const [projectIndex, project] of [
    'android-portrait',
    'android-landscape',
    'android-narrow',
    'desktop-control',
  ].entries()) {
    const salaryBase = 100_000 + projectIndex * 200_000;
    const variants: Array<{
      name: string;
      salaryMin: number;
      status: string;
      workMode: string;
      expiresAt?: Date | null;
      humanReviewStatus?: 'reject';
    }> = [
      ...Array.from({ length: 6 }, (_, index) => ({
        name: `Role ${index + 1}`,
        salaryMin: salaryBase + index * 10_000,
        status: 'found',
        workMode: 'remote',
        // The list deliberately includes expired rows unless excluded by its filters.
        expiresAt: index === 0 ? new Date('2020-01-01') : null,
      })),
      {
        name: 'Compensation excluded',
        salaryMin: 1,
        status: 'found',
        workMode: 'onsite',
      },
      {
        name: 'Status excluded',
        salaryMin: salaryBase + 5_000,
        status: 'recommended',
        workMode: 'remote',
      },
      {
        name: 'Decided excluded',
        salaryMin: salaryBase + 6_000,
        status: 'found',
        workMode: 'remote',
        humanReviewStatus: 'reject',
      },
    ];
    // `Readiness` rows belong to applying-readiness.spec.ts, whose decisions
    // must not consume the `Sequence` rows the mobile triage spec orders.
    for (const family of ['Sequence', 'Readiness'])
      for (const variant of [...variants].reverse()) {
        const { humanReviewStatus, ...publicVariant } = variant;
        const record = await opportunities.create({
          ...publicVariant,
          title: `${family} ${project} ${variant.name}`,
          descriptionRaw:
            'Synthetic queue inheritance test. No employer or external action.',
          currency: 'CAD',
          requiredSkills: 'TypeScript',
          postedAt: new Date('2026-01-01'),
          postingUrl: 'https://example.invalid/iolaus-fictional-qa',
        });
        await record.save();
        if (humanReviewStatus) await recordReview(record.id, humanReviewStatus);
      }
  }

  // Current-source eligibility fixture rows exercise the list's shared query
  // path. Their names and evidence are fictional and isolated by viewport.
  for (const project of [
    'android-portrait',
    'android-landscape',
    'android-narrow',
    'desktop-control',
  ] as const) {
    const eligibilityOpportunity = async (
      name: string,
      descriptionRaw: string,
    ) => {
      const source = {
        sourceContentFingerprint: fingerprintOpportunitySourceContent({
          descriptionRaw,
        }),
        sourceContentVersion: 1,
        sourceContentJson: JSON.stringify({ descriptionRaw }),
        descriptionRaw,
      };
      const record = await opportunities.create({
        ...source,
        currency: 'CAD',
        status: 'found',
        title: `Eligibility ${project} ${name}`,
        workMode: 'remote',
      });
      await record.save();
    };
    await eligibilityOpportunity('Canada', 'Location: Canada.');
    await eligibilityOpportunity(
      'Sponsor and US',
      'Candidates must reside in the United States. We offer visa sponsorship.',
    );
    await eligibilityOpportunity('Unknown', 'A general fictional role.');
    await eligibilityOpportunity(
      'Conflict',
      'Location: Canada. Candidates must reside in the United States.',
    );
  }
  const tasks = await privateCollection('Task');
  for (const values of [
    {
      title: 'Fictional overdue priority task',
      dueAt: new Date('2020-01-01'),
      kanbanColumn: 'inbox',
    },
    {
      title: 'Fictional owner decision priority task',
      dueAt: new Date('2100-01-01'),
      kanbanColumn: 'needs_user_decision',
    },
  ]) {
    const task = await tasks.create({
      ...values,
      assigneeRole: 'owner',
      description: 'Fictional priority ordering QA. No external action.',
      status: 'open',
      taskType: 'review_application',
    });
    await task.save();
  }
  for (let index = 0; index < 16; index += 1) {
    const task = await tasks.create({
      externalTaskId: `mobile-e2e-fictional-${index}`,
      title: `Fictional mobile task ${String(index + 1).padStart(2, '0')}`,
      description:
        'Synthetic browser test only. No employer or external action.',
      status: 'open',
      taskType: 'review_application',
      kanbanColumn: 'inbox',
      applicationId: fixture.applicationId,
      opportunityId: fixture.opportunityId,
    });
    await task.save();
  }
  const orphanApplication = await applications.create({
    applyMethod: 'manual',
    applicationInstructions:
      'Fictional orphan cleanup fixture. It intentionally has no opportunity.',
    notes: 'Retain this human note after archiving.',
    status: 'draft',
  });
  await orphanApplication.save();
  const approvedApplication = await applications.create({
    approvedAt: new Date('2026-09-30T12:00:00.000Z'),
    approvedByUserId: subject.userId,
    applicationInstructions:
      'Fictional approved cleanup fixture. Never submit externally.',
    opportunityId: fixture.opportunityId,
    packetAssetId: 'fictional-packet-to-retain',
    resumeAssetId: 'fictional-resume-to-retain',
    status: 'approved',
  });
  await approvedApplication.save();
  const draftingApplication = await applications.create({
    applicationInstructions:
      'Fictional in-progress cleanup fixture. Never submit externally.',
    opportunityId: fixture.opportunityId,
    status: 'application_drafting',
  });
  await draftingApplication.save();
  for (const [applicationId, title] of [
    [orphanApplication.id, 'Fictional orphan cleanup task'],
    [approvedApplication.id, 'Fictional approved cleanup task'],
    [draftingApplication.id, 'Fictional drafting cleanup task'],
  ] as const) {
    const task = await tasks.create({
      applicationId,
      description: 'Fictional local cleanup task. No external action exists.',
      externalTaskId: `e2e-cleanup-${applicationId}`,
      kanbanColumn: 'inbox',
      status: 'open',
      taskType: 'review_application',
      title,
    });
    await task.save();
  }
  writeFileSync(
    process.env.IOLAUS_E2E_FIXTURE as string,
    JSON.stringify({
      ...fixture,
      applyingOpportunities,
      sourceCoverageOpportunities,
      approvedApplicationId: approvedApplication.id,
      draftingApplicationId: draftingApplication.id,
      orphanApplicationId: orphanApplication.id,
    }),
    {
      mode: 0o600,
    },
  );

  // A separate real native identity/session proves denial with an authenticated
  // foreign tenant. Nothing is installed in application routes or production auth.
  const options = getSmrtOptions();
  const foreign = await withSystemContext(async () => {
    const users = await UserCollection.create(options);
    const user = await users.create({
      email: 'foreign-mobile-qa@example.invalid',
      status: UserStatus.ACTIVE,
    });
    await user.save();
    const tenants = await TenantCollection.create(options);
    const tenant = await tenants.create({
      name: 'Fictional foreign browser workspace',
      slug: 'fictional-foreign-e2e',
      status: TenantStatus.ACTIVE,
    });
    await tenant.save();
    const roles = await RoleCollection.create(options);
    const role = await roles.findBySlug(DEFAULT_ROLE_SLUGS.MEMBER);
    if (!user.id || !tenant.id || !role?.id)
      throw new Error('Foreign native fixture prerequisites are missing.');
    const memberships = await MembershipCollection.create(options);
    const membership = await memberships.create({
      userId: user.id,
      tenantId: tenant.id,
      roleId: role.id,
      status: MembershipStatus.ACTIVE,
    });
    await membership.save();
    return { userId: user.id, tenantId: tenant.id };
  });
  const session = await executeAsPrincipal(
    {
      ...options,
      action: 'e2e.foreign.onboarding',
      onBehalfOfUserId: foreign.userId,
      postgresRls: false,
      principal: {
        allowedTools: [],
        runAsUserId: foreign.userId,
        tenantId: foreign.tenantId,
      },
    },
    async () => {
      await saveCandidateOnboarding(
        { name: 'Fictional Foreign QA Candidate' },
        foreign,
      );
      const sessions = await SessionService.create(options);
      const sessionId = await sessions.createSession(
        foreign.userId,
        foreign.tenantId,
      );
      const context = await sessions.loadSessionContext(sessionId);
      if (
        context?.user.id !== foreign.userId ||
        context.tenantId !== foreign.tenantId
      )
        throw new Error('Foreign native session verification failed.');
      return sessionId;
    },
  );
  writeFileSync(
    process.env.IOLAUS_E2E_FOREIGN_AUTH as string,
    JSON.stringify({
      cookies: [
        {
          name: sessionCookieName,
          value: session,
          domain: '127.0.0.1',
          path: '/',
          expires: -1,
          httpOnly: true,
          secure: false,
          sameSite: 'Lax',
        },
      ],
      origins: [],
    }),
    { mode: 0o600 },
  );
});
