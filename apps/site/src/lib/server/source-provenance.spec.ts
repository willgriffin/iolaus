import { describe, expect, it, vi } from 'vitest';
import {
  assertOperableRootSource,
  backfillSourceProvenance,
  ensureSourceProvenanceSchema,
  getSourceProvenanceSchemaStatus,
  isOperableRootSource,
  sourceProvenanceSchemaIsReady,
} from './source-provenance';

const canonicalForeignKey = {
  definition:
    'FOREIGN KEY (parent_source_id) REFERENCES sources(id) ON DELETE RESTRICT DEFERRABLE',
  type: 'f',
  validated: true,
};

const canonicalRoleCheck = {
  definition:
    "CHECK (source_role IS NOT NULL AND (source_role = ANY (ARRAY['root'::text, 'posting_derived'::text, 'unknown'::text])) AND (source_role = 'root'::text AND NULLIF(btrim(parent_source_id), ''::text) IS NULL OR source_role = 'posting_derived'::text AND NULLIF(btrim(parent_source_id), ''::text) IS NOT NULL AND is_active IS FALSE OR source_role = 'unknown'::text AND NULLIF(btrim(parent_source_id), ''::text) IS NULL AND is_active IS FALSE))",
  type: 'c',
  validated: true,
};

const canonicalForwardTrigger = {
  argumentCount: 0,
  definition:
    'CREATE CONSTRAINT TRIGGER sources_parent_provenance_guard AFTER INSERT OR UPDATE OF source_role, parent_source_id ON sources DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION enforce_source_parent_provenance()',
  enabled: 'O',
  functionBody: `
    BEGIN
      IF NEW.source_role = 'posting_derived' THEN
        PERFORM 1
        FROM sources AS parent
        WHERE parent.id = NEW.parent_source_id
          AND parent.id <> NEW.id
          AND parent.source_role = 'root'
          AND NULLIF(BTRIM(parent.parent_source_id::text), '') IS NULL
        FOR SHARE;
        IF NOT FOUND THEN
          RAISE EXCEPTION 'posting-derived source requires an existing distinct root parent';
        END IF;
      END IF;
      RETURN NEW;
    END;
  `,
  functionInCurrentSchema: true,
  functionName: 'enforce_source_parent_provenance',
  internal: false,
  language: 'plpgsql',
  returnsTrigger: true,
  securityDefiner: false,
  volatility: 'v',
};

const canonicalReverseTrigger = {
  argumentCount: 0,
  definition:
    'CREATE TRIGGER sources_parent_reverse_guard BEFORE DELETE OR UPDATE OF source_role, parent_source_id ON sources FOR EACH ROW EXECUTE FUNCTION enforce_source_parent_reverse_provenance()',
  enabled: 'O',
  functionBody: `
    BEGIN
      IF TG_OP = 'DELETE' THEN
        IF EXISTS (
          SELECT 1 FROM sources AS child
          WHERE child.parent_source_id = OLD.id
        ) THEN
          RAISE EXCEPTION 'root source with posting-derived children cannot be deleted';
        END IF;
        RETURN OLD;
      END IF;
      IF (
        NEW.source_role IS DISTINCT FROM 'root'
        OR NULLIF(BTRIM(NEW.parent_source_id::text), '') IS NOT NULL
      ) AND EXISTS (
        SELECT 1 FROM sources AS child
        WHERE child.parent_source_id = OLD.id
      ) THEN
        RAISE EXCEPTION 'root source with posting-derived children cannot change provenance';
      END IF;
      RETURN NEW;
    END;
  `,
  functionInCurrentSchema: true,
  functionName: 'enforce_source_parent_reverse_provenance',
  internal: false,
  language: 'plpgsql',
  returnsTrigger: true,
  securityDefiner: false,
  volatility: 'v',
};

function statusQueryWith(
  overrides: Partial<{
    foreignKey: Record<string, unknown>;
    forwardTrigger: Record<string, unknown>;
    reverseTrigger: Record<string, unknown>;
    roleCheck: Record<string, unknown>;
  }> = {},
) {
  return vi
    .fn()
    .mockResolvedValueOnce({
      rows: [{ ...canonicalForeignKey, ...overrides.foreignKey }],
    })
    .mockResolvedValueOnce({
      rows: [{ ...canonicalForwardTrigger, ...overrides.forwardTrigger }],
    })
    .mockResolvedValueOnce({
      rows: [{ ...canonicalReverseTrigger, ...overrides.reverseTrigger }],
    })
    .mockResolvedValueOnce({ rows: [{ isNullable: 'NO' }] })
    .mockResolvedValueOnce({
      rows: [{ ...canonicalRoleCheck, ...overrides.roleCheck }],
    });
}

describe('source provenance', () => {
  it('backfills only from explicit parent links and durable direct crawl history', async () => {
    const statements: string[] = [];
    const db = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('RETURNING source.id')) {
          return { rows: [{ id: 'root-1' }] };
        }
        if (sql.includes('GROUP BY source_role')) {
          return {
            rows: [
              { count: 3, role: 'posting_derived' },
              { count: 4, role: 'unknown' },
              { count: 2, role: 'root' },
            ],
          };
        }
        return { rows: [] };
      }),
    };

    await expect(backfillSourceProvenance(db as never)).resolves.toEqual({
      postingDerived: 3,
      promotedRoots: 1,
      unknown: 4,
    });

    const rootPromotion = statements.find((sql) =>
      sql.includes("SET source_role = 'root'"),
    );
    expect(rootPromotion).toContain('FROM source_crawls');
    expect(rootPromotion).toContain('is_active = FALSE');
    expect(rootPromotion).toContain('crawl.source_id = source.id::text');
    expect(statements.join('\n')).toContain('is_active IS DISTINCT FROM FALSE');
    expect(statements.join('\n')).not.toMatch(
      /account_notes|name\s+(?:LIKE|=)|url\s+(?:LIKE|=)/i,
    );
  });

  it('does not re-promote operator-demoted roots after the one-shot backfill', async () => {
    const statements: string[] = [];
    const db = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('GROUP BY source_role')) {
          return { rows: [{ count: 1, role: 'unknown' }] };
        }
        return { rows: [] };
      }),
    };
    await expect(
      backfillSourceProvenance(db as never, { promoteLegacyRoots: false }),
    ).resolves.toEqual({ postingDerived: 0, promotedRoots: 0, unknown: 1 });
    expect(statements.join('\n')).not.toContain('FROM source_crawls');
  });

  it('records the authoritative promotion marker in the schema transaction', async () => {
    let markerPresent = false;
    let promotionRuns = 0;
    const db = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('SELECT 1 FROM _smrt_migrations')) {
          return { rows: markerPresent ? [{ one: 1 }] : [] };
        }
        if (sql.includes('INSERT INTO _smrt_migrations')) {
          markerPresent = true;
          return { rows: [] };
        }
        if (sql.includes('FROM source_crawls')) promotionRuns += 1;
        if (sql.includes('GROUP BY source_role')) return { rows: [] };
        return { rows: [] };
      }),
      transaction: vi.fn(),
    };
    db.transaction.mockImplementation(
      async (work: (database: typeof db) => Promise<unknown>) => work(db),
    );

    await ensureSourceProvenanceSchema(db as never);
    await ensureSourceProvenanceSchema(db as never);

    expect(promotionRuns).toBe(1);
    expect(markerPresent).toBe(true);
  });

  it('installs a deferred database guard for existing distinct root parents', async () => {
    const statements: string[] = [];
    const db = {
      query: vi.fn(async (sql: string) => {
        statements.push(sql);
        if (sql.includes('GROUP BY source_role')) return { rows: [] };
        return { rows: [] };
      }),
      transaction: vi.fn(),
    };
    db.transaction.mockImplementation(
      async (work: (database: typeof db) => Promise<unknown>) => work(db),
    );

    await ensureSourceProvenanceSchema(db as never);

    const sql = statements.join('\n');
    expect(db.transaction).toHaveBeenCalledOnce();
    expect(sql).toContain('LOCK TABLE sources IN SHARE ROW EXCLUSIVE MODE');
    expect(sql).toContain('ALTER COLUMN source_role SET NOT NULL');
    expect(sql).toContain('is_active IS FALSE');
    expect(sql).toContain("NEW.source_role IS DISTINCT FROM 'root'");
    expect(sql).toContain("child.source_role = 'posting_derived'");
    expect(sql).toContain('parent.id <> child.id');
    expect(sql).toContain("parent.source_role = 'root'");
    expect(sql).toContain(
      'CREATE CONSTRAINT TRIGGER sources_parent_provenance_guard',
    );
    expect(sql).toContain('DEFERRABLE INITIALLY IMMEDIATE');
    expect(sql).toContain('parent.id <> NEW.id');
    expect(sql).toContain('FOR SHARE');
    expect(sql).toContain(
      'FOREIGN KEY (parent_source_id) REFERENCES sources(id)',
    );
    expect(sql).toContain('ON DELETE RESTRICT');
    expect(sql).toContain(
      'BEFORE DELETE OR UPDATE OF source_role, parent_source_id',
    );
    expect(sql).toContain('cannot change provenance');
  });

  it('reports the durable parent foreign key and reverse guard', async () => {
    const query = statusQueryWith();

    await expect(
      getSourceProvenanceSchemaStatus({ query } as never),
    ).resolves.toEqual({
      parentForeignKeyPresent: true,
      parentForeignKeyValidated: true,
      parentForwardTriggerPresent: true,
      parentReverseTriggerPresent: true,
      sourceRoleCheckPresent: true,
      sourceRoleCheckValidated: true,
      sourceRoleRequired: true,
    });
    expect(query.mock.calls[0]?.[1]).toEqual(['sources_parent_source_fk']);
    expect(query.mock.calls[4]?.[1]).toEqual(['sources_source_role_check']);
  });

  it.each([
    ['foreign-key type', { foreignKey: { type: 'c' } }],
    [
      'foreign-key definition',
      {
        foreignKey: {
          definition: 'FOREIGN KEY (parent_source_id) REFERENCES sources(id)',
        },
      },
    ],
    ['forward trigger disabled', { forwardTrigger: { enabled: 'D' } }],
    [
      'forward trigger timing/events',
      {
        forwardTrigger: {
          definition:
            'CREATE TRIGGER sources_parent_provenance_guard BEFORE INSERT ON sources FOR EACH ROW EXECUTE FUNCTION enforce_source_parent_provenance()',
        },
      },
    ],
    [
      'forward trigger function binding',
      { forwardTrigger: { functionName: 'weakened_parent_guard' } },
    ],
    [
      'forward trigger function body',
      { forwardTrigger: { functionBody: 'BEGIN RETURN NEW; END;' } },
    ],
    ['reverse trigger disabled', { reverseTrigger: { enabled: 'D' } }],
    [
      'reverse trigger timing/events',
      {
        reverseTrigger: {
          definition:
            'CREATE TRIGGER sources_parent_reverse_guard BEFORE DELETE ON sources FOR EACH ROW EXECUTE FUNCTION enforce_source_parent_reverse_provenance()',
        },
      },
    ],
    [
      'reverse trigger function binding',
      { reverseTrigger: { functionName: 'weakened_reverse_guard' } },
    ],
    [
      'reverse trigger function body',
      { reverseTrigger: { functionBody: 'BEGIN RETURN OLD; END;' } },
    ],
    ['role-check type', { roleCheck: { type: 'f' } }],
    [
      'role-check definition',
      { roleCheck: { definition: 'CHECK (source_role IS NOT NULL)' } },
    ],
  ])('rejects a same-named malformed %s', async (_name, overrides) => {
    const status = await getSourceProvenanceSchemaStatus({
      query: statusQueryWith(overrides),
    } as never);
    expect(sourceProvenanceSchemaIsReady(status)).toBe(false);
  });

  it('fails schema readiness when the role check is absent or unvalidated', () => {
    const ready = {
      parentForeignKeyPresent: true,
      parentForeignKeyValidated: true,
      parentForwardTriggerPresent: true,
      parentReverseTriggerPresent: true,
      sourceRoleCheckPresent: true,
      sourceRoleCheckValidated: true,
      sourceRoleRequired: true,
    };
    expect(sourceProvenanceSchemaIsReady(ready)).toBe(true);
    expect(
      sourceProvenanceSchemaIsReady({
        ...ready,
        sourceRoleCheckPresent: false,
      }),
    ).toBe(false);
    expect(
      sourceProvenanceSchemaIsReady({
        ...ready,
        sourceRoleCheckValidated: false,
      }),
    ).toBe(false);
  });

  it('leaves ambiguous legacy and posting-derived sources non-operable', () => {
    expect(
      isOperableRootSource({
        id: 'unknown-1',
        isActive: false,
        parentSourceId: null,
        sourceRole: 'unknown',
      }),
    ).toBe(false);
    expect(
      isOperableRootSource({
        id: 'child-1',
        isActive: false,
        parentSourceId: 'root-1',
        sourceRole: 'posting_derived',
      }),
    ).toBe(false);
    expect(() => assertOperableRootSource({ sourceRole: 'unknown' })).toThrow(
      'durable provenance',
    );
    expect(
      isOperableRootSource({
        id: 'root-1',
        parentSourceId: null,
        sourceRole: 'root',
      }),
    ).toBe(true);
  });
});
