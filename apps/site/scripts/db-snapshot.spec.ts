import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertCanExportDatabase,
  assertCanImportDatabase,
  assertDisposableLocalDatabaseUrl,
  assertLocalSourceCrawlParentRestoreEvidence,
  assertLocalSourceCrawlRestoreEvidence,
  assertProductionRecoveryEvidence,
  assertProductionSourceCrawlParentRecoveryEvidence,
  assertProductionSourceCrawlRecoveryEvidence,
  databaseNameFromUrl,
  defaultBackupRoot,
  exportResumeFiles,
  importResumeFiles,
  isLocalDatabaseUrl,
  parseFlagArgs,
  postgresEnvFromUrl,
  readBackupManifest,
  recordLocalRestoreEvidence,
  redactDatabaseUrl,
  redactFilesystemConfig,
  resolveExportDatabaseUrl,
  sourceCrawlRecoveryPlanOptions,
  timestampForBackup,
  type VerifiedBackupManifest,
  verifyDatabaseDump,
} from './db-snapshot.js';

const originalProductionDatabaseUrl = process.env.PRODUCTION_DATABASE_URL;
const originalBackupDir = process.env.IOLAUS_BACKUP_DIR;
const originalResumeFilesConfigJson = process.env.RESUME_FILES_CONFIG_JSON;
const originalRuntimeProfile = process.env.SMRT_RUNTIME_PROFILE;
const originalAppId = process.env.SMRT_APP_ID;
const originalDataDir = process.env.SMRT_DATA_DIR;

afterEach(() => {
  restoreEnv('PRODUCTION_DATABASE_URL', originalProductionDatabaseUrl);
  restoreEnv('IOLAUS_BACKUP_DIR', originalBackupDir);
  restoreEnv('RESUME_FILES_CONFIG_JSON', originalResumeFilesConfigJson);
  restoreEnv('SMRT_RUNTIME_PROFILE', originalRuntimeProfile);
  restoreEnv('SMRT_APP_ID', originalAppId);
  restoreEnv('SMRT_DATA_DIR', originalDataDir);
});

describe('db snapshot helpers', () => {
  it('formats filesystem-safe timestamps', () => {
    expect(timestampForBackup(new Date('2026-05-26T12:34:56.789Z'))).toBe(
      '2026-05-26T12-34-56-789Z',
    );
  });

  it('parses command flags and positionals', () => {
    expect(
      parseFlagArgs([
        '--',
        '--from',
        'backup-a',
        '--skip-files',
        '--label=prod=db',
        'extra',
      ]),
    ).toEqual({
      flags: { from: 'backup-a', skipFiles: true, label: 'prod=db' },
      positionals: ['extra'],
    });
  });

  it('binds backup verification to a bounded whole-plan batch size', () => {
    const parsed = parseFlagArgs(['--source-crawl-limit', '37']);
    expect(sourceCrawlRecoveryPlanOptions(parsed.flags)).toEqual({
      limit: 37,
    });
    expect(() =>
      sourceCrawlRecoveryPlanOptions({ sourceCrawlLimit: '501' }),
    ).toThrow(/integer from 1 to 500/u);
  });

  it('detects local database URLs', () => {
    expect(
      isLocalDatabaseUrl('postgresql://user:pass@localhost:5432/app'),
    ).toBe(true);
    expect(
      isLocalDatabaseUrl('postgresql://user:pass@127.0.0.1:5432/app'),
    ).toBe(true);
    expect(isLocalDatabaseUrl('postgresql://user:pass@[::1]:5432/app')).toBe(
      true,
    );
    expect(
      isLocalDatabaseUrl('postgresql://user:pass@db.example.com:5432/app'),
    ).toBe(false);
  });

  it('guards production and local database commands', () => {
    const localUrl = 'postgresql://user:pass@localhost:5432/app';
    const remoteUrl = 'postgresql://user:pass@db.example.com:5432/app';

    expect(() => assertCanExportDatabase(localUrl, { prod: true })).toThrow(
      /production export against a local database/u,
    );
    expect(() =>
      assertCanExportDatabase(localUrl, { allowLocal: true, prod: true }),
    ).not.toThrow();
    expect(() => assertCanExportDatabase(remoteUrl, { prod: false })).toThrow(
      /non-local database/u,
    );
    expect(() =>
      assertCanExportDatabase(remoteUrl, {
        allowProduction: true,
        prod: false,
      }),
    ).not.toThrow();
    expect(() => assertCanImportDatabase(remoteUrl, {})).toThrow(
      /non-local database/u,
    );
  });

  it('does not treat a production-named loopback tunnel as a disposable local target', () => {
    expect(() =>
      assertDisposableLocalDatabaseUrl(
        'postgresql://user:pass@127.0.0.1:55433/iolaus',
        'Repair',
      ),
    ).toThrow(/must visibly identify disposable/u);
    expect(() =>
      assertDisposableLocalDatabaseUrl(
        'postgresql://user:pass@127.0.0.1:54329/iolaus_issue245_restore',
        'Repair',
      ),
    ).not.toThrow();
  });

  it('resolves production database URLs only from explicit production config', () => {
    process.env.PRODUCTION_DATABASE_URL =
      'postgresql://prod:secret@db.example.com/prod';

    expect(resolveExportDatabaseUrl({ prod: true })).toBe(
      'postgresql://prod:secret@db.example.com/prod',
    );
    expect(
      resolveExportDatabaseUrl({
        databaseUrl: 'postgresql://override/db',
        prod: true,
      }),
    ).toBe('postgresql://override/db');
  });

  it('redacts credentials and filesystem secrets', () => {
    expect(
      redactDatabaseUrl('postgresql://user:secret@localhost:5432/app'),
    ).toBe('postgresql://***:***@localhost:5432/app');
    const storageConfig = {
      accessKeyId: 'key',
      basePath: 'var/profile-assets',
      clientSecret: 'client-secret',
      credentials: {
        client_email: 'service@example.com',
        private_key: 'private-key',
      },
      secretAccessKey: 'secret',
      type: 's3',
    } as unknown as Parameters<typeof redactFilesystemConfig>[0];

    expect(redactFilesystemConfig(storageConfig)).toEqual({
      accessKeyId: '[redacted]',
      basePath: 'var/profile-assets',
      clientSecret: '[redacted]',
      credentials: '[redacted]',
      secretAccessKey: '[redacted]',
      type: 's3',
    });
  });

  it('exports and imports local resume file storage', async () => {
    const root = await mkdtemp(join(tmpdir(), 'resume-files-'));
    try {
      const sourceDataDir = join(root, 'source');
      const sourceDir = join(sourceDataDir, 'assets');
      const backupDir = join(root, 'backup');
      const restoredDataDir = join(root, 'restored');
      const restoredDir = join(restoredDataDir, 'assets');
      await mkdir(join(sourceDir, 'published'), { recursive: true });
      await writeFile(join(sourceDir, 'published', 'resume.pdf'), 'pdf');

      delete process.env.RESUME_FILES_CONFIG_JSON;
      process.env.SMRT_DATA_DIR = sourceDataDir;
      await expect(exportResumeFiles(backupDir)).resolves.toMatchObject({
        count: 1,
        exported: true,
      });

      process.env.SMRT_DATA_DIR = restoredDataDir;
      await expect(importResumeFiles(backupDir)).resolves.toMatchObject({
        count: 1,
        exported: true,
      });
      await expect(
        readFile(join(restoredDir, 'published', 'resume.pdf'), 'utf8'),
      ).resolves.toBe('pdf');
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('builds pg environment without exposing credentials in args', () => {
    expect(
      postgresEnvFromUrl(
        'postgresql://user:secret@db.example.com:5439/app?sslmode=require',
        'postgres',
      ),
    ).toEqual({
      PGDATABASE: 'postgres',
      PGHOST: 'db.example.com',
      PGPASSWORD: 'secret',
      PGPORT: '5439',
      PGSSLMODE: 'require',
      PGUSER: 'user',
    });
  });

  it('reads database names and backup root overrides', () => {
    process.env.IOLAUS_BACKUP_DIR = '/tmp/iolaus-backups';

    expect(
      databaseNameFromUrl('postgresql://user:pass@localhost:5432/app_name'),
    ).toBe('app_name');
    expect(defaultBackupRoot()).toBe('/tmp/iolaus-backups');
  });

  it('names new backup roots after the configured application identity', () => {
    delete process.env.IOLAUS_BACKUP_DIR;
    process.env.SMRT_APP_ID = 'career-hub';

    expect(defaultBackupRoot()).toMatch(/career-hub\/backups$/u);
  });

  it('accepts a version-one backup from the legacy local namespace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'legacy-iolaus-backup-'));
    try {
      await writeFile(
        join(root, 'manifest.json'),
        JSON.stringify({
          kind: 'iolaus.localhost-data-backup',
          version: 1,
        }),
      );

      await expect(readBackupManifest(root)).resolves.toMatchObject({
        kind: 'iolaus.localhost-data-backup',
        version: 1,
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('rejects an incomplete database archive before recording a backup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'invalid-db-dump-'));
    try {
      const dumpPath = join(root, 'database.dump');
      await writeFile(dumpPath, 'not a PostgreSQL custom archive');

      await expect(verifyDatabaseDump(dumpPath)).rejects.toThrow(
        /pg_restore exited with status/u,
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it('binds production repair authority to fresh full-restore evidence', () => {
    const digest = 'a'.repeat(64);
    const backup: VerifiedBackupManifest = {
      database: {
        archiveVerifiedAt: '2026-08-11T12:00:01.000Z',
        dumpBytes: 100,
        dumpFile: 'database.dump',
        dumpSha256: digest,
        name: 'iolaus',
        rowCounts: {},
        schemaCount: 113,
        url: 'postgresql://***:***@db.example.com/iolaus',
      },
      files: {
        bytes: 0,
        count: 0,
        directory: 'files',
        exported: false,
        storageConfig: {},
      },
      gitSha: null,
      kind: 'iolaus-data-backup',
      recovery: {
        databaseName: 'iolaus',
        dumpSha256: digest,
        fullRestoreVerifiedAt: '2026-08-11T12:05:00.000Z',
        restoredRowCountsSha256: 'b'.repeat(64),
        sourceCrawlOpportunityPlans: [
          {
            afterId: '',
            limit: 1,
            planSha256: 'e'.repeat(64),
          },
          {
            afterId: '00000000-0000-0000-0000-000000000001',
            limit: 1,
            planSha256: 'd'.repeat(64),
          },
        ],
        sourceCrawlParentRecoveryPlans: [
          { crawlId: 'crawl-legacy', planSha256: 'f'.repeat(64) },
        ],
        tagIntegrityPlanSha256: 'c'.repeat(64),
      },
      resume: {
        publishedAssetCount: 0,
        publishedAliasExists: null,
        publishedAssets: [],
      },
      source: 'production',
      timestamp: '2026-08-11T12:00:00.000Z',
      version: 1,
    };

    expect(() =>
      assertProductionRecoveryEvidence({
        backup,
        databaseUrl: 'postgresql://user:pass@127.0.0.1:55433/iolaus',
        expectedFingerprint: 'c'.repeat(64),
        now: new Date('2026-08-11T13:00:00.000Z'),
      }),
    ).not.toThrow();
    expect(() =>
      assertProductionSourceCrawlRecoveryEvidence({
        backup,
        databaseUrl: 'postgresql://user:pass@127.0.0.1:55433/iolaus',
        expectedFingerprint: 'd'.repeat(64),
        now: new Date('2026-08-11T13:00:00.000Z'),
      }),
    ).not.toThrow();
    expect(() =>
      assertProductionSourceCrawlParentRecoveryEvidence({
        backup,
        databaseUrl: 'postgresql://user:pass@127.0.0.1:55433/iolaus',
        expectedFingerprint: 'f'.repeat(64),
        now: new Date('2026-08-11T13:00:00.000Z'),
      }),
    ).not.toThrow();
    expect(() =>
      assertProductionSourceCrawlParentRecoveryEvidence({
        backup,
        databaseUrl: 'postgresql://user:pass@127.0.0.1:55433/iolaus',
        expectedFingerprint: 'd'.repeat(64),
        now: new Date('2026-08-11T13:00:00.000Z'),
      }),
    ).toThrow(/source-crawl-parent plan/u);
    expect(() =>
      assertProductionSourceCrawlRecoveryEvidence({
        backup,
        databaseUrl: 'postgresql://user:pass@127.0.0.1:55433/iolaus',
        expectedFingerprint: 'c'.repeat(64),
        now: new Date('2026-08-11T13:00:00.000Z'),
      }),
    ).toThrow(/source-crawl-opportunity plan/u);
    expect(() =>
      assertProductionRecoveryEvidence({
        backup: { ...backup, recovery: undefined },
        databaseUrl: 'postgresql://user:pass@127.0.0.1:55433/iolaus',
        expectedFingerprint: 'c'.repeat(64),
      }),
    ).toThrow(/full-restore recovery attestation/u);
    expect(() =>
      assertProductionRecoveryEvidence({
        backup,
        databaseUrl: 'postgresql://user:pass@127.0.0.1:55433/other',
        expectedFingerprint: 'c'.repeat(64),
      }),
    ).toThrow(/attestation is for database/u);
    expect(() =>
      assertProductionRecoveryEvidence({
        backup,
        databaseUrl: 'postgresql://user:pass@127.0.0.1:55433/iolaus',
        expectedFingerprint: 'c'.repeat(64),
        now: new Date('2026-08-11T17:00:01.000Z'),
      }),
    ).toThrow(/less than four hours old/u);
  });

  it('selects the separately attested local source-crawl repair plan', async () => {
    const queries: string[] = [];
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push(sql);
        if (sql.includes('to_regclass')) {
          return { rows: [{ table_name: 'local_backup_restore_evidence' }] };
        }
        return {
          rows:
            sql.includes('local_source_crawl_restore_evidence') &&
            params?.[1] === 'd'.repeat(64)
              ? [{ '?column?': 1 }]
              : [],
        };
      },
    };

    await expect(
      assertLocalSourceCrawlRestoreEvidence(db as never, {
        backupSha256: 'a'.repeat(64),
        planSha256: 'd'.repeat(64),
      }),
    ).resolves.toBeUndefined();
    expect(queries.at(-1)).toContain('local_source_crawl_restore_evidence');
  });

  it('selects separate local parent-recovery evidence', async () => {
    const queries: string[] = [];
    const db = {
      query: async (sql: string, params?: unknown[]) => {
        queries.push(sql);
        if (sql.includes('to_regclass')) {
          return {
            rows: [
              { table_name: 'local_source_crawl_parent_restore_evidence' },
            ],
          };
        }
        return {
          rows:
            sql.includes('local_source_crawl_parent_restore_evidence') &&
            params?.[1] === 'f'.repeat(64)
              ? [{ '?column?': 1 }]
              : [],
        };
      },
    };
    await expect(
      assertLocalSourceCrawlParentRestoreEvidence(db as never, {
        backupSha256: 'a'.repeat(64),
        planSha256: 'f'.repeat(64),
      }),
    ).resolves.toBeUndefined();
    expect(queries.at(-1)).toContain(
      'local_source_crawl_parent_restore_evidence',
    );
  });

  it('records every source-crawl cohort in one local evidence transaction', async () => {
    const queries: string[] = [];
    let transactions = 0;
    const db = {
      query: async (sql: string) => {
        queries.push(sql);
        return { rows: [] };
      },
      transaction: async (work: (transaction: unknown) => Promise<void>) => {
        transactions += 1;
        await work(db);
      },
    };

    await recordLocalRestoreEvidence(db as never, {
      backupSha256: 'a'.repeat(64),
      planSha256: 'b'.repeat(64),
      sourceCrawlOpportunityPlans: [
        { afterId: '', limit: 1, planSha256: 'c'.repeat(64) },
        {
          afterId: '00000000-0000-0000-0000-000000000001',
          limit: 1,
          planSha256: 'd'.repeat(64),
        },
      ],
      sourceCrawlParentRecoveryPlans: [
        { crawlId: 'crawl-legacy', planSha256: 'f'.repeat(64) },
      ],
      verifiedAt: '2026-08-11T12:05:00.000Z',
    });

    expect(transactions).toBe(1);
    expect(
      queries.filter((sql) =>
        sql.includes('INSERT INTO public.local_source_crawl_restore_evidence'),
      ),
    ).toHaveLength(2);
    expect(
      queries.filter((sql) =>
        sql.includes(
          'INSERT INTO public.local_source_crawl_parent_restore_evidence',
        ),
      ),
    ).toHaveLength(1);
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}
