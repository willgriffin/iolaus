import { error } from '@sveltejs/kit';
import {
  type Achievement,
  applyTailoring,
  CANONICAL_TAILORING_NAME,
  CANONICAL_TAILORING_SLUG,
  canonicalResumeTailoringConfig,
  type Duty,
  type Project,
  type ResumeSource,
  type TailoringConfig,
} from '@willgriffin/iolaus-resume';
import {
  listPublishedResumeProfiles,
  listResumeTailoringConfigs,
  loadPublishedResumeSource,
  type ResumeProfileSummary,
  type ResumeTailoringRecord,
} from './resume-data.js';

/**
 * Bounded resume read for the WebMCP job-seeker surface (#415).
 *
 * Returns the tailored resume structure the packet pipeline already renders:
 * summary, skill groups, experience with projects and bullets, other
 * experience, education — for the default candidate profile, or for one
 * selected by `profileKey` from the returned `profiles` inventory (key, name,
 * active, default only). Excluded on purpose: the profile email, phone,
 * location, work-authorization preference, profile links (they come from
 * `CandidateProfileLink` records, which the threat model treats as
 * `CandidateProfile` contact facts alongside the canonical profile URLs),
 * attachments (file paths and visibility), and anything from the
 * `CandidateAnswer` library.
 */

const MAX_TAILORING_OPTIONS = 25;
const MAX_PROFILE_OPTIONS = 25;
const MAX_SKILL_GROUPS = 20;
const MAX_SKILLS_PER_GROUP = 60;
const MAX_POSITIONS = 30;
const MAX_PROJECTS_PER_POSITION = 20;
const MAX_ACHIEVEMENTS = 20;
const MAX_DUTIES = 20;
const MAX_TAGS = 30;
const MAX_OTHER_ROLES = 30;
const MAX_EDUCATION = 20;
const SUMMARY_MAX_LENGTH = 3_000;
const BODY_MAX_LENGTH = 1_000;
const SHORT_MAX_LENGTH = 600;

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function limitedText(value: unknown, maximum: number): string {
  const text = stringValue(value);
  return text.length > maximum ? `${text.slice(0, maximum)}…` : text;
}

function optionalString(value: unknown, label: string, maxLength: number) {
  const text = stringValue(value);
  if (text.length > maxLength) {
    error(400, `${label} must be ${maxLength} characters or fewer.`);
  }
  return text;
}

function tags(values: readonly string[] | undefined): string[] {
  return (values ?? []).map(stringValue).filter(Boolean).slice(0, MAX_TAGS);
}

function duties(values: readonly Duty[] | undefined) {
  return (values ?? []).slice(0, MAX_DUTIES).map((duty) => ({
    title: limitedText(duty.title, 200),
    body: limitedText(duty.body, SHORT_MAX_LENGTH),
  }));
}

function achievements(values: readonly Achievement[]) {
  return values.slice(0, MAX_ACHIEVEMENTS).map((achievement) => ({
    title: limitedText(achievement.title, 300),
    body: limitedText(achievement.body, BODY_MAX_LENGTH),
    metric: limitedText(achievement.metric, 200),
    tags: tags(achievement.tags),
  }));
}

function projects(values: readonly Project[] | undefined) {
  return (values ?? []).slice(0, MAX_PROJECTS_PER_POSITION).map((project) => ({
    id: stringValue(project.id),
    name: limitedText(project.name, 200),
    url: stringValue(project.url),
    summary: limitedText(project.summary, BODY_MAX_LENGTH),
    start: stringValue(project.start),
    end: stringValue(project.end),
    duties: duties(project.duties),
    achievements: achievements(project.achievements),
    tags: tags(project.tags),
  }));
}

/** Project the tailored source onto the bounded, contact-free response. */
export function boundedResume(source: ResumeSource) {
  const { profile, experience, skills } = source;
  return {
    profile: {
      name: limitedText(profile.name, 200),
      title: limitedText(profile.title, 300),
      summary: limitedText(profile.summary, SUMMARY_MAX_LENGTH),
    },
    skills: {
      groups: (skills.groups ?? []).slice(0, MAX_SKILL_GROUPS).map((group) => ({
        id: stringValue(group.id),
        label: limitedText(group.label, 200),
        skills: (group.skills ?? [])
          .slice(0, MAX_SKILLS_PER_GROUP)
          .map((skill) => ({
            id: stringValue(skill.id),
            label: limitedText(skill.label, 100),
          })),
      })),
      skillGroups: (skills.skillGroups ?? [])
        .slice(0, MAX_SKILL_GROUPS)
        .map((group) => ({
          id: stringValue(group.id),
          label: limitedText(group.label, 200),
          blurb: limitedText(group.blurb, SHORT_MAX_LENGTH),
          skills: (group.skills ?? [])
            .map(stringValue)
            .filter(Boolean)
            .slice(0, MAX_SKILLS_PER_GROUP),
        })),
    },
    experience: {
      positions: experience.positions
        .slice(0, MAX_POSITIONS)
        .map((position) => ({
          id: stringValue(position.id),
          role: limitedText(position.role, 200),
          company: limitedText(position.company, 200),
          companyHref: stringValue(position.companyHref ?? position.url),
          start: stringValue(position.start),
          end: stringValue(position.end),
          blurb: limitedText(position.blurb, BODY_MAX_LENGTH),
          duties: duties(position.duties),
          achievements: achievements(position.achievements),
          projects: projects(position.projects),
          tags: tags(position.tags),
        })),
      other: experience.other.slice(0, MAX_OTHER_ROLES).map((role) => ({
        role: limitedText(role.role, 200),
        company: limitedText(role.company, 200),
        period: limitedText(role.period, 100),
        body: limitedText(role.body, SHORT_MAX_LENGTH),
        tags: tags(role.tags),
      })),
      education: experience.education.slice(0, MAX_EDUCATION).map((entry) => ({
        title: limitedText(entry.title, 200),
        institution: limitedText(entry.institution, 200),
        detail: limitedText(entry.detail, SHORT_MAX_LENGTH),
      })),
    },
    truncated: {
      positions: experience.positions.length > MAX_POSITIONS,
      other: experience.other.length > MAX_OTHER_ROLES,
      education: experience.education.length > MAX_EDUCATION,
    },
  };
}

function tailoringOption(record: ResumeTailoringRecord) {
  return {
    slug: stringValue(record.configSlug),
    name: limitedText(record.name, 200),
    company: limitedText(record.company, 200),
  };
}

function profileOption(profile: ResumeProfileSummary) {
  return {
    key: limitedText(profile.key, 120),
    name: limitedText(profile.name, 200),
    active: profile.active,
    default: profile.default,
  };
}

export async function readJobSearchResume(input: Record<string, unknown>) {
  const requestedSlug = optionalString(input.tailoring, 'Tailoring slug', 120);
  const requestedProfileKey = optionalString(
    input.profileKey,
    'Profile key',
    120,
  );

  // Resolve the profile against the inventory before loading: an unknown key
  // must be a descriptive 404, never a silent fallback to another profile.
  const profiles = await listPublishedResumeProfiles();
  if (
    requestedProfileKey &&
    !profiles.some((profile) => profile.key === requestedProfileKey)
  ) {
    error(404, 'Resume profile not found.');
  }
  const profileKey =
    requestedProfileKey ||
    profiles.find((profile) => profile.default)?.key ||
    'default';

  const [source, configs] = await Promise.all([
    loadPublishedResumeSource(
      requestedProfileKey ? { profileKey: requestedProfileKey } : undefined,
    ),
    listResumeTailoringConfigs(),
  ]);
  const stored = configs.filter((record) => stringValue(record.configSlug));

  let selected: {
    config: TailoringConfig | undefined;
    name: string;
    slug: string;
    source: 'stored' | 'canonical_default';
  };
  if (requestedSlug) {
    const match = stored.find(
      (record) => stringValue(record.configSlug) === requestedSlug,
    );
    if (!match) error(404, 'Tailoring config not found.');
    selected = {
      config: match.config,
      name: stringValue(match.name),
      slug: requestedSlug,
      source: 'stored',
    };
  } else {
    const canonical = stored.find(
      (record) => stringValue(record.configSlug) === CANONICAL_TAILORING_SLUG,
    );
    selected = canonical
      ? {
          config: canonical.config,
          name: stringValue(canonical.name) || CANONICAL_TAILORING_NAME,
          slug: CANONICAL_TAILORING_SLUG,
          source: 'stored',
        }
      : {
          config: canonicalResumeTailoringConfig,
          name: CANONICAL_TAILORING_NAME,
          slug: CANONICAL_TAILORING_SLUG,
          source: 'canonical_default',
        };
  }

  const tailored = applyTailoring(
    source.profile,
    source.experience,
    source.skills,
    selected.config,
  );

  return {
    tailoring: {
      slug: selected.slug,
      name: selected.name,
      source: selected.source,
      available: stored.slice(0, MAX_TAILORING_OPTIONS).map(tailoringOption),
      availableTruncated: stored.length > MAX_TAILORING_OPTIONS,
    },
    profileKey,
    profiles: profiles.slice(0, MAX_PROFILE_OPTIONS).map(profileOption),
    profilesTruncated: profiles.length > MAX_PROFILE_OPTIONS,
    ...boundedResume(tailored),
    excluded: [
      'email',
      'phone',
      'location',
      'workAuthorization',
      'profileLinks',
      'attachments',
      'candidateAnswers',
    ],
  };
}
