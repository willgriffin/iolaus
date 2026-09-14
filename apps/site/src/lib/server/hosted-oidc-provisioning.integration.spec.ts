import { randomUUID } from 'node:crypto';
import { ensureSystemTables, getTestDatabase } from '@happyvertical/smrt-core';
import {
  backfillProfileEmailKeys,
  OidcIdentityCollection,
  Person,
  ProfileCollection,
  ProfileTypeCollection,
} from '@happyvertical/smrt-profiles';
import { withSystemContext } from '@happyvertical/smrt-tenancy';
import {
  backfillUserEmailKeys,
  UserCollection,
} from '@happyvertical/smrt-users';
import { type DatabaseInterface, getDatabase } from '@happyvertical/sql';
import { afterEach, describe, expect, it } from 'vitest';
import { provisionHostedOidcUser } from './hosted-oidc-provisioning';

describe('hosted OIDC provisioning with released SMRT', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>> | undefined;

  afterEach(async () => {
    await db?.close?.();
    db = undefined;
  });

  async function users() {
    db = await getTestDatabase({
      classes: [
        'OidcIdentity',
        'OidcProfileEmailReservation',
        'Profile',
        'ProfileType',
        'User',
      ],
    });
    await backfillProfileEmailKeys(db);
    await backfillUserEmailKeys(db);
    return await UserCollection.create({ db });
  }

  it('provisions a fresh verified identity and reuses it on repeat login', async () => {
    const collection = await users();
    const claims = {
      email: 'fresh-owner@example.invalid',
      email_verified: true,
      iss: 'https://identity.example.invalid/realms/career',
      sub: 'fresh-subject',
    };

    const first = await provisionHostedOidcUser(claims, collection);
    const repeat = await provisionHostedOidcUser(claims, collection);

    expect(first.id).toBeDefined();
    expect(repeat.id).toBe(first.id);
  });

  it('reuses an imported owner only for its exact binding without duplicating records', async () => {
    const collection = await users();
    const profiles = await ProfileCollection.create({ db });
    const profileTypes = await ProfileTypeCollection.create({ db });
    const identities = await OidcIdentityCollection.create({ db });
    const { owner, profile } = await withSystemContext(async () => {
      const profileType = await profileTypes.getOrCreateGlobalBySlug('person', {
        name: 'Person',
      });
      if (!profileType.id) {
        throw new Error('Synthetic Person type fixture is missing an ID.');
      }
      const profile = new Person({
        db,
        email: 'imported-owner@example.invalid',
        name: 'Synthetic imported owner',
        typeId: profileType.id,
      });
      await profile.initialize();
      await profile.save();
      if (!profile.id) {
        throw new Error('Synthetic imported Profile fixture is missing an ID.');
      }
      const owner = await collection.create({
        email: 'imported-owner@example.invalid',
        profileId: profile.id,
      });
      return { owner, profile };
    });
    if (!owner.id || !profile.id) {
      throw new Error('Synthetic imported owner fixture is missing an ID.');
    }
    const claims = {
      email: 'imported-owner@example.invalid',
      email_verified: true,
      iss: 'https://identity.example.invalid',
      sub: 'imported-owner-subject',
    };
    const binding = {
      issuer: claims.iss,
      subject: claims.sub,
      userId: owner.id,
    };

    const first = await provisionHostedOidcUser(claims, collection, [binding]);
    const repeat = await provisionHostedOidcUser(claims, collection, [binding]);

    expect(first.id).toBe(owner.id);
    expect(first.profileId).toBe(profile.id);
    expect(repeat.id).toBe(owner.id);
    await expect(profiles.list({})).resolves.toHaveLength(1);
    await expect(collection.list({})).resolves.toHaveLength(1);
    await expect(identities.list({})).resolves.toHaveLength(1);

    await expect(
      provisionHostedOidcUser(
        { ...claims, email_verified: false },
        collection,
        [binding],
      ),
    ).rejects.toThrow('unverified');
    await expect(
      provisionHostedOidcUser(
        { ...claims, sub: 'different-subject' },
        collection,
        [binding],
      ),
    ).rejects.toMatchObject({ code: 'profile_owned' });
    await expect(profiles.list({})).resolves.toHaveLength(1);
    await expect(collection.list({})).resolves.toHaveLength(1);
    await expect(identities.list({})).resolves.toHaveLength(1);
  });

  it('lets an unmatched imported-owner binding fall through to SMRT', async () => {
    const collection = await users();
    const claims = {
      email: 'unmatched-owner@example.invalid',
      email_verified: true,
      iss: 'https://identity.example.invalid/realms/career',
      sub: 'unmatched-subject',
    };

    const user = await provisionHostedOidcUser(claims, collection, [
      {
        issuer: claims.iss,
        subject: 'different-subject',
        userId: '11111111-1111-4111-8111-111111111111',
      },
    ]);

    expect(user.id).toBeDefined();
  });

  it('rejects an invalid matching imported-owner binding', async () => {
    const collection = await users();
    const claims = {
      email: 'denied-owner@example.invalid',
      email_verified: true,
      iss: 'https://identity.example.invalid/realms/career',
      sub: 'denied-subject',
    };

    await expect(
      provisionHostedOidcUser(claims, collection, [
        {
          issuer: claims.iss,
          subject: claims.sub,
          userId: '11111111-1111-4111-8111-111111111111',
        },
      ]),
    ).rejects.toMatchObject({
      code: 'rejected',
    });
  });

  it('refuses a second subject from taking over an owned profile', async () => {
    const collection = await users();
    const claims = {
      email: 'owned-owner@example.invalid',
      email_verified: true,
      iss: 'https://identity.example.invalid/realms/career',
      sub: 'first-subject',
    };
    await provisionHostedOidcUser(claims, collection);

    await expect(
      provisionHostedOidcUser({ ...claims, sub: 'second-subject' }, collection),
    ).rejects.toMatchObject({
      code: 'profile_owned',
    });
  });
});

const coldRootPostgresUrl =
  process.env.HOSTED_OIDC_POSTGRES_TEST_DATABASE_URL?.trim();

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function rows(result: unknown): Record<string, unknown>[] {
  if (Array.isArray(result)) return result as Record<string, unknown>[];
  const resultWithRows = result as { rows?: unknown } | null;
  if (Array.isArray(resultWithRows?.rows)) {
    return resultWithRows.rows as Record<string, unknown>[];
  }
  return [];
}

describe.runIf(coldRootPostgresUrl)(
  'hosted OIDC cold-root PostgreSQL qualification',
  () => {
    let control: DatabaseInterface | undefined;
    let admin: DatabaseInterface | undefined;
    let runtime: DatabaseInterface | undefined;
    let databaseName: string | undefined;
    let role: string | undefined;

    afterEach(async () => {
      await runtime?.close?.();
      await admin?.close?.();
      if (control && databaseName) {
        await control.query(
          `DROP DATABASE IF EXISTS ${quoteIdentifier(databaseName)} WITH (FORCE)`,
        );
      }
      if (control && role) {
        await control.query(`DROP ROLE IF EXISTS ${quoteIdentifier(role)}`);
      }
      await control?.close?.();
      control = undefined;
      admin = undefined;
      runtime = undefined;
      databaseName = undefined;
      role = undefined;
    });

    it('reuses the imported owner from a fresh non-CREATE login in public', async () => {
      if (!coldRootPostgresUrl) {
        throw new Error('Expected a disposable PostgreSQL qualification URL.');
      }
      const suffix = randomUUID().replaceAll('-', '');
      databaseName = `iolaus_cold_root_${suffix}`;
      role = `hosted_oidc_runtime_${suffix}`;
      const password = randomUUID();
      control = await getDatabase({
        type: 'postgres',
        url: coldRootPostgresUrl,
      });
      await control.query(`CREATE DATABASE ${quoteIdentifier(databaseName)}`);
      const adminUrl = new URL(coldRootPostgresUrl);
      adminUrl.pathname = `/${databaseName}`;
      admin = await getDatabase({ type: 'postgres', url: adminUrl.toString() });
      await getTestDatabase({
        db: admin,
        classes: [
          'OidcIdentity',
          'OidcProfileEmailReservation',
          'Profile',
          'ProfileType',
          'User',
        ],
      });
      await ensureSystemTables(admin);
      await backfillProfileEmailKeys(admin);
      await backfillUserEmailKeys(admin);
      const adminProfiles = await ProfileCollection.create({ db: admin });
      const adminProfileTypes = await ProfileTypeCollection.create({
        db: admin,
      });
      const adminUsers = await UserCollection.create({ db: admin });
      const { owner, profile } = await withSystemContext(async () => {
        const profileType = await adminProfileTypes.getOrCreateGlobalBySlug(
          'person',
          {
            name: 'Person',
          },
        );
        if (!profileType.id) {
          throw new Error('Cold-root Person type fixture is missing an ID.');
        }
        const profile = new Person({
          db: admin,
          email: 'cold-root-owner@example.invalid',
          name: 'Cold-root imported owner',
          typeId: profileType.id,
        });
        await profile.initialize();
        await profile.save();
        if (!profile.id) {
          throw new Error('Cold-root Profile fixture is missing an ID.');
        }
        const owner = await adminUsers.create({
          email: 'cold-root-owner@example.invalid',
          profileId: profile.id,
        });
        return { owner, profile };
      });
      if (!owner.id || !profile.id) {
        throw new Error('Cold-root owner fixture is missing an ID.');
      }
      await expect(adminProfiles.list({})).resolves.toHaveLength(1);
      await admin.query(
        `CREATE ROLE ${quoteIdentifier(role)} LOGIN PASSWORD ${quoteLiteral(password)}`,
      );
      await admin.query(`REVOKE CREATE ON SCHEMA public FROM PUBLIC`);
      await admin.query(
        `GRANT USAGE ON SCHEMA public TO ${quoteIdentifier(role)}`,
      );
      await admin.query(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${quoteIdentifier(role)}`,
      );
      await admin.query(
        `GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${quoteIdentifier(role)}`,
      );
      await admin.query(
        `REVOKE CREATE ON DATABASE ${quoteIdentifier(databaseName)} FROM ${quoteIdentifier(role)}`,
      );
      await admin.query(
        `ALTER ROLE ${quoteIdentifier(role)} IN DATABASE ${quoteIdentifier(databaseName)} SET search_path TO public`,
      );

      const runtimeUrl = new URL(adminUrl);
      runtimeUrl.username = role;
      runtimeUrl.password = password;
      runtime = await getDatabase({
        type: 'postgres',
        url: runtimeUrl.toString(),
      });
      const runtimeStatements: string[] = [];
      const runtimeQuery = runtime.query.bind(runtime);
      runtime.query = async (statement, ...values) => {
        runtimeStatements.push(statement);
        return await runtimeQuery(statement, ...values);
      };
      const createPrivilege = rows(
        await runtime.query(
          `SELECT has_schema_privilege(current_user, 'public', 'CREATE') AS "allowed"`,
        ),
      )[0]?.allowed;
      expect(createPrivilege).toBe(false);

      const users = await UserCollection.create({ db: runtime });
      const claims = {
        email: 'cold-root-owner@example.invalid',
        email_verified: true,
        iss: 'https://identity.example.invalid/cold-root',
        sub: 'cold-root-subject',
      };
      const binding = {
        issuer: claims.iss,
        subject: claims.sub,
        userId: owner.id,
      };
      const first = await provisionHostedOidcUser(claims, users, [binding]);
      expect(
        runtimeStatements.filter((statement) =>
          /^\s*CREATE\b/iu.test(statement),
        ),
      ).toEqual([]);
      const profiles = await ProfileCollection.create({ db: runtime });
      const identities = await OidcIdentityCollection.create({ db: runtime });
      const repeat = await provisionHostedOidcUser(claims, users, [binding]);

      expect(first.id).toBe(owner.id);
      expect(first.profileId).toBe(profile.id);
      expect(repeat.id).toBe(owner.id);
      await expect(profiles.list({})).resolves.toHaveLength(1);
      await expect(users.list({})).resolves.toHaveLength(1);
      await expect(identities.list({})).resolves.toHaveLength(1);
      await expect(
        provisionHostedOidcUser({ ...claims, email_verified: false }, users, [
          binding,
        ]),
      ).rejects.toThrow('unverified');
      await expect(
        provisionHostedOidcUser(
          { ...claims, sub: 'other-cold-root-subject' },
          users,
          [binding],
        ),
      ).rejects.toMatchObject({ code: 'profile_owned' });
      await expect(profiles.list({})).resolves.toHaveLength(1);
      await expect(users.list({})).resolves.toHaveLength(1);
      await expect(identities.list({})).resolves.toHaveLength(1);
    });
  },
);
