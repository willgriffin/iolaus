import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type FilesystemInterface,
  type GetFilesystemOptions,
  getFilesystem,
} from '@happyvertical/files';

const RESUME_FILES_PATH = ['var', 'profile-assets'] as const;

function findResumeFilesBasePath(startDir: string): string | null {
  let dir = resolve(startDir);

  while (true) {
    const candidate = resolve(dir, ...RESUME_FILES_PATH);
    if (existsSync(candidate)) return candidate;

    const parent = resolve(dir, '..');
    if (parent === dir) return null;
    dir = parent;
  }
}

function defaultResumeFilesBasePath(): string {
  const candidates = [
    process.env.IOLAUS_REPO_ROOT,
    process.env.INIT_CWD,
    process.cwd(),
  ].filter((value): value is string => Boolean(value));

  for (const candidate of candidates) {
    const found = findResumeFilesBasePath(candidate);
    if (found) return found;
  }

  return resolve(process.cwd(), ...RESUME_FILES_PATH);
}

export const PUBLISHED_RESUME_PDF_PATH = 'published/resume.pdf';
export const CURRENT_RESUME_DIR_PATH = 'current-resume';
export const CURRENT_RESUME_PDF_BASENAME = 'resume.pdf';
export const CURRENT_RESUME_PDF_PATH = `${CURRENT_RESUME_DIR_PATH}/${CURRENT_RESUME_PDF_BASENAME}`;
export const PUBLIC_RESUME_PDF_FILENAME = 'resume.pdf';

export function getResumeFilesConfig(): GetFilesystemOptions {
  const raw = process.env.RESUME_FILES_CONFIG_JSON;
  if (!raw) {
    return {
      type: 'local',
      basePath: defaultResumeFilesBasePath(),
    };
  }

  const parsed = JSON.parse(raw) as GetFilesystemOptions;
  if (
    parsed.type === 'local' &&
    parsed.basePath &&
    !parsed.basePath.startsWith('/')
  ) {
    return { ...parsed, basePath: resolve(process.cwd(), parsed.basePath) };
  }
  return parsed;
}

export async function getResumeFilesystem(): Promise<FilesystemInterface> {
  return await getFilesystem(getResumeFilesConfig());
}
