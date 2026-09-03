import { describe, expect, it, vi } from 'vitest';
import {
  CANDIDATE_ANSWER_NATURAL_KEY_INDEX,
  ensureCandidateAnswerNaturalKeyIndex,
  repairExistingCandidateAnswerNaturalKeyIndex,
} from './candidate-answer-schema.js';

describe('CandidateAnswer schema compatibility', () => {
  it('atomically deduplicates complete legacy keys before creating the upsert key', async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const release = vi.fn(async () => undefined);

    await ensureCandidateAnswerNaturalKeyIndex({
      acquireSession: vi.fn(async () => ({ query, release })),
    } as never);

    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(query).toHaveBeenNthCalledWith(
      2,
      "SELECT set_config('lock_timeout', $1, true)",
      ['15s'],
    );
    expect(query).toHaveBeenNthCalledWith(
      3,
      "SELECT set_config('statement_timeout', $1, true)",
      ['60s'],
    );
    expect(query).toHaveBeenNthCalledWith(
      4,
      'LOCK TABLE candidate_answers IN ACCESS EXCLUSIVE MODE',
    );
    expect(query).toHaveBeenNthCalledWith(
      5,
      expect.stringContaining('constraint_definition.condeferrable'),
    );
    expect(query).toHaveBeenNthCalledWith(
      6,
      expect.stringContaining('WHERE profile_key IS NOT NULL'),
    );
    expect(query).toHaveBeenNthCalledWith(
      7,
      expect.stringContaining(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${CANDIDATE_ANSWER_NATURAL_KEY_INDEX}`,
      ),
    );
    expect(query).toHaveBeenNthCalledWith(
      8,
      expect.stringContaining(
        'Missing valid unique CandidateAnswer natural-key index',
      ),
    );
    expect(query).toHaveBeenNthCalledWith(9, 'COMMIT');
    expect(release).toHaveBeenCalledOnce();
  });

  it('rolls back and releases the session when the compatibility step fails', async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('lock timeout'));
    const release = vi.fn(async () => undefined);

    await expect(
      ensureCandidateAnswerNaturalKeyIndex({
        acquireSession: vi.fn(async () => ({ query, release })),
      } as never),
    ).rejects.toThrow('lock timeout');

    expect(query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });

  it('skips the legacy pre-pass when a fresh database has no CandidateAnswer table', async () => {
    const query = vi.fn(async () => ({ rows: [{ exists: false }] }));

    await repairExistingCandidateAnswerNaturalKeyIndex({ query } as never);

    expect(query).toHaveBeenCalledExactlyOnceWith(
      'SELECT to_regclass(\'candidate_answers\') IS NOT NULL AS "exists"',
    );
  });
});
