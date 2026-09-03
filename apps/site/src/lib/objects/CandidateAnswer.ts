import { field, SmrtObject, smrt } from '@happyvertical/smrt-core';

// The private reusable candidate answer library. Rows are explicit
// user-approved answers ("save for reuse") that seed future ATS applications.
// Deliberately excluded from the generated API/CLI/MCP surfaces: answers can
// contain personal contact facts and must only move through the application
// workflow's own audited writers.
@smrt({
  tableName: 'candidate_answers',
  // A reusable answer belongs to one candidate profile and one canonical
  // question label. Do not use the default slug/context key: different labels
  // such as "C++" and "C#" can share a generated slug, and profiles must not
  // overwrite one another's answers.
  conflictColumns: ['profile_key', 'label_key'],
  api: { include: [] },
  cli: { include: [] },
  mcp: { include: [] },
})
export class CandidateAnswer extends SmrtObject {
  @field({ type: 'text' })
  profileKey = 'default';
  /** The question label exactly as supplied when the answer was saved. */
  @field({ type: 'text' })
  label = '';
  /** Normalized label (see normalizeAnswerLabel) used for conservative matching. */
  @field({ type: 'text' })
  labelKey = '';
  @field({ type: 'text' })
  value = '';
  @field({ type: 'boolean' })
  active = true;
}
