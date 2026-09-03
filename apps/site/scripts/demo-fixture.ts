import { seedSyntheticDemoFixture } from '../src/lib/server/synthetic-demo-fixture.js';

const result = await seedSyntheticDemoFixture();
console.log(
  JSON.stringify(
    {
      ...result,
      message:
        'Synthetic fictional demo fixture is ready. It never contacts an employer or creates a real application.',
    },
    null,
    2,
  ),
);
