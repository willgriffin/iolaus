import { describe, expect, it } from 'vitest';
import {
  type AdminResourceDockData,
  adminDockContextsMatch,
  buildAdminDockTools,
  routeContextForAdminResource,
} from './dock';
import { getAdminResource } from './resources';

function resourceContext(
  overrides: Partial<AdminResourceDockData> = {},
): AdminResourceDockData {
  const resource = getAdminResource('candidate-profiles');
  if (!resource) {
    throw new Error('Expected candidate-profiles admin resource fixture.');
  }

  return {
    comboOptions: {},
    records: [],
    resource,
    selectedRecord: null,
    ...overrides,
  };
}

function requireResource(slug: string) {
  const resource = getAdminResource(slug);
  if (!resource) throw new Error(`Expected ${slug} admin resource fixture.`);
  return resource;
}

describe('buildAdminDockTools', () => {
  it('does not expose generic create or edit tools in the dock', () => {
    const context = resourceContext({ selectedRecord: { id: 'profile-1' } });

    expect(buildAdminDockTools(context).map((tool) => tool.id)).toEqual([]);
  });

  it.each([
    'opportunities',
    'tasks',
    'skills',
    'skill-categories',
  ])('exposes no per-record related tools for %s', (slug) => {
    const context = resourceContext({
      resource: requireResource(slug),
      selectedRecord: { id: 'record-1', title: 'Selected record' },
    });

    expect(buildAdminDockTools(context)).toEqual([]);
  });

  it('returns no tools without a context', () => {
    expect(buildAdminDockTools(null)).toEqual([]);
  });
});

describe('adminDockContextsMatch', () => {
  it('treats repeated resource effect payloads as equal', () => {
    const records = [{ id: 'profile-1' }];
    const context = resourceContext({ records, selectedRecord: records[0] });
    const repeatedContext = resourceContext({
      records,
      selectedRecord: { id: 'profile-1' },
    });

    expect(adminDockContextsMatch(context, repeatedContext)).toBe(true);
  });

  it('detects selected record changes', () => {
    const records = [{ id: 'profile-1' }, { id: 'profile-2' }];
    const context = resourceContext({ records, selectedRecord: records[0] });
    const nextContext = resourceContext({
      records,
      selectedRecord: records[1],
    });

    expect(adminDockContextsMatch(context, nextContext)).toBe(false);
  });

  it('keeps the focused record in the context feed for the dock', () => {
    const resource = requireResource('opportunities');
    const records = [{ id: 'opportunity-1', title: 'Staff Engineer' }];
    const context = resourceContext({
      records,
      resource,
      selectedRecord: records[0],
    });

    expect(context.selectedRecord).toEqual(records[0]);
    expect(context.records).toBe(records);
    expect(context.resource.slug).toBe('opportunities');
  });
});

describe('routeContextForAdminResource', () => {
  it('builds immediate dock context for admin resource routes', () => {
    const candidateProfiles = requireResource('candidate-profiles');

    const context = routeContextForAdminResource('/admin/candidate-profiles/', [
      candidateProfiles,
    ]);

    expect(context?.resource.slug).toBe('candidate-profiles');
    expect(context?.records).toEqual([]);
    expect(context?.selectedRecord).toBeNull();
  });

  it('returns null for non-resource admin routes', () => {
    const candidateProfiles = requireResource('candidate-profiles');

    expect(
      routeContextForAdminResource('/admin', [candidateProfiles]),
    ).toBeNull();
    expect(
      routeContextForAdminResource('/admin/resume', [candidateProfiles]),
    ).toBeNull();
  });
});
