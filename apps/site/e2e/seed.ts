import { writeFileSync } from 'node:fs';
import { executeAsPrincipal } from '@happyvertical/smrt-agents';
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
import { sessionCookieName } from '../src/lib/server/auth.js';
import { saveCandidateOnboarding } from '../src/lib/server/candidate-onboarding.js';
import { getSmrtOptions } from '../src/lib/server/db.js';
import { fingerprintOpportunitySourceContent } from '../src/lib/server/opportunity-source-content.js';
import { getCollection } from '../src/lib/server/smrt.js';
import {
  assertSyntheticDemoFixtureEnabled,
  seedSyntheticDemoFixture,
  withSyntheticDemoOwnerContext,
} from '../src/lib/server/synthetic-demo-fixture.js';
import { resolveWorkspaceSubjectForProfile } from '../src/lib/server/workspace-subject.js';

assertSyntheticDemoFixtureEnabled();
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
    for (const variant of variants.reverse()) {
      const { humanReviewStatus, ...publicVariant } = variant;
      const record = await opportunities.create({
        ...publicVariant,
        title: `Sequence ${project} ${variant.name}`,
        descriptionRaw:
          'Synthetic queue inheritance test. No employer or external action.',
        currency: 'CAD',
        requiredSkills: 'TypeScript',
        postedAt: new Date('2026-01-01'),
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
  await executeAsPrincipal(
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
    },
  );
  const sessions = await SessionService.create(options);
  const session = await sessions.createSession(
    foreign.userId,
    foreign.tenantId,
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
