import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getDatabase } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { getSourceCrawlWatchdogStatus } from './source-crawl-watchdog.js';
import { SOURCE_CRAWL_TIMEOUT_MS } from './source-schedules.js';

const postgresUrl = process.env.TRIAGE_TEST_POSTGRES_URL?.trim();
const now = new Date('2026-11-06T15:00:00.000Z');
const cutoff = now.getTime() - SOURCE_CRAWL_TIMEOUT_MS;

function statusSuite(postgres?: string) {
  describe(
    postgres ? 'PostgreSQL crawl status' : 'native SQLite crawl status',
    () => {
      it('counts at the cutoff and orders and redacts recent terminal errors', async () => {
        const directory = postgres
          ? undefined
          : await mkdtemp(
              join(await realpath(tmpdir()), 'iolaus-crawl-status-'),
            );
        let database: Awaited<ReturnType<typeof getDatabase>> | undefined;
        try {
          database = directory
            ? await getDatabase({
                type: 'sqlite',
                url: join(directory, 'status.sqlite'),
                cache: false,
                secureFile: {
                  custody: 'trusted-parent',
                  driver: 'node:sqlite',
                  root: directory,
                },
              })
            : await getDatabase({
                type: 'postgres',
                url: postgres,
                cache: false,
                max: 1,
              });
          await database.query(`CREATE ${postgres ? 'TEMP ' : ''}TABLE source_crawls (
          id TEXT PRIMARY KEY, status TEXT NOT NULL, error TEXT,
          started_at TIMESTAMP, finished_at TIMESTAMP, created_at TIMESTAMP
        )`);
          const timestamp = (
            milliseconds: number,
            format: 'iso' | 'sql' | 'epoch' = 'iso',
          ) => {
            const date = new Date(milliseconds);
            if (postgres) return date;
            if (format === 'epoch') return milliseconds;
            const iso = date.toISOString();
            return format === 'sql' ? iso.replace('T', ' ').slice(0, -1) : iso;
          };
          const rows = [
            ['queued', 'queued', null, null, null],
            ['pending', 'pending', null, null, null],
            ['active-text', 'running', null, timestamp(cutoff + 1), null],
            [
              'active-epoch',
              'running',
              null,
              timestamp(cutoff + 2, 'epoch'),
              null,
            ],
            ['at-cutoff', 'running', null, timestamp(cutoff, 'epoch'), null],
            ['stale-text', 'running', null, timestamp(cutoff - 1, 'sql'), null],
            ['missing-start', 'running', null, null, null],
            [
              'already-finished',
              'running',
              null,
              timestamp(cutoff - 1),
              timestamp(cutoff),
            ],
            ['completed', 'completed', null, null, timestamp(cutoff)],
            ['partial', 'completed_with_errors', null, null, timestamp(cutoff)],
            [
              'new-error',
              'failed',
              'token=synthetic-test-value',
              null,
              timestamp(cutoff + 3),
            ],
            [
              'old-error',
              'timed_out',
              'test deadline',
              null,
              timestamp(cutoff + 2, 'epoch'),
            ],
            ['no-finish', 'failed', 'test error without finish', null, null],
            ['no-error', 'failed', '', null, timestamp(cutoff + 4)],
          ];
          for (const row of rows) {
            await database.query(
              'INSERT INTO source_crawls (id, status, error, started_at, finished_at, created_at) VALUES (?, ?, ?, ?, ?, ?)',
              [...row, timestamp(cutoff)],
            );
          }

          const status = await getSourceCrawlWatchdogStatus(database, now);
          expect(status).toMatchObject({
            active: 2,
            completed: 2,
            failed: 3,
            queued: 2,
            staleRunning: 3,
            timedOut: 1,
          });
          expect(status.recentTerminalErrors.map(({ id }) => id)).toEqual([
            'new-error',
            'old-error',
            'no-finish',
          ]);
          expect(status.recentTerminalErrors[0]?.error).toBe(
            'token=[redacted]',
          );
          expect(status.recentTerminalErrors[2]?.finishedAt).toBeNull();
          if (!postgres) {
            expect(status.recentTerminalErrors[0]?.finishedAt).toBe(
              new Date(cutoff + 3).toISOString(),
            );
            expect(status.recentTerminalErrors[1]?.finishedAt).toBe(
              new Date(cutoff + 2).toISOString(),
            );
          }
        } finally {
          await database?.close?.();
          if (directory) await rm(directory, { force: true, recursive: true });
        }
      });
    },
  );
}

statusSuite();
if (postgresUrl) statusSuite(postgresUrl);
