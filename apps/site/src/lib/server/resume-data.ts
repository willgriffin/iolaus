import { createHash } from 'node:crypto';
import {
  executeCollectionReadPlan,
  type SmrtCollectionReadPlan,
} from '@happyvertical/smrt-core';
import { getCurrentTenant } from '@happyvertical/smrt-tenancy';
import {
  getCurrentSessionPermissionContext,
  getRequestScopedDatabase,
} from '@happyvertical/smrt-users';
import type {
  Achievement,
  Duty,
  Education,
  Experience,
  OtherRole,
  Position,
  Profile,
  Project,
  ResumeAttachment,
  ResumeSource,
  Skill,
  SkillCategory,
  SkillGroup,
  Skills,
  TailoringConfig,
} from '@willgriffin/iolaus-resume';
import experienceData from '../data/experience.json';
import profileData from '../data/profile.json';
import skillsData from '../data/skills.json';
import { getDbConfig } from './db.js';
import {
  LEGACY_RESUME_READ_PLAN,
  NORMALIZED_RESUME_READ_PLAN,
} from './resume-read-plans.js';
import {
  loadPublishedResumeStamp,
  type ResumeStampDatabase,
} from './resume-stamp.js';
import { getCollection, getRequestScopedSmrtOptions } from './smrt.js';
import { createStampedCache, type StampedResult } from './ssr-cache.js';

export type ResumeRecord = Record<string, unknown> & { id?: string };

export interface ResumeSourceRecords {
  achievements: ResumeRecord[];
  achievementAttachments: ResumeRecord[];
  achievementTags: ResumeRecord[];
  attachments: ResumeRecord[];
  companies: ResumeRecord[];
  companyAttachments: ResumeRecord[];
  duties: ResumeRecord[];
  dutyTags: ResumeRecord[];
  education: ResumeRecord[];
  educationTags: ResumeRecord[];
  experienceCompanies: ResumeRecord[];
  experienceRoles: ResumeRecord[];
  experienceTags: ResumeRecord[];
  experiences: ResumeRecord[];
  otherRoles: ResumeRecord[];
  profileLinks: ResumeRecord[];
  profiles: ResumeRecord[];
  projects: ResumeRecord[];
  projectAttachments: ResumeRecord[];
  projectTags: ResumeRecord[];
  roles: ResumeRecord[];
  roleTags: ResumeRecord[];
  skillCategories: ResumeRecord[];
  skillCategoryMembers: ResumeRecord[];
  skillGroups: ResumeRecord[];
  skillGroupMembers: ResumeRecord[];
  tags?: ResumeRecord[];
}

export interface LegacyResumeSourceRecords {
  achievements: ResumeRecord[];
  education: ResumeRecord[];
  links: ResumeRecord[];
  otherRoles: ResumeRecord[];
  positions: ResumeRecord[];
  profiles: ResumeRecord[];
  skillCategories: ResumeRecord[];
  skillGroups: ResumeRecord[];
  skills: ResumeRecord[];
}

export interface ResumeTailoringRecord extends ResumeRecord {
  config?: TailoringConfig;
}

/** Which candidate profile to assemble; omit for the active default. */
export interface ResumeProfileSelection {
  profileKey?: string;
}

/**
 * One selectable candidate profile. Deliberately carries no contact facts:
 * `default` is the profile assembled when no key is requested.
 */
export interface ResumeProfileSummary {
  active: boolean;
  default: boolean;
  key: string;
  name: string;
}

export function loadLegacyResumeSource(): ResumeSource {
  return {
    profile: profileData as Profile,
    experience: experienceData as Experience,
    skills: skillsData as Skills,
  };
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function optionalString(value: unknown): string | undefined {
  const next = stringValue(value);
  return next || undefined;
}

function numberValue(value: unknown): number {
  if (typeof value === 'number') return value;
  if (typeof value === 'string' && value.trim() !== '') return Number(value);
  return 0;
}

function booleanValue(value: unknown, fallback = false): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1' || normalized === 'on')
      return true;
    if (normalized === 'false' || normalized === '0' || normalized === 'off')
      return false;
  }
  if (typeof value === 'number') return value !== 0;
  return fallback;
}

function splitList(value: unknown): string[] {
  return stringValue(value)
    .split(/[\n,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

type AchievementResumePlacement = 'position' | 'project' | 'both';

function achievementResumePlacement(
  record: ResumeRecord,
): AchievementResumePlacement {
  const placement = stringValue(record.resumePlacement).toLowerCase();
  if (
    placement === 'position' ||
    placement === 'project' ||
    placement === 'both'
  )
    return placement;
  return stringValue(record.projectId) ? 'project' : 'position';
}

function shouldRenderAchievementAtPosition(record: ResumeRecord): boolean {
  const placement = achievementResumePlacement(record);
  return placement === 'position' || placement === 'both';
}

function shouldRenderAchievementAtProject(record: ResumeRecord): boolean {
  const placement = achievementResumePlacement(record);
  return placement === 'project' || placement === 'both';
}

function bySortOrder(a: ResumeRecord, b: ResumeRecord): number {
  const diff = numberValue(a.sortOrder) - numberValue(b.sortOrder);
  if (diff !== 0) return diff;
  return stringValue(a.id).localeCompare(stringValue(b.id));
}

function byLabel(a: ResumeRecord, b: ResumeRecord): number {
  return stringValue(a.label || a.name || a.title).localeCompare(
    stringValue(b.label || b.name || b.title),
  );
}

function dateValue(value: unknown): Date | null {
  if (value instanceof Date)
    return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value !== 'string' || value.trim() === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(
  value: unknown,
  precision: unknown,
  presentLabel = 'Present',
): string {
  const mode = stringValue(precision) || 'year';
  if (mode === 'present') return 'Present';
  const date = dateValue(value);
  if (!date) return presentLabel;
  if (mode === 'day') return date.toISOString().slice(0, 10);
  if (mode === 'month') return date.toISOString().slice(0, 7);
  return String(date.getUTCFullYear());
}

function profileKeyOf(record: ResumeRecord): string {
  return stringValue(record.profileKey) || 'default';
}

function activeDefaultProfile(
  records: ResumeRecord[],
): ResumeRecord | undefined {
  return (
    records.find(
      (record) =>
        stringValue(record.profileKey) === 'default' &&
        booleanValue(record.isDefault),
    ) ??
    records.find(
      (record) =>
        stringValue(record.profileKey) === 'default' &&
        booleanValue(record.active, true),
    ) ??
    records.find((record) => booleanValue(record.active, true)) ??
    records[0]
  );
}

/**
 * The profile a selection resolves to: the record whose `profileKey` matches
 * an explicit key (unknown key → `undefined`, never a silent fallback), or
 * the active default when no key is requested.
 */
function selectedProfile(
  records: ResumeRecord[],
  selection?: ResumeProfileSelection,
): ResumeRecord | undefined {
  const profileKey = stringValue(selection?.profileKey);
  if (profileKey) {
    return records.find((record) => profileKeyOf(record) === profileKey);
  }
  return activeDefaultProfile(records);
}

/** Project profile records onto the contact-free selectable inventory. */
export function resumeProfileSummaries(
  records: ResumeRecord[],
): ResumeProfileSummary[] {
  const defaultRecord = activeDefaultProfile(records);
  return records.map((record) => ({
    active: booleanValue(record.active, true),
    default: record === defaultRecord,
    key: profileKeyOf(record),
    name: stringValue(record.name),
  }));
}

function recordsById(records: ResumeRecord[]): Map<string, ResumeRecord> {
  return new Map(
    records
      .filter((record) => typeof record.id === 'string' && record.id)
      .map((record) => [record.id as string, record]),
  );
}

function groupByString(
  records: ResumeRecord[],
  key: string,
): Map<string, ResumeRecord[]> {
  const grouped = new Map<string, ResumeRecord[]>();
  for (const record of records) {
    const value = stringValue(record[key]);
    if (!value) continue;
    const items = grouped.get(value) ?? [];
    items.push(record);
    grouped.set(value, items);
  }
  return grouped;
}

function attachmentFromRecord(record: ResumeRecord): ResumeAttachment {
  return {
    id: stringValue(record.id),
    filePath: stringValue(record.filePath),
    kind: (stringValue(record.kind) || 'document') as ResumeAttachment['kind'],
    title: optionalString(record.title),
    caption: optionalString(record.caption),
    altText: optionalString(record.altText),
    mimeType: optionalString(record.mimeType),
    sourceUrl: optionalString(record.sourceUrl),
    visibility: (stringValue(record.visibility) ||
      'private') as ResumeAttachment['visibility'],
  };
}

function tagSlugResolver(
  records: ResumeRecord[] = [],
): (value: unknown) => string {
  const slugsByReference = new Map<string, string>();
  for (const record of records) {
    const id = stringValue(record.id);
    const slug = stringValue(record.slug);
    if (!slug) continue;
    slugsByReference.set(slug, slug);
    if (id) slugsByReference.set(id, slug);
  }
  return (value: unknown) => {
    const reference = stringValue(value);
    return slugsByReference.get(reference) ?? reference;
  };
}

function tagsFor(
  records: Map<string, ResumeRecord[]>,
  id: string,
  resolveTagSlug: (value: unknown) => string,
): string[] {
  return (records.get(id) ?? [])
    .map((record) => resolveTagSlug(record.tagId))
    .filter(Boolean);
}

function attachmentsFor(
  joins: Map<string, ResumeRecord[]>,
  attachmentsById: Map<string, ResumeRecord>,
  id: string,
): ResumeAttachment[] {
  return (joins.get(id) ?? [])
    .sort(bySortOrder)
    .map((join) => attachmentsById.get(stringValue(join.attachmentId)))
    .filter((record): record is ResumeRecord => Boolean(record))
    .map(attachmentFromRecord);
}

export function assembleResumeSourceFromRecords(
  records: ResumeSourceRecords,
  selection?: ResumeProfileSelection,
): ResumeSource | null {
  const profileRecord = selectedProfile(records.profiles, selection);
  if (!profileRecord) return null;
  const profileKey = profileKeyOf(profileRecord);
  const resolveTagSlug = tagSlugResolver(records.tags);

  const profile: Profile = {
    name: stringValue(profileRecord.name),
    title: stringValue(profileRecord.title),
    email: stringValue(profileRecord.email),
    summary: stringValue(profileRecord.summary),
    links: records.profileLinks
      .filter(
        (record) =>
          (stringValue(record.profileKey) || 'default') === profileKey,
      )
      .sort(bySortOrder)
      .map((record) => ({
        label: stringValue(record.label),
        href: stringValue(record.href),
      })),
  };

  const skillMembersByCategory = groupByString(
    records.skillCategoryMembers,
    'categoryId',
  );
  const groups: SkillCategory[] = [...records.skillCategories]
    .sort((a, b) => bySortOrder(a, b) || byLabel(a, b))
    .map((category) => {
      const categoryId = stringValue(category.id);
      const skills: Skill[] = (skillMembersByCategory.get(categoryId) ?? [])
        .sort(bySortOrder)
        .filter((record) => booleanValue(record.useOnResume, true))
        .map((record) => ({
          id: resolveTagSlug(record.tagId),
          label: stringValue(record.label) || resolveTagSlug(record.tagId),
        }))
        .filter((skill) => skill.id && skill.label);
      return {
        id: stringValue(category.categoryKey) || categoryId,
        label: stringValue(category.label),
        skills,
      };
    })
    .filter((group) => group.id && group.label);

  const skillMembersByGroup = groupByString(
    records.skillGroupMembers,
    'groupId',
  );
  const skillGroups: SkillGroup[] = [...records.skillGroups]
    .sort((a, b) => bySortOrder(a, b) || byLabel(a, b))
    .map((group) => ({
      id: stringValue(group.groupKey) || stringValue(group.id),
      label: stringValue(group.label),
      blurb: stringValue(group.blurb),
      skills: (skillMembersByGroup.get(stringValue(group.id)) ?? [])
        .sort(bySortOrder)
        .map((record) => resolveTagSlug(record.tagId))
        .filter(Boolean),
    }))
    .filter((group) => group.id && group.label);

  const attachmentsById = recordsById(records.attachments);
  const achievementAttachmentJoins = groupByString(
    records.achievementAttachments,
    'achievementId',
  );
  const projectAttachmentJoins = groupByString(
    records.projectAttachments,
    'projectId',
  );
  const companiesById = recordsById(records.companies);
  const rolesById = recordsById(records.roles);
  const companiesByExperience = groupByString(
    records.experienceCompanies,
    'experienceId',
  );
  const rolesByExperience = groupByString(
    records.experienceRoles,
    'experienceId',
  );
  const dutiesByExperience = groupByString(records.duties, 'experienceId');
  const dutiesByProject = groupByString(records.duties, 'projectId');
  const achievementsByExperience = groupByString(
    records.achievements,
    'experienceId',
  );
  const achievementsByProject = groupByString(
    records.achievements,
    'projectId',
  );
  const projectsByExperience = groupByString(records.projects, 'experienceId');
  const experienceTags = groupByString(records.experienceTags, 'experienceId');
  const achievementTags = groupByString(
    records.achievementTags,
    'achievementId',
  );
  const dutyTags = groupByString(records.dutyTags, 'dutyId');
  const projectTags = groupByString(records.projectTags, 'projectId');

  const buildDuty = (record: ResumeRecord): Duty => ({
    id: stringValue(record.id),
    title: optionalString(record.title),
    body: stringValue(record.body),
    tags: tagsFor(dutyTags, stringValue(record.id), resolveTagSlug),
  });

  const buildAchievement = (record: ResumeRecord): Achievement => {
    const achievement: Achievement = {
      id: stringValue(record.id),
      title: stringValue(record.title),
      body: stringValue(record.body),
      tags: tagsFor(achievementTags, stringValue(record.id), resolveTagSlug),
      attachments: attachmentsFor(
        achievementAttachmentJoins,
        attachmentsById,
        stringValue(record.id),
      ),
    };
    const metric = optionalString(record.metric);
    if (metric) achievement.metric = metric;
    return achievement;
  };

  const buildProject = (record: ResumeRecord): Project => {
    const id = stringValue(record.id);
    return {
      id: stringValue(record.projectKey) || id,
      name: stringValue(record.name),
      url: optionalString(record.url),
      summary: optionalString(record.summary),
      start: record.startDate
        ? formatDate(record.startDate, record.startPrecision, '')
        : undefined,
      end: record.endDate
        ? formatDate(record.endDate, record.endPrecision, '')
        : undefined,
      duties: (dutiesByProject.get(id) ?? []).sort(bySortOrder).map(buildDuty),
      achievements: (achievementsByProject.get(id) ?? [])
        .filter(shouldRenderAchievementAtProject)
        .sort(bySortOrder)
        .map(buildAchievement),
      tags: tagsFor(projectTags, id, resolveTagSlug),
      attachments: attachmentsFor(projectAttachmentJoins, attachmentsById, id),
    };
  };

  const positions: Position[] = [...records.experiences]
    .sort(bySortOrder)
    .map((experienceRecord) => {
      const experienceId = stringValue(experienceRecord.id);
      const companyJoin = [
        ...(companiesByExperience.get(experienceId) ?? []),
      ].sort(bySortOrder)[0];
      const companyRecord = companyJoin
        ? companiesById.get(stringValue(companyJoin.companyId))
        : undefined;
      const roleJoin = [...(rolesByExperience.get(experienceId) ?? [])].sort(
        bySortOrder,
      )[0];
      const roleRecord = roleJoin
        ? rolesById.get(stringValue(roleJoin.roleId))
        : undefined;

      const startDate = roleJoin?.startDate ?? experienceRecord.startDate;
      const endDate = roleJoin?.endDate ?? experienceRecord.endDate;
      const endPrecision = stringValue(
        roleJoin?.endPrecision ?? experienceRecord.endPrecision,
      );
      const end = endDate ? formatDate(endDate, endPrecision) : 'Present';

      return {
        id: stringValue(experienceRecord.experienceKey) || experienceId,
        role:
          stringValue(roleJoin?.titleSnapshot) ||
          stringValue(roleRecord?.label),
        company:
          stringValue(companyJoin?.companyNameSnapshot) ||
          stringValue(companyRecord?.name),
        url: optionalString(experienceRecord.url),
        companyHref: optionalString(
          companyJoin?.companyHrefSnapshot ?? companyRecord?.websiteUrl,
        ),
        weight: numberValue(experienceRecord.weight),
        start: formatDate(
          startDate,
          roleJoin?.startPrecision ?? experienceRecord.startPrecision,
          '',
        ),
        end,
        blurb: optionalString(experienceRecord.summary || roleJoin?.summary),
        tags: tagsFor(experienceTags, experienceId, resolveTagSlug),
        duties: (dutiesByExperience.get(experienceId) ?? [])
          .filter((record) => !stringValue(record.projectId))
          .sort(bySortOrder)
          .map(buildDuty),
        projects: (projectsByExperience.get(experienceId) ?? [])
          .sort(bySortOrder)
          .map(buildProject),
        achievements: (achievementsByExperience.get(experienceId) ?? [])
          .filter(shouldRenderAchievementAtPosition)
          .sort(bySortOrder)
          .map(buildAchievement),
      };
    })
    .filter((position) => position.id && position.role && position.company);

  const other: OtherRole[] = [...records.otherRoles]
    .sort(bySortOrder)
    .map((record) => ({
      role: stringValue(record.role),
      company: stringValue(record.company),
      period: stringValue(record.period),
      body: stringValue(record.body),
      tags: splitList(record.tags),
    }))
    .filter((role) => role.role && role.company && role.period);

  const education: Education[] = [...records.education]
    .sort(bySortOrder)
    .map((record) => ({
      title: stringValue(record.title),
      institution: stringValue(record.institution),
      detail: stringValue(record.detail),
    }))
    .filter((item) => item.title && item.detail);

  return {
    profile,
    skills: { skillGroups, groups },
    experience: { positions, other, education },
  };
}

export function assembleResumeSourceFromLegacyRecords(
  records: LegacyResumeSourceRecords,
  selection?: ResumeProfileSelection,
): ResumeSource | null {
  const profileRecord = selectedProfile(records.profiles, selection);
  if (!profileRecord) return null;
  const profileKey = profileKeyOf(profileRecord);

  const profile: Profile = {
    name: stringValue(profileRecord.name),
    title: stringValue(profileRecord.title),
    email: stringValue(profileRecord.email),
    summary: stringValue(profileRecord.summary),
    links: records.links
      .filter(
        (record) =>
          (stringValue(record.profileKey) || 'default') === profileKey,
      )
      .sort(bySortOrder)
      .map((record) => ({
        label: stringValue(record.label),
        href: stringValue(record.href),
      })),
  };

  const skillsByCategory = new Map<string, Skill[]>();
  for (const record of [...records.skills].sort(bySortOrder)) {
    const categoryId = stringValue(record.categoryId);
    const skill: Skill = {
      id: stringValue(record.skillId),
      label: stringValue(record.label),
    };
    if (!skill.id || !skill.label) continue;
    const categorySkills = skillsByCategory.get(categoryId) ?? [];
    categorySkills.push(skill);
    skillsByCategory.set(categoryId, categorySkills);
  }

  const groups: SkillCategory[] = [...records.skillCategories]
    .sort((a, b) => bySortOrder(a, b) || byLabel(a, b))
    .map((record) => ({
      id: stringValue(record.categoryId),
      label: stringValue(record.label),
      skills: skillsByCategory.get(stringValue(record.categoryId)) ?? [],
    }))
    .filter((group) => group.id && group.label);

  const skillGroups: SkillGroup[] = [...records.skillGroups]
    .sort((a, b) => bySortOrder(a, b) || byLabel(a, b))
    .map((record) => ({
      id: stringValue(record.groupId),
      label: stringValue(record.label),
      blurb: stringValue(record.blurb),
      skills: splitList(record.skillIds),
    }))
    .filter((group) => group.id && group.label);

  const achievementsByPosition = new Map<string, Achievement[]>();
  for (const record of [...records.achievements].sort(bySortOrder)) {
    const positionId = stringValue(record.positionId);
    const achievement: Achievement = {
      title: stringValue(record.title),
      body: stringValue(record.body),
      tags: splitList(record.tags),
    };
    const metric = optionalString(record.metric);
    if (metric) achievement.metric = metric;
    if (!positionId || !achievement.title || !achievement.body) continue;
    const achievements = achievementsByPosition.get(positionId) ?? [];
    achievements.push(achievement);
    achievementsByPosition.set(positionId, achievements);
  }

  const positions: Position[] = [...records.positions]
    .sort(bySortOrder)
    .map((record) => {
      const positionId = stringValue(record.positionId);
      const position: Position = {
        id: positionId,
        role: stringValue(record.role),
        company: stringValue(record.company),
        start: stringValue(record.start),
        end: stringValue(record.endLabel),
        achievements: achievementsByPosition.get(positionId) ?? [],
      };
      const url = optionalString(record.url);
      const companyHref = optionalString(record.companyHref);
      const blurb = optionalString(record.blurb);
      const weight = numberValue(record.weight);
      if (url) position.url = url;
      if (companyHref) position.companyHref = companyHref;
      if (blurb) position.blurb = blurb;
      if (weight !== 0) position.weight = weight;
      return position;
    })
    .filter((position) => position.id && position.role && position.company);

  const other: OtherRole[] = [...records.otherRoles]
    .sort(bySortOrder)
    .map((record) => ({
      role: stringValue(record.role),
      company: stringValue(record.company),
      period: stringValue(record.period),
      body: stringValue(record.body),
      tags: splitList(record.tags),
    }))
    .filter((role) => role.role && role.company && role.period);

  const education: Education[] = [...records.education]
    .sort(bySortOrder)
    .map((record) => ({
      title: stringValue(record.title),
      institution: stringValue(record.institution),
      detail: stringValue(record.detail),
    }))
    .filter((item) => item.title && item.detail);

  return {
    profile,
    skills: { skillGroups, groups },
    experience: { positions, other, education },
  };
}

async function listRecords(
  className: string,
  orderBy = 'updated_at ASC',
): Promise<ResumeRecord[]> {
  const collection = await getCollection(className);
  const records = await collection.list({ limit: 1000, orderBy });
  return JSON.parse(JSON.stringify(records)) as ResumeRecord[];
}

// Fetch each collection through SMRT's bounded read-plan executor. This keeps
// the public homepage's cold load parallel without creating an unbounded burst
// of connections, while retaining the request's tenant/database context.
async function loadRecordSpec<K extends string>(
  spec: Record<K, readonly [className: string, orderBy: string]>,
): Promise<Record<K, ResumeRecord[]>> {
  const keys = Object.keys(spec) as K[];
  const plan = Object.fromEntries(
    keys.map((key) => {
      const [className, orderBy] = spec[key];
      return [key, { className, options: { limit: 1000, orderBy } }];
    }),
  ) as SmrtCollectionReadPlan;
  const results = await executeCollectionReadPlan(plan, {
    collectionOptions: getRequestScopedSmrtOptions(),
    maxConcurrency: 2,
  });
  return Object.fromEntries(
    keys.map((key) => [
      key,
      JSON.parse(JSON.stringify(results[key])) as ResumeRecord[],
    ]),
  ) as Record<K, ResumeRecord[]>;
}

export async function loadNormalizedResumeSource(
  selection?: ResumeProfileSelection,
): Promise<ResumeSource | null> {
  const records: ResumeSourceRecords = await loadRecordSpec(
    NORMALIZED_RESUME_READ_PLAN,
  );
  return assembleResumeSourceFromRecords(records, selection);
}

export async function loadLegacyAdminResumeSource(
  selection?: ResumeProfileSelection,
): Promise<ResumeSource | null> {
  const records = (await loadRecordSpec(
    LEGACY_RESUME_READ_PLAN,
  )) as unknown as LegacyResumeSourceRecords;
  return assembleResumeSourceFromLegacyRecords(records, selection);
}

export async function loadAdminResumeSource(
  selection?: ResumeProfileSelection,
): Promise<ResumeSource | null> {
  return (
    (await loadNormalizedResumeSource(selection)) ??
    (await loadLegacyAdminResumeSource(selection))
  );
}

/**
 * The published resume for the active default profile, or for one explicit
 * profile key. Callers selecting by key must validate it against
 * `listPublishedResumeProfiles()` first: an unknown key assembles nothing and
 * would otherwise fall through to the bundled legacy resume.
 */
export async function loadPublishedResumeSource(
  selection?: ResumeProfileSelection,
): Promise<ResumeSource> {
  return (await loadAdminResumeSource(selection)) ?? loadLegacyResumeSource();
}

/** The selectable candidate profiles, without contact facts. */
export async function listPublishedResumeProfiles(): Promise<
  ResumeProfileSummary[]
> {
  return resumeProfileSummaries(
    await listRecords('CandidateProfile', 'profileKey ASC'),
  );
}

// The public homepage renders this on every request, and the underlying resume
// tables change only when the admin edits them. Serve it from an in-process
// cache keyed on a database-derived version stamp, so repeat loads skip the
// 27-collection read plan entirely and every replica converges on an admin edit
// without cross-process messaging. The admin resume editor reads the uncached
// loaders (loadNormalizedResumeSource / loadAdminResumeSource) directly and so
// always sees fresh data, and generateResumeAsset() calls
// loadPublishedResumeSource() directly (uncached) so generated PDFs are never
// stale. Resume write actions call invalidatePublishedResumeCache() so the
// writing replica refreshes immediately instead of waiting for a stamp check.
const RESUME_STAMP_TTL_MS = 5_000;
const RESUME_STALE_TTL_MS = 60_000;

interface PublishedResumeCacheContext {
  database: ResumeStampDatabase;
  key: string;
}

/**
 * Resolve the cache partition for the current request.
 *
 * The stamp and the payload must share one identity: a stamp read from one
 * database must never validate a payload loaded from another. Returning
 * `undefined` bypasses the cache entirely.
 */
function publishedResumeCacheContext():
  | PublishedResumeCacheContext
  | undefined {
  const sessionContext = getCurrentSessionPermissionContext();
  const tenantId = sessionContext?.tenantId ?? getCurrentTenant()?.tenantId;
  const database =
    sessionContext?.database ?? getRequestScopedDatabase() ?? getDbConfig();
  const configuredDatabase = getDbConfig();
  const fields =
    typeof database === 'string'
      ? { url: database }
      : (database as Record<string, unknown>);
  const url = typeof fields.url === 'string' ? fields.url.trim() : '';
  const configuredFields = configuredDatabase as Record<string, unknown>;
  const configuredType =
    typeof configuredFields.type === 'string'
      ? configuredFields.type
      : undefined;
  const type = typeof fields.type === 'string' ? fields.type : configuredType;

  // An opaque request-scoped handle could point at any database. Do not let it
  // share a value with another handle unless its stable endpoint is known.
  if (!url || !type) return undefined;

  // A live database handle carries context an endpoint cannot reproduce — an
  // open transaction, session variables, an RLS tenant scope. Caching here would
  // stamp through a freshly reconstructed connection while the payload loaded
  // through that handle, and the two could see different rows. Under RLS the
  // stamp connection would see none at all: a constant stamp that revalidates
  // the tenant's payload forever. Nothing in this app enables RLS today; this
  // exists so switching it on degrades to uncached reads instead of silently
  // serving stale data.
  if (typeof (fields as { query?: unknown }).query === 'function')
    return undefined;

  return {
    database: { type, url } as ResumeStampDatabase,
    key: JSON.stringify([type, url, tenantId ?? null]),
  };
}

const publishedResumeCache = createStampedCache<ResumeSource>({
  getKey: () => publishedResumeCacheContext()?.key,
  hashValue: (source) =>
    createHash('sha256').update(JSON.stringify(source)).digest('hex'),
  loadStamp: async () => {
    const context = publishedResumeCacheContext();
    if (!context) throw new Error('No resolvable resume stamp database.');
    return loadPublishedResumeStamp(context.database);
  },
  loader: loadPublishedResumeSource,
  stampTtlMs: RESUME_STAMP_TTL_MS,
  staleTtlMs: RESUME_STALE_TTL_MS,
});

/**
 * The published resume, the stamp it was loaded at, and a digest of the payload
 * itself.
 *
 * The homepage builds its `ETag` from the content digest rather than the stamp.
 * The stamp is read *before* the payload load, so a write landing between the
 * two files fresh content under the previous stamp; a stamp-derived validator
 * would then hand two clients the same `ETag` for different bytes. The digest
 * is computed from the payload being returned and cannot drift from it. It also
 * distinguishes tenants and databases for free.
 */
export function getCachedPublishedResume(): Promise<
  StampedResult<ResumeSource>
> {
  return publishedResumeCache.get();
}

export async function getCachedPublishedResumeSource(): Promise<ResumeSource> {
  return (await publishedResumeCache.get()).value;
}

export function invalidatePublishedResumeCache(): void {
  publishedResumeCache.invalidate();
}

export function parseTailoringConfigRecord(
  record: ResumeRecord,
): ResumeTailoringRecord {
  let config: TailoringConfig = {};
  try {
    config = JSON.parse(
      stringValue(record.configJson) || '{}',
    ) as TailoringConfig;
  } catch {
    config = {};
  }

  return {
    ...record,
    config,
  };
}

export async function listResumeTailoringConfigs(): Promise<
  ResumeTailoringRecord[]
> {
  const records = await listRecords('ResumeTailoringConfig', 'name ASC');
  return records
    .filter((record) => booleanValue(record.active, true))
    .map(parseTailoringConfigRecord);
}

export async function getResumeTailoringConfig(
  id: string,
): Promise<ResumeTailoringRecord | null> {
  if (!id) return null;
  const collection = await getCollection('ResumeTailoringConfig');
  const record = await collection.get(id);
  return record
    ? parseTailoringConfigRecord(
        JSON.parse(JSON.stringify(record)) as ResumeRecord,
      )
    : null;
}

export async function listResumeAssets(): Promise<ResumeRecord[]> {
  const assets = await listRecords('ResumeAsset', 'updated_at DESC');
  return assets.filter((asset) => !stringValue(asset.applicationId));
}

export async function getPublishedResumeAsset(): Promise<ResumeRecord | null> {
  const assets = await listResumeAssets();
  return assets.find((asset) => booleanValue(asset.isPublished)) ?? null;
}
