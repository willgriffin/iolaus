import { getDatabase } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { createScreeningQuestion } from '../opportunity-screening-questions.js';
import { createMatchingProjectionFixture } from './fixtures/matching-projection.js';
import { matchingCandidateEvidenceDigest } from './matching-candidate-store.js';
import {
  loadMatchingCandidateInput,
  matchingPostingInput,
  readMatchingPreferences,
} from './matching-projection-input.js';
import { fingerprintOpportunitySourceContent } from './opportunity-source-content.js';
import { SCREENING_QUESTION_RULE_VERSION } from './screening-question-store.js';

describe('matching inputs', () => {
  it('keeps explicit target roles and multiple places separate from career data', () => {
    expect(
      readMatchingPreferences({
        title: 'Previous occupation',
        workModes: ['remote'],
        targetRoles: ['Backend Engineer', 'Data Engineer', 'Backend Engineer'],
        locations: ['Canada', 'Edmonton'],
      }),
    ).toEqual({
      targetRoles: ['Backend Engineer', 'Data Engineer'],
      locations: ['Canada', 'Edmonton'],
      workModes: ['remote'],
      remoteCountries: [],
    });
    expect(readMatchingPreferences({ targetRoles: ['Good', 1] })).toBeNull();
  });

  it('passes the original description through so citations retain raw offsets', () => {
    const raw = 'Intro\nRequired skills: Postgres';
    expect(
      matchingPostingInput({
        title: 'Backend Engineer',
        description_raw: raw,
        location_notes: 'Remote (Canada)',
        locations: 'Toronto',
        work_mode: 'remote',
      }),
    ).toEqual({
      title: 'Backend Engineer',
      description: raw,
      location: 'Remote (Canada)',
      workplaceType: 'remote',
    });
  });

  it('uses verified original capture and withholds malformed captures instead of trusting projected fields', () => {
    const captured = {
      title: 'Backend Engineer',
      descriptionRaw: 'Required skills: Postgres',
      locationNotes: 'Remote (Canada)',
      workMode: 'remote',
    };
    const row = {
      title: 'Derived job title',
      description_raw: 'No requirements',
      location_notes: 'Anywhere',
      source_content_json: JSON.stringify(captured),
      source_content_fingerprint: fingerprintOpportunitySourceContent(captured),
      source_content_version: 1,
    };
    expect(matchingPostingInput(row)).toEqual({
      title: captured.title,
      description: captured.descriptionRaw,
      location: captured.locationNotes,
      workplaceType: captured.workMode,
    });
    expect(
      matchingPostingInput({
        ...row,
        source_content_json: '{"descriptionRaw":"No requirements"}',
      }),
    ).toEqual({ title: '', description: '', location: '' });
  });

  it('reads only evidence from the owned active tuple and preserves unresolved enabled questions', async () => {
    const db = await getDatabase({
      type: 'sqlite',
      url: ':memory:',
      cache: false,
    });
    const subject = {
      tenantId: 'tenant',
      userId: 'owner',
      profileId: 'profile',
    };
    try {
      await db.query(
        'CREATE TABLE candidate_profiles (id TEXT, tenant_id TEXT, owner_user_id TEXT, active BOOLEAN, preferences_json TEXT, facts_json TEXT, target_work_country_json TEXT, summary TEXT, use_on_resume BOOLEAN)',
      );
      await db.query(
        'CREATE TABLE resume_skills (id TEXT, tenant_id TEXT, owner_user_id TEXT, candidate_profile_id TEXT, label TEXT)',
      );
      await db.query(
        'CREATE TABLE resume_positions (id TEXT, tenant_id TEXT, owner_user_id TEXT, candidate_profile_id TEXT, position_id TEXT, role TEXT, company TEXT, blurb TEXT, start TEXT, end_label TEXT)',
      );
      await db.query(
        'CREATE TABLE resume_achievements (id TEXT, tenant_id TEXT, owner_user_id TEXT, candidate_profile_id TEXT, position_id TEXT, title TEXT, body TEXT, metric TEXT)',
      );
      const ownedCareer =
        'id TEXT, tenant_id TEXT, owner_user_id TEXT, candidate_profile_id TEXT, use_on_resume BOOLEAN';
      for (const [name, fields] of Object.entries({
        resume_other_roles: 'role TEXT, company TEXT, period TEXT, body TEXT',
        experiences: 'summary TEXT',
        projects: 'experience_id TEXT, name TEXT, summary TEXT',
        achievements:
          'experience_id TEXT, project_id TEXT, title TEXT, body TEXT, metric TEXT',
        duties: 'experience_id TEXT, project_id TEXT, title TEXT, body TEXT',
      }))
        await db.query(`CREATE TABLE ${name} (${ownedCareer}, ${fields})`);
      await db.query(
        'CREATE TABLE preference_rules (id TEXT, tenant_id TEXT, owner_user_id TEXT, candidate_profile_id TEXT, category TEXT, name TEXT, description TEXT, active BOOLEAN, rule_json TEXT)',
      );
      await db.query(
        'INSERT INTO candidate_profiles (id, tenant_id, owner_user_id, active, preferences_json, facts_json, target_work_country_json) VALUES (?, ?, ?, TRUE, ?, ?, ?)',
        [
          'profile',
          'tenant',
          'owner',
          JSON.stringify({ targetRoles: ['Backend Engineer'] }),
          JSON.stringify({
            version: 1,
            facts: {
              skillExperience: {
                provenance: 'user_verified',
                value: 'I have never used Kubernetes.',
              },
            },
          }),
          JSON.stringify({ code: 'CA', label: 'Canada' }),
        ],
      );
      for (const row of [
        ['own', 'tenant', 'owner', 'profile', 'Postgres'],
        ['sibling', 'tenant', 'owner', 'sibling-profile', 'Kubernetes'],
        ['foreign-user', 'tenant', 'other', 'profile', 'Node.js'],
        ['foreign-tenant', 'other', 'owner', 'profile', 'TypeScript'],
      ])
        await db.query('INSERT INTO resume_skills VALUES (?, ?, ?, ?, ?)', row);
      const question = await createScreeningQuestion({
        id: 'question',
        text: 'Does this role require travel?',
        kind: 'source',
        importance: 'must_have',
        desiredAnswer: 'no',
        active: true,
        weight: 5,
      });
      for (const [id, name, active, rule] of [
        [
          'question',
          question.text,
          true,
          JSON.stringify({
            version: SCREENING_QUESTION_RULE_VERSION,
            question,
          }),
        ],
        ['broken', 'Broken enabled question', true, 'x'],
        ['inactive', 'Broken disabled question', false, 'x'],
      ])
        await db.query(
          'INSERT INTO preference_rules VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            id,
            'tenant',
            'owner',
            'profile',
            'screening_questions',
            name,
            '',
            active,
            rule,
          ],
        );
      const loaded = await loadMatchingCandidateInput(db, subject);
      expect(loaded).toMatchObject({
        targetRoles: ['Backend Engineer'],
        locations: ['Canada'],
        evidence: [
          {
            id: 'profile:profile:skillExperience',
            text: 'I have never used Kubernetes.',
          },
          { id: 'skill:own', text: 'Postgres' },
        ],
        questions: [
          { id: 'broken', required: true },
          {
            id: 'question',
            text: question.text,
            required: true,
            desiredAnswer: 'no',
          },
        ],
      });
      expect(
        await loadMatchingCandidateInput(db, { ...subject, userId: 'other' }),
      ).toBeNull();
      expect(
        await loadMatchingCandidateInput(db, { ...subject, tenantId: 'other' }),
      ).toBeNull();
      await db.query('DELETE FROM resume_skills WHERE id = ?', ['own']);
      expect(
        (await loadMatchingCandidateInput(db, subject))?.evidence.map(
          (item) => item.id,
        ),
      ).toEqual(['profile:profile:skillExperience']);
      await db.query('UPDATE candidate_profiles SET active = FALSE');
      expect(await loadMatchingCandidateInput(db, subject)).toBeNull();
    } finally {
      await db.close?.();
    }
  });

  it('captures original selected summary and canonical other-role bodies without borrowing metadata', async () => {
    const { database: db, close } =
      await createMatchingProjectionFixture('sqlite');
    const subject = {
      profileId: 'profile',
      tenantId: 'tenant',
      userId: 'owner',
    };
    const summary = '  Maintained services for customers.\r\n🦉  ';
    const body =
      '  Investigated recurring delivery delays.\r\nFixed the rollout workflow.  ';
    try {
      await db.query(
        `INSERT INTO candidate_profiles
          (id, active, tenant_id, owner_user_id, summary, use_on_resume)
          VALUES ('profile', TRUE, 'tenant', 'owner', ?, NULL),
                 ('sibling', TRUE, 'tenant', 'owner', 'Unrelated summary', TRUE)`,
        [summary],
      );
      const defaults = {
        tenant: 'tenant',
        owner: 'owner',
        profile: 'profile',
        role: 'Engineer',
        company: 'Lab',
        period: '2018–2020',
        body,
        selected: true as boolean | null,
      };
      const cases: Record<string, Partial<typeof defaults>> = {
        valid: { selected: null },
        unselected: { selected: false },
        'foreign-owner': { owner: 'other' },
        'foreign-tenant': { tenant: 'other' },
        'foreign-profile': { profile: 'sibling' },
        'no-role': { role: '\u00a0' },
        'no-company': { company: '' },
        'no-period': { period: '' },
        'no-body': { body: '  ' },
      };
      for (const [id, overrides] of Object.entries(cases)) {
        const row = { ...defaults, ...overrides };
        await db.query(
          'INSERT INTO resume_other_roles VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [
            id,
            row.tenant,
            row.owner,
            row.profile,
            row.role,
            row.company,
            row.period,
            row.body,
            row.selected,
          ],
        );
      }

      const original = await loadMatchingCandidateInput(db, subject);
      expect(original?.incomplete).toBe(false);
      expect(original?.evidence).toEqual([
        { id: 'profile:profile:summary', text: summary, kind: 'experience' },
        { id: 'other-role:valid', text: body, kind: 'experience' },
      ]);
      expect(original?.targetRoles).toEqual([]);
      if (!original) throw new Error('Missing fixture profile.');

      const digest = matchingCandidateEvidenceDigest(original);
      await db.query(
        "UPDATE resume_other_roles SET company = 'New company' WHERE id = 'valid'",
      );
      await db.query(
        "UPDATE resume_other_roles SET body = 'Hidden edit' WHERE id = 'unselected'",
      );
      const metadataEdit = await loadMatchingCandidateInput(db, subject);
      expect(
        metadataEdit && matchingCandidateEvidenceDigest(metadataEdit),
      ).toBe(digest);
      await db.query(
        "UPDATE resume_other_roles SET body = ? WHERE id = 'valid'",
        [`${body}\n`],
      );
      const rawEdit = await loadMatchingCandidateInput(db, subject);
      expect(rawEdit && matchingCandidateEvidenceDigest(rawEdit)).not.toBe(
        digest,
      );

      await db.query(
        "UPDATE candidate_profiles SET use_on_resume = FALSE WHERE id = 'profile'",
      );
      expect((await loadMatchingCandidateInput(db, subject))?.evidence).toEqual(
        [{ id: 'other-role:valid', text: `${body}\n`, kind: 'experience' }],
      );
      await db.query(
        "UPDATE resume_other_roles SET use_on_resume = FALSE WHERE id = 'valid'",
      );
      expect((await loadMatchingCandidateInput(db, subject))?.evidence).toEqual(
        [],
      );
    } finally {
      await close();
    }
  });

  it('fails closed on malformed and over-limit selected prose', async () => {
    const { database: db, close } =
      await createMatchingProjectionFixture('sqlite');
    const subject = {
      profileId: 'profile',
      tenantId: 'tenant',
      userId: 'owner',
    };
    try {
      await db.query(
        `INSERT INTO candidate_profiles
          (id, active, tenant_id, owner_user_id, summary, use_on_resume)
          VALUES ('profile', TRUE, 'tenant', 'owner', X'FF', TRUE)`,
      );
      await db.query(
        `INSERT INTO resume_other_roles VALUES
          ('invalid', 'tenant', 'owner', 'profile', 'Engineer', 'Lab', '2022', X'FF', TRUE)`,
      );
      expect(await loadMatchingCandidateInput(db, subject)).toMatchObject({
        evidence: [],
        incomplete: true,
      });
      await db.query(
        "UPDATE candidate_profiles SET use_on_resume = FALSE WHERE id = 'profile'",
      );
      await db.query(
        "UPDATE resume_other_roles SET use_on_resume = FALSE WHERE id = 'invalid'",
      );
      expect(await loadMatchingCandidateInput(db, subject)).toMatchObject({
        evidence: [],
        incomplete: false,
      });

      await db.query(
        `WITH RECURSIVE evidence_row(n) AS (
          VALUES (1) UNION ALL SELECT n + 1 FROM evidence_row WHERE n < 501
        )
        INSERT INTO resume_other_roles
        SELECT printf('%04d', n), 'tenant', 'owner', 'profile',
          'Engineer', 'Lab', '2022', 'Original narrative', TRUE FROM evidence_row`,
      );
      const overflow = await loadMatchingCandidateInput(db, subject);
      expect(overflow?.incomplete).toBe(true);
      expect(overflow?.evidence).toHaveLength(500);
      expect(overflow?.evidence.at(-1)?.id).toBe('other-role:0500');
    } finally {
      await close();
    }
  });
});
