import { describe, expect, it } from 'vitest';
import {
  getAdminResourceCollectionDefinition,
  isHydratedAdminResourceSlug,
} from './admin-resource-definitions';

describe('curated private admin collection metadata', () => {
  for (const [slug, className] of [
    ['applications', 'Application'],
    ['opportunities', 'Opportunity'],
    ['tasks', 'Task'],
  ]) {
    it(`provides only list identity for ${slug}`, () => {
      expect(isHydratedAdminResourceSlug(slug)).toBe(true);
      expect(getAdminResourceCollectionDefinition(slug)).toEqual({
        name: slug,
        className,
        endpoint: `/admin-resources/${slug}`,
        idField: 'id',
        actions: ['list'],
        fields: {},
      });
    });
  }

  it('rejects resources outside the explicit admin live list', () => {
    for (const slug of ['candidate-profiles', 'onlypublic', '__proto__']) {
      expect(isHydratedAdminResourceSlug(slug)).toBe(false);
      expect(() => getAdminResourceCollectionDefinition(slug)).toThrow(
        'Unsupported hydrated admin resource',
      );
    }
  });

  it('does not let one collection mutate later metadata', () => {
    const definition = getAdminResourceCollectionDefinition('tasks');
    definition.actions.push('create');
    definition.fields.secret = { type: 'text' };

    const nextDefinition = getAdminResourceCollectionDefinition('tasks');
    expect(nextDefinition.actions).toEqual(['list']);
    expect(nextDefinition.fields).toEqual({});
  });
});
