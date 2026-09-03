import type { FilesystemInterface } from '@happyvertical/files';
import {
  renderResumeHtml,
  renderResumeMarkdown,
  renderResumeText,
} from './render.js';
import { applyTailoring } from './tailoring.js';
import type {
  GeneratedResumeArtifact,
  ResumeSource,
  TailoringConfig,
} from './types.js';
import { joinPath, slugify } from './utils.js';

export const DEFAULT_RESUME_PDF_BASENAME = 'resume.pdf';
const DEFAULT_PDF_LAUNCH_TIMEOUT_MS = 120_000;

export interface GenerateResumeArtifactsOptions {
  executablePath?: string;
  filesystem: FilesystemInterface;
  outputDir?: string;
  pdfRenderer?: (html: string) => Promise<Buffer>;
  pdfPathBasename?: string;
  source: ResumeSource;
  tailoring?: TailoringConfig;
  tailoringPath?: string;
}

/**
 * @deprecated Delegates to `resolveChromiumExecutablePath` from
 * `@happyvertical/pdf`, which owns binary discovery. Callers can stop passing
 * `executablePath` entirely — the renderer resolves it internally.
 */
export async function getDefaultPuppeteerExecutablePath(): Promise<
  string | undefined
> {
  const { resolveChromiumExecutablePath } = await import('@happyvertical/pdf');
  return resolveChromiumExecutablePath();
}

export function getOutputSlug(
  config: TailoringConfig | undefined,
  configPath: string | undefined,
): string {
  if (!config) return '';
  return slugify(
    config.outputSlug ??
      config.company ??
      config.name ??
      configPath ??
      'tailored',
  );
}

export function getPdfBasename(
  config: TailoringConfig | undefined,
  slug: string,
): string {
  if (!config) return DEFAULT_RESUME_PDF_BASENAME;
  return config.outputBasename ?? `resume-${slug}.pdf`;
}

export async function generateResumeArtifacts(
  options: GenerateResumeArtifactsOptions,
): Promise<GeneratedResumeArtifact> {
  const tailored = applyTailoring(
    options.source.profile,
    options.source.experience,
    options.source.skills,
    options.tailoring,
  );
  const slug = getOutputSlug(options.tailoring, options.tailoringPath);
  const outputPrefix = slug ? `resume.${slug}` : 'resume';
  const pdfBasename = getPdfBasename(options.tailoring, slug);
  const renderOptions = {
    footerLink: options.tailoring?.footerLink,
    hideSkills: options.tailoring?.hideSkills,
    hideTags: options.tailoring?.hideTags,
  };
  const markdown = renderResumeMarkdown(
    tailored.profile,
    tailored.experience,
    tailored.skills,
    renderOptions,
  );
  const text = renderResumeText(markdown, renderOptions);
  const html = renderResumeHtml(
    tailored.profile,
    tailored.experience,
    tailored.skills,
    renderOptions,
  );

  const markdownPath = joinPath(options.outputDir ?? '', `${outputPrefix}.md`);
  const textPath = joinPath(options.outputDir ?? '', `${outputPrefix}.txt`);
  const htmlPath = joinPath(options.outputDir ?? '', `${outputPrefix}.html`);
  const pdfPath = joinPath(
    options.outputDir ?? '',
    options.pdfPathBasename ?? pdfBasename,
  );

  await Promise.all([
    options.filesystem.write(markdownPath, markdown, { createParents: true }),
    options.filesystem.write(textPath, text, { createParents: true }),
    options.filesystem.write(htmlPath, html, { createParents: true }),
  ]);

  if (options.pdfRenderer) {
    await options.filesystem.write(pdfPath, await options.pdfRenderer(html), {
      createParents: true,
    });
    return {
      htmlPath,
      markdownPath,
      pdfBasename,
      pdfPath,
      slug,
      source: tailored,
      textPath,
      outputPrefix,
    };
  }

  // Engine lives upstream (org policy: all PDF work targets @happyvertical/pdf).
  // Lazy import so loading this module never pulls browser automation code.
  // The org renderer's defaults guarantee the behavior the old inline puppeteer
  // code set explicitly: printBackground + preferCSSPageSize on, waits for
  // document.fonts.ready, and container-safe launch args (--no-sandbox,
  // --disable-setuid-sandbox, --disable-dev-shm-usage).
  const { renderHtmlToPdf } = await import('@happyvertical/pdf');
  const pdf = await renderHtmlToPdf(html, {
    executablePath: options.executablePath,
    format: 'Letter',
    margin: {
      top: '0.45in',
      bottom: '0.45in',
      left: '0.55in',
      right: '0.55in',
    },
    launchTimeoutMs: DEFAULT_PDF_LAUNCH_TIMEOUT_MS,
  });
  await options.filesystem.write(pdfPath, Buffer.from(pdf), {
    createParents: true,
  });

  return {
    htmlPath,
    markdownPath,
    pdfBasename,
    pdfPath,
    slug,
    source: tailored,
    textPath,
    outputPrefix,
  };
}
