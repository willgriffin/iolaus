import type { Experience, Profile, Skills, TailoringConfig } from '@willgriffin/iolaus-resume';
import { access, readdir, readFile, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCollection } from '../src/lib/server/smrt.js';
import {
  CURRENT_RESUME_DIR_PATH,
  CURRENT_RESUME_PDF_BASENAME,
  PUBLISHED_RESUME_PDF_PATH,
  getResumeFilesystem,
} from '../src/lib/server/resume-files.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..');
const DATA_DIR = resolve(REPO_ROOT, 'apps', 'site', 'src', 'lib', 'data');
const TAILORING_DIR = resolve(REPO_ROOT, 'var', 'tailoring');
const CURRENT_RESUME_DIR = resolve(
  REPO_ROOT,
  'var',
  'profile-assets',
  CURRENT_RESUME_DIR_PATH,
);
const CURRENT_RESUME_SOURCE = `var/profile-assets/${CURRENT_RESUME_DIR_PATH}`;
const CURRENT_RESUME_ASSET_ID = 'legacy-current';

type RecordLike = Record<string, unknown> & {
  id?: string;
  save?: () => Promise<void>;
};

type Predicate = (record: RecordLike) => boolean;

export interface ResumeAdminBackfillSummary {
  assets: number;
  education: number;
  links: number;
  otherRoles: number;
  profiles: number;
  achievements: number;
  positions: number;
  skillCategories: number;
  skillGroups: number;
  skills: number;
  tailoringConfigs: number;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf8')) as T;
}

function compactJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}

function joinList(values: string[] | undefined): string {
  return (values ?? []).join('\n');
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function booleanValue(value: unknown): boolean {
  return value === true || value === 'true';
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function upsertRecord(
  className: string,
  predicate: Predicate,
  payload: Record<string, unknown>,
): Promise<RecordLike> {
  const collection = await getCollection(className);
  const records = (await collection.list({ limit: 1000 })) as RecordLike[];
  const existing = records.find(predicate);
  const record = existing ?? ((await collection.create(payload)) as RecordLike);
  Object.assign(record, payload);
  if (typeof record.save !== 'function') {
    throw new Error(`Cannot persist ${className}: record does not expose save().`);
  }
  await record.save();
  return record;
}

async function filesystemPathExists(
  filesystem: Awaited<ReturnType<typeof getResumeFilesystem>>,
  path: string,
) {
  const withExists = filesystem as typeof filesystem & {
    exists?: (path: string) => Promise<boolean>;
  };
  if (typeof withExists.exists === 'function') {
    return await withExists.exists(path);
  }

  try {
    await filesystem.read(path, { raw: true });
    return true;
  } catch {
    return false;
  }
}

async function backfillProfile(profile: Profile): Promise<number> {
  await upsertRecord(
    'ResumeProfile',
    (record) => record.profileKey === 'default',
    {
      active: true,
      email: profile.email,
      name: profile.name,
      profileKey: 'default',
      summary: profile.summary,
      title: profile.title,
    },
  );
  return 1;
}

async function backfillLinks(profile: Profile): Promise<number> {
  let count = 0;
  for (const [index, link] of profile.links.entries()) {
    await upsertRecord(
      'ResumeLink',
      (record) => record.profileKey === 'default' && record.href === link.href,
      {
        href: link.href,
        label: link.label,
        profileKey: 'default',
        sortOrder: index,
      },
    );
    count += 1;
  }
  return count;
}

async function backfillSkills(
  skills: Skills,
): Promise<Pick<ResumeAdminBackfillSummary, 'skillCategories' | 'skillGroups' | 'skills'>> {
  let skillCategories = 0;
  let skillGroups = 0;
  let skillCount = 0;

  for (const [categoryIndex, category] of skills.groups.entries()) {
    await upsertRecord(
      'ResumeSkillCategory',
      (record) => record.categoryId === category.id,
      {
        categoryId: category.id,
        label: category.label,
        sortOrder: categoryIndex,
      },
    );
    skillCategories += 1;

    for (const [skillIndex, skill] of category.skills.entries()) {
      await upsertRecord(
        'ResumeSkill',
        (record) => record.skillId === skill.id && record.categoryId === category.id,
        {
          categoryId: category.id,
          label: skill.label,
          skillId: skill.id,
          sortOrder: categoryIndex * 100 + skillIndex,
        },
      );
      skillCount += 1;
    }
  }

  for (const [index, group] of skills.skillGroups.entries()) {
    await upsertRecord(
      'ResumeSkillGroup',
      (record) => record.groupId === group.id,
      {
        blurb: group.blurb,
        groupId: group.id,
        label: group.label,
        skillIds: joinList(group.skills),
        sortOrder: index,
      },
    );
    skillGroups += 1;
  }

  return { skillCategories, skillGroups, skills: skillCount };
}

async function backfillExperience(
  experience: Experience,
): Promise<Pick<ResumeAdminBackfillSummary, 'achievements' | 'education' | 'otherRoles' | 'positions'>> {
  let achievements = 0;

  for (const [positionIndex, position] of experience.positions.entries()) {
    await upsertRecord(
      'ResumePosition',
      (record) => record.positionId === position.id,
      {
        blurb: position.blurb ?? '',
        company: position.company,
        companyHref: position.companyHref ?? '',
        endLabel: position.end,
        positionId: position.id,
        role: position.role,
        sortOrder: positionIndex,
        start: position.start,
        weight: position.weight ?? 0,
      },
    );

    for (const [achievementIndex, achievement] of position.achievements.entries()) {
      await upsertRecord(
        'ResumeAchievement',
        (record) => record.positionId === position.id && record.title === achievement.title,
        {
          body: achievement.body,
          metric: achievement.metric ?? '',
          positionId: position.id,
          sortOrder: positionIndex * 100 + achievementIndex,
          tags: joinList(achievement.tags),
          title: achievement.title,
        },
      );
      achievements += 1;
    }
  }

  let otherRoles = 0;
  for (const [index, role] of experience.other.entries()) {
    await upsertRecord(
      'ResumeOtherRole',
      (record) =>
        record.role === role.role && record.company === role.company && record.period === role.period,
      {
        body: role.body ?? '',
        company: role.company,
        period: role.period,
        role: role.role,
        sortOrder: index,
        tags: joinList(role.tags),
      },
    );
    otherRoles += 1;
  }

  let education = 0;
  for (const [index, item] of experience.education.entries()) {
    await upsertRecord(
      'ResumeEducation',
      (record) => record.title === item.title && record.institution === (item.institution ?? ''),
      {
        detail: item.detail,
        institution: item.institution ?? '',
        sortOrder: index,
        title: item.title,
      },
    );
    education += 1;
  }

  return {
    achievements,
    education,
    otherRoles,
    positions: experience.positions.length,
  };
}

async function backfillTailoringConfigs(): Promise<number> {
  if (!(await exists(TAILORING_DIR))) return 0;
  const entries = await readdir(TAILORING_DIR);
  let count = 0;

  for (const entry of entries.filter((item) => item.endsWith('.json'))) {
    const slug = entry.replace(/\.json$/, '');
    const config = await readJson<TailoringConfig>(resolve(TAILORING_DIR, entry));
    await upsertRecord(
      'ResumeTailoringConfig',
      (record) => record.configSlug === slug,
      {
        active: true,
        company: config.company ?? '',
        configSlug: slug,
        configJson: compactJson(config),
        name: config.name ?? config.company ?? slug,
      },
    );
    count += 1;
  }

  return count;
}

async function writeCurrentResumeFiles(
  filesystem: Awaited<ReturnType<typeof getResumeFilesystem>>,
  targetDir: string,
): Promise<Date | null> {
  const pdfSourcePath = resolve(CURRENT_RESUME_DIR, CURRENT_RESUME_PDF_BASENAME);
  if (!(await exists(pdfSourcePath))) return null;

  const generatedAt = (await stat(pdfSourcePath)).mtime;
  const files = [
    ['resume.md', `${targetDir}/resume.md`],
    ['resume.txt', `${targetDir}/resume.txt`],
    ['resume.html', `${targetDir}/resume.html`],
    [CURRENT_RESUME_PDF_BASENAME, `${targetDir}/resume.pdf`],
  ] as const;

  for (const [sourceName, targetPath] of files) {
    const sourcePath = resolve(CURRENT_RESUME_DIR, sourceName);
    if (!(await exists(sourcePath))) continue;
    await filesystem.write(targetPath, await readFile(sourcePath), { createParents: true });
  }
  await filesystem.write(PUBLISHED_RESUME_PDF_PATH, await readFile(pdfSourcePath), {
    createParents: true,
  });

  return generatedAt;
}

async function backfillCurrentResumeAsset(): Promise<number> {
  const filesystem = await getResumeFilesystem();
  const targetDir = `generated-resumes/${CURRENT_RESUME_ASSET_ID}`;
  const generatedAt = await writeCurrentResumeFiles(filesystem, targetDir);
  if (!generatedAt) return 0;

  await upsertRecord(
    'ResumeAsset',
    (record) => record.sourcePath === CURRENT_RESUME_SOURCE,
    {
      assetType: 'resume',
      generatedAt,
      generatedPath: targetDir,
      htmlPath: `${targetDir}/resume.html`,
      isPublished: true,
      markdownPath: `${targetDir}/resume.md`,
      notes: 'Backfilled from the current generated resume artifact.',
      outputSlug: '',
      pdfBasename: CURRENT_RESUME_PDF_BASENAME,
      pdfPath: `${targetDir}/resume.pdf`,
      publishedAt: new Date(),
      sourcePath: CURRENT_RESUME_SOURCE,
      status: 'published',
      textPath: `${targetDir}/resume.txt`,
      title: 'Resume - canonical',
    },
  );

  return 1;
}

export async function ensurePublishedCurrentResumeAssetFiles(): Promise<number> {
  const collection = await getCollection('ResumeAsset');
  const records = (await collection.list({ limit: 1000 })) as RecordLike[];
  const current = records.find(
    (record) =>
      stringValue(record.id) === CURRENT_RESUME_ASSET_ID ||
      stringValue(record.sourcePath) === CURRENT_RESUME_SOURCE,
  );

  if (!current || !booleanValue(current.isPublished)) {
    return 0;
  }

  const targetDir =
    stringValue(current.generatedPath) || `generated-resumes/${CURRENT_RESUME_ASSET_ID}`;
  const pdfPath = stringValue(current.pdfPath) || `${targetDir}/resume.pdf`;
  const filesystem = await getResumeFilesystem();
  const [hasPublishedAlias, hasAssetPdf] = await Promise.all([
    filesystemPathExists(filesystem, PUBLISHED_RESUME_PDF_PATH),
    filesystemPathExists(filesystem, pdfPath),
  ]);

  if (hasPublishedAlias && hasAssetPdf) {
    return 0;
  }

  const generatedAt = await writeCurrentResumeFiles(filesystem, targetDir);
  if (!generatedAt) return 0;

  Object.assign(current, {
    generatedPath: targetDir,
    htmlPath: `${targetDir}/resume.html`,
    markdownPath: `${targetDir}/resume.md`,
    pdfBasename: CURRENT_RESUME_PDF_BASENAME,
    pdfPath: `${targetDir}/resume.pdf`,
    textPath: `${targetDir}/resume.txt`,
  });
  if (typeof current.save !== 'function') {
    throw new Error('Cannot persist ResumeAsset: record does not expose save().');
  }
  await current.save();

  return 1;
}

export async function backfillResumeAdmin(): Promise<ResumeAdminBackfillSummary> {
  const [profile, experience, skills] = await Promise.all([
    readJson<Profile>(resolve(DATA_DIR, 'profile.json')),
    readJson<Experience>(resolve(DATA_DIR, 'experience.json')),
    readJson<Skills>(resolve(DATA_DIR, 'skills.json')),
  ]);
  const skillSummary = await backfillSkills(skills);
  const experienceSummary = await backfillExperience(experience);

  return {
    assets: await backfillCurrentResumeAsset(),
    profiles: await backfillProfile(profile),
    links: await backfillLinks(profile),
    tailoringConfigs: await backfillTailoringConfigs(),
    ...skillSummary,
    ...experienceSummary,
  };
}

export function formatResumeAdminBackfillSummary(summary: ResumeAdminBackfillSummary): string {
  return [
    'Resume admin backfill applied:',
    `- profiles: ${summary.profiles}`,
    `- links: ${summary.links}`,
    `- skill categories: ${summary.skillCategories}`,
    `- skills: ${summary.skills}`,
    `- skill groups: ${summary.skillGroups}`,
    `- positions: ${summary.positions}`,
    `- achievements: ${summary.achievements}`,
    `- other roles: ${summary.otherRoles}`,
    `- education: ${summary.education}`,
    `- tailoring configs: ${summary.tailoringConfigs}`,
    `- assets: ${summary.assets}`,
  ].join('\n');
}
