import { describe, expect, it } from 'vitest';
import { parseDbMigrateOptions } from './db-migrate-options.js';

describe('db:migrate options', () => {
  it('keeps the normal PostgreSQL-safe migration mode by default', () => {
    expect(parseDbMigrateOptions([])).toEqual({ maintenanceWindow: false });
  });

  it('requires an explicit maintenance-window flag for atomic native DDL', () => {
    expect(parseDbMigrateOptions(['--maintenance-window'])).toEqual({
      maintenanceWindow: true,
    });
  });

  it('rejects unknown flags rather than silently ignoring them', () => {
    expect(() => parseDbMigrateOptions(['--postgres-safe=false'])).toThrow(
      'Only --maintenance-window is supported',
    );
  });
});
