import type { DatabaseInterface } from '@happyvertical/sql';
import {
  backfillProfileEmailKeys,
  normalizeIdentityEmail,
  PROFILE_EMAIL_KEY_BACKFILL_NAME,
} from '@happyvertical/smrt-profiles';
import {
  backfillLegacyUserProfiles,
  backfillUserEmailKeys,
  LEGACY_USER_PROFILE_BACKFILL_NAME,
} from '@happyvertical/smrt-users';
import { initializeSmrtCollections } from './db-common.js';
import { remapLifecycleValues } from './remap-lifecycle-values.js';
import { backfillAchievementPlacement } from './backfill-achievement-placement.js';
import {
  inspectCanonicalSeeds,
  inspectLegacyNativeBackfill,
  inspectSourceSchedules,
} from './db-release-inspectors.js';
import type { ReleaseStep } from './db-release-executor.js';
import { ensureSeedSkillVocabulary } from '../src/lib/server/skill-vocabulary.js';
import { syncAllSourceSchedules } from '../src/lib/server/source-schedules.js';
import { backfillOpportunitySourceFingerprints } from '../src/lib/server/opportunity-source-fingerprint-backfill.js';
import {
  ensureSourceProvenanceSchema,
  getSourceProvenanceSchemaStatus,
  sourceProvenanceSchemaIsReady,
} from '../src/lib/server/source-provenance.js';
import {
  backfillSourceProviders,
  getSourceProviderSchemaStatus,
  sourceProviderSchemaIsReady,
} from '../src/lib/server/source-provider.js';
import {
  ensureOpportunityScoreRefreshSchedule,
  OPPORTUNITY_SCORE_REFRESH_SCHEDULE_ID,
  OPPORTUNITY_SCORE_REFRESH_METHOD,
} from '../src/lib/server/opportunity-score-refresh.js';
import { isSharedHosted } from '../src/lib/server/app-config.js';

/** Permanent logical IDs, independent of release/attempt/time. Changed behavior
 * requires a new ID; the tracker rejects a changed specification for an old ID. */
export function releaseCatalog(
  database: DatabaseInterface,
): readonly ReleaseStep[] {
  const steps: ReleaseStep[] = [
    {
      id: 'iolaus/2026-10-26/canonical-seeds-v1',
      mode: 'reconciled',
      specification:
        'canonical system roles+registered permissions; profile/relationship/place types; tag contexts; immutable career skill vocabulary; disabled intelligence control; idempotent public collection seeders',
      inspect: inspectCanonicalSeeds,
      apply: async () => {
        await initializeSmrtCollections(database);
        await ensureSeedSkillVocabulary();
      },
    },
    {
      id: 'iolaus/2026-10-26/legacy-native-adoption-v1',
      mode: 'reconciled',
      specification:
        'import historical 20260525_smrt_native_employment_backfill marker; empty-input no-op; missing marker with existing canonical input requires operator reconciliation; personal resume/assets permanently disabled',
      inspect: inspectLegacyNativeBackfill,
      apply: async () => {
        throw new Error(
          'Ambiguous legacy imports require explicit repair, never blind replay.',
        );
      },
    },
    {
      id: 'iolaus/2026-10-26/lifecycle-values-v1',
      mode: 'transactional',
      specification:
        'awaiting_will->awaiting_user; ready_for_will_review->ready_for_user_review; needs_will_decision->needs_user_decision; will role->owner in application/decision/source/task old-value updates',
      apply: async (tx) => {
        await remapLifecycleValues(tx);
      },
    },
    {
      id: 'iolaus/2026-10-26/achievement-placement-v1',
      mode: 'transactional',
      specification:
        'UPDATE achievements SET resume_placement=auto WHERE NULL or btrim empty',
      apply: async (tx) => {
        await backfillAchievementPlacement(tx);
      },
    },
    {
      id: 'iolaus/2026-10-26/source-provenance-v1',
      mode: 'reconciled',
      specification:
        'authoritative root/posting-derived/unknown provenance migration; native transaction and historical marker; inspect required role/FK/forward+reverse guards',
      inspect: async () => ({
        outcome: sourceProvenanceSchemaIsReady(
          await getSourceProvenanceSchemaStatus(database),
        )
          ? 'complete'
          : 'safe-to-resume',
      }),
      apply: async () => {
        await ensureSourceProvenanceSchema(database);
      },
    },
    {
      id: 'iolaus/2026-10-26/source-providers-v1',
      mode: 'reconciled',
      specification:
        'normalize providers; bounded adapter classification; unknown remains valid; inspect actual native allowlist/non-null/invalid-row invariants; helper owns transaction',
      inspect: async () => ({
        outcome: sourceProviderSchemaIsReady(
          await getSourceProviderSchemaStatus(database),
        )
          ? 'complete'
          : 'safe-to-resume',
      }),
      apply: async () => {
        await backfillSourceProviders(database);
      },
    },
    {
      id: 'iolaus/2026-10-26/source-fingerprints-v1',
      mode: 'transactional',
      specification:
        'keyset null-fingerprint stored-content backfill; parseable rows only; version baseline and change-feed append use pinned transaction query; refuse 100000 row truncation',
      apply: async (tx) => {
        const result = await backfillOpportunitySourceFingerprints(tx);
        if (result.truncated)
          throw new Error(
            'Source fingerprint backfill exceeded bounded pass; explicit migration plan required.',
          );
      },
    },
    {
      id: 'iolaus/2026-10-26/identity-readiness-v1',
      mode: 'reconciled',
      specification:
        'public profile/user email-key and legacy user-profile native atomic backfills; duplicate/stale/conflicting ownership refuses; independently inspect native markers+actual normalized keys and links',
      inspect: async (connection) => {
        const table = await connection.query(
          "SELECT to_regclass('_smrt_backfills') AS relation",
        );
        if (!table.rows[0]?.relation) return { outcome: 'safe-to-resume' };
        const requiredMarkers = [
          PROFILE_EMAIL_KEY_BACKFILL_NAME,
          LEGACY_USER_PROFILE_BACKFILL_NAME,
        ];
        const markers = await connection.query(
          'SELECT name FROM _smrt_backfills WHERE name IN (?, ?)',
          ...requiredMarkers,
        );
        const names = new Set(markers.rows.map((row) => row.name));
        if (requiredMarkers.some((name) => !names.has(name)))
          return { outcome: 'safe-to-resume' };
        for (const table of ['profiles', 'users']) {
          const rows = await connection.query(
            `SELECT email, email_key${table === 'users' ? ', profile_id' : ''} FROM ${table}`,
          );
          for (const row of rows.rows) {
            const email = String(row.email ?? '');
            const expected = email.trim()
              ? normalizeIdentityEmail(email)
              : null;
            if (
              row.email_key !== expected ||
              (table === 'users' && !row.profile_id)
            )
              return { outcome: 'safe-to-resume' };
          }
        }
        return { outcome: 'complete' };
      },
      apply: async () => {
        await backfillProfileEmailKeys(database);
        await backfillUserEmailKeys(database);
        await backfillLegacyUserProfiles(database);
      },
    },
    {
      id: 'iolaus/2026-10-26/source-schedules-v1',
      mode: 'reconciled',
      specification:
        'source schedule deterministic idempotent getOrUpsert; remove orphan schedules; preserve subject-bound shared-mode disablement; inspect actual method/cadence/enabled/timeout/concurrency/timezone',
      inspect: inspectSourceSchedules,
      apply: async () => {
        await syncAllSourceSchedules({ db: database });
      },
    },
    {
      id: 'iolaus/2026-10-26/score-refresh-schedule-v1',
      mode: 'reconciled',
      specification:
        'private mode minute score-refresh schedule enabled; shared mode no schedule; singleton timeout60000/maxConcurrent1/UTC and disabled control prerequisite',
      inspect: async (connection) => {
        if (isSharedHosted()) return { outcome: 'complete' };
        const rows = await connection.query(
          'SELECT 1 FROM _smrt_agent_schedules WHERE slug = ? AND method = ? AND cron = ? AND enabled = TRUE AND max_concurrent = 1 AND timeout = 60000 AND timezone = ?',
          OPPORTUNITY_SCORE_REFRESH_SCHEDULE_ID,
          OPPORTUNITY_SCORE_REFRESH_METHOD,
          '* * * * *',
          'UTC',
        );
        return {
          outcome: rows.rows.length === 1 ? 'complete' : 'safe-to-resume',
        };
      },
      apply: async () => {
        await ensureOpportunityScoreRefreshSchedule(database);
      },
    },
  ];
  const implementations: Record<string, string[]> = {
    'canonical-seeds-v1': [
      './db-common.ts',
      '../src/lib/server/role-permissions.ts',
      '../src/lib/server/skill-vocabulary.ts',
      '../src/lib/skill-vocabulary-data.ts',
      '../src/lib/server/workspace-workflow-capabilities.ts',
    ],
    'legacy-native-adoption-v1': [
      './db-release-inspectors.ts',
      './legacy-personal-resume-backfill.ts',
    ],
    'lifecycle-values-v1': ['./remap-lifecycle-values.ts'],
    'achievement-placement-v1': ['./backfill-achievement-placement.ts'],
    'source-provenance-v1': ['../src/lib/server/source-provenance.ts'],
    'source-providers-v1': [
      '../src/lib/server/source-provider.ts',
      '../src/lib/source-provider-ids.ts',
    ],
    'source-fingerprints-v1': [
      '../src/lib/server/opportunity-source-fingerprint-backfill.ts',
      '../src/lib/server/opportunity-source-content.ts',
    ],
    'identity-readiness-v1': ['../../../vendor/release/published-closure.json'],
    'source-schedules-v1': ['../src/lib/server/source-schedules.ts'],
    'score-refresh-schedule-v1': [
      '../src/lib/server/opportunity-score-refresh.ts',
    ],
  };
  return steps.map((step) => ({
    ...step,
    implementation: implementations[step.id.split('/').at(-1) ?? ''].map(
      (path) => new URL(path, import.meta.url),
    ),
  }));
}
