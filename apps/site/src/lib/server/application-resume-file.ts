import { safePdfFilename } from './http-headers.js';
import {
  getPrivateRecord,
  recordOwnedBySubject,
  requireWorkspaceSubject,
  type WorkspaceSubject,
} from './private-workspace.js';
import {
  CURRENT_RESUME_PDF_BASENAME,
  getResumeFilesystem,
  PUBLIC_RESUME_PDF_FILENAME,
} from './resume-files.js';

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function applicationResumeFilename(pdfBasename: unknown): string {
  const basename = stringValue(pdfBasename);
  if (basename === CURRENT_RESUME_PDF_BASENAME) {
    return PUBLIC_RESUME_PDF_FILENAME;
  }
  return safePdfFilename(basename);
}

/**
 * Resolve only the application-selected resume artifact. A final approval
 * fingerprints that same asset, so falling back to a global published resume
 * would silently attach material the owner did not approve.
 */
export interface ApplicationResumePdf {
  filename: string;
  pdfPath: string;
}

export async function applicationResumePdfFile(
  application: Record<string, unknown>,
  subject: WorkspaceSubject,
): Promise<ApplicationResumePdf | null> {
  const verifiedSubject = requireWorkspaceSubject(subject);
  if (!recordOwnedBySubject(application, verifiedSubject)) return null;
  const resumeAssetId = stringValue(application.resumeAssetId);
  if (!resumeAssetId) return null;

  try {
    const asset = await getPrivateRecord(
      'ResumeAsset',
      resumeAssetId,
      verifiedSubject,
    );
    const pdfPath = stringValue(asset?.pdfPath);
    if (!pdfPath) return null;
    return {
      filename: applicationResumeFilename(asset?.pdfBasename),
      pdfPath,
    };
  } catch {
    return null;
  }
}

export async function applicationResumePdfPath(
  application: Record<string, unknown>,
  subject: WorkspaceSubject,
): Promise<string> {
  return (await applicationResumePdfFile(application, subject))?.pdfPath ?? '';
}

export async function applicationResumePdfExists(
  application: Record<string, unknown>,
  subject: WorkspaceSubject,
): Promise<boolean> {
  const pdfPath = await applicationResumePdfPath(application, subject);
  if (!pdfPath) return false;

  try {
    return await (await getResumeFilesystem()).exists(pdfPath);
  } catch {
    return false;
  }
}
