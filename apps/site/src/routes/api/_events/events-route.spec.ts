import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GET } from './+server';

const mocks = vi.hoisted(() => ({
  buildChangeEventStream: vi.fn(),
  db: {},
  enterTenantContext: vi.fn(),
  eventStreamCapacityExceededResponse: vi.fn(),
  getCollection: vi.fn(),
  hasTenantContext: vi.fn(),
  resolveDispatchTenantScope: vi.fn(),
  tryReserveChangeEventSubscriberSlot: vi.fn(),
}));

vi.mock('@happyvertical/smrt-core', () => ({
  buildChangeEventStream: mocks.buildChangeEventStream,
  eventStreamCapacityExceededResponse:
    mocks.eventStreamCapacityExceededResponse,
  resolveDispatchTenantScope: mocks.resolveDispatchTenantScope,
  tryReserveChangeEventSubscriberSlot:
    mocks.tryReserveChangeEventSubscriberSlot,
}));

vi.mock('@happyvertical/smrt-tenancy', () => ({
  enterTenantContext: mocks.enterTenantContext,
  hasTenantContext: mocks.hasTenantContext,
}));

vi.mock('@happyvertical/smrt-virt-web', () => ({
  manifestHash: 'test-manifest',
}));
vi.mock('$lib/server/smrt', () => ({ getCollection: mocks.getCollection }));

describe('SMRT events API', () => {
  beforeEach(() => {
    mocks.buildChangeEventStream.mockReset();
    mocks.enterTenantContext.mockReset();
    mocks.eventStreamCapacityExceededResponse.mockReset();
    mocks.getCollection.mockReset();
    mocks.hasTenantContext.mockReset();
    mocks.resolveDispatchTenantScope.mockReset();
    mocks.tryReserveChangeEventSubscriberSlot.mockReset();

    mocks.buildChangeEventStream.mockReturnValue(new ReadableStream());
    mocks.getCollection.mockResolvedValue({ db: mocks.db });
    mocks.hasTenantContext.mockReturnValue(false);
    mocks.resolveDispatchTenantScope.mockReturnValue({ tenantId: 'tenant-1' });
    mocks.tryReserveChangeEventSubscriberSlot.mockReturnValue(vi.fn());
  });

  it('opens an authenticated, tenant-scoped event stream', async () => {
    const request = new Request('https://iolaus.localhost/api/_events', {
      headers: { 'Last-Event-ID': '42' },
    });
    const response = await GET({
      locals: { tenantId: 'tenant-1', user: { id: 'user-1' } },
      request,
      url: new URL(request.url),
    } as Parameters<typeof GET>[0]);

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    expect(mocks.enterTenantContext).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
    });
    expect(mocks.getCollection).toHaveBeenCalledWith('Achievement');
    expect(mocks.buildChangeEventStream).toHaveBeenCalledWith(mocks.db, {
      cursor: 42,
      manifestHash: 'test-manifest',
      releaseSubscriberSlot: expect.any(Function),
      tenantScope: { tenantId: 'tenant-1' },
    });
  });

  it('rejects a new connection when the subscriber cap is reached', async () => {
    mocks.tryReserveChangeEventSubscriberSlot.mockReturnValue(null);
    const capacityResponse = new Response(null, { status: 503 });
    mocks.eventStreamCapacityExceededResponse.mockReturnValue(capacityResponse);
    const request = new Request('https://iolaus.localhost/api/_events');

    await expect(
      GET({
        locals: { user: { id: 'user-1' } },
        request,
        url: new URL(request.url),
      } as Parameters<typeof GET>[0]),
    ).resolves.toBe(capacityResponse);
    expect(mocks.buildChangeEventStream).not.toHaveBeenCalled();
  });

  it('fails closed before accessing the database without authentication', async () => {
    const request = new Request('https://iolaus.localhost/api/_events');

    await expect(
      GET({
        locals: {},
        request,
        url: new URL(request.url),
      } as Parameters<typeof GET>[0]),
    ).rejects.toMatchObject({ status: 401 });
    expect(mocks.getCollection).not.toHaveBeenCalled();
  });
});
