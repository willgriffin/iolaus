import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AtsFormSchema } from './ats/types';
import {
  candidateProfileFacts,
  describeApplicationAnswersBody,
  loadApplicationAnswersEditorState,
  normalizeAnswerLabel,
  profileFactForLabel,
  reusableAnswersFromLibrary,
  seedApplicationAnswers,
  seedApplicationAnswersFromCandidateProfile,
} from './candidate-answers';

// In-memory stand-in for the SMRT collection layer used by the DB-touching
// seeding/loader functions.
const mocks = vi.hoisted(() => ({
  collections: new Map<string, { records: Record<string, unknown>[] }>(),
}));

vi.mock('./smrt.js', () => ({
  getCollection: vi.fn(async (className: string) => {
    const found = mocks.collections.get(className);
    if (!found) throw new Error(`Missing collection ${className}`);
    return {
      list: async (options: Record<string, unknown> = {}) => {
        let rows = [...found.records];
        const where = options.where as Record<string, unknown> | undefined;
        if (where) {
          rows = rows.filter((row) =>
            Object.entries(where).every(([key, value]) => row[key] === value),
          );
        }
        const orderBy = String(options.orderBy ?? '');
        if (orderBy.endsWith('updated_at DESC')) {
          rows.sort((a, b) =>
            String(b.updated_at ?? '').localeCompare(
              String(a.updated_at ?? ''),
            ),
          );
        }
        const limit =
          typeof options.limit === 'number' ? options.limit : rows.length;
        return rows.slice(0, limit);
      },
    };
  }),
}));

// The Greenhouse form used across these tests mirrors the real walkthrough:
// stable identity/contact questions plus role-specific judgment questions.
function greenhouseSchema(
  questions: AtsFormSchema['questions'],
): AtsFormSchema {
  return {
    ats: 'greenhouse',
    boardToken: 'acme',
    fetchedAt: '2026-08-28T00:00:00.000Z',
    jobId: '123',
    questions,
  };
}

const fullFacts = {
  email: 'will@example.com',
  firstName: 'Example',
  fullName: 'Example Candidate',
  githubUrl: 'https://github.com/iolaus',
  lastName: 'Candidate',
  linkedinUrl: 'https://www.linkedin.com/in/iolaus',
  location: 'Boulder, CO',
  phone: '+1 303 555 0123',
  workAuthorization: 'US citizen; no sponsorship needed',
};

function schemaJson(schema: AtsFormSchema): string {
  return JSON.stringify(schema);
}

describe('normalizeAnswerLabel', () => {
  it('lowercases, preserves punctuation, and collapses whitespace', () => {
    expect(normalizeAnswerLabel('  First  Name *')).toBe('first name %2a');
    expect(normalizeAnswerLabel('Phone:')).toBe('phone%3a');
    expect(normalizeAnswerLabel('Why this role?')).toBe('why this role%3f');
    expect(normalizeAnswerLabel('')).toBe('');
  });

  it('percent-encodes interior punctuation so keys stay injective', () => {
    expect(normalizeAnswerLabel('E-Mail Address')).toBe('e%2dmail address');
    expect(normalizeAnswerLabel('Phone-Number (Mobile')).toBe(
      'phone%2dnumber %28mobile',
    );
  });

  it('never collides labels that differ only in symbols', () => {
    const terminalVariants = ['C++', 'C#', 'C@', 'C--'];
    const terminalKeys = new Set(
      terminalVariants.map((label) => normalizeAnswerLabel(label)),
    );
    expect(terminalKeys.size).toBe(terminalVariants.length);

    const variants = ['C++', 'C#', 'C@', 'C--'].map(
      (symbol) => `Do you have ${symbol} experience?`,
    );
    const keys = new Set(variants.map((label) => normalizeAnswerLabel(label)));
    expect(keys.size).toBe(variants.length);
    expect(normalizeAnswerLabel('Do you have C++ experience?')).toBe(
      'do you have c%2b%2b experience%3f',
    );
    expect(normalizeAnswerLabel('Do you have C# experience?')).toBe(
      'do you have c%23 experience%3f',
    );
  });
});

describe('profileFactForLabel', () => {
  it('maps stable identity/contact labels to profile facts', () => {
    expect(profileFactForLabel('First Name')).toBe('firstName');
    expect(profileFactForLabel('Last name')).toBe('lastName');
    expect(profileFactForLabel('Full Name')).toBe('fullName');
    expect(profileFactForLabel('E-Mail Address')).toBe('email');
    expect(profileFactForLabel('Phone')).toBe('phone');
    expect(profileFactForLabel('Phone Number')).toBe('phone');
    expect(profileFactForLabel('Mobile')).toBe('phone');
    expect(profileFactForLabel('LinkedIn Profile URL')).toBe('linkedinUrl');
    expect(profileFactForLabel('GitHub')).toBe('githubUrl');
    expect(profileFactForLabel('Current Location')).toBe('location');
    expect(profileFactForLabel('Work Authorization')).toBe('workAuthorization');
  });

  it('refuses fuzzy or partial matches so judgment questions never map', () => {
    expect(profileFactForLabel('What is your phone number?')).toBeNull();
    expect(
      profileFactForLabel('Are you legally authorized to work in the US?'),
    ).toBeNull();
    expect(profileFactForLabel('First and last name')).toBeNull();
    expect(profileFactForLabel('Why this role?')).toBeNull();
    expect(profileFactForLabel('')).toBeNull();
  });
});

describe('candidateProfileFacts', () => {
  it('prefers the display name but can compose one from legal name parts', () => {
    expect(
      candidateProfileFacts({ name: 'Example Candidate', firstName: 'Example' })
        .fullName,
    ).toBe('Example Candidate');
    expect(
      candidateProfileFacts({ firstName: 'Example', lastName: 'Candidate' })
        .fullName,
    ).toBe('Example Candidate');
  });

  it('keeps missing values empty instead of inventing them', () => {
    const facts = candidateProfileFacts({ name: 'Example Candidate' });
    expect(facts.phone).toBe('');
    expect(facts.email).toBe('');
    expect(facts.githubUrl).toBe('');
  });
});

describe('seedApplicationAnswers', () => {
  const identityQuestions: AtsFormSchema['questions'] = [
    {
      id: 'first_name',
      label: 'First Name',
      required: true,
      type: 'input_text',
    },
    { id: 'last_name', label: 'Last Name', required: true, type: 'input_text' },
    { id: 'email', label: 'Email', required: true, type: 'input_text' },
    { id: 'phone', label: 'Phone', required: true, type: 'input_text' },
    {
      id: 'linkedin',
      label: 'LinkedIn Profile',
      required: false,
      type: 'input_text',
    },
    { id: 'github', label: 'GitHub URL', required: false, type: 'input_text' },
  ];

  it('pre-populates identity and contact fields from profile facts', () => {
    const { answers, seededFrom } = seedApplicationAnswers({
      existingAnswers: {},
      facts: fullFacts,
      reusableAnswers: {},
      schema: greenhouseSchema(identityQuestions),
    });

    expect(answers).toEqual({
      email: 'will@example.com',
      first_name: 'Example',
      github: 'https://github.com/iolaus',
      last_name: 'Candidate',
      linkedin: 'https://www.linkedin.com/in/iolaus',
      phone: '+1 303 555 0123',
    });
    expect(
      Object.values(seededFrom).every((source) => source === 'profile'),
    ).toBe(true);
  });

  it('never invents values: unmapped or unknown questions stay unanswered', () => {
    const { answers } = seedApplicationAnswers({
      existingAnswers: {},
      facts: fullFacts,
      reusableAnswers: {},
      schema: greenhouseSchema([
        ...identityQuestions,
        {
          id: 'q_cover',
          label: 'Why this role?',
          required: true,
          type: 'textarea',
        },
        {
          id: 'q_auth',
          label: 'Are you legally authorized to work in the United States?',
          required: true,
          type: 'input_text',
        },
        {
          id: 'q_empty',
          label: 'Fax Number',
          required: false,
          type: 'input_text',
        },
      ]),
    });

    expect(answers.q_cover).toBeUndefined();
    expect(answers.q_auth).toBeUndefined();
    expect(answers.q_empty).toBeUndefined();
  });

  it('never overwrites the application’s own existing answers', () => {
    const { answers, seededFrom } = seedApplicationAnswers({
      existingAnswers: { phone: '+1 555 000 9999' },
      facts: fullFacts,
      reusableAnswers: {},
      schema: greenhouseSchema(identityQuestions),
    });

    expect(answers.phone).toBe('+1 555 000 9999');
    expect(seededFrom.phone).toBeUndefined();
    expect(answers.email).toBe('will@example.com');
  });

  it('prefers an explicitly saved reusable answer over the profile alias', () => {
    const { answers, seededFrom } = seedApplicationAnswers({
      existingAnswers: {},
      facts: fullFacts,
      reusableAnswers: { 'first name': 'Alex' },
      schema: greenhouseSchema(identityQuestions),
    });

    expect(answers.first_name).toBe('Alex');
    expect(seededFrom.first_name).toBe('library');
  });

  it('seeds role-specific answers only from explicitly reusable library entries', () => {
    const { answers, seededFrom } = seedApplicationAnswers({
      existingAnswers: {},
      facts: fullFacts,
      // Keys are normalized labels, as stored by the reuse upsert.
      reusableAnswers: {
        'why this role%3f': 'Developer-experience work is my specialty.',
      },
      schema: greenhouseSchema([
        ...identityQuestions,
        {
          id: 'q_cover',
          label: 'Why this role?',
          required: true,
          type: 'textarea',
        },
      ]),
    });

    expect(answers.q_cover).toBe('Developer-experience work is my specialty.');
    expect(seededFrom.q_cover).toBe('library');
  });

  it('skips file questions (the resume artifact is not a typed answer)', () => {
    const { answers } = seedApplicationAnswers({
      existingAnswers: {},
      facts: fullFacts,
      reusableAnswers: {},
      schema: greenhouseSchema([
        { id: 'resume', label: 'Resume', required: true, type: 'input_file' },
        { id: 'email', label: 'Email', required: true, type: 'input_text' },
      ]),
    });

    expect(answers.resume).toBeUndefined();
    expect(answers.email).toBe('will@example.com');
  });
});

describe('reusableAnswersFromLibrary', () => {
  it('indexes active rows by normalized label and skips unusable rows', () => {
    expect(
      reusableAnswersFromLibrary([
        {
          label: 'Why this role?',
          labelKey: 'why this role%3f',
          value: 'Fit.',
        },
        { label: 'Notice period', value: ' 4 weeks ' },
        { label: '', labelKey: '', value: 'orphan' },
        {
          active: false,
          label: 'Old answer',
          labelKey: 'old answer',
          value: 'x',
        },
        { label: 'Blank', labelKey: 'blank', value: '   ' },
      ]),
    ).toEqual({
      'notice period': '4 weeks',
      'why this role%3f': 'Fit.',
    });
  });

  it('uses the stored label to safely canonicalize legacy key encodings', () => {
    expect(
      reusableAnswersFromLibrary([
        {
          label: 'C++',
          labelKey: 'c',
          value: 'Five years of production C++ experience.',
        },
      ]),
    ).toEqual({
      'c%2b%2b': 'Five years of production C++ experience.',
    });
  });

  it('resolves duplicate label keys to the newest row, including Date timestamps', () => {
    const older = new Date('2026-08-01T00:00:00.000Z');
    const newer = new Date('2026-08-27T00:00:00.000Z');
    expect(
      reusableAnswersFromLibrary([
        {
          id: 'old',
          label: 'Why this role?',
          labelKey: 'why this role%3f',
          updated_at: older,
          value: 'Stale copy.',
        },
        {
          id: 'new',
          label: 'Why this role?',
          labelKey: 'why this role%3f',
          updated_at: newer,
          value: 'Fresh copy.',
        },
      ]),
    ).toEqual({ 'why this role%3f': 'Fresh copy.' });

    // Identical timestamps still resolve deterministically (id DESC
    // tie-break) instead of depending on database iteration order.
    expect(
      reusableAnswersFromLibrary([
        { id: 'a', label: 'Q', labelKey: 'q', updated_at: older, value: 'A' },
        { id: 'b', label: 'Q', labelKey: 'q', updated_at: older, value: 'B' },
      ]),
    ).toEqual({ q: 'B' });
  });
});

describe('describeApplicationAnswersBody', () => {
  it('renders readable per-question lines instead of a JSON blob', () => {
    const body = describeApplicationAnswersBody({
      applicationInstructions: 'Use the Greenhouse form.',
      requiredAnswersJson: JSON.stringify({
        first_name: 'Example',
      }),
      requiredQuestionsJson: schemaJson(
        greenhouseSchema([
          {
            id: 'first_name',
            label: 'First Name',
            required: true,
            type: 'input_text',
          },
          {
            id: 'q_cover',
            label: 'Why this role?',
            required: true,
            type: 'textarea',
          },
        ]),
      ),
      requiredAnswers: 'Compensation expectations: flexible.',
    });

    expect(body).toContain('Instructions: Use the Greenhouse form.');
    expect(body).toContain(
      'Required answers: Compensation expectations: flexible.',
    );
    expect(body).toContain('## Application form (greenhouse)');
    expect(body).toContain('- First Name: Example');
    expect(body).toContain('- Why this role?: (unanswered)');
    expect(body).not.toContain('"questions"');
    expect(body).not.toContain('"first_name"');
  });

  it('changes when the stored answers change so review fingerprints move', () => {
    const schema = greenhouseSchema([
      { id: 'q1', label: 'Email', required: true, type: 'input_text' },
    ]);
    const before = describeApplicationAnswersBody({
      requiredAnswersJson: '{}',
      requiredQuestionsJson: schemaJson(schema),
    });
    const after = describeApplicationAnswersBody({
      requiredAnswersJson: JSON.stringify({ q1: 'will@example.com' }),
      requiredQuestionsJson: schemaJson(schema),
    });

    expect(before).toContain('- Email: (unanswered)');
    expect(after).toContain('- Email: will@example.com');
    expect(before).not.toBe(after);
  });

  it('carries a canonical digest so the fingerprint covers the full stored schema and answers', () => {
    const base = {
      ats: 'greenhouse',
      boardToken: 'acme',
      fetchedAt: '2026-08-28T00:00:00.000Z',
      jobId: '123',
      questions: [
        { id: 'q1', label: 'Email', required: true, type: 'input_text' },
      ],
    };
    // Same readable rendering, materially different wire representation:
    // only a required flag differs, and the displayed body would be
    // identical without the digest.
    const schemaA = schemaJson(greenhouseSchema(base.questions));
    const schemaB = schemaJson(
      greenhouseSchema([{ ...base.questions[0], required: false }]),
    );
    const bodyA = describeApplicationAnswersBody({
      requiredAnswersJson: '{}',
      requiredQuestionsJson: schemaA,
    });
    const bodyB = describeApplicationAnswersBody({
      requiredAnswersJson: '{}',
      requiredQuestionsJson: schemaB,
    });

    expect(bodyA).toMatch(/Answers fingerprint digest: [0-9a-f]{64}$/);
    expect(bodyB).toMatch(/Answers fingerprint digest: [0-9a-f]{64}$/);
    expect(bodyA).not.toBe(bodyB);
  });
});

describe('seedApplicationAnswersFromCandidateProfile', () => {
  beforeEach(() => {
    mocks.collections.clear();
  });

  it('fills only missing answers on the given application and leaves other applications untouched', async () => {
    mocks.collections.set('CandidateProfile', {
      records: [
        {
          active: true,
          email: 'will@example.com',
          firstName: 'Example',
          lastName: 'Candidate',
          name: 'Example Candidate',
          phone: '+1 303 555 0123',
          profileKey: 'default',
        },
      ],
    });
    mocks.collections.set('CandidateAnswer', { records: [] });

    const schema = greenhouseSchema([
      {
        id: 'first_name',
        label: 'First Name',
        required: true,
        type: 'input_text',
      },
      {
        id: 'phone',
        label: 'Phone Number',
        required: true,
        type: 'input_text',
      },
      {
        id: 'q_cover',
        label: 'Why this role?',
        required: true,
        type: 'textarea',
      },
    ]);
    const application: Record<string, unknown> = {
      id: 'app-1',
      requiredAnswersJson: JSON.stringify({
        phone: '+1 555 000 9999',
      }),
      requiredQuestionsJson: schemaJson(schema),
    };
    const untouchedApplication: Record<string, unknown> = {
      id: 'app-2',
      requiredAnswersJson: '{}',
      requiredQuestionsJson: schemaJson(schema),
    };

    const result =
      await seedApplicationAnswersFromCandidateProfile(application);

    expect(result.seeded).toBe(1);
    const answers = JSON.parse(String(application.requiredAnswersJson));
    expect(answers.first_name).toBe('Example');
    expect(answers.phone).toBe('+1 555 000 9999');
    expect(answers.q_cover).toBeUndefined();
    expect(
      JSON.parse(String(untouchedApplication.requiredAnswersJson)),
    ).toEqual({});
  });

  it('seeds explicitly reusable library answers by exact normalized label', async () => {
    mocks.collections.set('CandidateProfile', {
      records: [
        {
          active: true,
          name: 'Example Candidate',
          profileKey: 'default',
        },
      ],
    });
    mocks.collections.set('CandidateAnswer', {
      records: [
        {
          active: true,
          label: 'Why this role?',
          labelKey: 'why this role',
          profileKey: 'default',
          value: 'Developer-experience work is my specialty.',
        },
      ],
    });

    const application: Record<string, unknown> = {
      id: 'app-1',
      requiredAnswersJson: '{}',
      requiredQuestionsJson: schemaJson(
        greenhouseSchema([
          {
            id: 'q_cover',
            label: 'Why this role?',
            required: true,
            type: 'textarea',
          },
        ]),
      ),
    };

    const result =
      await seedApplicationAnswersFromCandidateProfile(application);

    expect(result.seeded).toBe(1);
    expect(result.seededFrom.q_cover).toBe('library');
    expect(JSON.parse(String(application.requiredAnswersJson)).q_cover).toBe(
      'Developer-experience work is my specialty.',
    );
  });

  it('does nothing without a persisted schema', async () => {
    const application: Record<string, unknown> = {
      requiredAnswersJson: '{}',
      requiredQuestionsJson: '',
    };
    const result =
      await seedApplicationAnswersFromCandidateProfile(application);
    expect(result.seeded).toBe(0);
    expect(application.requiredAnswersJson).toBe('{}');
  });

  it('leaves the stored JSON byte-identical when nothing can be seeded', async () => {
    mocks.collections.set('CandidateProfile', {
      records: [{ active: true, profileKey: 'default' }],
    });
    mocks.collections.set('CandidateAnswer', { records: [] });

    const stored = '{ "q_cover": "kept" }';
    const application: Record<string, unknown> = {
      requiredAnswersJson: stored,
      requiredQuestionsJson: schemaJson(
        greenhouseSchema([
          {
            id: 'q_cover',
            label: 'Why this role?',
            required: true,
            type: 'textarea',
          },
        ]),
      ),
    };

    const result =
      await seedApplicationAnswersFromCandidateProfile(application);

    expect(result.seeded).toBe(0);
    expect(application.requiredAnswersJson).toBe(stored);
  });
});

describe('loadApplicationAnswersEditorState', () => {
  beforeEach(() => {
    mocks.collections.clear();
  });

  it('labels each field with its source: profile-prefilled, application, or missing', async () => {
    mocks.collections.set('CandidateProfile', {
      records: [
        {
          active: true,
          email: 'will@example.com',
          firstName: 'Example',
          name: 'Example Candidate',
          phone: '+1 303 555 0123',
          profileKey: 'default',
        },
      ],
    });
    mocks.collections.set('CandidateAnswer', {
      records: [
        {
          active: true,
          label: 'Why this role?',
          labelKey: 'why this role',
          profileKey: 'default',
          value: 'Saved reusable answer.',
        },
      ],
    });

    const state = await loadApplicationAnswersEditorState({
      requiredAnswersJson: JSON.stringify({
        first_name: 'Alex',
      }),
      requiredQuestionsJson: schemaJson(
        greenhouseSchema([
          {
            id: 'first_name',
            label: 'First Name',
            required: true,
            type: 'input_text',
          },
          { id: 'phone', label: 'Phone', required: true, type: 'input_text' },
          {
            id: 'q_cover',
            label: 'Why this role?',
            required: true,
            type: 'textarea',
          },
          {
            id: 'resume',
            label: 'Resume',
            required: true,
            type: 'input_file',
          },
        ]),
      ),
    });

    expect(state.hasSchema).toBe(true);
    expect(state.ats).toBe('greenhouse');
    expect(state.reusableAnswerCount).toBe(1);
    // The file question is excluded; every scalar question is present.
    expect(state.questions.map((question) => question.id)).toEqual([
      'first_name',
      'phone',
      'q_cover',
    ]);
    const byId = new Map(state.questions.map((q) => [q.id, q]));
    // Stored value differs from what the profile would seed now: the stored
    // copy is application-specific history, so it is labeled as such.
    expect(byId.get('first_name')).toMatchObject({
      answered: true,
      source: 'application',
      value: 'Alex',
    });
    // Not yet stored on this application, but the profile knows it: shown as
    // a profile-prefilled suggestion awaiting the user's save.
    expect(byId.get('phone')).toMatchObject({
      answered: false,
      source: 'profile',
      value: '+1 303 555 0123',
      savedForReuse: false,
    });
    expect(byId.get('q_cover')).toMatchObject({
      answered: false,
      source: 'library',
      // The library entry's value cannot match an unstored answer, so the
      // "saved" flag is false even though the label is in the library.
      inLibrary: true,
      savedForReuse: false,
      required: true,
      value: 'Saved reusable answer.',
    });
  });

  it('marks savedForReuse only when the library copy matches the stored value', async () => {
    mocks.collections.set('CandidateProfile', {
      records: [
        { active: true, name: 'Example Candidate', profileKey: 'default' },
      ],
    });
    mocks.collections.set('CandidateAnswer', {
      records: [
        {
          active: true,
          label: 'Why this role?',
          labelKey: 'why this role%3f',
          profileKey: 'default',
          value: 'Generic saved answer.',
        },
      ],
    });

    const state = await loadApplicationAnswersEditorState({
      requiredAnswersJson: JSON.stringify({
        q_cover: 'Tailored application-specific answer.',
      }),
      requiredQuestionsJson: schemaJson(
        greenhouseSchema([
          {
            id: 'q_cover',
            label: 'Why this role?',
            required: true,
            type: 'textarea',
          },
        ]),
      ),
    });

    expect(state.questions[0]).toMatchObject({
      answered: true,
      source: 'application',
      value: 'Tailored application-specific answer.',
      inLibrary: true,
      savedForReuse: false,
    });
  });

  it('prefers the designated default profile over the newest active record', async () => {
    mocks.collections.set('CandidateProfile', {
      records: [
        {
          active: true,
          email: 'other@example.com',
          name: 'Other Person',
          profileKey: 'alt',
          updated_at: '2026-08-27T00:00:00.000Z',
        },
        {
          active: true,
          email: 'will@example.com',
          firstName: 'Example',
          isDefault: true,
          name: 'Example Candidate',
          profileKey: 'default',
          updated_at: '2026-08-01T00:00:00.000Z',
        },
      ],
    });
    mocks.collections.set('CandidateAnswer', { records: [] });

    const state = await loadApplicationAnswersEditorState({
      requiredAnswersJson: '{}',
      requiredQuestionsJson: schemaJson(
        greenhouseSchema([
          { id: 'email', label: 'Email', required: true, type: 'input_text' },
        ]),
      ),
    });

    expect(state.questions[0]).toMatchObject({
      source: 'profile',
      value: 'will@example.com',
    });
  });

  it('returns an empty state without a schema', async () => {
    const state = await loadApplicationAnswersEditorState({
      requiredAnswersJson: '{}',
      requiredQuestionsJson: '',
    });
    expect(state).toEqual({
      ats: '',
      hasSchema: false,
      questions: [],
      reusableAnswerCount: 0,
    });
  });
});

describe('candidate answer library privacy surface', () => {
  it('has no generic REST or admin CRUD surface anywhere', async () => {
    const { apiResourceClasses } = await import('./api-resources');
    const { resolveApiResource, resolveMcpToolClass } = await import(
      './api-exposure'
    );
    const { adminResources } = await import('$lib/admin/resources');

    expect(Object.values(apiResourceClasses)).not.toContain('CandidateAnswer');
    expect(Object.keys(apiResourceClasses)).not.toContain('candidateanswers');
    expect(resolveApiResource('candidateanswers')).toBeUndefined();
    expect(resolveApiResource('candidate_answers')).toBeUndefined();
    expect(resolveMcpToolClass('candidateanswer_list')).toBeUndefined();
    expect(
      adminResources.map(
        (resource: { className: string }) => resource.className,
      ),
    ).not.toContain('CandidateAnswer');
  });
});
