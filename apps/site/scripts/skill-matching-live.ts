import { getAI } from '@happyvertical/ai';
import {
  prepareSkillMatching,
  resolveSkillMatching,
} from '../src/lib/server/skill-matching.js';

// Synthetic, labeled canaries. This makes paid calls only when invoked explicitly.
const skill = (text: string, id = text) => ({
  id,
  kind: 'resume_skill',
  title: text,
  text,
});
const experience = (text: string) => ({
  id: 'experience',
  kind: 'achievement',
  title: 'Candidate experience',
  text,
});
const cases = [
  {
    name: 'technology-equivalence',
    requirements: [
      'server-side JavaScript services',
      'Java',
      'five years operating PostgreSQL at scale',
    ],
    sources: [skill('Node.js')],
    expected: [true, false, false],
  },
  {
    name: 'experience-depth',
    requirements: [
      'Production Kubernetes operations',
      'Ten years Kubernetes operations',
    ],
    sources: [
      experience(
        'Built and operated Kubernetes clusters in production for four years.',
      ),
    ],
    expected: [true, false],
  },
  {
    name: 'negated-experience',
    requirements: ['Rust'],
    sources: [
      experience('No production experience with Rust; planning to learn it.'),
    ],
    expected: [false],
  },
  {
    name: 'additional-capabilities',
    requirements: [
      'relational database querying',
      'C',
      'Java',
      'Production PostgreSQL operations',
    ],
    sources: [skill('PostgreSQL'), skill('C++'), skill('JavaScript')],
    expected: [true, false, false, false],
  },
  {
    name: 'qualified-experience',
    requirements: [
      'Three years Python development',
      'Ten years Python development',
      'Engineering team leadership',
    ],
    sources: [
      experience(
        'Developed Python applications professionally for three years. Individual contributor with no management experience.',
      ),
    ],
    expected: [true, false, false],
  },
  {
    name: 'holdout-skills',
    requirements: [
      'HTTP API development',
      'Ruby',
      'Five years PHP development',
    ],
    sources: [experience('Built HTTP APIs in PHP for two years.')],
    expected: [true, false, false],
  },
  {
    name: 'missing-evidence',
    requirements: ['Machine learning'],
    sources: [skill('CSS')],
    expected: [false],
  },
];

if (!process.env.TYPESAFE_API_KEY) {
  console.error(
    'TYPESAFE_API_KEY is required; supply it through the environment.',
  );
  process.exit(1);
}
const model = process.env.OPPORTUNITY_SKILL_DECISION_MODEL || 'jev-latest';
const rows = [];
let failed = false;
try {
  const client = await getAI({
    type: 'typesafe',
    apiKey: process.env.TYPESAFE_API_KEY,
    defaultModel: model,
  });
  for (const item of cases) {
    for (const reversed of [false, true]) {
      const requirements = reversed
        ? [...item.requirements].reverse()
        : item.requirements;
      const expected = reversed ? [...item.expected].reverse() : item.expected;
      const sources = reversed ? [...item.sources].reverse() : item.sources;
      const prepared = prepareSkillMatching(requirements, sources);
      const start = Date.now();
      const result = await client.decide(prepared.request, {
        model,
        timeout: 30000,
      });
      const resolved = resolveSkillMatching(prepared, result);
      const matches = resolved.matches.map((match, index) => {
        const passed = (match.status === 'supported') === expected[index];
        if (!passed) failed = true;
        return {
          requirement: match.requirement,
          status: match.status,
          probability: match.probability,
          expectedSupported: expected[index],
          passed,
        };
      });
      rows.push({
        name: item.name,
        reversed,
        version: resolved.version,
        model: result.model,
        usage: result.usage,
        latencyMs: Date.now() - start,
        matches,
      });
    }
  }
} catch {
  // Provider errors can include request headers: never log the raw error.
  console.error(
    'Live skill matching failed; provider error details suppressed.',
  );
  failed = true;
}
console.log(
  JSON.stringify(
    { schema: 'iolaus-live-skills-smoke/v1', passed: !failed, cases: rows },
    null,
    2,
  ),
);
process.exitCode = failed ? 1 : 0;
