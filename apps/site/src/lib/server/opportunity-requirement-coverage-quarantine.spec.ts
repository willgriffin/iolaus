import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  buildRequirementCoverageSource,
  type CoverageLedger,
  type RequirementCoverageContext,
  recoverPartialRequirementCoverageFromCapturedSource,
  validateRequirementCoverageAuditAdmission,
} from './opportunity-requirement-coverage.js';
import {
  QUARANTINED_SOURCE_COVERAGE_VERSION,
  quarantinePartialRequirementCoverageFromCompletedExtraction,
} from './opportunity-requirement-coverage-quarantine.js';

function mapped(text: string[]) {
  const context: RequirementCoverageContext = {
    extractionContract: 'current',
    sourceText: text.join('\n'),
    sourceFingerprint: 'native-source',
    sourceVersion: 1,
    extractionFingerprint: 'native-completed-extraction',
    preparedFingerprint: 'native-prepared',
  };
  const ledger = buildRequirementCoverageSource(context);
  ledger.requirements = ledger.clauses.map((clause, index) => ({
    id: `r${index}`,
    text: clause.text,
    clauseIds: [clause.id],
    importance: 'unknown',
  }));
  ledger.dispositions = ledger.clauses.map((clause, index) => ({
    clauseId: clause.id,
    type: 'role_duty',
    requirementIds: [`r${index}`],
  }));
  return { context, ledger };
}
function knak() {
  const value = mapped([
    'Design systems, plan architecture, improve quality.',
    '- Design independently and plan across teams.',
    '- Improve system quality.',
    '- Test systems.',
  ]);
  const clauses = value.ledger.clauses;
  value.ledger.requirements = [
    {
      id: 'r4',
      text: 'Design systems.',
      clauseIds: [clauses[0].id, clauses[1].id],
      importance: 'unknown',
    },
    {
      id: 'r5',
      text: 'Plan architecture.',
      clauseIds: [clauses[0].id, clauses[1].id],
      importance: 'unknown',
    },
    {
      id: 'r6',
      text: 'Improve quality.',
      clauseIds: [clauses[0].id, clauses[2].id],
      importance: 'unknown',
    },
    {
      id: 'r25',
      text: 'Design independently.',
      clauseIds: [clauses[1].id],
      importance: 'unknown',
    },
    {
      id: 'r26',
      text: 'Plan across teams.',
      clauseIds: [clauses[1].id],
      importance: 'unknown',
    },
    {
      id: 'r27',
      text: 'Improve system quality.',
      clauseIds: [clauses[2].id],
      importance: 'unknown',
    },
    {
      id: 'r30',
      text: 'Test systems.',
      clauseIds: [clauses[3].id],
      importance: 'unknown',
    },
  ];
  value.ledger.dispositions = [
    {
      clauseId: clauses[0].id,
      type: 'role_duty',
      requirementIds: ['r4', 'r5', 'r6'],
    },
    {
      clauseId: clauses[1].id,
      type: 'role_duty',
      requirementIds: ['r25', 'r26'],
    },
    { clauseId: clauses[2].id, type: 'role_duty', requirementIds: ['r27'] },
    { clauseId: clauses[3].id, type: 'role_duty', requirementIds: ['r30'] },
  ];
  return value;
}
describe('explicit immutable partial row quarantine', () => {
  it('quarantines the whole Knak-shaped three rows without inventing reverse links', () => {
    const { context, ledger } = knak(),
      original = structuredClone(ledger);
    const admission = validateRequirementCoverageAuditAdmission(
      context,
      ledger,
    );
    expect(admission.errors).toHaveLength(3);
    expect(admission.uncoveredClauseIds).toEqual([]);
    expect(
      recoverPartialRequirementCoverageFromCapturedSource(context, ledger),
    ).toBeUndefined();
    const view = quarantinePartialRequirementCoverageFromCompletedExtraction(
      context,
      ledger,
    );
    expect(view?.version).toBe(QUARANTINED_SOURCE_COVERAGE_VERSION);
    expect(view?.quarantinedRequirementIds).toEqual(['r4', 'r5', 'r6']);
    expect(view?.unresolvedClauses.map((row) => row.clauseId)).toEqual([
      ledger.clauses[1].id,
      ledger.clauses[2].id,
    ]);
    expect(view?.ledger).toEqual(original);
    expect(ledger).toEqual(original);
    expect(view?.originalLedgerFingerprint).toBe(
      createHash('sha256').update(JSON.stringify(original)).digest('hex'),
    );
    expect(
      validateRequirementCoverageAuditAdmission(context, view?.ledger)
        .structuralComplete,
    ).toBe(false);
    expect(view?.ledger.requirements).toHaveLength(7);
    expect(view?.ledger.dispositions[1].requirementIds).toEqual(['r25', 'r26']);
  });
  it('preserves an Agents-shaped reciprocal sibling while quarantining the entire partially reciprocal row', () => {
    const { context, ledger } = mapped([
      'Customer embedded engineering.',
      '- Map workflows and define scope.',
      '- Ship integrations.',
    ]);
    ledger.requirements[1].clauseIds.unshift(ledger.clauses[0].id);
    const view = quarantinePartialRequirementCoverageFromCompletedExtraction(
      context,
      ledger,
    );
    expect(view?.quarantinedRequirementIds).toEqual(['r1']);
    expect(view?.ledger.requirements[1].clauseIds).toEqual([
      ledger.clauses[0].id,
      ledger.clauses[1].id,
    ]);
    expect(
      view?.ledger.requirements
        .filter((row) => !view.quarantinedRequirementIds.includes(row.id))
        .map((row) => row.id),
    ).toEqual(['r0', 'r2']);
    expect(view?.unresolvedClauses[0].reason).toBe(
      'broken_reciprocal_requirement_mapping',
    );
  });
  it('keeps all four Cards-shaped unknown body clauses unknown and every exact reciprocal row unchanged', () => {
    const { context, ledger } = mapped([
      'What you bring',
      '- Ship code.',
      'Nice to have experience',
      '- Test code.',
      'Why FictionalCo?',
      '- Review code.',
      'ICYMI',
      '- Support code.',
    ]);
    ledger.requirements = ledger.requirements.filter(
      (_row, index) => index % 2 === 1,
    );
    for (const index of [0, 2, 4, 6])
      ledger.dispositions[index] = {
        clauseId: ledger.clauses[index].id,
        type: 'unknown',
        requirementIds: [],
      };
    const view = quarantinePartialRequirementCoverageFromCompletedExtraction(
      context,
      ledger,
    );
    expect(view?.quarantinedRequirementIds).toEqual([]);
    expect(view?.unresolvedClauses).toHaveLength(4);
    expect(
      view?.unresolvedClauses.every(
        (row) => row.reason === 'unresolved_clause_disposition',
      ),
    ).toBe(true);
    expect(view?.ledger).toEqual(ledger);
    expect(view?.ledger.clauses[0].kind).toBe('body');
    expect(view?.ledger.dispositions[0].type).toBe('unknown');
    expect(
      validateRequirementCoverageAuditAdmission(context, view?.ledger)
        .structuralComplete,
    ).toBe(false);
  });
  it('retains unsupported exclusions as unresolved without classifying them', () => {
    const { context, ledger } = mapped(['Role Summary', '- Ship code.']);
    ledger.requirements.shift();
    ledger.dispositions[0] = {
      clauseId: ledger.clauses[0].id,
      type: 'nonrequirement',
      requirementIds: [],
      exclusionRule: 'section_heading',
    };
    const view = quarantinePartialRequirementCoverageFromCompletedExtraction(
      context,
      ledger,
    );
    expect(view?.unresolvedClauses[0].reason).toBe(
      'unsupported_nonrequirement_exclusion',
    );
    expect(view?.ledger).toEqual(ledger);
  });
  it.each([
    'span',
    'hash',
    'unknown_row',
    'unknown_clause',
    'duplicate_row',
    'unknown_with_rows',
  ])('fails closed on %s corruption', (fault) => {
    const { context, ledger } = knak();
    if (fault === 'span') ledger.clauses[0].spanStart += 1;
    if (fault === 'hash') ledger.clauses[0].hash = 'forged';
    if (fault === 'unknown_row')
      ledger.dispositions[0].requirementIds.push('invented');
    if (fault === 'unknown_clause')
      ledger.requirements[0].clauseIds.push('invented');
    if (fault === 'duplicate_row')
      ledger.requirements.push(structuredClone(ledger.requirements[0]));
    if (fault === 'unknown_with_rows') ledger.dispositions[0].type = 'unknown';
    expect(
      quarantinePartialRequirementCoverageFromCompletedExtraction(
        context,
        ledger,
      ),
    ).toBeUndefined();
  });
  it('requires a viable reciprocal subset and refuses historical, audited, repaired or already valid ledgers', () => {
    const { context, ledger } = mapped(['- Ship code.', '- Test code.']);
    expect(
      quarantinePartialRequirementCoverageFromCompletedExtraction(
        context,
        ledger,
      ),
    ).toBeUndefined();
    ledger.requirements[0].clauseIds.push(ledger.clauses[1].id);
    ledger.requirements[1].clauseIds.push(ledger.clauses[0].id);
    expect(
      quarantinePartialRequirementCoverageFromCompletedExtraction(
        context,
        ledger,
      ),
    ).toBeUndefined();
    const value = knak();
    expect(
      quarantinePartialRequirementCoverageFromCompletedExtraction(
        { ...value.context, extractionContract: 'paid-v4-coverage-only4096' },
        value.ledger,
      ),
    ).toBeUndefined();
    expect(
      quarantinePartialRequirementCoverageFromCompletedExtraction(
        value.context,
        { ...value.ledger, audit: {} as CoverageLedger['audit'] },
      ),
    ).toBeUndefined();
  });
  it('binds the precise quarantine layout and unchanged original ledger into a distinct deterministic fingerprint', () => {
    const { context, ledger } = knak();
    const a = quarantinePartialRequirementCoverageFromCompletedExtraction(
      context,
      ledger,
    );
    expect(a).toEqual(
      quarantinePartialRequirementCoverageFromCompletedExtraction(
        context,
        ledger,
      ),
    );
    const changed = structuredClone(ledger);
    changed.requirements[0].text += ' with explicit ownership.';
    expect(
      quarantinePartialRequirementCoverageFromCompletedExtraction(
        context,
        changed,
      )?.fingerprint,
    ).not.toBe(a?.fingerprint);
  });
});
