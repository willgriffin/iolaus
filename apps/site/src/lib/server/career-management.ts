import { error } from '@sveltejs/kit';
import {
  buildCareerPresentation,
  type CareerRecordPresentation,
} from './career-presentation';
import { isOwnerAuthorityDenial, runAsOwner } from './owner-principal.js';
import {
  getPrivateRecord,
  listPrivateRecords,
  requireWorkspaceSubject,
} from './private-workspace.js';
import {
  invalidatePublishedResumeCache,
  loadAdminResumeSource,
} from './resume-data.js';
import {
  requireCandidateWorkspaceSubject,
  withVerifiedWorkspaceSubject,
  workspaceSubjectFromLocals,
} from './workspace-subject.js';
import { workspaceWorkflowOperation } from './workspace-workflow-capabilities.js';

type CareerField = {
  key: string;
  label: string;
  multiline?: boolean;
  type?: 'email' | 'url';
};
type SectionSpec = {
  className: string;
  label: string;
  href: string;
  fields: readonly CareerField[];
};
export const CAREER_EDIT_SECTIONS = {
  profile: {
    className: 'CandidateProfile',
    label: 'Profile and summary',
    href: '/admin/candidate-profiles',
    fields: [
      { key: 'name', label: 'Name' },
      { key: 'title', label: 'Professional title' },
      { key: 'summary', label: 'Summary', multiline: true },
      { key: 'email', label: 'Contact email', type: 'email' },
      { key: 'phone', label: 'Phone' },
      { key: 'location', label: 'Location' },
    ],
  },
  experiences: {
    className: 'Experience',
    label: 'Experience',
    href: '/admin/experiences',
    fields: [
      { key: 'summary', label: 'Experience summary', multiline: true },
      { key: 'url', label: 'Experience URL', type: 'url' },
    ],
  },
  projects: {
    className: 'Project',
    label: 'Projects',
    href: '/admin/projects',
    fields: [
      { key: 'name', label: 'Project name' },
      { key: 'summary', label: 'Project summary', multiline: true },
      { key: 'url', label: 'Project URL', type: 'url' },
    ],
  },
  achievements: {
    className: 'Achievement',
    label: 'Achievements',
    href: '/admin/achievements',
    fields: [
      { key: 'title', label: 'Achievement title' },
      { key: 'body', label: 'Achievement body', multiline: true },
      { key: 'metric', label: 'Metric' },
    ],
  },
  duties: {
    className: 'Duty',
    label: 'Responsibilities',
    href: '/admin/duties',
    fields: [
      { key: 'title', label: 'Responsibility title' },
      { key: 'body', label: 'Responsibility body', multiline: true },
    ],
  },
  education: {
    className: 'Education',
    label: 'Education',
    href: '/admin/education',
    fields: [
      { key: 'title', label: 'Education title' },
      { key: 'institution', label: 'Institution' },
      { key: 'detail', label: 'Education detail', multiline: true },
    ],
  },
  other: {
    className: 'ResumeOtherRole',
    label: 'Other experience',
    href: '/admin/resume-other-roles',
    fields: [
      { key: 'role', label: 'Role' },
      { key: 'company', label: 'Company' },
      { key: 'period', label: 'Period' },
      { key: 'body', label: 'Other experience detail', multiline: true },
    ],
  },
  links: {
    className: 'CandidateProfileLink',
    label: 'Contact links',
    href: '/admin/candidate-profile-links',
    fields: [
      { key: 'label', label: 'Link label' },
      { key: 'href', label: 'Link URL', type: 'url' },
    ],
  },
  skillCategories: {
    className: 'SkillCategory',
    label: 'Skill categories',
    href: '/admin/skill-categories',
    fields: [{ key: 'label', label: 'Category label' }],
  },
  skillGroups: {
    className: 'SkillGroup',
    label: 'Skill groups',
    href: '/admin/skill-groups',
    fields: [
      { key: 'label', label: 'Skill group label' },
      { key: 'blurb', label: 'Skill group description', multiline: true },
    ],
  },
} as const satisfies Record<string, SectionSpec>;
export type CareerSectionKey = keyof typeof CAREER_EDIT_SECTIONS;
export interface CareerEditorSection {
  key: CareerSectionKey;
  label: string;
  href: string;
  fields: readonly CareerField[];
  records: Array<{
    id: string;
    values: Record<string, string>;
    presentation?: CareerRecordPresentation;
  }>;
  loadedComplete?: boolean;
  hiddenCount?: number;
}
function subjectFor(locals: App.Locals) {
  return requireWorkspaceSubject(
    requireCandidateWorkspaceSubject(workspaceSubjectFromLocals(locals)),
  );
}
export async function loadCareerManagement(locals: App.Locals) {
  const subject = subjectFor(locals);
  const profile = await getPrivateRecord(
    'CandidateProfile',
    subject.profileId,
    subject,
  );
  if (profile?.active !== true)
    error(403, 'Active candidate profile required.');
  const rows = {} as Record<CareerSectionKey, Record<string, unknown>[]>;
  const [source, sections, dependencies] = await Promise.all([
    loadAdminResumeSource(undefined, subject),
    Promise.all(
      Object.entries(CAREER_EDIT_SECTIONS).map(async ([key, entry]) => {
        const spec: SectionSpec = entry;
        const entries =
          key === 'profile'
            ? [profile]
            : await listPrivateRecords(spec.className, subject, {
                limit: 1000,
                orderBy:
                  spec.className === 'CandidateProfileLink'
                    ? 'id ASC'
                    : 'sortOrder ASC',
              });
        rows[key as CareerSectionKey] = entries;
        return {
          key: key as CareerSectionKey,
          label: spec.label,
          href: spec.href,
          fields: spec.fields,
          records: entries.map((row) => ({
            id: String(row.id),
            values: Object.fromEntries(
              spec.fields.map((field): [string, string] => {
                const value = row[field.key];
                return [field.key, typeof value === 'string' ? value : ''];
              }),
            ),
          })),
        } satisfies CareerEditorSection;
      }),
    ),
    Promise.all(
      ['ExperienceRole', 'ExperienceCompany', 'SkillCategoryMember'].map(
        async (className) =>
          await listPrivateRecords(className, subject, {
            limit: 1000,
            orderBy: 'sortOrder ASC',
          }),
      ),
    ),
  ]);
  if (!source) error(404, 'Canonical resume not found for this profile.');
  const presentation = buildCareerPresentation(
    source,
    sections,
    rows,
    {
      experienceRoles: dependencies[0],
      experienceCompanies: dependencies[1],
      skillMembers: dependencies[2],
    },
    typeof profile.profileKey === 'string' ? profile.profileKey : 'default',
  );
  return { source, ...presentation };
}
export type CareerManagementData = Awaited<
  ReturnType<typeof loadCareerManagement>
>;

export async function saveCareerSection(locals: App.Locals, form: FormData) {
  const subject = subjectFor(locals);
  const key = String(form.get('section') ?? '');
  if (!Object.hasOwn(CAREER_EDIT_SECTIONS, key))
    error(400, 'Unknown career section.');
  const spec: SectionSpec = CAREER_EDIT_SECTIONS[key as CareerSectionKey];
  const id = String(form.get('id') ?? '').trim();
  if (!id) error(400, 'Record ID required.');
  const values: Record<string, string> = {};
  for (const field of spec.fields) {
    if (!form.has(field.key)) continue;
    const value = form.get(field.key);
    if (typeof value !== 'string' || value.length > 50000)
      error(400, `Invalid ${field.label.toLowerCase()}.`);
    values[field.key] = value.trim();
    if (field.type === 'url' && values[field.key]) {
      try {
        const url = new URL(values[field.key]);
        if (!['http:', 'https:', 'mailto:'].includes(url.protocol))
          throw new Error();
      } catch {
        error(400, 'Use an HTTP, HTTPS or email link.');
      }
    }
  }
  if (!Object.keys(values).length) error(400, 'No editable fields provided.');
  const operation = workspaceWorkflowOperation('profile.manage');
  try {
    return await runAsOwner(
      locals,
      async (run) => {
        await run.assertOperation(operation.collection, operation.action);
        return await withVerifiedWorkspaceSubject(subject, async (verified) => {
          const owned = requireWorkspaceSubject(verified);
          const record = await getPrivateRecord(spec.className, id, owned);
          if (!record || typeof record.save !== 'function')
            error(404, 'Career record not found.');
          // Re-enter native authority immediately before the private write.
          return await runAsOwner(
            locals,
            async (write) => {
              await write.assertOperation(
                operation.collection,
                operation.action,
              );
              return await withVerifiedWorkspaceSubject(
                owned,
                async (current) => {
                  const writable = await getPrivateRecord(
                    spec.className,
                    id,
                    requireWorkspaceSubject(current),
                  );
                  if (!writable || typeof writable.save !== 'function')
                    error(404, 'Career record not found.');
                  Object.assign(writable, values);
                  await writable.save();
                  invalidatePublishedResumeCache();
                  return {
                    ok: true,
                    message: `Saved ${spec.label.toLowerCase()}.`,
                  };
                },
              );
            },
            { action: 'admin.career.write' },
          );
        });
      },
      { action: 'admin.career.manage' },
    );
  } catch (cause) {
    if (isOwnerAuthorityDenial(cause)) error(403, 'Forbidden');
    throw cause;
  }
}
