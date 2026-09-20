import assert from 'node:assert/strict';
import test from 'node:test';
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

test('extra asset supports copy, byte-identical retry noop, and conflict rejection', () => {
  assert.equal(planExtraAsset({ sha256: 'a'.repeat(64) }, null).disposition, 'copy');
  assert.equal(planExtraAsset({ sha256: 'a'.repeat(64) }, { sha256: 'a'.repeat(64) }).disposition, 'noop');
  assert.throws(() => planExtraAsset({ sha256: 'a'.repeat(64) }, { sha256: 'b'.repeat(64) }));
});

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
});
