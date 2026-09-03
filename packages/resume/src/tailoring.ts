import type {
  Achievement,
  Education,
  Experience,
  Position,
  Profile,
  ResumeSource,
  Skills,
  TailoringConfig,
} from './types.js';

function hasAnyTag(
  tags: string[] | undefined,
  candidates: Set<string>,
): boolean {
  return Boolean(tags?.some((tag) => candidates.has(tag)));
}

function byPreferredTags(
  a: Achievement,
  b: Achievement,
  preferred: Set<string>,
): number {
  const aHit = hasAnyTag(a.tags, preferred) ? 1 : 0;
  const bHit = hasAnyTag(b.tags, preferred) ? 1 : 0;
  return bHit - aHit;
}

function normalizeCompany(value: string): string {
  return value.trim().toLowerCase();
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function filterByIds<T extends { id: string }>(
  items: T[],
  includeIds: string[] | undefined,
  excludeIds: string[] | undefined,
): T[] {
  const include = includeIds ? new Set(includeIds) : undefined;
  const exclude = excludeIds ? new Set(excludeIds) : undefined;
  return items.filter((item) => {
    if (include && !include.has(item.id)) return false;
    if (exclude?.has(item.id)) return false;
    return true;
  });
}

function filterEducationByTitles(
  education: Education[],
  includeTitles: string[] | undefined,
  excludeTitles: string[] | undefined,
): Education[] {
  const include = includeTitles ? new Set(includeTitles) : undefined;
  const exclude = new Set(excludeTitles ?? []);
  return education.filter((item) => {
    if (include && !include.has(item.title)) return false;
    return !exclude.has(item.title);
  });
}

function titlesForIds(
  values: Record<string, string[]> | undefined,
  ids: string[],
): Set<string> {
  return new Set(ids.flatMap((id) => values?.[id] ?? []));
}

function tailorAchievements(
  position: Position,
  config: TailoringConfig,
  fallbackIds: string[] = [],
  maxAchievements = config.maxAchievementsPerPosition,
): Achievement[] {
  const ids = [position.id, ...fallbackIds];
  const emphasizeTags = new Set(config.emphasizeTags ?? []);
  const excludeTags = new Set(config.excludeTags ?? []);
  const pinnedTitles = titlesForIds(config.pinnedAchievementTitles, ids);
  const droppedTitles = titlesForIds(config.droppedAchievementTitles, ids);

  const retained = position.achievements.filter((achievement) => {
    if (droppedTitles.has(achievement.title)) return false;
    if (pinnedTitles.has(achievement.title)) return true;
    return !hasAnyTag(achievement.tags, excludeTags);
  });

  const ordered = [...retained].sort((a, b) => {
    const pinned =
      Number(pinnedTitles.has(b.title)) - Number(pinnedTitles.has(a.title));
    if (pinned !== 0) return pinned;
    return byPreferredTags(a, b, emphasizeTags);
  });

  if (!maxAchievements) return ordered;

  const limited = ordered.slice(0, maxAchievements);
  for (const achievement of ordered) {
    if (limited.includes(achievement)) continue;
    if (pinnedTitles.has(achievement.title)) limited.push(achievement);
  }
  return limited;
}

function positionHasRenderableContent(position: Position): boolean {
  return (
    position.achievements.length > 0 ||
    Boolean(position.duties?.length) ||
    Boolean(
      position.projects?.some(
        (project) => project.achievements.length > 0 || project.duties?.length,
      ),
    )
  );
}

function yearOf(value: string): string {
  // Accepts "2003-06", "2003", and the fixture form "Jun 2003".
  const match = /(?:^|\s)(\d{4})(?:-|$)/.exec(value);
  return match ? match[1] : value;
}

function startYear(period: string): number {
  const match = /(\d{4})/.exec(period);
  return match ? Number(match[1]) : 0;
}

function compactRoleFromPosition(position: Position) {
  return {
    body: position.blurb,
    company: position.company,
    period: `${yearOf(position.start)}\u2013${yearOf(position.end)}`,
    role: position.role,
    tags: position.tags,
  };
}

export function applyTailoring(
  profile: Profile,
  experience: Experience,
  skills: Skills,
  config: TailoringConfig | undefined,
): ResumeSource {
  const tailoredProfile = cloneJson(profile);
  const tailoredExperience = cloneJson(experience);
  const tailoredSkills = cloneJson(skills);

  if (!config) {
    return {
      profile: tailoredProfile,
      experience: tailoredExperience,
      skills: tailoredSkills,
    };
  }

  if (config.title) tailoredProfile.title = config.title;
  if (config.summary) tailoredProfile.summary = config.summary;

  tailoredExperience.education = filterEducationByTitles(
    tailoredExperience.education,
    config.includeEducationTitles,
    config.excludeEducationTitles,
  );

  const compactExperienceIds = new Set(config.compactExperienceIds ?? []);
  const includeExperienceIds =
    config.includeExperienceIds ?? config.includePositionIds;
  const excludeExperienceIds =
    config.excludeExperienceIds ?? config.excludePositionIds;
  const includeProjectIds = config.includeProjectIds
    ? new Set(config.includeProjectIds)
    : undefined;
  const excludeProjectIds = new Set(config.excludeProjectIds ?? []);
  const maxProjectsPerPosition = config.maxProjectsPerPosition;

  const compactPositions = tailoredExperience.positions.filter((position) =>
    compactExperienceIds.has(position.id),
  );

  tailoredExperience.positions = filterByIds(
    tailoredExperience.positions,
    includeExperienceIds,
    excludeExperienceIds,
  )
    .filter((position) => !compactExperienceIds.has(position.id))
    .map((position) => ({
      ...position,
      duties: config.includeDuties === false ? [] : position.duties,
      projects: (position.projects ?? [])
        .filter((project) => {
          if (includeProjectIds && !includeProjectIds.has(project.id))
            return false;
          if (excludeProjectIds.has(project.id)) return false;
          return true;
        })
        .slice(0, maxProjectsPerPosition || undefined)
        .map((project) => ({
          ...project,
          duties: config.includeDuties === false ? [] : project.duties,
          achievements: tailorAchievements(
            { ...position, id: project.id, achievements: project.achievements },
            config,
            [position.id],
            config.maxAchievementsPerProject ??
              config.maxAchievementsPerPosition,
          ),
        })),
      achievements: tailorAchievements(position, config),
    }))
    .filter(positionHasRenderableContent);

  if (config.hideOtherExperience) {
    tailoredExperience.other = [];
  } else {
    const includeCompanies = config.includeOtherCompanies
      ? new Set(config.includeOtherCompanies.map(normalizeCompany))
      : undefined;
    const excludeCompanies = new Set(
      (config.excludeOtherCompanies ?? []).map(normalizeCompany),
    );
    const excludeTags = new Set(config.excludeTags ?? []);

    tailoredExperience.other = tailoredExperience.other.filter((role) => {
      const company = normalizeCompany(role.company);
      if (includeCompanies && !includeCompanies.has(company)) return false;
      if (excludeCompanies.has(company)) return false;
      return !hasAnyTag(role.tags, excludeTags);
    });

    if (config.maxOtherRoles) {
      tailoredExperience.other = tailoredExperience.other.slice(
        0,
        config.maxOtherRoles,
      );
    }
  }

  if (compactPositions.length > 0 && !config.hideOtherExperience) {
    // Authored other roles are listed newest first; keep compacted positions
    // in that order instead of appending them after the oldest entry.
    tailoredExperience.other = [
      ...tailoredExperience.other,
      ...compactPositions.map(compactRoleFromPosition),
    ].sort((a, b) => startYear(b.period) - startYear(a.period));
  }

  if (config.includeSkillGroupIds) {
    const included = new Set(config.includeSkillGroupIds);
    tailoredSkills.groups = tailoredSkills.groups.filter((group) =>
      included.has(group.id),
    );
  }

  if (config.excludeSkillIds) {
    const excluded = new Set(config.excludeSkillIds);
    tailoredSkills.groups = tailoredSkills.groups
      .map((group) => ({
        ...group,
        skills: group.skills.filter((skill) => !excluded.has(skill.id)),
      }))
      .filter((group) => group.skills.length > 0);
  }

  if (config.emphasizeTags?.length) {
    const emphasized = new Set(config.emphasizeTags);
    tailoredSkills.groups = tailoredSkills.groups.map((group) => ({
      ...group,
      skills: [...group.skills].sort((a, b) => {
        const aHit = emphasized.has(a.id) ? 1 : 0;
        const bHit = emphasized.has(b.id) ? 1 : 0;
        return bHit - aHit;
      }),
    }));
  }

  return {
    profile: tailoredProfile,
    experience: tailoredExperience,
    skills: tailoredSkills,
  };
}
