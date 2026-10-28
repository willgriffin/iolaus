import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { webMcpToolDefinitions } from '@happyvertical/smrt-virt-web';
import { describe, expect, it } from 'vitest';
import {
  commandCenterWebMcpDefinitions,
  jobSearchWebMcpToolDefinitions,
} from '../src/lib/webmcp.js';
import { buildDeployedParityInventory } from './deployed-parity-inventory.js';

function webMcpProjection(
  definitions: ReturnType<typeof commandCenterWebMcpDefinitions>,
) {
  return definitions
    .map((definition) => ({
      effect: 'effect' in definition ? definition.effect : null,
      idempotent:
        'idempotent' in definition ? definition.idempotent : null,
      name: definition.name,
      openWorld: 'openWorld' in definition ? definition.openWorld : null,
      readOnly: 'readOnly' in definition ? definition.readOnly : null,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
}

describe('deployed parity inventory', () => {
  it('matches the reviewed snapshot and the generated browser manifest', async () => {
    const inventory = await buildDeployedParityInventory();
    const snapshot = JSON.parse(
      readFileSync(
        resolve('scripts/deployed-parity-inventory.snapshot.json'),
        'utf8',
      ),
    );
    const generatedWebMcp = webMcpProjection(
      commandCenterWebMcpDefinitions([
        ...webMcpToolDefinitions,
        ...jobSearchWebMcpToolDefinitions,
      ]),
    );

    expect(inventory).toEqual(snapshot);
    expect(inventory.surfaces.webmcp).toEqual(generatedWebMcp);
  });

  it('keeps private models and irreversible actions outside agent surfaces', async () => {
    const inventory = await buildDeployedParityInventory();
    const restClasses = inventory.surfaces.rest.map(
      (resource) => resource.className,
    );
    const webMcpNames = inventory.surfaces.webmcp.map((tool) => tool.name);

    for (const className of [
      'CliAuthRequest',
      'OpportunityIntelligenceRequest',
      'PublicProfileRevision',
      'ResumePosition',
      'ResumeProfile',
    ]) {
      expect(restClasses, className).not.toContain(className);
    }
    // The owner-scoped career model (#259) and private workspace (#262) are
    // on REST; the profile itself is never created or deleted through an
    // agent and system-authored records take no generic write.
    for (const className of [
      'Achievement',
      'Application',
      'CandidateProfileLink',
      'Decision',
      'Education',
      'EmploymentRole',
      'Experience',
      'PreferenceRule',
      'Project',
      'ResumeVariant',
      'Task',
    ]) {
      expect(restClasses, className).toContain(className);
    }
    expect(
      inventory.surfaces.rest.find(
        (resource) => resource.className === 'AgentRun',
      )?.actions,
    ).toEqual(['get', 'list']);
    expect(
      inventory.surfaces.rest.find(
        (resource) => resource.className === 'CandidateProfile',
      )?.actions,
    ).toEqual(['get', 'list', 'update']);
    expect(webMcpNames).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/(?:^|[_-])(?:approve|submit)(?:$|[_-])/u),
      ]),
    );
    expect(inventory.surfaces.webmcp).toHaveLength(18);
    expect(inventory.surfaces.dataSurface).toEqual([
      'opportunity_bulk_process_llm',
      'opportunity_bulk_review',
    ]);
  });
});
