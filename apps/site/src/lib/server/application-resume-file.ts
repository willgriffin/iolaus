import { safePdfFilename } from './http-headers.js';
import {
  CURRENT_RESUME_PDF_BASENAME,
  getResumeFilesystem,
  PUBLIC_RESUME_PDF_FILENAME,
} from './resume-files.js';
import { getCollection } from './smrt.js';

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
): Promise<ApplicationResumePdf | null> {
  const resumeAssetId = stringValue(application.resumeAssetId);
  if (!resumeAssetId) return null;

  try {
    const resumeAssets = await getCollection('ResumeAsset');
    const asset = (await resumeAssets.get(resumeAssetId)) as Record<
      string,
      unknown
    > | null;
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
): Promise<string> {
  return (await applicationResumePdfFile(application))?.pdfPath ?? '';
}

export async function applicationResumePdfExists(
  application: Record<string, unknown>,
): Promise<boolean> {
  const pdfPath = await applicationResumePdfPath(application);
  if (!pdfPath) return false;

  try {
    return await (await getResumeFilesystem()).exists(pdfPath);
  } catch {
    return false;
  }
}
