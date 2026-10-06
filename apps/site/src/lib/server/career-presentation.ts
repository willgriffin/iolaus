import type { ResumeSource } from '@willgriffin/iolaus-resume';
import type {
  CareerEditorSection,
  CareerSectionKey,
} from './career-management';
import {
  isCanonicalEducationEntry,
  isCanonicalOtherRoleEntry,
} from './resume-canonical-membership';

type Row = Record<string, unknown>;
export interface CareerRecordPresentation {
  title: string;
  context: string;
  preview: string;
  inResume: boolean | null;
  hiddenReason?: string;
  parentExperienceId?: string;
  kind: string;
}
export interface CareerSkillExclusion {
  id: string;
  title: string;
  context: string;
  href: string;
}
const text = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';
const identity = (row: Row, key: string) => text(row[key]) || text(row.id);
const short = (value: string) =>
  value.length > 160 ? `${value.slice(0, 157)}…` : value;

/** Presentation only: canonical assembly and record ownership remain in their existing services. */
export function buildCareerPresentation(
  source: ResumeSource,
  sections: CareerEditorSection[],
  rows: Record<CareerSectionKey, Row[]>,
  dependencies: {
    experienceRoles: Row[];
    experienceCompanies: Row[];
    skillMembers: Row[];
  },
  profileKey: string,
) {
  const complete =
    Object.values(rows).every((entries) => entries.length < 1000) &&
    Object.values(dependencies).every((entries) => entries.length < 1000);
  const positions = new Map(
    source.experience.positions.map((position) => [position.id, position]),
  );
  const projects = new Map(
    source.experience.positions.flatMap((position) =>
      (position.projects ?? []).map(
        (project) => [project.id, project] as const,
      ),
    ),
  );
  const achievements = new Set(
    source.experience.positions
      .flatMap((position) => [
        ...position.achievements,
        ...(position.projects ?? []).flatMap((project) => project.achievements),
      ])
      .map((item) => item.id)
      .filter(Boolean),
  );
  const duties = new Set(
    source.experience.positions
      .flatMap((position) => [
        ...(position.duties ?? []),
        ...(position.projects ?? []).flatMap((project) => project.duties ?? []),
      ])
      .map((item) => item.id)
      .filter(Boolean),
  );
  const categories = new Set(source.skills.groups.map((group) => group.id));
  const groups = new Set(source.skills.skillGroups.map((group) => group.id));
  const byId = (key: CareerSectionKey, id: unknown) =>
    rows[key].find((row) => row.id === id);
  const unique = (key: CareerSectionKey, field: string, row: Row) =>
    rows[key].filter((other) => identity(other, field) === identity(row, field))
      .length === 1;
  const renderedBulletParent = new Map<string, string>();
  for (const position of source.experience.positions) {
    for (const bullet of [
      ...position.achievements,
      ...(position.duties ?? []),
      ...(position.projects ?? []).flatMap((project) => [
        ...project.achievements,
        ...(project.duties ?? []),
      ]),
    ]) {
      if (bullet.id && !renderedBulletParent.has(bullet.id))
        renderedBulletParent.set(bullet.id, position.id);
    }
  }
  const metadata = new Map<string, CareerRecordPresentation>();
  for (const row of rows.experiences) {
    const unambiguous = unique('experiences', 'experienceKey', row);
    const position = unambiguous
      ? positions.get(identity(row, 'experienceKey'))
      : undefined;
    const role = dependencies.experienceRoles.find(
      (join) => join.experienceId === row.id,
    );
    const company = dependencies.experienceCompanies.find(
      (join) => join.experienceId === row.id,
    );
    const inResume = !unambiguous
      ? null
      : position
        ? true
        : complete && (!role || !company)
          ? false
          : null;
    metadata.set(`experiences:${row.id}`, {
      title: position
        ? `${position.role} · ${position.company}`
        : text(role?.titleSnapshot) || 'Experience details',
      context: position
        ? [position.start, position.end].filter(Boolean).join(' – ')
        : text(company?.companyNameSnapshot),
      preview: short(position?.blurb || text(row.summary)),
      inResume,
      kind: 'Experience',
      hiddenReason:
        inResume === false
          ? 'A role and company relationship are required to render this experience.'
          : inResume === null
            ? 'Canonical identity or related details are unavailable; check detailed records.'
            : undefined,
    });
  }
  for (const row of rows.projects) {
    const project = projects.get(identity(row, 'projectKey'));
    const parent = byId('experiences', row.experienceId);
    const parentMeta = parent
      ? metadata.get(`experiences:${parent.id}`)
      : undefined;
    const inResume = !unique('projects', 'projectKey', row)
      ? null
      : project
        ? true
        : !complete || parentMeta?.inResume === null
          ? null
          : false;
    metadata.set(`projects:${row.id}`, {
      title: text(row.name) || 'Untitled project',
      context: parentMeta?.title || 'No linked experience',
      preview: short(text(row.summary)),
      kind: 'Project',
      inResume,
      parentExperienceId: parent ? text(parent.id) : undefined,
      hiddenReason:
        inResume === false
          ? parent
            ? 'This project is not rendered under its linked experience.'
            : 'Link this project to an experience in detailed records.'
          : inResume === null
            ? 'Canonical membership is unavailable for the loaded data.'
            : undefined,
    });
  }
  for (const key of ['achievements', 'duties'] as const) {
    for (const row of rows[key]) {
      const project = byId('projects', row.projectId);
      const canonicalParent = renderedBulletParent.get(text(row.id));
      const experience = canonicalParent
        ? rows.experiences.find(
            (entry) =>
              identity(entry, 'experienceKey') === canonicalParent &&
              unique('experiences', 'experienceKey', entry),
          )
        : (byId('experiences', row.experienceId) ??
          (project ? byId('experiences', project.experienceId) : undefined));
      const projectMeta = project
        ? metadata.get(`projects:${project.id}`)
        : undefined;
      const parentMeta = experience
        ? metadata.get(`experiences:${experience.id}`)
        : undefined;
      const rendered = (key === 'achievements' ? achievements : duties).has(
        text(row.id),
      );
      const inResume = rendered
        ? true
        : !complete ||
            parentMeta?.inResume === null ||
            projectMeta?.inResume === null
          ? null
          : false;
      metadata.set(`${key}:${row.id}`, {
        title:
          text(row.title) ||
          (key === 'achievements' ? 'Achievement' : 'Responsibility'),
        context:
          projectMeta?.title || parentMeta?.title || 'No linked experience',
        preview: short(text(row.body)),
        kind: key === 'achievements' ? 'Achievement' : 'Responsibility',
        inResume,
        parentExperienceId: experience ? text(experience.id) : undefined,
        hiddenReason:
          inResume === false
            ? 'Not rendered at its current placement or relationship. Manage placement in detailed records.'
            : inResume === null
              ? 'Canonical membership is unavailable for the loaded data.'
              : undefined,
      });
    }
  }
  const enriched = sections.map((section): CareerEditorSection => {
    const records = section.records.map((record) => {
      const row = byId(section.key, record.id) ?? {};
      let presentation = metadata.get(`${section.key}:${record.id}`);
      if (!presentation) {
        let inResume: boolean | null = true;
        let hiddenReason: string | undefined;
        if (section.key === 'other')
          inResume = isCanonicalOtherRoleEntry({
            role: text(row.role),
            company: text(row.company),
            period: text(row.period),
          })
            ? complete
              ? true
              : null
            : false;
        if (section.key === 'education')
          inResume = isCanonicalEducationEntry({
            title: text(row.title),
            detail: text(row.detail),
          })
            ? complete
              ? true
              : null
            : false;
        if (section.key === 'links')
          inResume = (text(row.profileKey) || 'default') === profileKey;
        if (
          section.key === 'skillCategories' ||
          section.key === 'skillGroups'
        ) {
          const field =
            section.key === 'skillCategories' ? 'categoryKey' : 'groupKey';
          const rendered = (
            section.key === 'skillCategories' ? categories : groups
          ).has(identity(row, field));
          inResume = !unique(section.key, field, row)
            ? null
            : rendered
              ? true
              : complete
                ? false
                : null;
        }
        if (inResume === false)
          hiddenReason =
            section.key === 'education'
              ? 'Add a title and detail to render this education entry.'
              : section.key === 'other'
                ? 'Add a role, company and period to render this entry.'
                : 'This entry is not rendered by the canonical resume. Manage its details below.';
        if (inResume === null)
          hiddenReason =
            'Canonical membership is unavailable for the loaded data.';
        const title =
          section.key === 'profile'
            ? source.profile.name || 'Summary & contact'
            : text(row.title) ||
              text(row.label) ||
              text(row.role) ||
              'Untitled entry';
        const context =
          text(row.institution) ||
          [text(row.company), text(row.period)].filter(Boolean).join(' · ') ||
          text(row.email);
        let preview =
          text(row.summary) ||
          text(row.detail) ||
          text(row.body) ||
          text(row.blurb) ||
          text(row.href);
        if (section.key === 'skillCategories') {
          const group = source.skills.groups.find(
            (item) => item.id === identity(row, 'categoryKey'),
          );
          const labels = group?.skills.map((skill) => skill.label) ?? [];
          preview = `${labels.slice(0, 3).join(' · ')}${labels.length > 3 ? ` · +${labels.length - 3} more` : ''}`;
        }
        if (section.key === 'skillGroups') {
          const group = source.skills.skillGroups.find(
            (item) => item.id === identity(row, 'groupKey'),
          );
          const labels = group?.skills ?? [];
          preview =
            `${labels.slice(0, 3).join(' · ')}${labels.length > 3 ? ` · +${labels.length - 3} more` : ''}` ||
            preview;
        }
        presentation = {
          title,
          context,
          preview: short(preview),
          inResume,
          hiddenReason,
          kind: section.label,
        };
      }
      return { ...record, presentation };
    });
    return {
      ...section,
      records,
      loadedComplete: complete,
      hiddenCount: records.filter(
        (record) => record.presentation.inResume === false,
      ).length,
    };
  });
  const skillExclusions: CareerSkillExclusion[] = dependencies.skillMembers
    .filter((member) => member.useOnResume === false)
    .map((member) => ({
      id: text(member.id),
      title: text(member.label) || 'Unnamed skill membership',
      context:
        text(byId('skillCategories', member.categoryId)?.label) ||
        'Skill category',
      href: '/admin/skill-category-members',
    }));
  return { sections: enriched, skillExclusions, loadedComplete: complete };
}
