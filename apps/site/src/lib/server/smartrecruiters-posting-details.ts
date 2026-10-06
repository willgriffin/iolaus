type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;
type ToPlainText = (value: unknown) => string;
type RecordValue = Record<string, unknown>;

export type SmartRecruitersDetailResult =
  | {
      status: 'not_found' | 'unsupported';
      provider: 'smartrecruiters';
      message: string;
    }
  | {
      status: 'resolved';
      provider: 'smartrecruiters';
      message: string;
      canonicalUrl: string;
      externalId: string;
      title: string;
      companyName: string;
      descriptionRaw: string;
      qualifications?: string;
      responsibilities: string;
      locations: string[];
      locationNotes: string;
      postedAt: Date | null;
      employmentType?: string;
      workMode: 'remote' | 'hybrid' | 'onsite' | 'unknown';
      /** Direct public API facts, not an inferred verification/lifecycle flag. */
      sourceEvidence: {
        apiUrl: string;
        requestedPostingUrl: string;
        apiPostingUrl?: string;
        active: true;
        visibility: 'PUBLIC';
        remote?: boolean;
        hybrid?: boolean;
      };
    };

function record(value: unknown): RecordValue {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as RecordValue)
    : {};
}
function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
function postingTarget(url: URL): { company: string; id: string } | null {
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'jobs.smartrecruiters.com' ||
    url.username ||
    url.password ||
    url.port
  )
    return null;
  const match = url.pathname.match(
    /^\/([A-Za-z0-9_-]{1,100})\/(\d{5,30})(?:-[^/]*)?\/?$/,
  );
  return match ? { company: match[1], id: match[2] } : null;
}
export function isSmartRecruitersPostingUrl(url: URL): boolean {
  return Boolean(postingTarget(url));
}
function refusal(
  status: 'not_found' | 'unsupported',
  message: string,
): SmartRecruitersDetailResult {
  return { status, provider: 'smartrecruiters', message };
}
function employmentType(value: unknown): string | undefined {
  const label = text(record(value).label).toLowerCase().replace(/[-_]/g, ' ');
  if (label === 'full time') return 'full_time';
  if (label === 'part time') return 'fractional';
  if (label === 'contract') return 'contract';
  return undefined;
}
function workMode(
  location: RecordValue,
  fields: unknown,
  body: string,
): 'remote' | 'hybrid' | 'onsite' | 'unknown' {
  const modes = new Set<'remote' | 'hybrid' | 'onsite'>();
  if (location.remote === true) modes.add('remote');
  if (location.hybrid === true) modes.add('hybrid');
  if (Array.isArray(fields)) {
    for (const entry of fields) {
      const field = record(entry);
      if (text(field.fieldLabel).toLowerCase() !== 'role type') continue;
      const label = text(field.valueLabel).toLowerCase();
      if (label === 'remote') modes.add('remote');
      if (label === 'hybrid') modes.add('hybrid');
      if (['on-site', 'onsite', 'on site'].includes(label)) modes.add('onsite');
    }
  }
  if (/\bfully\s+remote\b|#LI-Remote\b/i.test(body)) modes.add('remote');
  return modes.size === 1 ? [...modes][0] : 'unknown';
}

/**
 * Capture one identity-bound official posting. The existing detail dispatcher
 * supplies its shared HTML text conversion; this helper has no AI or write path.
 */
export async function resolveSmartRecruitersPosting(
  url: URL,
  fetchImpl: FetchLike,
  toPlainText: ToPlainText,
): Promise<SmartRecruitersDetailResult> {
  const target = postingTarget(url);
  if (!target)
    return refusal(
      'unsupported',
      'Not an official SmartRecruiters posting URL.',
    );
  const requestedPostingUrl = `${url.origin}${url.pathname.replace(/\/$/, '')}`;
  const apiUrl = `https://api.smartrecruiters.com/v1/companies/${encodeURIComponent(target.company)}/postings/${target.id}`;
  let payload: RecordValue;
  try {
    const response = await fetchImpl(apiUrl, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      return refusal(
        response.status === 404 || response.status === 410
          ? 'not_found'
          : 'unsupported',
        `Official SmartRecruiters posting API returned HTTP ${response.status}.`,
      );
    if (
      response.url &&
      new URL(response.url).origin !== 'https://api.smartrecruiters.com'
    )
      return refusal(
        'unsupported',
        'Official SmartRecruiters API redirected outside its origin.',
      );
    payload = record(await response.json());
  } catch {
    return refusal(
      'unsupported',
      'Could not capture the official SmartRecruiters posting API.',
    );
  }
  const company = record(payload.company);
  if (
    text(payload.id) !== target.id ||
    (company.identifier !== undefined &&
      text(company.identifier).toLowerCase() !== target.company.toLowerCase())
  )
    return refusal(
      'unsupported',
      'SmartRecruiters response does not match the requested posting identity.',
    );
  if (
    payload.active === false ||
    ['PRIVATE', 'INTERNAL'].includes(text(payload.visibility))
  )
    return refusal(
      'not_found',
      'The official SmartRecruiters posting is not active and public.',
    );
  if (payload.active !== true || payload.visibility !== 'PUBLIC')
    return refusal(
      'unsupported',
      'The official SmartRecruiters posting has unknown publication state.',
    );
  const title = text(payload.name);
  const companyName = text(company.name);
  const sections = record(record(payload.jobAd).sections);
  const responsibilities = toPlainText(
    record(sections.jobDescription).text,
  ).trim();
  if (!title || !companyName || responsibilities.length < 160)
    return refusal(
      'unsupported',
      'SmartRecruiters did not provide a meaningful identity-bound job description.',
    );
  const qualifications = toPlainText(
    record(sections.qualifications).text,
  ).trim();
  const descriptionRaw = [
    ['companyDescription', 'Company description'],
    ['jobDescription', 'Job description'],
    ['qualifications', 'Qualifications'],
    ['additionalInformation', 'Additional information'],
  ]
    .map(([key, fallback]) => {
      const section = record(sections[key]);
      const body = toPlainText(section.text).trim();
      return body ? `${text(section.title) || fallback}\n${body}` : '';
    })
    .filter(Boolean)
    .join('\n\n');
  if (descriptionRaw.length > 200_000)
    return refusal(
      'unsupported',
      'SmartRecruiters posting exceeds the bounded capture size.',
    );
  const location = record(payload.location);
  const locationText =
    text(location.fullLocation) ||
    [
      ...new Set(
        [location.city, location.region, location.country]
          .map(text)
          .filter(Boolean),
      ),
    ].join(', ');
  const mode = workMode(location, payload.customField, descriptionRaw);
  const date = text(payload.releasedDate)
    ? new Date(text(payload.releasedDate))
    : null;
  const apiPostingUrl = text(payload.postingUrl);
  let safeApiPostingUrl: string | undefined;
  try {
    const reported = new URL(apiPostingUrl);
    if (
      postingTarget(reported)?.company.toLowerCase() ===
      target.company.toLowerCase()
    )
      safeApiPostingUrl = reported.toString();
  } catch {
    /* Optional alias is not authority for the requested posting. */
  }
  return {
    canonicalUrl: requestedPostingUrl,
    externalId: target.id,
    title,
    companyName,
    descriptionRaw,
    qualifications: qualifications || undefined,
    responsibilities,
    locations: locationText ? [locationText] : [],
    locationNotes: [
      locationText,
      ...(mode === 'unknown' &&
      location.hybrid === true &&
      /\bfully\s+remote\b|#LI-Remote\b/i.test(descriptionRaw)
        ? ['Work-mode conflict: structured Hybrid; posting says fully remote.']
        : []),
    ]
      .filter(Boolean)
      .join('; '),
    postedAt: date && Number.isFinite(date.getTime()) ? date : null,
    employmentType: employmentType(payload.typeOfEmployment),
    workMode: mode,
    provider: 'smartrecruiters',
    status: 'resolved',
    message:
      'Captured substantive active public SmartRecruiters posting details from its official API.',
    sourceEvidence: {
      apiUrl,
      requestedPostingUrl,
      ...(safeApiPostingUrl ? { apiPostingUrl: safeApiPostingUrl } : {}),
      active: true,
      visibility: 'PUBLIC',
      ...(typeof location.remote === 'boolean'
        ? { remote: location.remote }
        : {}),
      ...(typeof location.hybrid === 'boolean'
        ? { hybrid: location.hybrid }
        : {}),
    },
  };
}
