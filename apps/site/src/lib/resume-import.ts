export type ResumeImportStatus = 'processing' | 'review' | 'applied' | 'failed';
export type ResumeImportAction = 'create' | 'merge' | 'skip';

export type ResumeImportEvidence = { page: number; text: string };
export type ResumeImportCandidate = {
  id: string;
  label: string;
  summary?: string;
};

type ResumeImportEntryBase = {
  id: string;
  evidence?: ResumeImportEvidence[];
  candidateMatches?: ResumeImportCandidate[];
  uncertain?: boolean;
};

export type ResumeImportExperience = ResumeImportEntryBase & {
  kind: 'experience';
  fields: Partial<
    Record<
      | 'company'
      | 'title'
      | 'startDate'
      | 'endDate'
      | 'summary'
      | 'bullets'
      | 'bulletSections',
      string
    >
  >;
};
export type ResumeImportProject = ResumeImportEntryBase & {
  kind: 'project';
  fields: Partial<
    Record<
      | 'name'
      | 'url'
      | 'summary'
      | 'startDate'
      | 'endDate'
      | 'proposalExperienceId'
      | 'bullets'
      | 'bulletSections',
      string
    >
  >;
};
export type ResumeImportEducation = ResumeImportEntryBase & {
  kind: 'education';
  fields: Partial<
    Record<'title' | 'institution' | 'startDate' | 'endDate' | 'detail', string>
  >;
};
export type ResumeImportSkill = ResumeImportEntryBase & {
  kind: 'skill';
  fields: Partial<Record<'name' | 'skillEvidence', string>>;
};
export type ResumeImportProfile = ResumeImportEntryBase & {
  kind: 'profile';
  fields: Partial<Record<'summary', string>>;
};

export type ResumeImportEntry =
  | ResumeImportExperience
  | ResumeImportProject
  | ResumeImportEducation
  | ResumeImportSkill
  | ResumeImportProfile;

export type ResumeImportProgressStage =
  | 'queued'
  | 'reading_pdf'
  | 'reading_scan'
  | 'extracting_details'
  | 'matching'
  | 'model_output_limit';

/** Maximum review decisions or extracted proposal entries for one resume import. */
export const RESUME_IMPORT_MAX_ENTRIES = 200;

export type ResumeImportView = {
  id: string;
  status: ResumeImportStatus;
  revision: string;
  filename: string;
  progress?: ResumeImportProgressStage;
  warnings: string[];
  error?: string;
  entries: ResumeImportEntry[];
};

export type ResumeImportApplyEntry = {
  id: string;
  action: ResumeImportAction;
  targetId?: string;
  fields: Record<string, string>;
};

const fieldKeys: Record<ResumeImportEntry['kind'], readonly string[]> = {
  experience: [
    'company',
    'title',
    'startDate',
    'endDate',
    'summary',
    'bullets',
    'bulletSections',
  ],
  education: ['title', 'institution', 'startDate', 'endDate', 'detail'],
  project: [
    'name',
    'url',
    'summary',
    'startDate',
    'endDate',
    'proposalExperienceId',
    'bullets',
    'bulletSections',
  ],
  // Evidence is proposal metadata, displayed read-only and never submitted in
  // a browser decision. The apply domain reads the pinned proposal instead.
  skill: ['name'],
  profile: ['summary'],
};

export function editableResumeImportFields(
  entry: ResumeImportEntry,
): Record<string, string> {
  const allowed = fieldKeys[entry.kind];
  return Object.fromEntries(
    allowed.map((key) => [
      key,
      typeof entry.fields[key as never] === 'string'
        ? entry.fields[key as never]
        : '',
    ]),
  );
}

export function defaultResumeImportAction(
  entry: ResumeImportEntry,
): ResumeImportAction {
  if (entry.kind === 'profile' && entry.candidateMatches?.length === 1)
    return 'merge';
  return entry.uncertain || (entry.candidateMatches?.length ?? 0) > 0
    ? 'skip'
    : 'create';
}
