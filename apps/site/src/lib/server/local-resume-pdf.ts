import { getPDFReader } from '@happyvertical/pdf';
import {
  RESUME_EXTRACTION_MAX_BYTES,
  RESUME_EXTRACTION_TIMEOUT_MS,
  type ResumeImportPdfClient,
  ResumeImportPdfClientError,
} from './resume-import-pdf-client.js';

/** Local owner documents never leave this process or invoke OCR services. */
export function createLocalResumePdfClient(): ResumeImportPdfClient {
  return {
    async extract({ bytes, authorize, signal }) {
      if (!bytes.byteLength || bytes.byteLength > RESUME_EXTRACTION_MAX_BYTES)
        throw new ResumeImportPdfClientError('limit');
      if (signal?.aborted) throw new ResumeImportPdfClientError('cancelled');
      await authorize();
      if (signal?.aborted) throw new ResumeImportPdfClientError('cancelled');
      try {
        const reader = await getPDFReader({
          provider: 'unpdf',
          enableOCR: false,
          maxFileSize: RESUME_EXTRACTION_MAX_BYTES,
          timeout: RESUME_EXTRACTION_TIMEOUT_MS,
        });
        const metadata = await reader.extractMetadata(new Uint8Array(bytes));
        if (!Number.isInteger(metadata.pageCount) || metadata.pageCount < 1)
          throw new ResumeImportPdfClientError('malformed_output');
        if (metadata.pageCount > 20)
          throw new ResumeImportPdfClientError('limit');
        const pages: Array<{ page: number; text: string }> = [];
        let length = 0;
        for (let page = 1; page <= metadata.pageCount; page += 1) {
          if (signal?.aborted)
            throw new ResumeImportPdfClientError('cancelled');
          const text =
            (await reader.extractText(new Uint8Array(bytes), {
              pages: [page],
              skipOCRFallback: true,
              preserveFormatting: true,
            })) ?? '';
          length += text.length;
          if (length > 120_000) throw new ResumeImportPdfClientError('limit');
          pages.push({ page, text });
        }
        return {
          pages,
          needsOcr: pages.some((page) => !page.text.trim()),
          text: pages
            .map((page) => `[Page ${page.page}]\n${page.text}`)
            .join('\n\n'),
        };
      } catch (cause) {
        if (cause instanceof ResumeImportPdfClientError) throw cause;
        throw new ResumeImportPdfClientError('malformed_output');
      }
    },
  };
}
