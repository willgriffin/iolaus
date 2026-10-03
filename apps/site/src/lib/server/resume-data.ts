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
import { isSharedHosted } from './app-config.js';
import { getDbConfig } from './db.js';
import {
  candidateProfileWhere,
  getPrivateRecord,
  privateRecordWhere,
  requireWorkspaceSubject,
  type WorkspaceSubject,
} from './private-workspace.js';
import {
  isCanonicalEducationEntry,
  isCanonicalOtherRoleEntry,
} from './resume-canonical-membership.js';
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

const PRIVATE_RESUME_COLLECTIONS = new Set([
  'Achievement',
  'AchievementAttachment',
  'AchievementTag',
  'Attachment',
  'CandidateProfile',
  'CandidateProfileLink',
  'Duty',
  'DutyTag',
  'Education',
  'EducationTag',
  'EmploymentRole',
  'EmploymentRoleTag',
  'Experience',
  'ExperienceCompany',
  'ExperienceRole',
  'ExperienceTag',
  'Project',
  'ProjectAttachment',
  'ProjectTag',
  'ResumeAchievement',
  'ResumeAsset',
  'ResumeEducation',
  'ResumeLink',
  'ResumeOtherRole',
  'ResumePosition',
  'ResumeProfile',
  'ResumeSkill',
  'ResumeSkillCategory',
  'ResumeSkillGroup',
  'ResumeTailoringConfig',
  'SkillCategory',
  'SkillCategoryMember',
  'SkillGroup',
  'SkillGroupMember',
]);

/**
 * CandidateProfile is the selected root; all other resume records are children.
 */
function privateResumeReadWhere(
  className: string,
  subject: WorkspaceSubject,
): Record<string, unknown> {
  return className === 'CandidateProfile'
    ? { id: subject.profileId, ...candidateProfileWhere(subject) }
    : privateRecordWhere(subject);
}

export interface CandidateEvidenceSource {
  id: string;
  kind:
    | 'achievement'
    | 'candidate_profile'
    | 'education'
    | 'duty'
    | 'employment'
    | 'project'
    | 'skill'
    | 'skill_context';
  /** Original record identifier; id identifies its attributable catalog occurrence. */
  recordId?: string;
  sectionId?: string;
  text: string;
  title: string;
}

export interface WorkspaceCandidateEvidence {
  candidate: {
    authorizedWorkCountriesJson: string;
    citizenshipsJson: string;
    factsJson: string;
    location: string;
    preferencesJson: string;
    residenceCountryJson: string;
    sponsorshipRequired: boolean | 'unknown';
    summary: string;
    targetWorkCountryJson: string;
    title: string;
    workAuthorization: string;
  };
  evidence: CandidateEvidenceSource[];
  fingerprint: string;
  subject: WorkspaceSubject;
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

function privateReadSubject(
  subject?: WorkspaceSubject,
): WorkspaceSubject | undefined {
  if (subject) return requireWorkspaceSubject(subject);
  if (isSharedHosted()) {
    throw new Error('A verified candidate workspace subject is required.');
  }
  return undefined;
}

function emptyPublishedResumeSource(): ResumeSource {
  return {
    experience: { education: [], other: [], positions: [] },
    profile: { email: '', links: [], name: '', summary: '', title: '' },
    skills: { groups: [], skillGroups: [] },
  };
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
    .filter(isCanonicalOtherRoleEntry);

  const education: Education[] = [...records.education]
    .sort(bySortOrder)
    .map((record) => ({
      title: stringValue(record.title),
      institution: stringValue(record.institution),
      detail: stringValue(record.detail),
    }))
    .filter(isCanonicalEducationEntry);

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
    .filter(isCanonicalOtherRoleEntry);

  const education: Education[] = [...records.education]
    .sort(bySortOrder)
    .map((record) => ({
      title: stringValue(record.title),
      institution: stringValue(record.institution),
      detail: stringValue(record.detail),
    }))
    .filter(isCanonicalEducationEntry);

  return {
    profile,
    skills: { skillGroups, groups },
    experience: { positions, other, education },
  };
}

async function listRecords(
  className: string,
  orderBy = 'updated_at ASC',
  subject?: WorkspaceSubject,
): Promise<ResumeRecord[]> {
  const collection = await getCollection(className);
  const scopedSubject = privateReadSubject(subject);
  const records = await collection.list({
    limit: 1000,
    orderBy,
    ...(scopedSubject && PRIVATE_RESUME_COLLECTIONS.has(className)
      ? { where: privateResumeReadWhere(className, scopedSubject) }
      : {}),
  });
  return JSON.parse(JSON.stringify(records)) as ResumeRecord[];
}

// Fetch each collection through SMRT's bounded read-plan executor. This keeps
// the public homepage's cold load parallel without creating an unbounded burst
// of connections, while retaining the request's tenant/database context.
async function loadRecordSpec<K extends string>(
  spec: Record<
    K,
    readonly [
      className: string,
      orderBy: string,
      readLimit?: number,
      inMemoryOrderBy?: string,
    ]
  >,
  subject?: WorkspaceSubject,
): Promise<Record<K, ResumeRecord[]>> {
  const scopedSubject = privateReadSubject(subject);
  const keys = Object.keys(spec) as K[];
  const plan = Object.fromEntries(
    keys.map((key) => {
      const [className, orderBy, readLimit] = spec[key];
      return [
        key,
        {
          className,
          options: {
            limit: readLimit ?? 1000,
            orderBy,
            ...(scopedSubject && PRIVATE_RESUME_COLLECTIONS.has(className)
              ? { where: privateResumeReadWhere(className, scopedSubject) }
              : {}),
          },
        },
      ];
    }),
  ) as SmrtCollectionReadPlan;
  const results = await executeCollectionReadPlan(plan, {
    collectionOptions: getRequestScopedSmrtOptions(),
    maxConcurrency: 2,
  });
  return Object.fromEntries(
    keys.map((key) => {
      const [, , readLimit, inMemoryOrderBy] = spec[key];
      const records = results[key] as unknown as ResumeRecord[];

      // The normal 1,000-row bound selected rows by sortOrder before the
      // sensitive-field guard landed. A safe ID read may only replace that
      // ordering when the collection is fully represented; fail closed at the
      // first overflow rather than silently changing which 1,000 rows render.
      if (readLimit === 1001 && records.length === readLimit) {
        throw new Error(
          `Published resume read exceeds the supported 1000-row limit for ${key}.`,
        );
      }

      if (inMemoryOrderBy === 'sortOrder ASC') records.sort(bySortOrder);

      return [key, JSON.parse(JSON.stringify(records)) as ResumeRecord[]];
    }),
  ) as Record<K, ResumeRecord[]>;
}

export async function loadNormalizedResumeSource(
  selection?: ResumeProfileSelection,
  subject?: WorkspaceSubject,
): Promise<ResumeSource | null> {
  const records: ResumeSourceRecords = await loadRecordSpec(
    NORMALIZED_RESUME_READ_PLAN,
    subject,
  );
  return assembleResumeSourceFromRecords(records, selection);
}

export async function loadLegacyAdminResumeSource(
  selection?: ResumeProfileSelection,
  subject?: WorkspaceSubject,
): Promise<ResumeSource | null> {
  const records = (await loadRecordSpec(
    LEGACY_RESUME_READ_PLAN,
    subject,
  )) as unknown as LegacyResumeSourceRecords;
  return assembleResumeSourceFromLegacyRecords(records, selection);
}

export async function loadAdminResumeSource(
  selection?: ResumeProfileSelection,
  subject?: WorkspaceSubject,
): Promise<ResumeSource | null> {
  return (
    (await loadNormalizedResumeSource(selection, subject)) ??
    (await loadLegacyAdminResumeSource(selection, subject))
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
  if (isSharedHosted()) return emptyPublishedResumeSource();
  return (await loadAdminResumeSource(selection)) ?? loadLegacyResumeSource();
}

/** The selectable candidate profiles, without contact facts. */
export async function listPublishedResumeProfiles(): Promise<
  ResumeProfileSummary[]
> {
  if (isSharedHosted()) return [];
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
    // Keep the configured pool options (notably `max`). SMRT caches the pool
    // under `smrt:<url>` regardless of options, so whichever caller creates it
    // first sets its size; this stamp probe runs on the first public request
    // and used to create every process's shared pool at the SQL default of 20
    // instead of IOLAUS_DB_POOL_MAX (#93).
    database: { ...fields, type, url } as ResumeStampDatabase,
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

export async function listResumeTailoringConfigs(
  subject?: WorkspaceSubject,
): Promise<ResumeTailoringRecord[]> {
  const records = await listRecords(
    'ResumeTailoringConfig',
    'name ASC',
    subject,
  );
  return records
    .filter((record) => booleanValue(record.active, true))
    .map(parseTailoringConfigRecord);
}

export async function getResumeTailoringConfig(
  id: string,
  subject?: WorkspaceSubject,
): Promise<ResumeTailoringRecord | null> {
  if (!id) return null;
  const scopedSubject = privateReadSubject(subject);
  const record = scopedSubject
    ? await getPrivateRecord('ResumeTailoringConfig', id, scopedSubject)
    : await (await getCollection('ResumeTailoringConfig')).get(id);
  return record
    ? parseTailoringConfigRecord(
        JSON.parse(JSON.stringify(record)) as ResumeRecord,
      )
    : null;
}

export async function listResumeAssets(
  subject?: WorkspaceSubject,
): Promise<ResumeRecord[]> {
  const assets = await listRecords('ResumeAsset', 'updated_at DESC', subject);
  const ownership = subject ? privateRecordWhere(subject) : null;
  return assets.filter(
    (asset) =>
      !stringValue(asset.applicationId) &&
      (!ownership ||
        Object.entries(ownership).every(
          ([key, value]) => asset[key] === value,
        )),
  );
}

export async function getPublishedResumeAsset(
  subject?: WorkspaceSubject,
): Promise<ResumeRecord | null> {
  const assets = await listResumeAssets(subject);
  return assets.find((asset) => booleanValue(asset.isPublished)) ?? null;
}

function evidenceText(...values: unknown[]): string {
  // Do not silently crop private material here. The assessment input layer owns
  // the request ceiling and records any omitted/clipped source as coverage loss.
  return values.map(stringValue).filter(Boolean).join('\n');
}

/**
 * Load complete candidate evidence for an authenticated selected profile.
 *
 * This is deliberately separate from public resume loading: the assessment
 * engine receives a server-validated subject and cannot ask it to read a
 * different profile by swapping an opaque id in tool input.
 */
function completeEvidenceReadPlan<K extends string>(
  spec: Record<K, readonly [string, string, number?, string?]>,
): Record<K, readonly [string, string, number, string?]> {
  // Read one overflow row so a source collection limit cannot masquerade as
  // complete candidate coverage. loadRecordSpec fails closed at 1001 rows.
  const result = {} as Record<K, readonly [string, string, number, string?]>;
  for (const key of Object.keys(spec) as K[]) {
    const [className, orderBy, , inMemoryOrderBy] = spec[key];
    result[key] =
      inMemoryOrderBy === undefined
        ? [className, orderBy, 1001]
        : [className, orderBy, 1001, inMemoryOrderBy];
  }
  return result;
}

export async function loadWorkspaceCandidateEvidence(
  subject: WorkspaceSubject,
): Promise<WorkspaceCandidateEvidence> {
  const scopedSubject = requireWorkspaceSubject(subject);
  const profile = await getPrivateRecord(
    'CandidateProfile',
    scopedSubject.profileId,
    scopedSubject,
  );
  if (!profile) {
    throw new Error('Candidate profile is outside this workspace.');
  }

  const normalizedRecords = await loadRecordSpec(
    completeEvidenceReadPlan(NORMALIZED_RESUME_READ_PLAN),
    scopedSubject,
  );
  let source = assembleResumeSourceFromRecords(normalizedRecords);
  let educationRecords = normalizedRecords.education;
  if (!source) {
    const legacyRecords = (await loadRecordSpec(
      completeEvidenceReadPlan(LEGACY_RESUME_READ_PLAN),
      scopedSubject,
    )) as unknown as LegacyResumeSourceRecords;
    source = assembleResumeSourceFromLegacyRecords(legacyRecords);
    educationRecords = legacyRecords.education;
  }
  const evidence: CandidateEvidenceSource[] = [];
  const append = (next: CandidateEvidenceSource) => {
    if (next.id && next.text) evidence.push(next);
  };

  append({
    id: `profile:${scopedSubject.profileId}`,
    recordId: scopedSubject.profileId,
    kind: 'candidate_profile',
    text: evidenceText(profile.title, profile.summary, profile.factsJson),
    title: stringValue(profile.name) || 'Candidate profile',
  });
  // Preserve atomic role/tenure facts alongside every narrative source.
  for (const position of source?.experience.positions ?? []) {
    append({
      id: `position:${stringValue(position.id)}`,
      recordId: stringValue(position.id),
      kind: 'employment',
      text: evidenceText(
        position.role,
        position.company,
        [stringValue(position.start), stringValue(position.end)]
          .filter(Boolean)
          .join(' - '),
        position.blurb,
      ),
      title: stringValue(position.role) || 'Employment',
    });
  }
  for (const [index, role] of (source?.experience.other ?? []).entries()) {
    append({
      id: `other-role:${index}`,
      kind: 'employment',
      text: evidenceText(role.role, role.company, role.period, role.body),
      title: role.role || 'Other employment',
    });
  }
  for (const group of source?.skills.skillGroups ?? []) {
    append({
      id: `skill-group:${group.id}`,
      kind: 'skill_context',
      text: evidenceText(group.label, group.blurb, group.skills.join(', ')),
      title: group.label || 'Skill context',
    });
  }
  for (const group of source?.skills.groups ?? []) {
    for (const skill of group.skills ?? []) {
      append({
        id: `skill:${group.id}:${stringValue(skill.id)}`,
        recordId: stringValue(skill.id),
        kind: 'skill',
        text: stringValue(skill.label),
        title: stringValue(skill.label) || 'Skill',
      });
    }
  }
  for (const position of source?.experience.positions ?? []) {
    for (const [index, duty] of (position.duties ?? []).entries()) {
      append({
        id: `position:${position.id}:duty:${duty.id || index}`,
        kind: 'duty',
        sectionId: `position:${position.id}`,
        text: evidenceText(duty.title, duty.body),
        title: duty.title || position.role,
      });
    }
    for (const project of position.projects ?? []) {
      append({
        id: `project:${stringValue(project.id)}`,
        recordId: stringValue(project.id),
        kind: 'project',
        sectionId: `position:${position.id}`,
        text: evidenceText(
          project.name,
          project.summary,
          project.start,
          project.end,
        ),
        title: stringValue(project.name) || 'Project',
      });
      for (const [index, duty] of (project.duties ?? []).entries()) {
        append({
          id: `project:${project.id}:duty:${duty.id || index}`,
          kind: 'duty',
          sectionId: `project:${project.id}`,
          text: evidenceText(duty.title, duty.body),
          title: duty.title || project.name,
        });
      }
      for (const [index, achievement] of (
        project.achievements ?? []
      ).entries()) {
        append({
          id: `achievement:project:${project.id}:${achievement.id || index}`,
          ...(achievement.id ? { recordId: achievement.id } : {}),
          kind: 'achievement',
          sectionId: `project:${project.id}`,
          text: evidenceText(
            achievement.title,
            achievement.body,
            achievement.metric,
          ),
          title: stringValue(achievement.title) || 'Achievement',
        });
      }
    }
    for (const [index, achievement] of (
      position.achievements ?? []
    ).entries()) {
      append({
        id: `achievement:position:${position.id}:${achievement.id || index}`,
        ...(achievement.id ? { recordId: achievement.id } : {}),
        kind: 'achievement',
        sectionId: `position:${position.id}`,
        text: evidenceText(
          achievement.title,
          achievement.body,
          achievement.metric,
        ),
        title: stringValue(achievement.title) || 'Achievement',
      });
    }
  }
  const educationIds = new Map<string, string[]>();
  for (const [index, record] of [...educationRecords]
    .sort(bySortOrder)
    .entries()) {
    const identity = evidenceText(
      record.title,
      record.institution,
      record.detail,
    );
    const ids = educationIds.get(identity) ?? [];
    ids.push(stringValue(record.id) || `occurrence:${index}`);
    educationIds.set(identity, ids);
  }
  for (const [index, education] of (
    source?.experience.education ?? []
  ).entries()) {
    const body = evidenceText(
      education.title,
      education.institution,
      education.detail,
    );
    const recordId = educationIds.get(body)?.shift() || `occurrence:${index}`;
    append({
      id: `education:${recordId}`,
      kind: 'education',
      recordId,
      sectionId: `profile:${scopedSubject.profileId}`,
      text: body,
      title: education.title || 'Education',
    });
  }

  const candidate: WorkspaceCandidateEvidence['candidate'] = {
    authorizedWorkCountriesJson: stringValue(
      profile.authorizedWorkCountriesJson,
    ),
    citizenshipsJson: stringValue(profile.citizenshipsJson),
    factsJson: stringValue(profile.factsJson),
    location: stringValue(profile.location),
    preferencesJson: stringValue(profile.preferencesJson),
    residenceCountryJson: stringValue(profile.residenceCountryJson),
    // Missing or malformed data must remain unknown. Treating it as `false`
    // would incorrectly claim that an applicant needs no sponsorship.
    sponsorshipRequired:
      typeof profile.sponsorshipRequired === 'boolean'
        ? profile.sponsorshipRequired
        : 'unknown',
    summary: stringValue(profile.summary),
    targetWorkCountryJson: stringValue(profile.targetWorkCountryJson),
    title: stringValue(profile.title),
    workAuthorization: stringValue(profile.workAuthorization),
  };
  const fingerprint = createHash('sha256')
    .update(
      JSON.stringify({
        // Preferences rerank saved facts locally and never invalidate JEV material.
        candidate: { ...candidate, preferencesJson: undefined },
        evidence,
        subject: scopedSubject,
      }),
    )
    .digest('hex');
  return { candidate, evidence, fingerprint, subject: scopedSubject };
}
