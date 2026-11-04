// biome-ignore-all lint/style/useNamingConvention: Environment variables use runtime-defined names.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { getDatabase } from '@happyvertical/sql';
import { chromium } from '@playwright/test';

const databaseUrl = new URL(
  process.env.HOSTED_SMOKE_DATABASE_URL ?? 'invalid:',
);
assert(
  ['postgres:', 'postgresql:'].includes(databaseUrl.protocol) &&
    databaseUrl.hostname === '127.0.0.1' &&
    /^\/iolaus_hosted_smoke(?:_[a-z0-9_]+)?$/u.test(databaseUrl.pathname) &&
    !databaseUrl.search &&
    !databaseUrl.hash,
  'Use an empty disposable loopback PostgreSQL database named iolaus_hosted_smoke.',
);

const listener = createServer();
listener.listen(0, '127.0.0.1');
await once(listener, 'listening');
const address = listener.address();
assert(address && typeof address === 'object');
const { port } = address;
await new Promise<void>((resolve) => listener.close(() => resolve()));
const origin = `http://127.0.0.1:${port}`;
const readerRole = `hosted_smoke_reader_${process.pid}`;
const readerUrl = new URL(databaseUrl);
readerUrl.username = readerRole;
readerUrl.password = '';
const operatorEmail = 'operator@hosted-smoke.invalid';
const memberEmail = 'member@hosted-smoke.invalid';
const environment: NodeJS.ProcessEnv = {};
for (const key of [
  'PATH',
  'HOME',
  'TMPDIR',
  'CI',
  'PLAYWRIGHT_BROWSERS_PATH',
]) {
  if (process.env[key]) environment[key] = process.env[key];
}
Object.assign(environment, {
  DATABASE_URL: databaseUrl.href,
  HOST: '127.0.0.1',
  PORT: String(port),
  ORIGIN: origin,
  IOLAUS_PUBLIC_URL: `https://127.0.0.1:${port}`,
  IOLAUS_WORKSPACE_MODE: 'shared',
  IOLAUS_PUBLIC_SEARCH_ENABLED: 'true',
  IOLAUS_PUBLIC_READ_DATABASE_URL: readerUrl.href,
  IOLAUS_PUBLIC_CURSOR_SECRET: 'synthetic-hosted-smoke-cursor-secret',
  IOLAUS_OIDC_SERVER_URL: 'https://127.0.0.1:1',
  IOLAUS_OIDC_REALM: 'hosted-smoke',
  IOLAUS_OIDC_CLIENT_ID: 'hosted-smoke',
  IOLAUS_OIDC_ADMIN_EMAILS: operatorEmail,
  SMRT_RUNTIME_PROFILE: 'self-hosted',
  SMRT_APP_ID: 'iolaus-hosted-smoke',
  SMRT_BACKGROUND_JOBS: 'false',
  TSX_TSCONFIG_PATH: 'tsconfig.runtime.json',
});
process.env = environment;

const db = await getDatabase({ type: 'postgres', url: databaseUrl.href });
let readerCreated = false;
try {
  const existing = await db.query(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' LIMIT 1",
  );
  assert.equal(
    existing.rows.length,
    0,
    'Hosted smoke requires a fresh database.',
  );
  const migration = spawnSync(
    'pnpm',
    ['exec', 'tsx', 'scripts/db-migrate.ts', '--maintenance-window'],
    { env: environment, stdio: 'inherit', timeout: 120_000 },
  );
  assert.equal(migration.status, 0, 'Hosted smoke migration failed.');
  await db.query(`CREATE ROLE ${readerRole} LOGIN`);
  readerCreated = true;
  await db.query(`GRANT USAGE ON SCHEMA public TO ${readerRole}`);
  await db.query(
    `GRANT SELECT ON jobgeni_public_catalog_v1, jobgeni_public_search_v1 TO ${readerRole}`,
  );
  await db.query(
    `GRANT EXECUTE ON FUNCTION consume_public_search_quota(integer), search_public_catalog(tsquery) TO ${readerRole}`,
  );
  await db.query(`ALTER ROLE ${readerRole} SET statement_timeout = '500ms'`);

  const { executeAsPrincipal } = await import('@happyvertical/smrt-agents');
  const { SessionService, UserCollection, UserStatus } = await import(
    '@happyvertical/smrt-users'
  );
  const { ensureHostedWorkspaceAccess, sessionCookieName } = await import(
    '../src/lib/server/auth.js'
  );
  const { saveCandidateOnboarding } = await import(
    '../src/lib/server/candidate-onboarding.js'
  );
  const { getSmrtOptions } = await import('../src/lib/server/db.js');
  const { addInvite } = await import('../src/lib/server/hosted-invite.js');
  const { runMatchingTick } = await import(
    '../src/lib/server/matching-projection-worker.js'
  );
  const { verifyWorkspaceSubject } = await import(
    '../src/lib/server/workspace-subject.js'
  );

  const options = getSmrtOptions();
  const users = await UserCollection.create(options);
  const sessions = await SessionService.create(options);
  async function seedActor(email: string) {
    await addInvite(email);
    const user = await users.create({ email, status: UserStatus.ACTIVE });
    const { tenant } = await ensureHostedWorkspaceAccess(user);
    assert(user.id && tenant.id);
    const userId = user.id;
    const tenantId = tenant.id;
    const profileId = await executeAsPrincipal(
      {
        ...options,
        action: 'hosted-smoke.fixture',
        onBehalfOfUserId: userId,
        postgresRls: false,
        principal: { allowedTools: [], runAsUserId: userId, tenantId },
      },
      async () => {
        const subject = await verifyWorkspaceSubject({ user, tenantId });
        assert(
          subject,
          'Synthetic workspace must pass the real identity checks.',
        );
        const { profile } = await saveCandidateOnboarding(
          {
            email,
            name: 'Synthetic hosted smoke user',
            title: 'Fictional platform engineer',
            summary: 'Isolated browser fixture.',
            preferences: {
              targetRoles: ['Backend Engineer'],
              locations: ['Canada'],
              workModes: ['remote'],
            },
          },
          subject,
        );
        assert(profile.id);
        return profile.id;
      },
    );
    return {
      userId,
      tenantId,
      profileId,
      sessionId: await sessions.createSession(userId, tenantId),
    };
  }
  const operator = await seedActor(operatorEmail);
  const member = await seedActor(memberEmail);
  for (const actor of [operator, member])
    await db.query(
      `INSERT INTO resume_skills (id, slug, tenant_id, owner_user_id, candidate_profile_id, skill_id, label)
       VALUES (gen_random_uuid(), 'smoke-typescript', $1, $2, $3, 'fictional-typescript', 'TypeScript')`,
      actor.tenantId,
      actor.userId,
      actor.profileId,
    );

  await db.query(`INSERT INTO sources (id, slug, source_role, is_active)
    VALUES ('smoke-active', 'smoke-active', 'root', TRUE),
           ('smoke-inactive', 'smoke-inactive', 'root', FALSE)`);
  // Large enough to catch reintroduction of the 10,000-posting request-time
  // catalog rebuild. All posting and identity data in this suite is fictional.
  await db.query(`INSERT INTO opportunities
    (id, slug, title, source_id, status, first_seen_at, last_seen_at, description_raw, location_notes, work_mode)
    SELECT gen_random_uuid(), 'smoke-' || n, 'Backend Engineer',
      'smoke-active', 'found', NOW(), NOW(), 'Required skills: TypeScript',
      CASE WHEN n BETWEEN 2 AND 101 THEN 'Remote (Canada)' ELSE 'Remote (United States)' END,
      'remote'
    FROM generate_series(1, 10001) AS n`);
  const eligible = 'e0000000-0000-4000-8000-000000000001';
  const applied = 'e0000000-0000-4000-8000-000000000002';
  const decided = 'e0000000-0000-4000-8000-000000000003';
  await db.query(
    `INSERT INTO opportunities (id, slug, title, source_id, status, first_seen_at, last_seen_at)
    VALUES
      ($1, 'smoke-old', 'Fictional inactive posting', 'smoke-inactive', 'found', NOW() - INTERVAL '60 days', NOW() - INTERVAL '60 days'),
      ($2, 'smoke-applied', 'Fictional protected application', 'smoke-inactive', 'found', NOW(), NOW() - INTERVAL '60 days'),
      ($3, 'smoke-decided', 'Fictional protected decision', 'smoke-inactive', 'found', NOW(), NOW() - INTERVAL '60 days')`,
    eligible,
    applied,
    decided,
  );
  await db.query(
    `INSERT INTO applications (id, slug, tenant_id, owner_user_id, candidate_profile_id, opportunity_id, status)
    VALUES (gen_random_uuid(), 'smoke-application', $1, $2, $3, $4, 'draft')`,
    member.tenantId,
    member.userId,
    member.profileId,
    applied,
  );
  await db.query(
    `INSERT INTO decisions (id, slug, tenant_id, owner_user_id, candidate_profile_id, opportunity_id, decision_by)
    VALUES (gen_random_uuid(), 'smoke-decision', $1, $2, $3, $4, 'owner')`,
    member.tenantId,
    member.userId,
    member.profileId,
    decided,
  );

  await db.query(
    "UPDATE sources SET public_listing = TRUE WHERE id = 'smoke-active'",
  );
  await db.query(`INSERT INTO opportunity_analyses
    (id, slug, opportunity_id, source_content_fingerprint, source_content_version, analysis_version, status, normalized_title, skills_json, requirements_json)
    SELECT md5('hosted-smoke-analysis')::uuid, 'smoke-analysis', id, 'smoke-content', 1, 'opportunity-analysis/v1', 'deterministic',
      'Synthetic PostgreSQL engineer', '[]', '[]'
    FROM opportunities WHERE slug = 'smoke-1'`);
  await db.query(`UPDATE opportunities SET source_content_fingerprint = 'smoke-content', source_content_version = 1,
    posting_url = 'https://example.invalid/fictional-posting' WHERE slug = 'smoke-1'`);
  await db.query(
    `UPDATE opportunities SET current_analysis_id = md5('hosted-smoke-analysis')::uuid WHERE slug = 'smoke-1'`,
  );
  await db.query('ANALYZE');
  let idleTicks = 0;
  for (let tick = 0; tick < 1_000; tick += 1) {
    const result = await runMatchingTick(db, 'postgres');
    if (
      result.sourceBacklog ||
      result.profileBacklog ||
      result.normalized ||
      result.evaluated
    )
      idleTicks = 0;
    else if (++idleTicks === 3) break;
    if (tick === 999)
      throw new Error('Hosted smoke matching backlog did not settle.');
  }

  const server = spawn(process.execPath, ['build/index.js'], {
    env: environment,
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    let ready = false;
    for (
      let attempt = 0;
      attempt < 100 && server.exitCode === null;
      attempt++
    ) {
      try {
        ready = (
          await fetch(`${origin}/live`, { signal: AbortSignal.timeout(500) })
        ).ok;
      } catch {}
      if (ready) break;
      await delay(100);
    }
    assert(ready, 'Built shared-mode server did not start.');
    const browser = await chromium.launch();
    try {
      const guest = await browser.newContext();
      for (const path of ['/', '/login/', '/shortlist/']) {
        const response = await guest.request.get(`${origin}${path}`, {
          maxRedirects: 0,
        });
        assert.equal(response.status(), 200, `Guest ${path}`);
      }
      assert.equal(
        (
          await guest.request.get(`${origin}/admin/`, { maxRedirects: 0 })
        ).status(),
        303,
      );
      assert.equal(
        (
          await guest.request.get(`${origin}/api/admin-resources/opportunities`)
        ).status(),
        401,
      );
      const publicSearch = await guest.request.get(
        `${origin}/api/public/v1/opportunities?q=postgresql`,
      );
      assert.equal(
        publicSearch.status(),
        200,
        'Public search must work through the restricted reader.',
      );
      assert.equal((await publicSearch.json()).items.length, 1);
      await guest.close();

      const operatorContext = await browser.newContext();
      const memberContext = await browser.newContext();
      for (const [context, actor] of [
        [operatorContext, operator],
        [memberContext, member],
      ] as const) {
        await context.route('**/*', (route) =>
          new URL(route.request().url()).origin === origin
            ? route.continue()
            : route.abort(),
        );
        await context.addCookies([
          {
            name: sessionCookieName,
            value: actor.sessionId,
            url: origin,
            httpOnly: true,
          },
        ]);
      }
      const home = await operatorContext.request.get(
        `${origin}/admin/__data.json`,
      );
      assert.equal(home.status(), 200);
      const homeFrames = (await home.text())
        .trim()
        .split('\n')
        .map((frame) => JSON.parse(frame));
      assert(
        homeFrames.some(
          (frame) =>
            frame.type === 'chunk' &&
            frame.data?.some?.(
              (value: unknown) =>
                value &&
                typeof value === 'object' &&
                'tasks' in value &&
                'opportunities' in value,
            ),
        ),
        'Home must deliver its streamed overview.',
      );
      assert(
        !homeFrames.some((frame) => frame.type === 'error' || frame.error),
      );
      for (const path of [
        '/admin/applications/',
        '/admin/tasks/',
        '/admin/career/',
        '/admin/resume/',
        '/admin/research/',
        '/admin/memory/',
        '/admin/system/',
        '/admin/account/',
        '/admin/preferences/screening-questions/',
      ]) {
        assert.equal(
          (
            await operatorContext.request.get(`${origin}${path}`, {
              maxRedirects: 0,
            })
          ).status(),
          200,
          path,
        );
      }

      for (const resource of [
        'applications',
        'tasks',
        'sources',
        'company-research',
        'facts',
      ]) {
        const response = await operatorContext.request.get(
          `${origin}/api/admin-resources/${resource}`,
        );
        assert.equal(response.status(), 200, resource);
        const { records } = await response.json();
        assert(
          Array.isArray(records),
          `${resource} must return data behind the shell.`,
        );
        if (resource === 'applications')
          assert.equal(
            records.length,
            0,
            'Operator cannot read the member application.',
          );
      }
      const memberApplications = await memberContext.request.get(
        `${origin}/api/admin-resources/applications`,
      );
      assert.equal(memberApplications.status(), 200);
      assert.equal(
        (await memberApplications.json()).records.length,
        1,
        'Member can read their own application.',
      );

      const listPath = '/admin/opportunities/?review=unsorted&sort=best';
      const operatorPage = await operatorContext.newPage();
      const listRead = operatorPage.waitForResponse((response) =>
        response.url().includes('/api/admin-resources/opportunities'),
      );
      assert.equal(
        (await operatorPage.goto(`${origin}${listPath}`))?.status(),
        200,
      );
      const list = await listRead;
      assert.equal(list.status(), 200);
      const { records, pagination } = await list.json();
      assert.equal(records.length, 100);
      assert.equal(pagination.totalRecords, 100);
      assert(
        records.every(
          (record: { locationNotes?: string }) =>
            record.locationNotes === 'Remote (Canada)',
        ),
        'Known location conflicts must stay outside hosted discovery.',
      );
      await operatorPage
        .getByRole('button', { name: 'Triage opportunities' })
        .click();
      await operatorPage
        .getByRole('button', { name: 'Dig deeper', exact: true })
        .and(operatorPage.locator('button:not([disabled])'))
        .waitFor();
      assert.equal(
        await operatorPage
          .getByText('The triage queue could not be loaded.')
          .count(),
        0,
      );
      await operatorPage.getByRole('button', { name: 'Close triage' }).click();

      const sweepState = () =>
        db.query(`SELECT
        (SELECT count(*) FROM agent_runs WHERE run_type = 'opportunity_sweep_source_inactive') AS audits,
        (SELECT count(*) FROM opportunities WHERE status = 'archived') AS archived`);
      const before = (await sweepState()).rows;
      const preview = operatorPage.waitForResponse((response) =>
        response.url().includes('/previewInactiveOpportunitySweep'),
      );
      await operatorPage
        .getByRole('button', { name: 'Sweep inactive', exact: true })
        .click();
      assert.equal((await preview).status(), 200);
      await operatorPage
        .getByText('Shared catalog archival requires operator dispatch.', {
          exact: true,
        })
        .waitFor();
      await operatorPage
        .getByText(/1 opportunities under an inactive source/)
        .waitFor();
      assert.equal(
        await operatorPage
          .getByRole('button', { name: /^Archive \d+$/u })
          .count(),
        0,
      );
      const memberPage = await memberContext.newPage();
      await memberPage.goto(`${origin}${listPath}`);
      await memberPage
        .getByRole('button', { name: 'Triage opportunities' })
        .waitFor();
      assert.equal(
        await memberPage
          .getByRole('button', { name: 'Sweep inactive', exact: true })
          .count(),
        0,
      );
      for (const [context, action] of [
        [operatorContext, 'applyInactiveOpportunitySweep'],
        [memberContext, 'previewInactiveOpportunitySweep'],
        [memberContext, 'applyInactiveOpportunitySweep'],
      ] as const) {
        const result = await context.request.post(
          `${origin}/admin/opportunities/?/${action}`,
          {
            headers: { origin, 'x-sveltekit-action': 'true' },
            form: { notSeenDays: '30' },
          },
        );
        assert.equal(result.status(), 403, action);
      }
      assert.deepEqual(
        (await sweepState()).rows,
        before,
        'Shared sweep must preserve archive and audit state.',
      );
      console.log(
        'Shared PostgreSQL browser smoke passed: Home, list, triage, sweep, and public/administrative reads.',
      );
    } finally {
      await browser.close();
    }
  } finally {
    if (server.exitCode === null) {
      server.kill('SIGTERM');
      await once(server, 'exit');
    }
  }
} finally {
  try {
    if (readerCreated) {
      await db.query(`DROP OWNED BY ${readerRole}`);
      await db.query(`DROP ROLE ${readerRole}`);
    }
  } finally {
    await db.close?.();
  }
}
