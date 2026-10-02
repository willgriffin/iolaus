import { describe, expect, it } from 'vitest';
import { nullEqualConflictIndexTarget } from './workspace-ownership-empty-ddl.js';

const wrapper = (
  table = 'opportunity_assessments',
  suffix = '',
) => `-- smrt:null-equal-conflict-index
DO $smrt_null_equal$
BEGIN
  IF current_setting('server_version_num')::integer >= 150000 THEN
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "${table}_key" ON "${table}" ("tenant_id", "owner_user_id") NULLS NOT DISTINCT';
  ELSE
    EXECUTE 'CREATE UNIQUE INDEX IF NOT EXISTS "${table}_key" ON "${table}" ("tenant_id", "owner_user_id")';
  END IF;
END;
$smrt_null_equal$;${suffix}`;

describe('null-equal empty-table DDL guard', () => {
  it('accepts only the exact native wrapper target', () => {
    expect(nullEqualConflictIndexTarget(wrapper())).toBe(
      'opportunity_assessments',
    );
  });

  it('rejects appended statements and mismatched foreign targets', () => {
    expect(
      nullEqualConflictIndexTarget(`${wrapper()} DROP TABLE "users";`),
    ).toBeNull();
    expect(
      nullEqualConflictIndexTarget(
        wrapper().replace('ON "opportunity_assessments"', 'ON "other_table"'),
      ),
    ).toBeNull();
  });
});
