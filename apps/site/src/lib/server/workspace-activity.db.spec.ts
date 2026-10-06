import { getDatabase } from '@happyvertical/sql';
import { describe, expect, it, vi } from 'vitest';
import { loadWorkspaceActivity } from './workspace-activity.js';

vi.mock('./db.js', () => ({ getDbConfig: () => ({ type: 'sqlite' }) }));
const subject = {
  tenantId: 'tenant-a',
  userId: 'user-a',
  profileId: 'profile-a',
};
describe('workspace activity SQL projection on native SQLite', () => {
  it('selects owned pending and recent terminal work without workers, excludes expired runs and old/foreign outcomes', async () => {
    const db = await getDatabase({
      type: 'sqlite',
      url: ':memory:',
      cache: false,
    });
    await db.query(
      'CREATE TABLE _smrt_jobs(id TEXT, status TEXT, created_at TEXT, started_at TEXT, completed_at TEXT, method TEXT, object_type TEXT, queue TEXT, tenant_id TEXT, args TEXT, worker_id TEXT)',
    );
    await db.query(
      'CREATE TABLE _smrt_workers(worker_id TEXT,status TEXT,lease_expires_at TEXT)',
    );
    const rows = [
      ['waiting', 'pending', null, null, 'user-a', null],
      [
        'done',
        'completed',
        '2026-10-02T20:58:30Z',
        '2026-10-02T20:59:00Z',
        'user-a',
        null,
      ],
      [
        'old',
        'completed',
        '2026-10-02T20:50:00Z',
        '2026-10-02T20:54:00Z',
        'user-a',
        null,
      ],
      ['foreign', 'pending', null, null, 'foreign', null],
      [
        'orphan',
        'running',
        '2026-10-02T20:59:00Z',
        null,
        'user-a',
        'missing-worker',
      ],
      [
        'live',
        'running',
        '2026-10-02T20:59:00Z',
        null,
        'user-a',
        'live-worker',
      ],
    ];
    for (const [id, status, started, completed, user, worker] of rows)
      await db.query('INSERT INTO _smrt_jobs VALUES (?,?,?,?,?,?,?,?,?,?,?)', [
        id,
        status,
        '2026-10-02T20:40:00Z',
        started,
        completed,
        'processIntelligence',
        '@willgriffin/iolaus-site:Opportunity',
        'opportunity-intelligence',
        'tenant-a',
        JSON.stringify({
          runtimeWorkspaceSubject: { ...subject, userId: user },
        }),
        worker,
      ]);
    await db.query('INSERT INTO _smrt_workers VALUES (?,?,?)', [
      'live-worker',
      'running',
      '2026-10-02T21:01:00Z',
    ]);
    const result = await loadWorkspaceActivity(subject, {
      database: db,
      dialect: 'sqlite',
      now: new Date('2026-10-02T21:00:00Z'),
      loadProgress: async () => new Map(),
    });
    expect(result.items.map(({ id, status }) => ({ id, status }))).toEqual([
      { id: 'job:live', status: 'running' },
      { id: 'job:waiting', status: 'queued' },
      { id: 'job:done', status: 'completed' },
    ]);
    expect(
      result.items.find((i) => i.status === 'queued')?.startedAt,
    ).toBeNull();
    expect(
      result.items.find((i) => i.status === 'completed')?.completedAt,
    ).toBe('2026-10-02T20:59:00.000Z');
  });
});
