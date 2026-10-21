import { z } from 'zod';

export const RESUME_EXTRACTION_URL_ENV = 'IOLAUS_RESUME_EXTRACTION_URL';
export const RESUME_EXTRACTION_MAX_BYTES = 10 * 1024 * 1024;
export const RESUME_EXTRACTION_MAX_RESPONSE_BYTES = 1_000_000;
export const RESUME_EXTRACTION_TIMEOUT_MS = 75_000;

const outputSchema = z
  .object({
    pages: z
      .array(
        z
          .object({ page: z.number().int().positive(), text: z.string() })
          .strict(),
      )
      .min(1)
      .max(20),
    needsOcr: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.pages.some((page, index) => page.page !== index + 1))
      context.addIssue({ code: 'custom', message: 'pages' });
    if (
      value.pages.reduce((total, page) => total + page.text.length, 0) > 120_000
    )
      context.addIssue({ code: 'custom', message: 'text' });
  });

export type ResumeImportPdfExtraction = z.infer<typeof outputSchema> & {
  text: string;
};
export type ResumeImportPdfFailureCategory =
  | 'unsupported_type'
  | 'malformed_output'
  | 'limit'
  | 'timeout'
  | 'unavailable'
  | 'cancelled';

export class ResumeImportPdfClientError extends Error {
  constructor(readonly category: ResumeImportPdfFailureCategory) {
    super(category);
    this.name = 'ResumeImportPdfClientError';
  }
}

export interface ResumeImportPdfClient {
  /** authorize must re-enter the caller's verified subject immediately before I/O. */
  extract(input: {
    bytes: Uint8Array;
    authorize: () => Promise<void>;
    signal?: AbortSignal;
  }): Promise<ResumeImportPdfExtraction>;
}

function extractionUrl(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash
    )
      return null;
    url.pathname = url.pathname.replace(/\/$/u, '') + '/extract';
    return url;
  } catch {
    return null;
  }
}

export function createResumeImportPdfClient(
  value = process.env[RESUME_EXTRACTION_URL_ENV],
  fetchImpl: typeof fetch = fetch,
): ResumeImportPdfClient | null {
  const url = extractionUrl(value);
  if (!value) return null;
  if (!url) throw new ResumeImportPdfClientError('unavailable');
  return {
    async extract({ bytes, authorize, signal }) {
      if (bytes.byteLength > RESUME_EXTRACTION_MAX_BYTES)
        throw new ResumeImportPdfClientError('limit');
      if (signal?.aborted) throw new ResumeImportPdfClientError('cancelled');
      await authorize();
      if (signal?.aborted) throw new ResumeImportPdfClientError('cancelled');
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort('timeout'),
        RESUME_EXTRACTION_TIMEOUT_MS,
      );
      const abort = () => controller.abort('cancelled');
      signal?.addEventListener('abort', abort, { once: true });
      try {
        const response = await fetchImpl(url, {
          method: 'POST',
          redirect: 'error',
          headers: {
            'content-type': 'application/pdf',
            'content-length': String(bytes.byteLength),
          },
          body: new Uint8Array(bytes).buffer,
          signal: controller.signal,
        });
        if (!response.ok) {
          await response.body?.cancel();
          if (response.status === 413)
            throw new ResumeImportPdfClientError('limit');
          if (response.status === 504)
            throw new ResumeImportPdfClientError('timeout');
          if (response.status === 415)
            throw new ResumeImportPdfClientError('unsupported_type');
          throw new ResumeImportPdfClientError('unavailable');
        }
        if (!response.body)
          throw new ResumeImportPdfClientError('malformed_output');
        const reader = response.body.getReader();
        const chunks: Uint8Array[] = [];
        let length = 0;
        for (;;) {
          const part = await reader.read();
          if (part.done) break;
          length += part.value.byteLength;
          if (length > RESUME_EXTRACTION_MAX_RESPONSE_BYTES) {
            await reader.cancel();
            throw new ResumeImportPdfClientError('malformed_output');
          }
          chunks.push(part.value);
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
        } catch {
          throw new ResumeImportPdfClientError('malformed_output');
        }
        const result = outputSchema.safeParse(parsed);
        if (!result.success)
          throw new ResumeImportPdfClientError('malformed_output');
        return {
          ...result.data,
          needsOcr:
            result.data.needsOcr ||
            result.data.pages.some((page) => !page.text.trim()),
          text: result.data.pages
            .map((page) => `[Page ${page.page}]\n${page.text}`)
            .join('\n\n'),
        };
      } catch (error) {
        if (error instanceof ResumeImportPdfClientError) throw error;
        if (controller.signal.reason === 'timeout')
          throw new ResumeImportPdfClientError('timeout');
        if (controller.signal.reason === 'cancelled')
          throw new ResumeImportPdfClientError('cancelled');
        throw new ResumeImportPdfClientError('unavailable');
      } finally {
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
      }
    },
  };
}
