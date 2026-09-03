#!/usr/bin/env tsx
/**
 * Sweep curated resume/profile evidence for skills that should be present in the
 * resume skill catalog and skill groups.
 *
 * Default mode is dry-run. Pass --apply to update apps/site/src/lib/data/*.json.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { normalizeSkill } from '../src/lib/skill-matching';

type Skill = { id: string; label: string };
type SkillCategory = { id: string; label: string; skills: Skill[] };
type SkillGroup = { id: string; label: string; skills: string[] };
type SkillsJson = { groups: SkillCategory[]; skillGroups: SkillGroup[] };
type Achievement = { body?: string; tags?: string[]; title?: string };
type Position = {
  achievements?: Achievement[];
  blurb?: string;
  body?: string;
  role?: string;
  tags?: string[];
  title?: string;
};
type ExperienceJson = { other?: Position[]; positions?: Position[] };
type ProfileJson = { summary?: string; title?: string };

type SkillInference = {
  categoryId: string;
  evidence: string[];
  groupId: string;
  id: string;
  label: string;
  tagMatchingAchievements?: boolean;
};

const root = resolve(import.meta.dirname, '..');
const skillsPath = resolve(root, 'src/lib/data/skills.json');
const experiencePath = resolve(root, 'src/lib/data/experience.json');
const profilePath = resolve(root, 'src/lib/data/profile.json');
const apply = process.argv.includes('--apply');

const inferredSkills: SkillInference[] = [
  {
    categoryId: 'cloud-devops',
    evidence: [
      'cloud infrastructure',
      'hybrid cloud infrastructure',
      'cloud solutions',
      'kubernetes cluster',
    ],
    groupId: 'g-devops',
    id: 'cloud-infrastructure',
    label: 'Cloud Infrastructure',
    tagMatchingAchievements: true,
  },
  {
    categoryId: 'cloud-devops',
    evidence: ['cloudnativepg', 'postgresql-on-kubernetes', 'postgres on kubernetes'],
    groupId: 'g-devops',
    id: 'cloudnativepg',
    label: 'CloudNativePG',
    tagMatchingAchievements: true,
  },
];

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}

function includesEvidence(haystack: string, evidence: string[]): boolean {
  const normalized = normalizeSkill(haystack);
  return evidence.some((term) => normalized.includes(normalizeSkill(term)));
}

function positionText(position: Position): string {
  return [
    position.role,
    position.title,
    position.blurb,
    position.body,
    ...(position.tags ?? []),
    ...(position.achievements ?? []).flatMap((achievement) => [
      achievement.title,
      achievement.body,
      ...(achievement.tags ?? []),
    ]),
  ]
    .filter(Boolean)
    .join(' ');
}

function allEvidenceText(profile: ProfileJson, experience: ExperienceJson): string {
  return [
    profile.title,
    profile.summary,
    ...(experience.positions ?? []).map(positionText),
    ...(experience.other ?? []).map(positionText),
  ]
    .filter(Boolean)
    .join(' ');
}

function addSkillToCategory(skills: SkillsJson, inferred: SkillInference): boolean {
  const category = skills.groups.find((group) => group.id === inferred.categoryId);
  if (!category) throw new Error(`Missing skill category ${inferred.categoryId}`);
  if (category.skills.some((skill) => skill.id === inferred.id)) return false;
  category.skills.push({ id: inferred.id, label: inferred.label });
  category.skills.sort((a, b) => a.label.localeCompare(b.label));
  return true;
}

function addSkillToGroup(skills: SkillsJson, inferred: SkillInference): boolean {
  const group = skills.skillGroups.find((item) => item.id === inferred.groupId);
  if (!group) throw new Error(`Missing skill group ${inferred.groupId}`);
  if (group.skills.includes(inferred.id)) return false;
  group.skills.push(inferred.id);
  return true;
}

function addTagToMatchingAchievements(
  experience: ExperienceJson,
  inferred: SkillInference,
): number {
  if (!inferred.tagMatchingAchievements) return 0;
  let count = 0;
  for (const position of [...(experience.positions ?? []), ...(experience.other ?? [])]) {
    for (const achievement of position.achievements ?? []) {
      const text = [achievement.title, achievement.body, ...(achievement.tags ?? [])]
        .filter(Boolean)
        .join(' ');
      if (!includesEvidence(text, inferred.evidence)) continue;
      achievement.tags ??= [];
      if (!achievement.tags.includes(inferred.id)) {
        achievement.tags.push(inferred.id);
        count += 1;
      }
    }
  }
  return count;
}

const skills = readJson<SkillsJson>(skillsPath);
const experience = readJson<ExperienceJson>(experiencePath);
const profile = readJson<ProfileJson>(profilePath);
const evidenceText = allEvidenceText(profile, experience);
const changes: string[] = [];

for (const inferred of inferredSkills) {
  if (!includesEvidence(evidenceText, inferred.evidence)) continue;
  if (addSkillToCategory(skills, inferred)) {
    changes.push(`add skill ${inferred.id} (${inferred.label}) to ${inferred.categoryId}`);
  }
  if (addSkillToGroup(skills, inferred)) {
    changes.push(`add skill ${inferred.id} to group ${inferred.groupId}`);
  }
  const tagged = addTagToMatchingAchievements(experience, inferred);
  if (tagged > 0) changes.push(`tag ${tagged} achievement(s) with ${inferred.id}`);
}

if (changes.length === 0) {
  console.log('No inferred skill updates needed.');
  process.exit(0);
}

console.log(`${apply ? 'Applying' : 'Dry-run'} inferred skill updates:`);
for (const change of changes) console.log(`- ${change}`);

if (apply) {
  writeFileSync(skillsPath, `${JSON.stringify(skills, null, 2)}\n`);
  writeFileSync(experiencePath, `${JSON.stringify(experience, null, 2)}\n`);
}
