import nodemailer from 'nodemailer';
import {
  type AppConfigEnvironment,
  getAppConfig,
  getConfiguredPublicOrigin,
} from './app-config.js';

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  password: string;
  from: string;
}

export interface InviteMessage {
  from: string;
  to: string;
  subject: string;
  text: string;
  html: string;
}

/** The narrow transport surface used here; nodemailer's transporter fits. */
export interface InviteTransport {
  sendMail(message: InviteMessage): Promise<unknown>;
}

export type InviteEmailOutcome =
  | { status: 'sent' }
  | { status: 'skipped'; reason: string }
  | { status: 'failed'; reason: string };

export interface InviteEmailOptions {
  environment?: AppConfigEnvironment;
  /** Test seam: replaces the SMTP transport built from `SMTP_*`. */
  transport?: InviteTransport;
}

const SMTP_KEYS = ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD', 'SMTP_FROM'];
const DEFAULT_SMTP_PORT = 587;

function value(raw: string | undefined): string {
  return raw?.trim() ?? '';
}

/** SMTP settings from the environment, or null unless fully configured. */
export function getSmtpConfig(
  environment: AppConfigEnvironment = process.env,
): SmtpConfig | null {
  if (SMTP_KEYS.some((key) => !value(environment[key]))) return null;
  const rawPort = value(environment.SMTP_PORT);
  const port = rawPort ? Number(rawPort) : DEFAULT_SMTP_PORT;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return {
    host: value(environment.SMTP_HOST),
    port,
    user: value(environment.SMTP_USER),
    password: value(environment.SMTP_PASSWORD),
    from: value(environment.SMTP_FROM),
  };
}

/** The support address when IOLAUS_SUPPORT_URL is an email or mailto: link. */
export function getSupportEmail(
  environment: AppConfigEnvironment = process.env,
): string | null {
  const raw = value(environment.IOLAUS_SUPPORT_URL).replace(/^mailto:/iu, '');
  return /^[^\s@/:?]+@[^\s@/:?]+\.[^\s@/:?]+$/u.test(raw) ? raw : null;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Build the plain-text plus simple HTML invitation (no tracking, no images). */
export function buildInviteMessage(
  recipient: string,
  details: {
    appName: string;
    loginUrl: string;
    supportEmail: string | null;
    from: string;
  },
): InviteMessage {
  const { appName, loginUrl, supportEmail, from } = details;
  const textLines = [
    `You've been invited to ${appName}.`,
    '',
    `Sign in here: ${loginUrl}`,
    '',
    `Sign in with the account for this email address (${recipient}).`,
  ];
  const htmlParagraphs = [
    `<p>You've been invited to <strong>${escapeHtml(appName)}</strong>.</p>`,
    `<p><a href="${escapeHtml(loginUrl)}">Sign in to ${escapeHtml(appName)}</a><br>${escapeHtml(loginUrl)}</p>`,
    `<p>Sign in with the account for this email address (${escapeHtml(recipient)}).</p>`,
  ];
  if (supportEmail) {
    textLines.push('', `Questions? Contact ${supportEmail}.`);
    htmlParagraphs.push(
      `<p>Questions? Contact <a href="mailto:${escapeHtml(supportEmail)}">${escapeHtml(supportEmail)}</a>.</p>`,
    );
  }
  return {
    from,
    to: recipient,
    subject: `You've been invited to ${appName}`,
    text: `${textLines.join('\n')}\n`,
    html: `<!doctype html><html><body>${htmlParagraphs.join('')}</body></html>`,
  };
}

/**
 * Send the invitation. Never throws and never reports credentials or message
 * bodies: an unconfigured deployment is `skipped`, a delivery error `failed`.
 */
export async function sendInviteEmail(
  email: string,
  options: InviteEmailOptions = {},
): Promise<InviteEmailOutcome> {
  const environment = options.environment ?? process.env;
  const smtp = getSmtpConfig(environment);
  if (!smtp && !options.transport) {
    return {
      status: 'skipped',
      reason:
        'SMTP is not configured (SMTP_HOST, SMTP_USER, SMTP_PASSWORD, SMTP_FROM)',
    };
  }
  const origin = getConfiguredPublicOrigin(environment);
  if (!origin) {
    return {
      status: 'skipped',
      reason: 'IOLAUS_PUBLIC_URL is not configured for this runtime profile',
    };
  }
  const message = buildInviteMessage(email, {
    appName: getAppConfig(environment).appName,
    loginUrl: `${origin}/login`,
    supportEmail: getSupportEmail(environment),
    from: smtp?.from ?? value(environment.SMTP_FROM),
  });
  const transport: InviteTransport =
    options.transport ??
    nodemailer.createTransport({
      host: smtp?.host,
      port: smtp?.port,
      secure: false,
      requireTLS: true,
      auth: { user: smtp?.user, pass: smtp?.password },
    });
  try {
    await transport.sendMail(message);
    return { status: 'sent' };
  } catch (error) {
    const code =
      error && typeof error === 'object' && 'code' in error
        ? String((error as { code: unknown }).code)
        : 'unknown';
    return { status: 'failed', reason: `SMTP delivery failed (${code})` };
  }
}
