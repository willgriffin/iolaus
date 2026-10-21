import { decodeHtmlEntities, htmlToPlainText } from '../html-text.js';

const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const phone = /(?<!\w)(?:\+?\d[\d().\-\s]{6,}\d)(?!\w)/g;

/**
 * Canonical posting text is untrusted source material. Public detail responses
 * may expose only bounded readable text, never active markup or contact data.
 */
export function sanitizePublicOpportunityText(
  value: unknown,
  maximum: number,
): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const withoutActiveContent = decodeHtmlEntities(value)
    .replace(
      /<\s*(script|style|template|noscript)\b[^>]*>[\s\S]*?(?:<\s*\/\s*\1\s*>|$)/gi,
      '',
    )
    .replace(/<\s*(script|style|template|noscript)\b[^>]*\/?>/gi, '');
  const text = htmlToPlainText(withoutActiveContent)
    .replace(email, '[contact removed]')
    .replace(phone, '[contact removed]')
    .trim()
    .slice(0, maximum)
    .trim();
  return text || undefined;
}
