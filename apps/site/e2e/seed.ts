import { writeFileSync } from 'node:fs';
import { getCollection } from '../src/lib/server/smrt.js';
import {
  assertSyntheticDemoFixtureEnabled,
  seedSyntheticDemoFixture,
} from '../src/lib/server/synthetic-demo-fixture.js';

assertSyntheticDemoFixtureEnabled();
const fixture = await seedSyntheticDemoFixture();
const sources = await getCollection('Source');
// Long, synthetic descriptions exercise the triage body's real touch scrolling.
const opportunities = await getCollection('Opportunity');
const applications = await getCollection('Application');
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
const sweepOpportunity = async (
  title: string,
  sourceId: string,
  overrides: Record<string, unknown> = {},
) => {
  const record = await opportunities.create({
    currency: 'CAD',
    descriptionRaw:
      'Fictional local browser test opportunity. No employer or external action exists.',
    humanReviewStatus: 'needs_input',
    lastSeenAt: new Date('2020-01-01T00:00:00.000Z'),
    sourceId,
    status: 'found',
    title,
    workMode: 'remote',
    ...overrides,
  });
  await record.save();
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
  // Test projects share one local database. Descending thresholds make each
  // project archive only its own eligible cohort, even after prior projects
  // have completed their destructive confirmation.
  const staleAt = new Date(Date.now() - (notSeenDays + 1) * 86_400_000);
  await sweepOpportunity(
    `Fictional sweep ${project} eligible`,
    inactiveSweepSource.id,
    { lastSeenAt: staleAt },
  );
  await sweepOpportunity(
    `Fictional sweep ${project} active-source protected`,
    activeSweepSource.id,
    { lastSeenAt: staleAt },
  );
  await sweepOpportunity(
    `Fictional sweep ${project} recently-seen protected`,
    inactiveSweepSource.id,
    {
      lastSeenAt: new Date(),
    },
  );
  await sweepOpportunity(
    `Fictional sweep ${project} decided protected`,
    inactiveSweepSource.id,
    {
      lastSeenAt: staleAt,
      humanReviewStatus: 'reject',
    },
  );
  const applicationProtectedOpportunity = await sweepOpportunity(
    `Fictional sweep ${project} application-linked protected`,
    inactiveSweepSource.id,
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
  const variants = [
    ...Array.from({ length: 6 }, (_, index) => ({
      name: `Role ${index + 1}`,
      salaryMin: salaryBase + index * 10_000,
      status: 'found',
      workMode: 'remote',
      humanReviewStatus: 'needs_input',
      // The list deliberately includes expired rows unless excluded by its filters.
      expiresAt: index === 0 ? new Date('2020-01-01') : null,
    })),
    {
      name: 'Compensation excluded',
      salaryMin: 1,
      status: 'found',
      workMode: 'onsite',
      humanReviewStatus: 'needs_input',
    },
    {
      name: 'Status excluded',
      salaryMin: salaryBase + 5_000,
      status: 'recommended',
      workMode: 'remote',
      humanReviewStatus: 'needs_input',
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
    const record = await opportunities.create({
      ...variant,
      title: `Sequence ${project} ${variant.name}`,
      descriptionRaw:
        'Synthetic queue inheritance test. No employer or external action.',
      currency: 'CAD',
      requiredSkills: 'TypeScript',
      postedAt: new Date('2026-01-01'),
    });
    await record.save();
  }
}
const tasks = await getCollection('Task');
for (let index = 0; index < 16; index += 1) {
  const task = await tasks.create({
    externalTaskId: `mobile-e2e-fictional-${index}`,
    title: `Fictional mobile task ${String(index + 1).padStart(2, '0')}`,
    description: 'Synthetic browser test only. No employer or external action.',
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
  approvedByUserId: 'synthetic-owner',
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
