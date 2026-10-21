/**
 * Shared, untrusted JSON structures carried through resume-import review.
 * They remain text fields at the transport boundary so the import proposal is
 * serializable, but each reader must use these bounded parsers before use.
 */
export const RESUME_IMPORT_STRUCTURE_MAX_BYTES = 512 * 1024;

export type ResumeImportBulletSection = {
  title: string;
  bullets: string[];
};

export type ResumeImportSkillEvidenceDepth =
  | 'hands_on'
  | 'leadership'
  | 'mentioned';

/** Explicit usage dates. These are deliberately distinct from role dates. */
export type ResumeImportSkillEvidence = {
  proposalExperienceId: string;
  usage: string;
  depth: ResumeImportSkillEvidenceDepth;
  quote: string;
  page: number;
  startDate?: string;
  endDate?: string;
};

/**
 * Private, server-enriched skill evidence stored on SkillGroup.evidenceJson.
 * `experienceId` is absent when the referenced proposal role was skipped.
 */
export type ResumeImportStoredSkillEvidence = ResumeImportSkillEvidence & {
  experienceId?: string;
  company?: string;
  role?: string;
  roleStartDate?: string;
  roleEndDate?: string;
};

export class ResumeImportStructureError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResumeImportStructureError';
  }
}

function text(value: unknown, label: string, limit = 20_000): string {
  if (typeof value !== 'string')
    throw new ResumeImportStructureError(`${label} must be text.`);
  const result = value.trim();
  if (!result) throw new ResumeImportStructureError(`${label} is required.`);
  if (result.length > limit)
    throw new ResumeImportStructureError(`${label} is too long.`);
  return result;
}

function optionalText(value: unknown, label: string, limit = 20_000) {
  if (value === undefined) return undefined;
  return text(value, label, limit);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new ResumeImportStructureError(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function onlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
) {
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new ResumeImportStructureError(`${label} has unknown fields.`);
}

function proposalId(value: unknown, label: string) {
  const id = text(value, label, 160);
  if ([...id].some((character) => character.charCodeAt(0) < 32))
    throw new ResumeImportStructureError(`${label} is invalid.`);
  return id;
}

function date(value: unknown, label: string) {
  const result = text(value, label, 10);
  if (!/^\d{4}(?:-\d{2}(?:-\d{2})?)?$/u.test(result))
    throw new ResumeImportStructureError(
      `${label} must be YYYY, YYYY-MM, or YYYY-MM-DD.`,
    );
  const match = result.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/u);
  if (!match) throw new ResumeImportStructureError(`${label} is invalid.`);
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = monthText ? Number(monthText) : 1;
  const day = dayText ? Number(dayText) : 1;
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  )
    throw new ResumeImportStructureError(`${label} is not a calendar date.`);
  return result;
}

function parseJson(value: string, label: string): unknown {
  if (
    new TextEncoder().encode(value).byteLength >
    RESUME_IMPORT_STRUCTURE_MAX_BYTES
  )
    throw new ResumeImportStructureError(`${label} is too large.`);
  try {
    return JSON.parse(value) as unknown;
  } catch {
    throw new ResumeImportStructureError(`${label} must be valid JSON.`);
  }
}

export function parseResumeImportBulletSections(
  value: string,
): ResumeImportBulletSection[] {
  const parsed = parseJson(value, 'Bullet sections');
  if (!Array.isArray(parsed))
    throw new ResumeImportStructureError('Bullet sections must be an array.');
  if (parsed.length > 100)
    throw new ResumeImportStructureError('Too many bullet sections.');
  return parsed.map((entry, index) => {
    const section = object(entry, `Bullet section ${index + 1}`);
    onlyKeys(section, ['title', 'bullets'], `Bullet section ${index + 1}`);
    if (!Array.isArray(section.bullets) || !section.bullets.length)
      throw new ResumeImportStructureError(
        `Bullet section ${index + 1} needs bullets.`,
      );
    if (section.bullets.length > 100)
      throw new ResumeImportStructureError(
        `Bullet section ${index + 1} has too many bullets.`,
      );
    return {
      title: text(section.title, `Bullet section ${index + 1} title`, 1_200),
      bullets: section.bullets.map((bullet, bulletIndex) =>
        text(
          bullet,
          `Bullet section ${index + 1} bullet ${bulletIndex + 1}`,
          1_200,
        ),
      ),
    };
  });
}

function parseSkillEvidence(
  entry: unknown,
  index: number,
): ResumeImportSkillEvidence {
  const evidence = object(entry, `Skill evidence ${index + 1}`);
  onlyKeys(
    evidence,
    [
      'proposalExperienceId',
      'usage',
      'depth',
      'quote',
      'page',
      'startDate',
      'endDate',
    ],
    `Skill evidence ${index + 1}`,
  );
  if (
    evidence.depth !== 'hands_on' &&
    evidence.depth !== 'leadership' &&
    evidence.depth !== 'mentioned'
  )
    throw new ResumeImportStructureError(
      `Skill evidence ${index + 1} depth is invalid.`,
    );
  if (!Number.isInteger(evidence.page) || (evidence.page as number) < 1)
    throw new ResumeImportStructureError(
      `Skill evidence ${index + 1} page is invalid.`,
    );
  return {
    proposalExperienceId: proposalId(
      evidence.proposalExperienceId,
      `Skill evidence ${index + 1} proposal experience ID`,
    ),
    usage: text(evidence.usage, `Skill evidence ${index + 1} usage`, 4_000),
    depth: evidence.depth,
    quote: text(evidence.quote, `Skill evidence ${index + 1} quote`, 8_000),
    page: evidence.page as number,
    ...(evidence.startDate === undefined
      ? {}
      : {
          startDate: date(
            evidence.startDate,
            `Skill evidence ${index + 1} start date`,
          ),
        }),
    ...(evidence.endDate === undefined
      ? {}
      : {
          endDate: date(
            evidence.endDate,
            `Skill evidence ${index + 1} end date`,
          ),
        }),
  };
}

export function parseResumeImportSkillEvidence(
  value: string,
): ResumeImportSkillEvidence[] {
  const parsed = parseJson(value, 'Skill evidence');
  if (!Array.isArray(parsed))
    throw new ResumeImportStructureError('Skill evidence must be an array.');
  if (parsed.length > 200)
    throw new ResumeImportStructureError(
      'Too many skill evidence observations.',
    );
  return parsed.map(parseSkillEvidence);
}

export function parseResumeImportStoredSkillEvidence(
  value: string,
): ResumeImportStoredSkillEvidence[] {
  const parsed = parseJson(value, 'Stored skill evidence');
  if (!Array.isArray(parsed))
    throw new ResumeImportStructureError(
      'Stored skill evidence must be an array.',
    );
  if (parsed.length > 2_000)
    throw new ResumeImportStructureError(
      'Too many stored skill evidence observations.',
    );
  return parsed.map((entry, index) => {
    const evidence = object(entry, `Stored skill evidence ${index + 1}`);
    onlyKeys(
      evidence,
      [
        'proposalExperienceId',
        'usage',
        'depth',
        'quote',
        'page',
        'startDate',
        'endDate',
        'experienceId',
        'company',
        'role',
        'roleStartDate',
        'roleEndDate',
      ],
      `Stored skill evidence ${index + 1}`,
    );
    const base = parseSkillEvidence(
      Object.fromEntries(
        [
          'proposalExperienceId',
          'usage',
          'depth',
          'quote',
          'page',
          'startDate',
          'endDate',
        ]
          .filter((key) => evidence[key] !== undefined)
          .map((key) => [key, evidence[key]]),
      ),
      index,
    );
    return {
      ...base,
      ...(evidence.experienceId === undefined
        ? {}
        : {
            experienceId: proposalId(
              evidence.experienceId,
              `Stored skill evidence ${index + 1} experience ID`,
            ),
          }),
      ...(evidence.company === undefined
        ? {}
        : {
            company: optionalText(
              evidence.company,
              `Stored skill evidence ${index + 1} company`,
              240,
            ),
          }),
      ...(evidence.role === undefined
        ? {}
        : {
            role: optionalText(
              evidence.role,
              `Stored skill evidence ${index + 1} role`,
              240,
            ),
          }),
      ...(evidence.roleStartDate === undefined
        ? {}
        : {
            roleStartDate: date(
              evidence.roleStartDate,
              `Stored skill evidence ${index + 1} role start date`,
            ),
          }),
      ...(evidence.roleEndDate === undefined
        ? {}
        : {
            roleEndDate: date(
              evidence.roleEndDate,
              `Stored skill evidence ${index + 1} role end date`,
            ),
          }),
    };
  });
}

export function stringifyResumeImportStructure(value: unknown): string {
  const result = JSON.stringify(value);
  if (
    new TextEncoder().encode(result).byteLength >
    RESUME_IMPORT_STRUCTURE_MAX_BYTES
  )
    throw new ResumeImportStructureError(
      'Resume import structure is too large.',
    );
  return result;
}
