import { getTestDatabase } from '@happyvertical/smrt-core';
import { describe, expect, it, vi } from 'vitest';
import { inviteAndNotify, sendInviteNotification } from './hosted-invite';
import {
  buildInviteMessage,
  getSmtpConfig,
  getSupportEmail,
  type InviteMessage,
  sendInviteEmail,
} from './hosted-invite-email';
import './smrt.js';

const env = {
  SMRT_RUNTIME_PROFILE: 'cloud',
  SMRT_APP_ID: 'jobgenius',
  IOLAUS_APP_NAME: 'JobGenius <Beta>',
  IOLAUS_PUBLIC_URL: 'https://app.example.com',
  IOLAUS_SUPPORT_URL: 'help@example.com',
  SMTP_HOST: 'smtp.example.com',
  SMTP_USER: 'user',
  SMTP_PASSWORD: 'secret-pass',
  SMTP_FROM: 'JobGenius <noreply@example.com>',
};

function fakeTransport(fail = false) {
  const sent: InviteMessage[] = [];
  return {
    sent,
    sendMail: vi.fn(async (message: InviteMessage) => {
      if (fail) {
        throw Object.assign(new Error('boom secret-pass'), { code: 'EAUTH' });
      }
      sent.push(message);
    }),
  };
}

describe('invite email', () => {
  it('requires full SMTP config and defaults to port 587', () => {
    expect(getSmtpConfig({})).toBeNull();
    expect(getSmtpConfig(env)?.port).toBe(587);
    expect(getSmtpConfig({ ...env, SMTP_PORT: 'x' })).toBeNull();
    expect(getSmtpConfig({ ...env, SMTP_PORT: '2587' })?.port).toBe(2587);
  });

  it('accepts only email-shaped support contacts', () => {
    expect(getSupportEmail({ IOLAUS_SUPPORT_URL: 'mailto:a@b.co' })).toBe(
      'a@b.co',
    );
    expect(
      getSupportEmail({ IOLAUS_SUPPORT_URL: 'https://x.co/help' }),
    ).toBeNull();
  });

  it('builds text and escaped html from the configured app name', async () => {
    const transport = fakeTransport();
    await expect(
      sendInviteEmail('friend@example.invalid', {
        environment: env,
        transport,
      }),
    ).resolves.toEqual({ status: 'sent' });
    const [message] = transport.sent;
    expect(message.subject).toBe("You've been invited to JobGenius <Beta>");
    expect(message.text).toContain('https://app.example.com/login');
    expect(message.text).toContain('friend@example.invalid');
    expect(message.text).toContain('help@example.com');
    expect(message.html).toContain('JobGenius &lt;Beta&gt;');
    expect(message.html).not.toContain('<Beta>');
    expect(message.html).not.toMatch(/<img/u);
  });

  it('omits support when none is configured', () => {
    const message = buildInviteMessage('a@b.co', {
      appName: 'X',
      loginUrl: 'https://x.co/login',
      supportEmail: null,
      from: 'f@x.co',
    });
    expect(message.text).not.toContain('Questions');
  });

  it('skips without SMTP and reports failures without secrets', async () => {
    await expect(
      sendInviteEmail('a@b.co', { environment: { ...env, SMTP_HOST: '' } }),
    ).resolves.toMatchObject({ status: 'skipped' });
    const outcome = await sendInviteEmail('a@b.co', {
      environment: env,
      transport: fakeTransport(true),
    });
    expect(outcome).toEqual({
      status: 'failed',
      reason: 'SMTP delivery failed (EAUTH)',
    });
    expect(JSON.stringify(outcome)).not.toContain('secret-pass');
  });
});

describe('invite notification', () => {
  async function store() {
    return { db: await getTestDatabase({ classes: ['HostedInvite'] }) };
  }

  it('emails created invites, honors --no-email, resends, and skips unchanged', async () => {
    const options = await store();
    const transport = fakeTransport();
    const base = { ...options, environment: env, transport };

    const quiet = await inviteAndNotify('a@example.invalid', {
      ...base,
      sendEmail: false,
    });
    expect(quiet.emailOutcome.status).toBe('not-sent');
    expect(transport.sent).toHaveLength(0);

    const again = await inviteAndNotify('a@example.invalid', base);
    expect(again.result).toBe('unchanged');
    expect(transport.sent).toHaveLength(0);

    const created = await inviteAndNotify('b@example.invalid', base);
    expect(created.emailOutcome).toEqual({ status: 'sent' });
    expect(transport.sent).toHaveLength(1);

    expect(await sendInviteNotification('a@example.invalid', base)).toEqual({
      status: 'sent',
    });
    expect(transport.sent).toHaveLength(2);
    expect(
      await sendInviteNotification('nobody@example.invalid', base),
    ).toEqual({ status: 'not-invited' });
  });

  it('does not attempt delivery when SMTP is unconfigured', async () => {
    const options = await store();
    const noSmtp = { ...options, environment: {} };
    await inviteAndNotify('c@example.invalid', { ...noSmtp, sendEmail: false });
    await expect(
      sendInviteNotification('c@example.invalid', noSmtp),
    ).resolves.toMatchObject({ status: 'skipped' });
  });
});
