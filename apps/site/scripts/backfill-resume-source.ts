import type { Experience, Profile, Skills, TailoringConfig } from '@willgriffin/iolaus-resume';
import { TagCollection } from '@happyvertical/smrt-tags';
import { getSmrtOptions } from '../src/lib/server/db.js';
import { getCollection } from '../src/lib/server/smrt.js';
import { loadLegacyAdminResumeSource, loadLegacyResumeSource } from '../src/lib/server/resume-data.js';

type RecordLike = Record<string, unknown> & {
  id?: string;
  save?: () => Promise<void>;
};

type Predicate = (record: RecordLike) => boolean;

export interface ResumeSourceBackfillSummary {
  achievements: number;
  companies: number;
  compactExperience: number;
  duties: number;
  education: number;
  experience: number;
  experienceCompanies: number;
  experienceRoles: number;
  profileLinks: number;
  profiles: number;
  projects: number;
  roleTags: number;
  roles: number;
  skillCategories: number;
  skillCategoryMembers: number;
  skillGroups: number;
  skillGroupMembers: number;
  tags: number;
}

interface ParsedDate {
  date: Date | null;
  precision: 'day' | 'month' | 'year' | 'present';
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function compactJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
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

function parseDateLabel(value: string, isEnd = false): ParsedDate {
  const label = value.trim();
  if (!label || /^present|current|now$/i.test(label)) {
    return { date: null, precision: isEnd ? 'present' : 'year' };
  }

  const monthMatch = label.match(/^([A-Za-z]{3,9})\s+(\d{4})$/);
  if (monthMatch) {
    const month = new Date(`${monthMatch[1]} 1, 2000`).getUTCMonth();
    return {
      date: new Date(Date.UTC(Number(monthMatch[2]), month, 1)),
      precision: 'month',
    };
  }

  const yearMatch = label.match(/\b(\d{4})\b/);
  if (yearMatch) {
    return {
      date: new Date(Date.UTC(Number(yearMatch[1]), 0, 1)),
      precision: 'year',
    };
  }

  const parsed = new Date(label);
  return Number.isNaN(parsed.getTime())
    ? { date: null, precision: isEnd ? 'present' : 'year' }
    : { date: parsed, precision: 'day' };
}

function parsePeriod(period: string): { start: ParsedDate; end: ParsedDate } {
  const parts = period.split(/\s*[–-]\s*/);
  return {
    start: parseDateLabel(parts[0] ?? ''),
    end: parseDateLabel(parts[1] ?? '', true),
  };
}

async function ensureSkillTag(tagId: string, label?: string): Promise<string> {
  if (!tagId) throw new Error('A skill tag slug is required.');
  const tags = await TagCollection.create(getSmrtOptions());
  const tag = await tags.getOrCreate(tagId, 'skill');
  if (label) tag.name = label;
  await tag.save();
  if (!tag.id) throw new Error(`SMRT tag ${tagId} did not receive an ID.`);
  return tag.id;
}

async function backfillProfile(profile: Profile): Promise<Pick<ResumeSourceBackfillSummary, 'profiles' | 'profileLinks'>> {
  await upsertRecord(
    'CandidateProfile',
    (record) => record.profileKey === 'default',
    {
      active: true,
      email: profile.email,
      isDefault: true,
      name: profile.name,
      profileKey: 'default',
      summary: profile.summary,
      title: profile.title,
    },
  );

  let profileLinks = 0;
  for (const [index, link] of profile.links.entries()) {
    await upsertRecord(
      'CandidateProfileLink',
      (record) => record.profileKey === 'default' && record.href === link.href,
      {
        href: link.href,
        label: link.label,
        profileKey: 'default',
        sortOrder: index,
      },
    );
    profileLinks += 1;
  }

  return { profiles: 1, profileLinks };
}

async function backfillSkills(
  skills: Skills,
): Promise<Pick<ResumeSourceBackfillSummary, 'skillCategories' | 'skillCategoryMembers' | 'skillGroups' | 'skillGroupMembers' | 'tags'>> {
  let skillCategories = 0;
  let skillCategoryMembers = 0;
  let skillGroups = 0;
  let skillGroupMembers = 0;
  let tags = 0;

  for (const [categoryIndex, category] of skills.groups.entries()) {
    const categoryRecord = await upsertRecord(
      'SkillCategory',
      (record) => record.categoryKey === category.id,
      {
        categoryKey: category.id,
        label: category.label,
        sortOrder: categoryIndex,
      },
    );
    skillCategories += 1;

    for (const [skillIndex, skill] of category.skills.entries()) {
      const canonicalTagId = await ensureSkillTag(skill.id, skill.label);
      tags += 1;
      await upsertRecord(
        'SkillCategoryMember',
        (record) =>
          record.categoryId === categoryRecord.id &&
          (record.tagId === canonicalTagId || record.tagId === skill.id),
        {
          categoryId: categoryRecord.id,
          label: skill.label,
          sortOrder: categoryIndex * 100 + skillIndex,
          tagId: canonicalTagId,
        },
      );
      skillCategoryMembers += 1;
    }
  }

  for (const [groupIndex, group] of skills.skillGroups.entries()) {
    const groupRecord = await upsertRecord(
      'SkillGroup',
      (record) => record.groupKey === group.id,
      {
        blurb: group.blurb,
        groupKey: group.id,
        label: group.label,
        sortOrder: groupIndex,
      },
    );
    skillGroups += 1;

    for (const [skillIndex, skillId] of group.skills.entries()) {
      const canonicalTagId = await ensureSkillTag(skillId);
      tags += 1;
      await upsertRecord(
        'SkillGroupMember',
        (record) =>
          record.groupId === groupRecord.id &&
          (record.tagId === canonicalTagId || record.tagId === skillId),
        {
          groupId: groupRecord.id,
          sortOrder: groupIndex * 100 + skillIndex,
          tagId: canonicalTagId,
        },
      );
      skillGroupMembers += 1;
    }
  }

  return { skillCategories, skillCategoryMembers, skillGroups, skillGroupMembers, tags };
}

async function upsertCompany(name: string, websiteUrl = ''): Promise<RecordLike> {
  const companyKey = slugify(name);
  return await upsertRecord(
    'Company',
    (record) => record.companyKey === companyKey || record.name === name,
    {
      companyKey,
      name,
      websiteUrl,
    },
  );
}

async function upsertRole(label: string): Promise<RecordLike> {
  const slug = slugify(label);
  return await upsertRecord(
    'EmploymentRole',
    (record) => record.roleSlug === slug || record.label === label,
    {
      label,
      roleKey: slug,
      roleSlug: slug,
    },
  );
}

async function backfillAchievementTags(achievementId: string, tags: string[] | undefined): Promise<number> {
  let count = 0;
  for (const tagId of tags ?? []) {
    const canonicalTagId = await ensureSkillTag(tagId);
    await upsertRecord(
      'AchievementTag',
      (record) =>
        record.achievementId === achievementId &&
        (record.tagId === canonicalTagId || record.tagId === tagId),
      {
        achievementId,
        tagId: canonicalTagId,
        tagRole: 'skill',
      },
    );
    count += 1;
  }
  return count;
}

async function backfillExperience(experience: Experience): Promise<Pick<ResumeSourceBackfillSummary, 'achievements' | 'companies' | 'compactExperience' | 'duties' | 'education' | 'experience' | 'experienceCompanies' | 'experienceRoles' | 'projects' | 'roleTags' | 'roles'>> {
  let achievements = 0;
  let companies = 0;
  let compactExperience = 0;
  let education = 0;
  let experienceCount = 0;
  let experienceCompanies = 0;
  let experienceRoles = 0;
  let roleTags = 0;
  let roles = 0;
  const compactExperienceIds: string[] = [];

  for (const [positionIndex, position] of experience.positions.entries()) {
    const start = parseDateLabel(position.start);
    const end = parseDateLabel(position.end, true);
    const experienceRecord = await upsertRecord(
      'Experience',
      (record) => record.experienceKey === position.id,
      {
        endDate: end.date,
        endPrecision: end.precision,
        experienceKey: position.id,
        sortOrder: positionIndex,
        startDate: start.date,
        startPrecision: start.precision,
        summary: position.blurb ?? '',
        weight: position.weight ?? 0,
      },
    );
    experienceCount += 1;

    const company = await upsertCompany(position.company, position.companyHref ?? '');
    companies += 1;
    await upsertRecord(
      'ExperienceCompany',
      (record) => record.experienceId === experienceRecord.id && record.companyId === company.id,
      {
        companyHrefSnapshot: position.companyHref ?? '',
        companyId: company.id,
        companyNameSnapshot: position.company,
        experienceId: experienceRecord.id,
        isPrimary: true,
        relationship: 'employer',
        sortOrder: positionIndex,
      },
    );
    experienceCompanies += 1;

    const role = await upsertRole(position.role);
    roles += 1;
    await upsertRecord(
      'ExperienceRole',
      (record) => record.experienceId === experienceRecord.id && record.roleId === role.id,
      {
        endDate: end.date,
        endPrecision: end.precision,
        experienceId: experienceRecord.id,
        isPrimary: true,
        roleId: role.id,
        sortOrder: 0,
        startDate: start.date,
        startPrecision: start.precision,
        summary: '',
        titleSnapshot: position.role,
      },
    );
    experienceRoles += 1;

    for (const [achievementIndex, achievement] of position.achievements.entries()) {
      const achievementRecord = await upsertRecord(
        'Achievement',
        (record) => record.experienceId === experienceRecord.id && record.title === achievement.title,
        {
          body: achievement.body,
          experienceId: experienceRecord.id,
          metric: achievement.metric ?? '',
          projectId: '',
          sortOrder: positionIndex * 100 + achievementIndex,
          title: achievement.title,
        },
      );
      achievements += 1;
      roleTags += await backfillAchievementTags(String(achievementRecord.id ?? ''), achievement.tags);
    }
  }

  for (const [index, role] of experience.other.entries()) {
    const key = `other-${slugify(`${role.role}-${role.company}-${role.period}`)}`;
    const period = parsePeriod(role.period);
    const experienceRecord = await upsertRecord(
      'Experience',
      (record) => record.experienceKey === key,
      {
        endDate: period.end.date,
        endPrecision: period.end.precision,
        experienceKey: key,
        sortOrder: experience.positions.length + index,
        startDate: period.start.date,
        startPrecision: period.start.precision,
        summary: role.body ?? '',
        weight: 0,
      },
    );
    compactExperienceIds.push(key);
    compactExperience += 1;
    experienceCount += 1;

    const company = await upsertCompany(role.company);
    companies += 1;
    await upsertRecord(
      'ExperienceCompany',
      (record) => record.experienceId === experienceRecord.id && record.companyId === company.id,
      {
        companyId: company.id,
        companyNameSnapshot: role.company,
        experienceId: experienceRecord.id,
        isPrimary: true,
        relationship: 'employer',
        sortOrder: 0,
      },
    );
    experienceCompanies += 1;

    const roleRecord = await upsertRole(role.role);
    roles += 1;
    await upsertRecord(
      'ExperienceRole',
      (record) => record.experienceId === experienceRecord.id && record.roleId === roleRecord.id,
      {
        endDate: period.end.date,
        endPrecision: period.end.precision,
        experienceId: experienceRecord.id,
        isPrimary: true,
        roleId: roleRecord.id,
        sortOrder: 0,
        startDate: period.start.date,
        startPrecision: period.start.precision,
        titleSnapshot: role.role,
      },
    );
    experienceRoles += 1;

    for (const tagId of role.tags ?? []) {
      const canonicalTagId = await ensureSkillTag(tagId);
      await upsertRecord(
        'ExperienceTag',
        (record) =>
          record.experienceId === experienceRecord.id &&
          (record.tagId === canonicalTagId || record.tagId === tagId),
        {
          experienceId: experienceRecord.id,
          tagId: canonicalTagId,
          tagRole: 'skill',
        },
      );
      roleTags += 1;
    }
  }

  for (const [index, item] of experience.education.entries()) {
    await upsertRecord(
      'Education',
      (record) => record.title === item.title && record.institution === (item.institution ?? ''),
      {
        detail: item.detail,
        institution: item.institution ?? '',
        profileKey: 'default',
        sortOrder: index,
        title: item.title,
      },
    );
    education += 1;
  }

  await upsertCanonicalCompactConfig(compactExperienceIds);

  return {
    achievements,
    companies,
    compactExperience,
    duties: 0,
    education,
    experience: experienceCount,
    experienceCompanies,
    experienceRoles,
    projects: 0,
    roleTags,
    roles,
  };
}

async function upsertCanonicalCompactConfig(compactExperienceIds: string[]): Promise<void> {
  if (compactExperienceIds.length === 0) return;
  const collection = await getCollection('ResumeTailoringConfig');
  const records = (await collection.list({ limit: 1000 })) as RecordLike[];
  const existing = records.find((record) => record.configSlug === 'canonical');
  let config: TailoringConfig = {};
  if (typeof existing?.configJson === 'string') {
    try {
      config = JSON.parse(existing.configJson) as TailoringConfig;
    } catch {
      config = {};
    }
  }
  config.compactExperienceIds = Array.from(
    new Set([...(config.compactExperienceIds ?? []), ...compactExperienceIds]),
  );

  await upsertRecord(
    'ResumeTailoringConfig',
    (record) => record.configSlug === 'canonical',
    {
      active: true,
      company: '',
      configJson: compactJson(config),
      configSlug: 'canonical',
      name: existing?.name ?? 'Canonical resume',
    },
  );
}

export async function backfillResumeSource(): Promise<ResumeSourceBackfillSummary> {
  const source = (await loadLegacyAdminResumeSource()) ?? loadLegacyResumeSource();
  const profileSummary = await backfillProfile(source.profile as Profile);
  const skillSummary = await backfillSkills(source.skills as Skills);
  const experienceSummary = await backfillExperience(source.experience as Experience);

  return {
    ...profileSummary,
    ...skillSummary,
    ...experienceSummary,
  };
}

export function formatResumeSourceBackfillSummary(summary: ResumeSourceBackfillSummary): string {
  return [
    'Resume source backfill applied:',
    `- profiles: ${summary.profiles}`,
    `- profile links: ${summary.profileLinks}`,
    `- skill categories: ${summary.skillCategories}`,
    `- skill category members: ${summary.skillCategoryMembers}`,
    `- skill groups: ${summary.skillGroups}`,
    `- skill group members: ${summary.skillGroupMembers}`,
    `- SMRT skill tags touched: ${summary.tags}`,
    `- companies: ${summary.companies}`,
    `- roles: ${summary.roles}`,
    `- experience: ${summary.experience}`,
    `- compact experience: ${summary.compactExperience}`,
    `- experience companies: ${summary.experienceCompanies}`,
    `- experience roles: ${summary.experienceRoles}`,
    `- projects: ${summary.projects}`,
    `- duties: ${summary.duties}`,
    `- achievements: ${summary.achievements}`,
    `- tag joins: ${summary.roleTags}`,
    `- education: ${summary.education}`,
  ].join('\n');
}
