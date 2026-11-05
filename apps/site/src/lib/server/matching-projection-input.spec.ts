import { getDatabase } from '@happyvertical/sql';
import { describe, expect, it } from 'vitest';
import { createScreeningQuestion } from '../opportunity-screening-questions.js';
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
        'CREATE TABLE candidate_profiles (id TEXT, tenant_id TEXT, owner_user_id TEXT, active BOOLEAN, preferences_json TEXT, facts_json TEXT, target_work_country_json TEXT)',
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
        'INSERT INTO candidate_profiles VALUES (?, ?, ?, TRUE, ?, ?, ?)',
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
});
