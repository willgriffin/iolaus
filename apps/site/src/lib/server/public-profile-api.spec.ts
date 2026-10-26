import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { publicProfileApiSchema } from '$lib/public-profile-api-contract';

const mocks = vi.hoisted(() => ({ profile: vi.fn() }));
vi.mock('./public-profile-service', () => ({
  getPublicProfile: mocks.profile,
}));

import {
  GET,
  HEAD,
  OPTIONS,
} from '../../routes/api/public/v1/profiles/[handle]/+server';
import { publicProfileApiResponse } from './public-profile-api';

const fixture = JSON.parse(
  readFileSync(
    new URL(
      '../../../../../docs/public-profile-api/synthetic-profile.json',
      import.meta.url,
    ),
    'utf8',
  ),
);
function current() {
  return {
    handle: fixture.handle,
    revisionId: 'private-revision-id',
    publishedAt: fixture.revisionCreatedAt,
    snapshot: { version: 1, ...structuredClone(fixture.profile) },
    tenantId: 'private-tenant',
    sourceProfileId: 'private-source',
    pdfPath: 'private.pdf',
  };
}
beforeEach(() => {
  mocks.profile.mockReset();
  mocks.profile.mockResolvedValue(current());
});
afterEach(() => vi.unstubAllEnvs());
const event = (locals = {}) =>
  ({ params: { handle: fixture.handle }, locals }) as never;
const read = async () => publicProfileApiResponse(fixture.handle);
describe('published profile API privacy and transport', () => {
  it('validates the synthetic external contract and rejects unknown versions/fields', () => {
    expect(publicProfileApiSchema.safeParse(fixture).success).toBe(true);
    expect(
      publicProfileApiSchema.safeParse({ ...fixture, apiVersion: 2 }).success,
    ).toBe(false);
    expect(
      publicProfileApiSchema.safeParse({ ...fixture, tenantId: 'private' })
        .success,
    ).toBe(false);
    expect(
      publicProfileApiSchema.safeParse({
        ...fixture,
        profile: { ...fixture.profile, version: 1 },
      }).success,
    ).toBe(false);
  });
  it('keeps published JSON Schema and OpenAPI aligned with the runtime validator', () => {
    const schema = JSON.parse(
      readFileSync(
        new URL(
          '../../../../../docs/public-profile-api/profile-v1.schema.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    const openapi = JSON.parse(
      readFileSync(
        new URL(
          '../../../../../docs/public-profile-api/openapi.json',
          import.meta.url,
        ),
        'utf8',
      ),
    );
    expect(schema).toEqual(z.toJSONSchema(publicProfileApiSchema));
    expect(
      openapi.paths['/api/public/v1/profiles/{handle}'].get.responses['200']
        .content['application/json'].schema,
    ).toEqual(schema);
  });
  it('returns identical public data for anonymous, owner and unrelated signed-in context', async () => {
    const anonymous = await GET(event());
    const owner = await GET(
      event({ user: { id: 'owner' }, workspaceSubject: { tenantId: 'a' } }),
    );
    const foreign = await GET(
      event({ user: { id: 'foreign' }, workspaceSubject: { tenantId: 'b' } }),
    );
    const body = await anonymous.json();
    expect(await owner.json()).toEqual(body);
    expect(await foreign.json()).toEqual(body);
    expect(body.profile).toEqual(fixture.profile);
    expect(body).toMatchObject({
      apiVersion: 1,
      revisionCreatedAt: fixture.revisionCreatedAt,
      links: fixture.links,
    });
    expect(body.revision).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(body)).not.toMatch(
      /private|tenantId|sourceProfileId|pdfPath|revisionId/,
    );
    expect(body.profile).not.toHaveProperty('version');
    expect(mocks.profile).toHaveBeenCalledWith(fixture.handle);
  });
  it('preserves only contacts/sections captured in the selected snapshot', async () => {
    const value = current();
    Object.assign(value.snapshot, {
      email: 'public@example.invalid',
      phone: '+1 555 0100',
      location: 'Example City',
      experience: [],
      education: [],
      skills: [],
      other: [],
      links: [],
    });
    mocks.profile.mockResolvedValue(value);
    const body = await (await read()).json();
    expect(body.profile).toMatchObject({
      email: 'public@example.invalid',
      phone: '+1 555 0100',
      location: 'Example City',
      experience: [],
      education: [],
      skills: [],
      other: [],
      links: [],
    });
    mocks.profile.mockResolvedValue(current());
    expect((await (await read()).json()).profile).not.toHaveProperty('email');
  });
  it('does not enrich from private edits; changes only when resolver publication changes', async () => {
    const first = await (await read()).json();
    // Extra live source facts outside the immutable snapshot must never be used.
    mocks.profile.mockResolvedValue({
      ...current(),
      privateProfile: { name: 'Unpublished edit' },
    });
    expect(await (await read()).json()).toEqual(first);
    const next = current();
    next.snapshot.name = 'Next published name';
    next.revisionId = 'next-revision';
    mocks.profile.mockResolvedValue(next);
    const published = await (await read()).json();
    expect(published.profile.name).toBe('Next published name');
    expect(published.revision).not.toBe(first.revision);
  });
  it.each([
    'unknown',
    'draft',
    'withdrawn',
    'deleted',
  ])('uses uniform unavailable for %s publication state', async () => {
    mocks.profile.mockResolvedValue(null);
    const response = await read();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      apiVersion: 1,
      error: { code: 'PROFILE_UNAVAILABLE', message: 'Profile unavailable.' },
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it.each([
    'x',
    'api',
    'bad--handle',
    '../private',
    'x'.repeat(64),
    '<script>',
  ])('rejects invalid handle %s before resolver', async (handle) => {
    expect((await publicProfileApiResponse(handle)).status).toBe(404);
    expect(mocks.profile).not.toHaveBeenCalled();
  });
  it.each([
    { version: 2 },
    { summary: 42 },
    { internalId: 'secret' },
    { links: [{ label: 'Unsafe', url: 'javascript:alert(1)' }] },
    {
      experience: [
        {
          role: 'x',
          company: 'y',
          start: '',
          end: '',
          bullets: [],
          projects: [],
          secret: true,
        },
      ],
    },
  ])('fails closed on malformed/unknown publication fields %j', async (fields) => {
    const value = current();
    Object.assign(value.snapshot, fields);
    mocks.profile.mockResolvedValue(value);
    expect((await read()).status).toBe(503);
  });
  it('distinguishes operational failures without exposing details', async () => {
    mocks.profile.mockRejectedValue(new Error('database password secret'));
    const response = await read();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      apiVersion: 1,
      error: {
        code: 'PROFILE_SERVICE_UNAVAILABLE',
        message: 'Profile service unavailable.',
      },
    });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('maps the feature-gate 404 to typed unavailable', async () => {
    const { error } = await import('@sveltejs/kit');
    mocks.profile.mockImplementation(() => error(404, 'Not found'));
    expect((await (await read()).json()).error.code).toBe(
      'PROFILE_UNAVAILABLE',
    );
  });
  it('HEAD preserves GET status/headers without body; OPTIONS never resolves content', async () => {
    const get = await GET(event());
    const head = await HEAD(event());
    expect(head.status).toBe(get.status);
    expect(await head.text()).toBe('');
    expect([...head.headers]).toEqual([...get.headers]);
    mocks.profile.mockClear();
    const options = await OPTIONS(event());
    expect(options.status).toBe(204);
    expect(mocks.profile).not.toHaveBeenCalled();
    for (const response of [get, head, options]) {
      expect(response.headers.get('cache-control')).toBe('no-store');
      expect(response.headers.get('access-control-allow-origin')).toBe('*');
      expect(response.headers.get('access-control-allow-methods')).toBe(
        'GET, HEAD, OPTIONS',
      );
      expect(response.headers.has('access-control-allow-credentials')).toBe(
        false,
      );
      expect(response.headers.has('set-cookie')).toBe(false);
    }
    mocks.profile.mockResolvedValue(null);
    expect((await HEAD(event())).status).toBe(404);
  });
});
