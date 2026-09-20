import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import {
  applyFinalCutoverPreservation,
  planExtraAsset,
  planFinalCutoverPreservation,
  planSourceAssetParity,
} from './final-cutover-preservation.mjs';

function fixture() {
  const tenant = { id: 'source-tenant', slug: 'main', context: '' };
  const role = { id: 'source-role', slug: 'owner', context: '' };
  const type = { id: 'source-type', slug: 'person', context: '' };
  const profile = { id: 'profile', email_key: 'profile-key', tenant_id: tenant.id, type_id: type.id };
  const user = { id: 'user', email_key: 'user-key', profile_id: profile.id };
  const membership = { id: 'membership', user_id: user.id, tenant_id: tenant.id, role_id: role.id };
  const reservation = { id: 'reservation', profile_id: profile.id, email_key: 'reservation-key' };
  return {
    source: { users: [user], profiles: [profile], memberships: [membership], oidc_profile_email_reservations: [reservation], tenants: [tenant], roles: [role], profile_types: [type], sessions: [{ id: 'session' }] },
    target: { users: [], profiles: [], memberships: [], oidc_profile_email_reservations: [], tenants: [{ ...tenant, id: 'target-tenant' }], roles: [{ ...role, id: 'target-role' }], profile_types: [{ ...type, id: 'target-type' }] },
  };
}

test('preflight produces an insert-only four-row closure and excludes sessions', () => {
  const { source, target } = fixture();
  const plan = planFinalCutoverPreservation(source, target);
  assert.deepEqual(plan.dispositions, { users: 'insert', profiles: 'insert', memberships: 'insert', oidc_profile_email_reservations: 'insert' });
  assert.equal(plan.sessionsCopied, false);
  assert.equal(plan.sessionRowsObserved, 1);
  assert.match(plan.transferDigest, /^[a-f0-9]{64}$/u);
});

test('applicator writes only the four preflight-approved rows and skips sessions', async () => {
  const { source, target } = fixture();
  const writes = [];
  const result = await applyFinalCutoverPreservation(
    { transaction: async (run) => run({ query: async (sql, values) => writes.push({ sql, values }) }) },
    source,
    target,
  );
  assert.equal(writes.length, 4);
  assert.deepEqual(result.insertedCounts, {
    users: 1,
    profiles: 1,
    memberships: 1,
    oidc_profile_email_reservations: 1,
  });
  assert.equal(writes.some(({ sql }) => /sessions/u.test(sql)), false);
});

test('preflight rejects missing or ambiguous semantic parents and root conflicts', () => {
  for (const mutate of [
    ({ target }) => { target.roles = []; },
    ({ target }) => { target.tenants.push({ ...target.tenants[0], id: 'another' }); },
    ({ target }) => { target.users = [{ id: 'user', email_key: 'different', profile_id: 'profile' }]; },
    ({ target }) => { target.users = [{ id: 'different-id', email_key: 'user-key', profile_id: 'profile' }]; },
  ]) {
    const input = fixture(); mutate(input);
    assert.throws(() => planFinalCutoverPreservation(input.source, input.target));
  }
});

test('application requires an atomic adapter and does not report partial writes', async () => {
  const { source, target } = fixture();
  await assert.rejects(
    applyFinalCutoverPreservation({ query: async () => {} }, source, target),
    /transaction-scoped/u,
  );
  const writes = [];
  await assert.rejects(
    applyFinalCutoverPreservation(
      { transaction: async (run) => run({ query: async () => { writes.push('write'); if (writes.length === 2) throw new Error('forced'); } }) },
      source,
      target,
    ),
    /forced/u,
  );
  assert.equal(writes.length, 2);
});

test('global profile keeps its null tenant while membership maps its tenant', async () => {
  const { source, target } = fixture();
  source.profiles[0].tenant_id = null;
  const writes = [];
  await applyFinalCutoverPreservation({ transaction: async (run) => run({
    query: async (sql, values) => writes.push({ sql, values }),
  }) }, source, target);
  assert.equal(writes[0].values[Object.keys(source.profiles[0]).indexOf('tenant_id')], null);
  assert.equal(writes[2].values[Object.keys(source.memberships[0]).indexOf('tenant_id')], 'target-tenant');
});

test('extra asset supports copy, byte-identical retry noop, and conflict rejection', () => {
  assert.equal(planExtraAsset({ sha256: 'a'.repeat(64) }, null).disposition, 'copy');
  assert.equal(planExtraAsset({ sha256: 'a'.repeat(64) }, { sha256: 'a'.repeat(64) }).disposition, 'noop');
  assert.throws(() => planExtraAsset({ sha256: 'a'.repeat(64) }, { sha256: 'b'.repeat(64) }));
});

test('extra asset rejects malformed SHA-256 receipts before copy, noop, or conflict decisions', () => {
  const valid = { sha256: 'a'.repeat(64) };
  const different = { sha256: 'b'.repeat(64) };
  const malformed = [
    undefined,
    null,
    '',
    1,
    {},
    { sha256: undefined },
    { sha256: null },
    { sha256: '' },
    { sha256: 'a'.repeat(63) },
    { sha256: 'g'.repeat(64) },
    { sha256: 1 },
    { sha256: ['a'.repeat(64)] },
    { sha256: new String('a'.repeat(64)) },
    { sha256: { toString: () => 'a'.repeat(64) } },
    { sha256: true },
  ];
  for (const receipt of malformed) {
    assert.throws(() => planExtraAsset(receipt, null), 'copy rejects malformed source');
    assert.throws(() => planExtraAsset(receipt, receipt), 'noop rejects malformed source');
    assert.throws(() => planExtraAsset(receipt, different), 'conflict rejects malformed source');
    if (receipt !== undefined && receipt !== null) assert.throws(() => planExtraAsset(valid, receipt), 'target receipt rejects before disposition');
  }
});

for (const table of ['profiles', 'users', 'memberships', 'oidc_profile_email_reservations']) {
  for (const timestamp of ['created_at', 'updated_at']) {
    test(`retry rejects timestamp-only change to ${table}.${timestamp}`, async () => {
      const { source, target } = fixture();
      const row = { ...source[table][0], created_at: '2026-09-19T00:00:00+00:00', updated_at: '2026-09-19T00:00:00+00:00' };
      source[table] = [row];
      target[table] = [{ ...row }];
      if (table === 'profiles') Object.assign(target[table][0], { tenant_id: target.tenants[0].id, type_id: target.profile_types[0].id });
      if (table === 'memberships') Object.assign(target[table][0], { tenant_id: target.tenants[0].id, role_id: target.roles[0].id });
      assert.equal(planFinalCutoverPreservation(source, target).dispositions[table], 'noop');
      target[table][0][timestamp] = '2026-09-20T00:00:00+00:00';
      let transactions = 0;
      await assert.rejects(applyFinalCutoverPreservation({ transaction: async () => { transactions += 1; } }, source, target), /no-overwrite conflict/);
      assert.equal(transactions, 0);
    });
  }
}

test('asset parity permits target reuse only when every source object is byte-identical', () => {
  const source = [{ key: 'source-object', sha256: 'a'.repeat(64), bytes: 4 }];
  const target = [...source, { key: 'extra-object', sha256: 'b'.repeat(64), bytes: 9 }];
  const receipt = planSourceAssetParity(source, target);
  assert.equal(receipt.reuseTargetBucket, true);
  assert.equal(receipt.targetOnlyObjectCount, 1);
  assert.throws(() => planSourceAssetParity(source, [{ ...source[0], sha256: 'b'.repeat(64) }]));
  assert.throws(() => planSourceAssetParity([], target));
  assert.throws(() => planSourceAssetParity(source, [{ ...source[0] }, { ...source[0] }]));
  assert.throws(() => planSourceAssetParity(source, [{ key: 'bad', sha256: 'no', bytes: 1 }]));
  for (const sha256 of [
    ['a'.repeat(64)],
    new String('a'.repeat(64)),
    { toString: () => 'a'.repeat(64) },
    1,
    true,
    null,
    undefined,
  ]) {
    assert.throws(() => planSourceAssetParity([{ ...source[0], sha256 }], target));
    assert.throws(() => planSourceAssetParity(source, [{ ...target[0], sha256 }]));
  }
});

// Opt-in only: a disposable PostgreSQL database restored from the protected dump.
// All fixture changes are enclosed in an outer transaction that always rolls back.
test('restored PostgreSQL closure preserves rows and rolls back partial application', {
  skip: !process.env.PRESERVATION_PROOF_DATABASE_URL,
}, async () => {
  const { default: pg } = await import(process.env.PRESERVATION_PROOF_PG_MODULE || 'pg');
  const databaseUrl = new URL(process.env.PRESERVATION_PROOF_DATABASE_URL);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(databaseUrl.hostname), 'proof requires a local disposable database');
  assert.ok(databaseUrl.pathname.endsWith('_proof'), 'proof requires a database named with the _proof suffix');
  const client = new pg.Client({ connectionString: process.env.PRESERVATION_PROOF_DATABASE_URL });
  await client.connect();
  const roots = ['profiles', 'users', 'memberships', 'oidc_profile_email_reservations'];
  const read = async (table) => (await client.query(`SELECT row_to_json(t) AS row FROM "${table}" t ORDER BY id`)).rows.map(({ row }) => row);
  const hash = (value) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  try {
    await client.query('BEGIN');
    const joined = await client.query(`SELECT row_to_json(p) AS profiles, row_to_json(u) AS users,
      row_to_json(m) AS memberships, row_to_json(o) AS oidc_profile_email_reservations
      FROM users u JOIN profiles p ON p.id = u.profile_id
      JOIN memberships m ON m.user_id = u.id
      JOIN oidc_profile_email_reservations o ON o.profile_id = p.id`);
    assert.equal(joined.rowCount, 1, 'protected fixture must contain exactly one joined closure');
    const source = Object.fromEntries(roots.map((table) => [table, [joined.rows[0][table]]]));
    const target = {};
    for (const [table, id] of [['tenants', source.memberships[0].tenant_id], ['roles', source.memberships[0].role_id], ['profile_types', source.profiles[0].type_id]]) {
      target[table] = await read(table);
      source[table] = target[table].filter((row) => row.id === id).map((row) => ({ ...row }));
      assert.equal(source[table].length, 1);
    }
    const expected = structuredClone(source);
    // Deliberately distinct source parent IDs prove semantic mapping, while all
    // four original root IDs and every non-parent value remain untouched.
    for (const table of ['tenants', 'roles', 'profile_types']) source[table][0].id = randomUUID();
    if (source.profiles[0].tenant_id !== null) source.profiles[0].tenant_id = source.tenants[0].id;
    source.profiles[0].type_id = source.profile_types[0].id;
    source.memberships[0].tenant_id = source.tenants[0].id;
    source.memberships[0].role_id = source.roles[0].id;
    await client.query('TRUNCATE profiles, users, memberships, oidc_profile_email_reservations CASCADE');
    for (const table of roots) target[table] = [];
    let failAt = 0;
    let writes = 0;
    const database = { transaction: async (run) => {
      await client.query('SAVEPOINT preservation_apply');
      try {
        const result = await run({ query: async (sql, values) => {
          writes += 1;
          if (failAt === writes) await client.query('SELECT 1 / 0');
          let index = 0;
          return client.query(sql.replaceAll('?', () => `$${++index}`), values);
        } });
        await client.query('RELEASE SAVEPOINT preservation_apply');
        return result;
      } catch (error) {
        await client.query('ROLLBACK TO SAVEPOINT preservation_apply');
        throw error;
      }
    } };
    failAt = 3;
    await assert.rejects(applyFinalCutoverPreservation(database, source, target), /division by zero/);
    assert.equal(writes, 3);
    for (const table of roots) assert.equal((await read(table)).length, 0, `${table} rolled back`);
    failAt = 0;
    writes = 0;
    const receipt = await applyFinalCutoverPreservation(database, source, target);
    assert.equal(Object.values(receipt.insertedCounts).reduce((a, b) => a + b), 4);
    for (const table of roots) {
      target[table] = await read(table);
      const changedFields = Object.keys(expected[table][0]).filter((key) => hash(target[table][0][key]) !== hash(expected[table][0][key]));
      assert.equal(changedFields.join(','), '', `${table} changed column names`);
      assert.equal(hash(target[table]), hash(expected[table]), `${table} exact IDs and full row hash`);
    }
    writes = 0;
    const retry = await applyFinalCutoverPreservation(database, source, target);
    assert.equal(writes, 0);
    assert.equal(Object.values(retry.noopCounts).reduce((a, b) => a + b), 4);
    for (const table of roots) {
      for (const timestamp of ['created_at', 'updated_at']) {
        await client.query('SAVEPOINT conflicting_timestamp');
        await client.query(`UPDATE "${table}" SET "${timestamp}" = COALESCE("${timestamp}", CURRENT_TIMESTAMP) + INTERVAL '1 second'`);
        const timestampConflict = { ...target, [table]: await read(table) };
        await assert.rejects(applyFinalCutoverPreservation(database, source, timestampConflict), /no-overwrite conflict/);
        assert.equal(writes, 0);
        await client.query('ROLLBACK TO SAVEPOINT conflicting_timestamp');
      }
    }
    await client.query('SAVEPOINT conflicting_identity');
    await client.query('UPDATE users SET id = $1 WHERE id = $2', [randomUUID(), target.users[0].id]);
    const conflict = { ...target, users: await read('users') };
    await assert.rejects(applyFinalCutoverPreservation(database, source, conflict), /identity conflict/);
    await client.query('ROLLBACK TO SAVEPOINT conflicting_identity');
    const ambiguous = structuredClone(target);
    ambiguous.tenants.push({ ...source.tenants[0], id: randomUUID() });
    await assert.rejects(applyFinalCutoverPreservation(database, source, ambiguous), /exactly one target tenant/);
    assert.equal(writes, 0);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});
