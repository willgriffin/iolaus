import type { FilesystemInterface } from '@happyvertical/files';
import { error } from '@sveltejs/kit';
import {
  getPrivateRecord,
  requireWorkspaceSubject,
  type WorkspaceSubject,
} from './private-workspace.js';
import { getResumeFilesystem } from './resume-files.js';

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function bufferValue(value: string | Buffer): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

export async function loadResumeAssetPdf(
  assetId: string,
  subject: WorkspaceSubject,
  filesystem?: FilesystemInterface,
) {
  const verifiedSubject = requireWorkspaceSubject(subject);
  const id = assetId.trim();
  if (!id) {
    error(400, 'Missing resume asset ID.');
  }

  const asset = await getPrivateRecord('ResumeAsset', id, verifiedSubject);
  if (!asset) {
    error(404, 'Resume asset not found.');
  }

  const record = asset as unknown as Record<string, unknown>;
  const pdfPath = stringValue(record.pdfPath);
  if (!pdfPath) {
    error(404, 'Resume asset has no generated PDF.');
  }

  const fs = filesystem ?? (await getResumeFilesystem());
  try {
    const pdf = await fs.read(pdfPath, { raw: true });
    return {
      body: bufferValue(pdf),
      filename:
        stringValue(record.pdfBasename) ||
        `${stringValue(record.title) || 'resume-asset'}.pdf`,
    };
  } catch {
    error(404, 'Resume asset PDF was not found.');
  }
}
