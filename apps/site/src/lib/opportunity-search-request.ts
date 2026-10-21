import {
  type PublicSearchInput,
  publicSearchInputSchema,
} from './public-opportunity-contract.js';
import { interpretOpportunitySearch } from './search-interpretation.js';

/** Natural-language UI input is kept separate from the public API's FTS query. */
export function opportunitySearchRequest(url: URL) {
  const parameters: Record<string, unknown> = {};
  const lists = new Set([
    'skills',
    'seniority',
    'function',
    'work_mode',
    'employment_type',
    'country',
  ]);
  const ui = {
    start: ['1'],
    view: ['triage', 'list'],
    skills_mode: ['replace'],
  };
  for (const [key, allowed] of Object.entries(ui)) {
    const values = url.searchParams.getAll(key);
    if (values.length > 1 || (values.length && !allowed.includes(values[0])))
      throw new Error('Invalid search option.');
  }
  const replaceSkills = url.searchParams.get('skills_mode') === 'replace';
  for (const [key, value] of url.searchParams) {
    if (key === 'search' || Object.hasOwn(ui, key)) continue;
    if (
      value === '' &&
      [
        'salary_min',
        'salary_currency',
        'salary_period',
        'location',
        'company',
        'source',
        'posted_since',
        'cursor',
      ].includes(key)
    )
      continue;
    if (lists.has(key))
      parameters[key] = [
        ...((parameters[key] as string[]) ?? []),
        ...value.split(',').filter(Boolean),
      ];
    else if (key in parameters) throw new Error('Duplicate search parameter.');
    else if (key === 'remote_ok') {
      if (value !== 'true' && value !== 'false')
        throw new Error('Invalid remote preference.');
      parameters[key] = value === 'true';
    } else parameters[key] = value;
  }
  if (url.searchParams.getAll('search').length > 1)
    throw new Error('Duplicate search.');
  const raw = url.searchParams.get('search');
  const interpretation = raw !== null ? interpretOpportunitySearch(raw) : null;
  if (
    interpretation &&
    !replaceSkills &&
    Array.isArray(parameters.skills) &&
    parameters.skills.length
  ) {
    parameters.skills = [
      ...new Set([...interpretation.input.skills, ...parameters.skills]),
    ];
  }
  const input: PublicSearchInput = publicSearchInputSchema.parse({
    ...(interpretation?.input ?? {}),
    ...(replaceSkills ? { skills: [] } : {}),
    ...parameters,
  });
  const submitted = Boolean(
    url.searchParams.get('start') === '1' ||
      input.location ||
      raw?.trim() ||
      input.q ||
      input.skills.length ||
      input.seniority.length ||
      input.work_mode.length ||
      input.country.length ||
      input.employment_type.length ||
      input.function.length ||
      input.company ||
      input.source ||
      input.salary_min !== undefined ||
      input.posted_since ||
      input.remote_ok !== undefined,
  );
  if (interpretation) {
    interpretation.chips = interpretation.chips.filter((chip) =>
      input[chip.kind === 'skill' ? 'skills' : chip.kind].includes(chip.value),
    );
  }
  const view: 'list' | 'triage' =
    url.searchParams.get('view') === 'list' ? 'list' : 'triage';
  return { input, interpretation, submitted, view };
}
