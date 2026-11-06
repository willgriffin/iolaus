import type { DecisionAnswer, DecisionRequest } from '@happyvertical/ai';
import { describe, expect, it, vi } from 'vitest';
import { draftJevSourceRole } from './matching-source-jev-role.js';

function choice(selected: string, probability = 0.9): DecisionAnswer {
  return {
    type: 'choice',
    choice: selected,
    probabilities: { [selected]: probability },
    confidence: probability,
  };
}

describe('Jev source title role drafting', () => {
  it('offers a bounded shortlist with nearby canonical pairs and independently selects a stated level', async () => {
    const title = 'Senior Backend Developer — Payments';
    const decide = vi.fn(async (request: DecisionRequest) => {
      expect(request.state).toEqual({ title });
      expect(request.questions.role_pair).toMatchObject({
        type: 'choice',
        criteria: {
          'software-engineering:backend': expect.any(String),
          'software-engineering': expect.any(String),
          unsupported: expect.any(String),
        },
      });
      expect(
        Object.keys(request.questions.role_pair.criteria ?? {}),
      ).toHaveLength(6);
      expect(request.questions.role_level.criteria).toHaveProperty('unstated');
      return {
        role_pair: choice('software-engineering:backend'),
        role_level: choice('senior'),
      };
    });
    await expect(draftJevSourceRole(title, 'title', decide)).resolves.toEqual({
      family: 'software-engineering',
      specialty: 'backend',
      level: 'senior',
      unitId: 'title',
    });
    expect(decide).toHaveBeenCalledTimes(1);
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

  it('does not send a compound title with two competing governed role families', async () => {
    const decide = vi.fn(async () => ({}));
    await expect(
      draftJevSourceRole(
        'Engineering Manager - Account Executive',
        'title',
        decide,
      ),
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
