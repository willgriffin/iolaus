import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ profile: 'local', runtime: vi.fn() }));
vi.mock('$lib/server/application-runtime', () => ({
  applicationRuntime: state,
  getLocalApplicationRuntime: state.runtime,
}));
vi.mock('$lib/server/auth', () => ({ sessionCookieName: 'test-session' }));
vi.mock('$lib/server/runtime-paths', () => ({
  getIolausSourceRoot: () => process.cwd(),
  IOLAUS_APPLICATION_ID: 'iolaus',
  resolveIolausLocalRuntimePaths: vi.fn(),
}));

import { trailingSlash } from './+page';
import { actions, load } from './+page.server';

const page = (query = '') =>
  ({
    url: new URL(`http://127.0.0.1/setup${query}`),
    locals: {},
  }) as Parameters<typeof load>[0];
const action = () =>
  ({
    request: { formData: vi.fn().mockResolvedValue(new FormData()) },
  }) as unknown as Parameters<NonNullable<typeof actions.default>>[0];
describe('native setup recovery', () => {
  beforeEach(() => {
    vi.stubEnv('SMRT_DESKTOP_OWNER_LINK_SECRET', '');
    state.profile = 'local';
    state.runtime.mockReset().mockResolvedValue({
      diagnostics: async () => ({ bootstrap: { status: 'unclaimed' } }),
    });
  });
  afterEach(() => vi.unstubAllEnvs());
  it('accepts /setup without forcing a trailing-slash redirect', () =>
    expect(trailingSlash).toBe('ignore'));
  it('shows native recovery without returning the token or loading bootstrap state', async () => {
    vi.stubEnv('SMRT_DESKTOP_OWNER_LINK_SECRET', 'server-private-launch-proof');
    expect(await load(page('?token=private-bootstrap-token'))).toEqual({
      desktop: true,
      available: false,
      token: '',
    });
    expect(state.runtime).not.toHaveBeenCalled();
  });
  it('preserves browser bootstrap when no server desktop environment is present', async () => {
    expect(await load(page('?token=browser-token'))).toEqual({
      desktop: false,
      available: true,
      token: 'browser-token',
    });
    expect(state.runtime).toHaveBeenCalledOnce();
  });
  it('does not trust a desktop flag supplied in the request', async () => {
    expect(await load(page('?desktop=true'))).toMatchObject({
      desktop: false,
      available: true,
    });
  });
  it('does not enable native recovery in a hosted profile', async () => {
    state.profile = 'self-hosted';
    vi.stubEnv('SMRT_DESKTOP_OWNER_LINK_SECRET', 'server-private-launch-proof');
    expect(await load(page())).toEqual({
      desktop: false,
      available: false,
      token: '',
    });
    expect(state.runtime).not.toHaveBeenCalled();
  });
  it('refuses native owner-form mutations before reading form data', async () => {
    vi.stubEnv('SMRT_DESKTOP_OWNER_LINK_SECRET', 'server-private-launch-proof');
    const request = action();
    expect(await actions.default(request)).toMatchObject({ status: 404 });
    expect(request.request.formData).not.toHaveBeenCalled();
    expect(state.runtime).not.toHaveBeenCalled();
  });
  it('retains browser form validation', async () => {
    const request = action();
    expect(await actions.default(request)).toMatchObject({ status: 400 });
    expect(request.request.formData).toHaveBeenCalledOnce();
  });
});
