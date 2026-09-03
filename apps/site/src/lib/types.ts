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

export interface Position {
  id: string;
  role: string;
  company: string;
  url?: string;
  companyHref?: string;
  /** Sort priority within a chronological tier; higher comes first. Defaults to 0. */
  weight?: number;
  start: string;
  end: string;
  blurb?: string;
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

export type FilterMode = 'and' | 'or';

export interface FilterState {
  tags: Set<string>;
  mode: FilterMode;
}
