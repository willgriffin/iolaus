import { writeFileSync } from 'node:fs';
import { getCollection } from '../src/lib/server/smrt.js';
import {
  assertSyntheticDemoFixtureEnabled,
  seedSyntheticDemoFixture,
} from '../src/lib/server/synthetic-demo-fixture.js';

assertSyntheticDemoFixtureEnabled();
const fixture = await seedSyntheticDemoFixture();
// Long, synthetic descriptions exercise the triage body's real touch scrolling.
const opportunities = await getCollection('Opportunity');
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
writeFileSync(
  process.env.IOLAUS_E2E_FIXTURE as string,
  JSON.stringify(fixture),
  {
    mode: 0o600,
  },
);
