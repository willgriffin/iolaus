import { json, type RequestHandler } from '@sveltejs/kit';
import { exchangeCliAuthDeviceCode } from '$lib/server/terminal-auth';

export const POST: RequestHandler = async ({ request }) => {
  const body = (await request.json().catch(() => null)) as {
    deviceCode?: unknown;
  } | null;
  const deviceCode =
    typeof body?.deviceCode === 'string' ? body.deviceCode.trim() : '';

  if (!deviceCode) {
    return json({ error: 'deviceCode is required.' }, { status: 400 });
  }

  return json(await exchangeCliAuthDeviceCode(deviceCode));
};
