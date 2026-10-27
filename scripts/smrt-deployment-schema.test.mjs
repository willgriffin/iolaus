import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertDeploymentSchemaReady,
  assertDeploymentCatalogReady,
  assertRuntimeDatabaseRole,
  assertRuntimeStaticAgreement,
  releaseDeploymentProtocolEnabled,
} from './smrt-deployment-schema.mjs';

const schemas = [
  { tableName: 'sentinels', columns: { id: { type: 'UUID', notNull: true } } },
];
test('schema readiness only reads catalogs and refuses missing/nullable columns', async () => {
  const sql = [];
  const db = {
    query: async (statement) => {
      sql.push(statement);
      return {
        rows: statement.includes('information_schema')
          ? [
              {
                table_name: 'sentinels',
                column_name: 'id',
                is_nullable: 'NO',
                udt_name: 'uuid',
              },
            ]
          : [{ relation: 'present' }],
      };
    },
  };
  await assertDeploymentSchemaReady(db, schemas);
  assert.ok(sql.every((statement) => statement.trim().startsWith('SELECT')));
  await assert.rejects(
    assertDeploymentSchemaReady({ query: async () => ({ rows: [] }) }, schemas),
    /not ready/,
  );
});
test('runtime roles must lack every DDL privilege, including ownership', async () => {
  const role = {
    rolsuper: false,
    rolcreatedb: false,
    rolcreaterole: false,
    database_create: false,
    schema_create: false,
    owns_tables: false,
  };
  await assertRuntimeDatabaseRole({ query: async () => ({ rows: [role] }) });
  for (const key of Object.keys(role))
    await assert.rejects(
      assertRuntimeDatabaseRole({
        query: async () => ({ rows: [{ ...role, [key]: true }] }),
      }),
      /denied DDL/,
    );
  await assert.rejects(
    assertRuntimeDatabaseRole({ query: async () => ({ rows: [] }) }),
    /denied DDL/,
  );
});
test('static/runtime agreement rejects missing and changed columns before effects', () => {
  assertRuntimeStaticAgreement({ Sentinels: schemas[0] }, schemas);
  assert.throws(() => assertRuntimeStaticAgreement({}, schemas), /empty/);
  assert.throws(
    () =>
      assertRuntimeStaticAgreement(
        {
          Sentinels: {
            ...schemas[0],
            columns: { id: { type: 'TEXT', notNull: true } },
          },
        },
        schemas,
      ),
    /disagrees/,
  );
  assert.throws(
    () =>
      assertRuntimeStaticAgreement(
        { Sentinels: { tableName: 'unknown', columns: {} } },
        schemas,
      ),
    /mismatch/,
  );
});

test('explicit deployment protocol preserves legacy absence and rejects invalid defined values', () => {
  assert.equal(releaseDeploymentProtocolEnabled({}), false);
  assert.equal(
    releaseDeploymentProtocolEnabled({
      IOLAUS_DEPLOYMENT_PROTOCOL: 'smrt-release-v1',
    }),
    true,
  );
  for (const value of [
    '',
    'legacy',
    'true',
    'smrt-release-v2',
    ' smrt-release-v1',
  ])
    assert.throws(
      () =>
        releaseDeploymentProtocolEnabled({ IOLAUS_DEPLOYMENT_PROTOCOL: value }),
      /IOLAUS_DEPLOYMENT_PROTOCOL/,
    );
});

test('physical catalog attestor rejects undeclared expression and predicate support rather than guessing SQL equivalence', async () => {
  const db = { query: async () => ({ rows: [] }) };
  for (const index of [
    { name: 'unknown', columns: ['id'], where: 'id > 0' },
    { name: 'unknown', columns: ['lower(id)'] },
    {
      name: 'unknown',
      columns: ['id'],
      jsonPath: { column: 'id', path: 'key' },
    },
  ])
    await assert.rejects(
      assertDeploymentCatalogReady(db, [
        {
          tableName: 'sentinel',
          columns: { id: { type: 'TEXT' } },
          indexes: [index],
        },
      ]),
      /Unsupported declared startup/,
    );
});
