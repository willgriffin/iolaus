import { randomUUID } from 'node:crypto';
import type { DatabaseInterface } from '@happyvertical/sql';

/** Minimal native identity tables for the standalone SQL-store contracts. */
export async function seedShortlistOwner(
  database: Pick<DatabaseInterface, 'query'>,
  subject: { tenantId: string; userId: string },
) {
  await database.query(
    'CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, status TEXT)',
  );
  await database.query(
    'CREATE TABLE IF NOT EXISTS tenants (id TEXT PRIMARY KEY, status TEXT)',
  );
  await database.query(
    'CREATE TABLE IF NOT EXISTS memberships (id TEXT PRIMARY KEY, tenant_id TEXT, user_id TEXT, status TEXT)',
  );
  await database.query(
    "INSERT INTO users (id, status) VALUES (?, 'active') ON CONFLICT (id) DO NOTHING",
    [subject.userId],
  );
  await database.query(
    "INSERT INTO tenants (id, status) VALUES (?, 'active') ON CONFLICT (id) DO NOTHING",
    [subject.tenantId],
  );
  await database.query(
    "INSERT INTO memberships (id, tenant_id, user_id, status) VALUES (?, ?, ?, 'active')",
    [randomUUID(), subject.tenantId, subject.userId],
  );
}
