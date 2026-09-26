import { writeFileSync } from 'node:fs';
import { getCollection } from '../src/lib/server/smrt.js';
import {
  assertSyntheticDemoFixtureEnabled,
  seedSyntheticDemoFixture,
} from '../src/lib/server/synthetic-demo-fixture.js';

assertSyntheticDemoFixtureEnabled();
const fixture = await seedSyntheticDemoFixture();
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
