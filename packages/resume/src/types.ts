export interface Profile {
  name: string;
  title: string;
  email: string;
  links: Array<{ label: string; href: string }>;
  summary: string;
}

export interface Skill {
  id: string;
  label: string;
}

export interface SkillCategory {
  id: string;
  label: string;
  skills: Skill[];
}

export interface SkillGroup {
  id: string;
  label: string;
  blurb: string;
  skills: string[];
}

export interface Skills {
  skillGroups: SkillGroup[];
  groups: SkillCategory[];
}

export interface Achievement {
  id?: string;
  title: string;
  body: string;
  metric?: string;
  tags: string[];
  attachments?: ResumeAttachment[];
}

export interface Duty {
  id?: string;
  title?: string;
  body: string;
  tags?: string[];
}

export interface Project {
  id: string;
  name: string;
  url?: string;
  summary?: string;
  start?: string;
  end?: string;
  duties?: Duty[];
  achievements: Achievement[];
  tags?: string[];
  attachments?: ResumeAttachment[];
}

export interface ResumeAttachment {
  id: string;
  filePath: string;
  kind: 'image' | 'document' | 'link' | 'video' | 'other';
  title?: string;
  caption?: string;
  altText?: string;
  mimeType?: string;
  sourceUrl?: string;
  visibility?: 'public' | 'private' | 'confidential';
}

export interface Position {
  id: string;
  role: string;
  company: string;
  url?: string;
  companyHref?: string;
  weight?: number;
  start: string;
  end: string;
  blurb?: string;
  compact?: boolean;
  duties?: Duty[];
  projects?: Project[];
  tags?: string[];
  achievements: Achievement[];
}

export interface OtherRole {
  role: string;
  company: string;
  period: string;
  body?: string;
  tags?: string[];
}

export interface Education {
  title: string;
  institution?: string;
  detail: string;
}

export interface Experience {
  positions: Position[];
  other: OtherRole[];
  education: Education[];
}

export interface ResumeSource {
  profile: Profile;
  experience: Experience;
  skills: Skills;
}

export interface TailoringConfig {
  name?: string;
  company?: string;
  outputSlug?: string;
  outputBasename?: string;
  copyToSite?: boolean;
  title?: string;
  summary?: string;
  includePositionIds?: string[];
  excludePositionIds?: string[];
  includeExperienceIds?: string[];
  excludeExperienceIds?: string[];
  compactExperienceIds?: string[];
  includeProjectIds?: string[];
  excludeProjectIds?: string[];
  includeOtherCompanies?: string[];
  excludeOtherCompanies?: string[];
  includeEducationTitles?: string[];
  excludeEducationTitles?: string[];
  hideOtherExperience?: boolean;
  includeDuties?: boolean;
  includeSkillGroupIds?: string[];
  excludeSkillIds?: string[];
  emphasizeTags?: string[];
  excludeTags?: string[];
  maxAchievementsPerPosition?: number;
  maxAchievementsPerProject?: number;
  maxOtherRoles?: number;
  maxProjectsPerPosition?: number;
  pinnedAchievementTitles?: Record<string, string[]>;
  droppedAchievementTitles?: Record<string, string[]>;
  hideSkills?: boolean;
  hideTags?: boolean;
  footerLink?: ResumeFooterLink;
}

export interface ResumeFooterLink {
  label: string;
  url: string;
}

export type ResumeRenderOptions = Pick<
  TailoringConfig,
  'hideSkills' | 'hideTags' | 'footerLink'
>;

export interface GeneratedResumeArtifact {
  htmlPath: string;
  markdownPath: string;
  pdfBasename: string;
  pdfPath: string;
  slug: string;
  source: ResumeSource;
  textPath: string;
  outputPrefix: string;
}
