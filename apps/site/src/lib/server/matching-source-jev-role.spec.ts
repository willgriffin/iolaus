import type { DecisionAnswer, DecisionRequest } from '@happyvertical/ai';
import { describe, expect, it, vi } from 'vitest';
import {
  draftJevSourceRole,
  matchingSourceJevPrimaryRole,
} from './matching-source-jev-role.js';
import {
  compileMatchingVocabulary,
  normalizeMatchingPosting,
} from './normalized-matching.js';

function choice(selected: string, probability = 0.9): DecisionAnswer {
  return {
    type: 'choice',
    choice: selected,
    probabilities: { [selected]: probability },
    confidence: probability,
  };
}

describe('Jev source title role drafting', () => {
  it('proposes the exact primary occupation and level without model reproof', async () => {
    const title = 'Senior Backend Developer — Payments';
    const decide = vi.fn(async () => ({}));
    await expect(draftJevSourceRole(title, 'title', decide)).resolves.toEqual({
      family: 'software-engineering',
      specialty: 'backend',
      level: 'senior',
      unitId: 'title',
    });
    expect(decide).not.toHaveBeenCalled();
  });

  it.each([
    [
      'Staff Software Engineer, Observability Platform',
      'Staff Software Engineer',
      null,
      ['Observability Platform'],
    ],
    [
      'Staff FullStack Engineer - Application Core Services | Canada | Remote',
      'Staff FullStack Engineer',
      'full-stack',
      ['Application Core Services', 'Canada', 'Remote'],
    ],
    [
      'Staff Fullstack Engineer - Service Quality',
      'Staff Fullstack Engineer',
      'full-stack',
      ['Service Quality'],
    ],
  ] as const)('preserves a governed primary occupation with unclassified suffixes in %s', async (title, head, specialty, suffixes) => {
    const vocabulary = compileMatchingVocabulary([]);
    expect(
      normalizeMatchingPosting(
        { title, description: '', location: '' },
        vocabulary,
      ).role,
    ).toBeUndefined();
    const role = {
      family: 'software-engineering',
      specialty,
      level: 'staff' as const,
    };
    expect(matchingSourceJevPrimaryRole(title)).toEqual({
      head,
      suffixes,
      ...role,
    });
    const decide = vi.fn(async () => ({}));
    await expect(draftJevSourceRole(title, 'title', decide)).resolves.toEqual({
      ...role,
      unitId: 'title',
    });
    expect(decide).not.toHaveBeenCalled();
  });

  it('uses a familiar alias for retrieval while preserving an unrecognized modifier for the decision', async () => {
    const title = 'Fictional Domain Network Engineer';
    const decide = vi.fn(async (request: DecisionRequest) => {
      expect(request.state).toEqual({ title });
      expect(request.questions.role_pair.criteria).toHaveProperty(
        'network-engineering',
      );
      return {
        role_pair: choice('unsupported'),
        role_level: choice('unstated'),
      };
    });
    await expect(
      draftJevSourceRole(title, 'title', decide),
    ).resolves.toBeNull();
  });

  it('retrieves a governed role using words from an alias that does not appear verbatim', async () => {
    const decide = vi.fn(async (request: DecisionRequest) => {
      expect(request.questions.role_pair.criteria).toHaveProperty(
        'platform-engineering',
      );
      expect(request.state).toEqual({ title: 'Site Reliability Consultant' });
      return {
        role_pair: choice('unsupported'),
        role_level: choice('unstated'),
      };
    });
    await expect(
      draftJevSourceRole('Site Reliability Consultant', 'title', decide),
    ).resolves.toBeNull();
    expect(decide).toHaveBeenCalledTimes(1);
  });

  it.each([
    'Engineering Manager - Account Executive',
    'Engineering Manager - Senior Account Executive',
    'Engineering Manager & Account Executive',
    'Engineering Manager and Account Executive',
    'Engineering Manager (Account Executive)',
    'Backend Software Engineer / Frontend Software Engineer',
    'Senior Backend Engineer and Staff Frontend Engineer',
    'Staff Fullstack Engineer; Backend Engineer',
    'Staff Software Engineer and Senior Software Engineer',
    'Staff Software Engineer, Senior Software Engineer',
    'Staff Software Engineer, Backend',
    'Staff Software Engineer, Bioprocess Scientist',
  ])('does not submit competing explicit roles in %s', async (title) => {
    const decide = vi.fn(async () => ({}));
    await expect(
      draftJevSourceRole(title, 'title', decide),
    ).resolves.toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });

  it('represents unstated seniority without inventing a level', async () => {
    const decide = vi.fn(async () => ({
      role_pair: choice('data-engineering'),
      role_level: choice('unstated'),
    }));
    await expect(
      draftJevSourceRole('Data Engineer', 'title', decide),
    ).resolves.toEqual({
      family: 'data-engineering',
      specialty: null,
      level: null,
      unitId: 'title',
    });
  });

  it.each([
    {
      role_pair: choice('software-engineering:unlisted'),
      role_level: choice('unstated'),
    },
    {
      role_pair: choice('software-engineering:backend'),
      role_level: choice('unsupported'),
    },
    {
      role_pair: choice('software-engineering:backend', 0.5),
      role_level: choice('unstated'),
    },
    {
      role_pair: choice('software-engineering:backend'),
      role_level: choice('senior', Number.NaN),
    },
    {},
  ])('refuses an out-of-list, unsupported, tied, invalid, or missing answer (%#)', async (answers) => {
    await expect(
      draftJevSourceRole(
        'Backend Engineer',
        'title',
        async () => answers as Record<string, DecisionAnswer>,
      ),
    ).resolves.toBeNull();
  });

  it('skips transport for unrelated, oversized, or non-title inputs', async () => {
    const decide = vi.fn(async () => ({}));
    await expect(
      draftJevSourceRole('Zookeeper', 'title', decide),
    ).resolves.toBeNull();
    await expect(
      draftJevSourceRole('a'.repeat(301), 'title', decide),
    ).resolves.toBeNull();
    await expect(
      draftJevSourceRole('Backend Engineer', 'd1', decide),
    ).resolves.toBeNull();
    expect(decide).not.toHaveBeenCalled();
  });
});
