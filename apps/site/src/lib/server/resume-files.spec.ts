import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { getResumeFilesConfig } from './resume-files';

const repoRoot = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
);

const originalCwd = process.cwd();
const originalInitCwd = process.env.INIT_CWD;
const originalResumeFilesConfigJson = process.env.RESUME_FILES_CONFIG_JSON;
const originalIolausRepoRoot = process.env.IOLAUS_REPO_ROOT;

afterEach(() => {
  process.chdir(originalCwd);
  restoreEnv('INIT_CWD', originalInitCwd);
  restoreEnv('RESUME_FILES_CONFIG_JSON', originalResumeFilesConfigJson);
  restoreEnv('IOLAUS_REPO_ROOT', originalIolausRepoRoot);
});

describe('getResumeFilesConfig', () => {
  it('uses a package-local private directory when no asset directory exists', () => {
    delete process.env.RESUME_FILES_CONFIG_JSON;
    process.env.INIT_CWD = repoRoot;
    process.chdir(resolve(repoRoot, 'apps', 'site'));

    expect(getResumeFilesConfig()).toEqual({
      type: 'local',
      basePath: resolve(repoRoot, 'apps', 'site', 'var', 'profile-assets'),
    });
  });

  it('keeps explicit relative filesystem config relative to the current process', () => {
    process.chdir(resolve(repoRoot, 'apps', 'site'));
    process.env.RESUME_FILES_CONFIG_JSON = JSON.stringify({
      type: 'local',
      basePath: 'tmp/profile-assets',
    });

    expect(getResumeFilesConfig()).toEqual({
      type: 'local',
      basePath: resolve(repoRoot, 'apps', 'site', 'tmp', 'profile-assets'),
    });
  });
});

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }

  process.env[name] = value;
}
