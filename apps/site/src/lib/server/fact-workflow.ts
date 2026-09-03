import {
  createFactEvidenceKey,
  FactCollection,
  FactEvidenceCollection,
  type FactExtractionCandidate,
  FactSubjectCollection,
  type FactType,
} from '@happyvertical/smrt-facts';
import type { User } from '@happyvertical/smrt-users';
import { error } from '@sveltejs/kit';
import { getCollection, getRequestScopedSmrtOptions } from './smrt.js';

type MutableRecord = Record<string, unknown> & {
  id?: string;
  save: () => Promise<void>;
};

const factTypes = new Set([
  'assertion',
  'observation',
  'measurement',
  'definition',
  'relationship',
  'event',
  'opinion',
  'prediction',
]);

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeFactType(value: unknown): FactType {
  const normalized = stringValue(value);
  return factTypes.has(normalized) ? (normalized as FactType) : 'assertion';
}

function fallbackCandidates(text: string): FactExtractionCandidate[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .slice(0, 12)
    .map((statement) => ({
      confidence: 0.45,
      sourceExcerpt: statement,
      statement,
      type: 'assertion',
    }));
}

function errorMessage(value: unknown): string {
  if (value instanceof Error) return value.message;
  return String(value);
}

export async function createFactIntakeFromText(options: {
  intakeContext?: string;
  createdByProfileId?: string;
  rawText: string;
  sourceKind?: string;
  targetEntityId?: string;
  targetEntityType?: string;
  user?: Pick<User, 'id'> | null;
}) {
  const rawText = stringValue(options.rawText);
  if (!rawText) {
    error(400, 'Fact intake requires raw text.');
  }

  const sourceKind = stringValue(options.sourceKind) || 'story';
  const targetEntityType = stringValue(options.targetEntityType);
  const targetEntityId = stringValue(options.targetEntityId);
  const intakeCollection = await getCollection('FactIntake');
  const candidateCollection = await getCollection('FactCandidate');
  const facts = await FactCollection.create(getRequestScopedSmrtOptions());
  const now = new Date();
  const intake = (await intakeCollection.create({
    intakeContext: stringValue(options.intakeContext),
    createdByProfileId: stringValue(options.createdByProfileId),
    createdByUserId: stringValue(options.user?.id),
    rawText,
    sourceKind,
    status: 'draft',
    targetEntityId,
    targetEntityType,
  })) as unknown as MutableRecord;
  await intake.save();

  let candidates: FactExtractionCandidate[] = [];
  let extractionError = '';
  try {
    candidates = await facts.extractCandidatesFromText(rawText, {
      context: stringValue(options.intakeContext),
      domain: 'employment',
      maxFacts: 12,
      sourceType: sourceKind,
    });
  } catch (error) {
    extractionError = errorMessage(error);
    candidates = fallbackCandidates(rawText);
  }

  const savedCandidates = [];
  for (const candidate of candidates) {
    const record = (await candidateCollection.create({
      confidence: candidate.confidence ?? null,
      factIntakeId: stringValue(intake.id),
      factType: normalizeFactType(candidate.type),
      reviewStatus: 'pending',
      sourceExcerpt: stringValue(candidate.sourceExcerpt),
      statement: candidate.statement,
      targetEntityId,
      targetEntityType,
    })) as unknown as MutableRecord;
    await record.save();
    savedCandidates.push(JSON.parse(JSON.stringify(record)));
  }

  Object.assign(intake, {
    extractedAt: now,
    extractedCandidatesJson: JSON.stringify(candidates),
    notes: extractionError
      ? JSON.stringify({
          extractionError,
          extractionMode: 'fallback',
        })
      : stringValue(intake.notes),
    status: 'extracted',
  });
  await intake.save();

  return {
    candidates: savedCandidates,
    intake: JSON.parse(JSON.stringify(intake)),
  };
}

export async function acceptFactCandidate(options: {
  candidateId: string;
  reviewedByProfileId?: string;
  user?: Pick<User, 'id'> | null;
}) {
  const candidateCollection = await getCollection('FactCandidate');
  const intakeCollection = await getCollection('FactIntake');
  const candidate = (await candidateCollection.get(
    options.candidateId,
  )) as unknown as MutableRecord | null;
  if (!candidate) {
    error(404, 'Fact candidate not found.');
  }

  const statement =
    stringValue(candidate.editedStatement) || stringValue(candidate.statement);
  if (!statement) {
    error(400, 'Fact candidate has no statement.');
  }

  const intake = stringValue(candidate.factIntakeId)
    ? ((await intakeCollection.get(
        stringValue(candidate.factIntakeId),
      )) as unknown as MutableRecord | null)
    : null;
  const smrtOptions = getRequestScopedSmrtOptions();
  const facts = await FactCollection.create(smrtOptions);
  const result = await facts.reconcile({
    domain: 'employment',
    rawInput: statement,
    source: {
      credibility: numberValue(candidate.confidence) ?? 0.7,
      metadata: {
        factCandidateId: stringValue(candidate.id),
        factIntakeId: stringValue(candidate.factIntakeId),
      },
      sourceTitle: intake
        ? `Fact intake ${stringValue(intake.id)}`
        : 'Fact candidate',
      sourceType: stringValue(intake?.sourceKind) || 'story',
    },
    type: normalizeFactType(candidate.factType),
  });

  const factId = stringValue(result.fact.id);
  const evidence = await FactEvidenceCollection.create(smrtOptions);
  const quote = stringValue(candidate.sourceExcerpt) || statement;
  // A FactCandidate may have no factIntakeId. Fall back to the candidate itself
  // as the evidence source so we never write empty sourceId / misleading
  // 'fact_intake' sourceKind (which would also collide on the evidence key).
  const factIntakeId = stringValue(candidate.factIntakeId);
  const evidenceSourceKind = factIntakeId ? 'fact_intake' : 'fact_candidate';
  const evidenceSourceId = factIntakeId || stringValue(candidate.id);
  const evidenceRecord = await evidence.create({
    confidence: numberValue(candidate.confidence) ?? 0.7,
    evidenceKey: createFactEvidenceKey({
      locator: stringValue(candidate.id),
      quote,
      sourceId: evidenceSourceId,
      sourceKind: evidenceSourceKind,
    }),
    extractionMethod: 'application_review',
    factId,
    locator: stringValue(candidate.id),
    metadata: JSON.stringify({
      factCandidateId: stringValue(candidate.id),
      factIntakeId,
    }),
    quote,
    sourceId: evidenceSourceId,
    sourceKind: evidenceSourceKind,
    sourceTitle: intake
      ? `Fact intake ${stringValue(intake.id)}`
      : 'Fact candidate',
    status: 'supports',
  });
  await evidenceRecord.save();

  const targetEntityType = stringValue(candidate.targetEntityType);
  const targetEntityId = stringValue(candidate.targetEntityId);
  if (targetEntityType && targetEntityId) {
    const subjects = await FactSubjectCollection.create(smrtOptions);
    const subject = await subjects.create({
      entityId: targetEntityId,
      entityType: targetEntityType,
      factId,
      metadata: JSON.stringify({
        factCandidateId: stringValue(candidate.id),
        factIntakeId: stringValue(candidate.factIntakeId),
      }),
      role: 'subject',
    });
    await subject.save();
  }

  Object.assign(candidate, {
    createdFactId: factId,
    reviewedAt: new Date(),
    reviewedByProfileId: stringValue(options.reviewedByProfileId),
    reviewedByUserId: stringValue(options.user?.id),
    reviewStatus: 'accepted',
  });
  await candidate.save();

  return {
    candidate: JSON.parse(JSON.stringify(candidate)),
    fact: JSON.parse(JSON.stringify(result.fact)),
  };
}
