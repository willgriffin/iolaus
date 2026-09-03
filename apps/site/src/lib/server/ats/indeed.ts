// Indeed apply-URL resolver for the ATS auto-submit feature.
//
// Indeed is not an ATS we can submit to directly: it exposes no public
// form-schema or application API, and its hosted "Indeed Apply" flow sits behind
// authentication and bot defenses we never bypass (docs/auto-submit-design.md).
// But most Indeed postings worth applying to are "Apply on company site" links
// that point at a real ATS (Greenhouse, Ashby, ...). This resolver reads an
// Indeed posting and extracts that underlying company apply URL so the existing
// ATS adapters can take over.
//
// Strictly additive and safe: a resolved URL is returned ONLY when it
// independently detects as a SUPPORTED ATS. Every other case — not Indeed, an
// Indeed-hosted apply, an unsupported ATS, a parse miss, or a blocked fetch —
// yields null, and the application falls back to manual submission exactly as
// it does today. The resolver can never cause a submission to the wrong place;
// at worst it fails to upgrade an opportunity that would have been manual anyway.

import type { FetchLike } from './types.js';

const INDEED_HOST_SUFFIX = '.indeed.com';

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function isIndeedHost(host: string): boolean {
  const lower = host.toLowerCase();
  return lower === 'indeed.com' || lower.endsWith(INDEED_HOST_SUFFIX);
}

export function isIndeedUrl(value: unknown): boolean {
  const raw = stringValue(value);
  if (!raw) return false;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    return isIndeedHost(url.hostname);
  } catch {
    return false;
  }
}

// Keys in Indeed's embedded job JSON that have historically carried the
// third-party (company-site) apply URL. Indeed's markup shifts often, so we scan
// for any of these rather than rely on a fixed path.
const APPLY_URL_KEYS = [
  'thirdPartyApplyUrl',
  'companyApplyUrl',
  'jobApplyUrl',
  'applyUrl',
  'applyLink',
  'dispatchUrl',
];

function isExternalApplyCandidate(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
    // Reject Indeed's own hosts (incl. apply/redirect endpoints): we want the
    // company destination, not an Indeed-hosted or Indeed-tracked URL.
    return !isIndeedHost(url.hostname);
  } catch {
    return false;
  }
}

function normalizeCandidate(raw: string): string {
  // Indeed embeds URLs JSON-escaped (\/), unicode-escaped (/), and
  // HTML-entity-encoded (&amp;). Decode the common forms before validating.
  return raw
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&')
    .trim();
}

/**
 * Best-effort: pull the external company apply URL out of an Indeed posting's
 * HTML. Returns the first external (non-Indeed) http(s) URL found against a
 * known apply-url key or an apply anchor, or '' when none is present (e.g. an
 * Indeed-hosted "Indeed Apply" job). Pure — no network, and no check that the
 * target is a supported ATS (the caller validates that).
 */
export function extractCompanyApplyUrl(html: unknown): string {
  const source = typeof html === 'string' ? html : '';
  if (!source) return '';

  // 1. Keyed JSON values, e.g.
  //    "thirdPartyApplyUrl":"https:\/\/boards.greenhouse.io\/acme\/jobs\/42"
  for (const key of APPLY_URL_KEYS) {
    const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'g');
    for (const match of source.matchAll(re)) {
      const candidate = normalizeCandidate(match[1]);
      if (candidate && isExternalApplyCandidate(candidate)) return candidate;
    }
  }

  // 2. An apply anchor that points off Indeed.
  const anchorRe = /<a\b[^>]*\bhref\s*=\s*"([^"]+)"[^>]*>/gi;
  for (const match of source.matchAll(anchorRe)) {
    if (!match[0].toLowerCase().includes('apply')) continue;
    const candidate = normalizeCandidate(match[1]);
    if (candidate && isExternalApplyCandidate(candidate)) return candidate;
  }

  return '';
}

export interface ResolveIndeedApplyUrlOptions {
  url: string;
  fetchImpl?: FetchLike;
  /**
   * Returns true when the candidate URL is a supported ATS. Defaults to the
   * detectJobBoard + getAtsSubmitter check. Injectable for tests.
   */
  isSupportedAts?: (candidate: string) => Promise<boolean>;
}

async function defaultIsSupportedAts(candidate: string): Promise<boolean> {
  const [{ detectJobBoard }, { getAtsSubmitter }] = await Promise.all([
    import('../opportunity-source-crawler.js'),
    import('./index.js'),
  ]);
  const detection = await detectJobBoard(candidate).catch(() => null);
  return getAtsSubmitter(detection?.type) !== null;
}

/**
 * Resolve an Indeed posting to its underlying company apply URL when — and only
 * when — that URL is a supported ATS. Returns the resolved URL, or null on any
 * miss (not Indeed, fetch failed/blocked, no external apply link, or an
 * unsupported ATS). Best-effort and side-effect free.
 */
export async function resolveIndeedApplyUrl(
  options: ResolveIndeedApplyUrlOptions,
): Promise<string | null> {
  const url = stringValue(options.url);
  if (!isIndeedUrl(url)) return null;

  const fetchImpl = options.fetchImpl ?? fetch;
  let html = '';
  try {
    const response = await fetchImpl(url, {
      headers: { accept: 'text/html' },
      redirect: 'follow',
    });
    if (!response.ok) return null;
    html = await response.text();
  } catch {
    return null;
  }

  const candidate = extractCompanyApplyUrl(html);
  if (!candidate) return null;

  const isSupportedAts = options.isSupportedAts ?? defaultIsSupportedAts;
  const supported = await isSupportedAts(candidate).catch(() => false);
  return supported ? candidate : null;
}
