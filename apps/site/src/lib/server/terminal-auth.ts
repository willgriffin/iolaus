import { createHash, randomBytes } from 'node:crypto';
import {
  type SessionContext,
  type SessionPermissionRuntimeContext,
  SessionService,
  type User,
  withSessionPermissionContext,
} from '@happyvertical/smrt-users';
import type { CliAuthRequest } from '$lib/objects';
import { sessionCookieName } from './auth.js';
import { getSmrtOptions } from './db.js';
import { getCollection } from './smrt.js';

export const cliAuthPollIntervalSeconds = 2;
const cliAuthTtlSeconds = 10 * 60;
const cliSessionTtlSeconds = Number(
  process.env.CLI_SESSION_TTL_SECONDS ?? 30 * 24 * 60 * 60,
);

export interface CliAuthStartResult {
  deviceCode: string;
  expiresAt: string;
  interval: number;
  userCode: string;
  verificationUrl: string;
}

export type CliAuthTokenResult =
  | { status: 'pending'; expiresAt: string; interval: number }
  | { status: 'expired' }
  | {
      status: 'approved';
      accessToken: string;
      expiresIn: number;
      tokenType: 'Bearer';
    };

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

function hashDeviceCode(deviceCode: string): string {
  return createHash('sha256').update(deviceCode).digest('hex');
}

function makeUserCode(): string {
  const raw = randomBytes(6).toString('hex').toUpperCase();
  return `WG-${raw.slice(0, 8)}`;
}

async function getCliAuthCollection() {
  return await getCollection<CliAuthRequest>('CliAuthRequest');
}

async function findByUserCode(
  userCode: string,
): Promise<CliAuthRequest | null> {
  const collection = await getCliAuthCollection();
  const [request] = await collection.list({
    limit: 1,
    where: { userCode: userCode.trim().toUpperCase() },
  });
  return request ?? null;
}

async function findByDeviceCode(
  deviceCode: string,
): Promise<CliAuthRequest | null> {
  const collection = await getCliAuthCollection();
  const [request] = await collection.list({
    limit: 1,
    where: { deviceCodeHash: hashDeviceCode(deviceCode) },
  });
  return request ?? null;
}

function isExpired(request: CliAuthRequest): boolean {
  return new Date(request.expiresAt).getTime() <= Date.now();
}

async function createSessionService(): Promise<SessionService> {
  return await SessionService.create({
    ...getSmrtOptions(),
    autoExtend: true,
    cookieName: sessionCookieName,
    defaultTTL: cliSessionTtlSeconds,
  });
}

export async function createCliAuthRequest(
  origin: string,
): Promise<CliAuthStartResult> {
  const collection = await getCliAuthCollection();
  const deviceCode = base64url(randomBytes(32));
  const userCode = makeUserCode();
  const expiresAt = new Date(Date.now() + cliAuthTtlSeconds * 1000);

  const request = await collection.create({
    deviceCodeHash: hashDeviceCode(deviceCode),
    expiresAt,
    status: 'pending',
    userCode,
  });
  await request.save();

  return {
    deviceCode,
    expiresAt: expiresAt.toISOString(),
    interval: cliAuthPollIntervalSeconds,
    userCode,
    verificationUrl: `${origin}/admin/terminal-login?code=${encodeURIComponent(userCode)}`,
  };
}

export async function getCliAuthRequestForUserCode(
  userCode: string,
): Promise<CliAuthRequest | null> {
  const request = await findByUserCode(userCode);
  if (!request) return null;

  if (request.status === 'pending' && isExpired(request)) {
    request.status = 'expired';
    await request.save();
  }

  return request;
}

export async function approveCliAuthRequest(options: {
  ipAddress?: string;
  tenantId: string | null | undefined;
  user: Pick<User, 'email' | 'id'>;
  userAgent?: string;
  userCode: string;
}): Promise<CliAuthRequest> {
  if (!options.user.id || !options.tenantId) {
    throw new Error('An authenticated tenant session is required.');
  }

  const request = await getCliAuthRequestForUserCode(options.userCode);
  if (!request) {
    throw new Error('Terminal login request not found.');
  }
  if (request.status === 'approved') {
    return request;
  }
  if (request.status !== 'pending' || isExpired(request)) {
    request.status = 'expired';
    await request.save();
    throw new Error('Terminal login request has expired.');
  }

  const sessionService = await createSessionService();
  const sessionId = await sessionService.createSession(
    options.user.id,
    options.tenantId,
    {
      data: {
        approvedBy: options.user.email ?? options.user.id,
        kind: 'terminal',
      },
      ipAddress: options.ipAddress,
      ttl: cliSessionTtlSeconds,
      userAgent: options.userAgent,
    },
  );

  request.approvedAt = new Date();
  request.sessionId = sessionId;
  request.status = 'approved';
  request.tenantId = options.tenantId;
  request.userId = options.user.id;
  await request.save();
  return request;
}

export async function exchangeCliAuthDeviceCode(
  deviceCode: string,
): Promise<CliAuthTokenResult> {
  const request = await findByDeviceCode(deviceCode);
  if (!request) {
    return { status: 'expired' };
  }

  if (isExpired(request)) {
    if (request.status === 'pending') {
      request.status = 'expired';
      await request.save();
    }
    return { status: 'expired' };
  }

  if (request.status === 'pending') {
    return {
      expiresAt: new Date(request.expiresAt).toISOString(),
      interval: cliAuthPollIntervalSeconds,
      status: 'pending',
    };
  }

  if (request.status === 'approved' && request.sessionId) {
    return {
      accessToken: request.sessionId,
      expiresIn: cliSessionTtlSeconds,
      status: 'approved',
      tokenType: 'Bearer',
    };
  }

  return { status: 'expired' };
}

export async function loadBearerSession(
  token: string,
): Promise<SessionContext | null> {
  const sessionService = await createSessionService();
  return await sessionService.loadSessionContext(token);
}

export async function withBearerSessionContext<T>(
  token: string,
  fn: (context: SessionPermissionRuntimeContext) => Promise<T>,
): Promise<T> {
  const sessionService = await createSessionService();
  return await withSessionPermissionContext(
    {
      ...getSmrtOptions(),
      enterTenantContext: true,
      sessionId: token,
      sessionService,
    },
    fn,
  );
}

export async function destroyBearerSession(token: string): Promise<boolean> {
  const sessionService = await createSessionService();
  return await sessionService.destroySession(token);
}
