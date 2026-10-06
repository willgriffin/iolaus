import { seedSyntheticDemoFixture } from '../src/lib/server/synthetic-demo-fixture.js';

// Select an existing native owner with IOLAUS_DEMO_OWNER_EMAIL; seed refuses
// missing/revoked/ambiguous ownership rather than inventing a local identity.
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
