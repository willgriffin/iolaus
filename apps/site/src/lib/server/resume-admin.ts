import { randomUUID } from 'node:crypto';
import type { FilesystemInterface } from '@happyvertical/files';
import { resolveDatabase } from '@happyvertical/smrt-core';
import { getRequestScopedDatabase } from '@happyvertical/smrt-users';
import { error } from '@sveltejs/kit';
import type { TailoringConfig } from '@willgriffin/iolaus-resume';
import { getDbConfig } from './db.js';
import {
  getPublishedResumeAsset,
  getResumeTailoringConfig,
  listResumeAssets,
  loadPublishedResumeSource,
  type ResumeRecord,
} from './resume-data.js';
import {
  CURRENT_RESUME_PDF_BASENAME,
  CURRENT_RESUME_PDF_PATH,
  getResumeFilesystem,
  PUBLISHED_RESUME_PDF_PATH,
} from './resume-files.js';
import { ensureCanonicalResumeTailoringConfig } from './resume-tailoring-configs.js';
import { getCollection } from './smrt.js';

interface GenerateResumeAssetOptions {
  applicationId?: string;
  /**
   * Application workflows use this to fence database-visible artifacts behind
   * their opportunity lifecycle lock without coupling canonical resume work to
   * that lock.
   */
  assertWriteAllowed?: () => void;
  failureNote?: string;
  filesystem?: FilesystemInterface;
  sourcePath?: string;
  targetOpportunityId?: string;
  tailoring?: TailoringConfig;
  tailoringId?: string;
  tailoringName?: string;
  tailoringSlug?: string;
}

interface RefreshCanonicalResumeAssetOptions {
  filesystem?: FilesystemInterface;
  generation?: Pick<GenerateResumeAssetOptions, 'failureNote' | 'sourcePath'>;
  publicationFailureNote?: string;
}

export interface ResumeAssetPreview extends ResumeRecord {
  markdownBody: string;
  markdownStatus: ArtifactStatus;
  pdfHref: string;
  textBody: string;
  textStatus: ArtifactStatus;
}

export interface PublishedAssetState {
  id: string;
  isPublished: boolean;
  publishedAt: Date | null;
  status: string;
}

export interface PublishedCanonicalRefreshResult {
  asset: ResumeRecord;
  updatedApplications: number;
}

type ArtifactStatus = 'available' | 'missing' | 'unloaded';
type ResumeArtifactContent = 'all' | 'markdown' | 'none' | 'text';

interface ResumePdf {
  body: Buffer;
  filename: string;
}

interface PublishedResumeAsset {
  asset: ResumeRecord;
  pdf: ResumePdf;
}

const DEFAULT_RESUME_REFRESHABLE_APPLICATION_STATUSES = new Set([
  'draft',
  'application_drafting',
  'awaiting_user',
]);
const DEFAULT_RESUME_APPLICATION_REFRESH_PAGE_SIZE = 500;
const CANONICAL_RESUME_PUBLICATION_LOCK = 'iolaus:canonical-resume';
const PUBLIC_RESUME_RECOVERY_SOURCE_PATH = 'public-resume-recovery';
const PUBLIC_RESUME_RECOVERY_FAILURE_NOTE =
  'Automatic published resume recovery failed before artifacts were saved.';
const PUBLIC_RESUME_RECOVERY_PUBLICATION_FAILURE_NOTE =
  'Automatic published resume recovery failed while publishing the generated PDF.';
const PUBLIC_RESUME_RECOVERY_COOLDOWN_MS = 60_000;
const PUBLIC_RESUME_RECOVERY_LOCK_TIMEOUT = '5min';
const PUBLIC_RESUME_RECOVERY_FALLBACK_SCOPE = 'iolaus:public-resume-recovery';
const transientPublicResumeRecoveryFailures = new Map<string, number>();

type ResumePublicationDatabase = Awaited<ReturnType<typeof resolveDatabase>>;
type ResumePublicationSession = {
  query: ResumePublicationDatabase['query'];
  release: () => Promise<void>;
};
type SessionCapableResumePublicationDatabase = ResumePublicationDatabase & {
  acquireSession?: () => Promise<ResumePublicationSession>;
};
interface ResumePublicationLockOptions {
  lockTimeout?: string;
}

// This mutex does not share generated data between requests. It merely keeps
// non-Postgres development adapters serialized while the database advisory
// lock coordinates the same scoped publication across production replicas.
const publicationMutexes = new Map<string, Promise<void>>();

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function titleForAsset(tailoringName: string | undefined): string {
  return tailoringName ? `Resume - ${tailoringName}` : 'Resume - canonical';
}

function bufferValue(value: string | Buffer): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.from(value);
}

function databaseUrl(database: unknown): string {
  if (typeof database === 'string') return database.trim();
  const url = stringValue((database as { url?: unknown } | null)?.url);
  return url;
}

function publicationScope(database: unknown): string {
  const url = databaseUrl(database);
  return url || 'default';
}

function usesPostgres(database: unknown): boolean {
  return /^postgres(?:ql)?:/iu.test(databaseUrl(database));
}

async function withPublicationMutex<T>(
  scope: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = publicationMutexes.get(scope) ?? Promise.resolve();
  let release: (() => void) | undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  publicationMutexes.set(scope, current);

  await previous;
  try {
    return await work();
  } finally {
    release?.();
    if (publicationMutexes.get(scope) === current) {
      publicationMutexes.delete(scope);
    }
  }
}

async function withCanonicalResumePublicationLock<T>(
  work: (scope: string) => Promise<T>,
  options: ResumePublicationLockOptions = {},
): Promise<T> {
  const requestDatabase = getRequestScopedDatabase();
  const database = requestDatabase ?? (await resolveDatabase(getDbConfig()));
  const scope = publicationScope(database);

  return await withPublicationMutex(scope, async () => {
    if (!usesPostgres(database)) return await work(scope);

    // Keep the session lock outside the request-scoped transaction. It only
    // coordinates publication, while all resume data operations below retain
    // their existing request/tenant database context. A session advisory lock
    // stays held throughout PDF rendering without the transaction idle timeout
    // releasing it underneath the renderer.
    const lockDatabase = requestDatabase
      ? await resolveDatabase(getDbConfig())
      : database;
    const sessionCapable =
      lockDatabase as SessionCapableResumePublicationDatabase;
    if (!sessionCapable.acquireSession) return await work(scope);

    const session = await sessionCapable.acquireSession();
    try {
      if (options.lockTimeout) {
        await session.query(
          "SELECT set_config('statement_timeout', ?, false)",
          [options.lockTimeout],
        );
        await session.query("SELECT set_config('lock_timeout', ?, false)", [
          options.lockTimeout,
        ]);
      }
      await session.query('SELECT pg_advisory_lock(hashtext(?))', [
        // PostgreSQL advisory locks are scoped to the database already. Keep
        // the bound value credential-free: adapter errors can retain query
        // parameters in their diagnostic context.
        CANONICAL_RESUME_PUBLICATION_LOCK,
      ]);
      return await work(scope);
    } finally {
      await session.release();
    }
  });
}

function hasRecentTransientPublicResumeRecoveryFailure(scope: string): boolean {
  const until = transientPublicResumeRecoveryFailures.get(scope);
  if (!until) return false;
  if (until > Date.now()) return true;
  transientPublicResumeRecoveryFailures.delete(scope);
  return false;
}

function rememberTransientPublicResumeRecoveryFailure(scope: string): void {
  transientPublicResumeRecoveryFailures.set(
    scope,
    Date.now() + PUBLIC_RESUME_RECOVERY_COOLDOWN_MS,
  );
}

async function readTextArtifact(
  filesystem: FilesystemInterface,
  path: string,
): Promise<{ body: string; status: Exclude<ArtifactStatus, 'unloaded'> }> {
  if (!path) return { body: '', status: 'missing' };
  try {
    if (!(await filesystem.exists(path)))
      return { body: '', status: 'missing' };
    const content = await filesystem.read(path);
    return {
      body: typeof content === 'string' ? content : content.toString(),
      status: 'available',
    };
  } catch {
    return { body: '', status: 'missing' };
  }
}

function unloadedTextArtifact(path: string): {
  body: string;
  status: ArtifactStatus;
} {
  return {
    body: '',
    status: path ? 'unloaded' : 'missing',
  };
}

async function readResumePdf(
  filesystem: FilesystemInterface,
  path: string,
  filename: string,
): Promise<ResumePdf | null> {
  try {
    const pdf = await filesystem.read(path, { raw: true });
    return {
      body: bufferValue(pdf),
      filename,
    };
  } catch (cause) {
    if (isMissingResumeFileError(cause)) return null;
    throw cause;
  }
}

function isMissingResumeFileError(cause: unknown): boolean {
  if (!cause || typeof cause !== 'object') return false;
  const details = cause as {
    code?: unknown;
    message?: unknown;
    name?: unknown;
    status?: unknown;
    statusCode?: unknown;
  };
  const code = stringValue(details.code).toUpperCase();
  if (code === 'ENOENT' || code === 'NOSUCHKEY' || code === 'NOT_FOUND') {
    return true;
  }
  if (details.status === 404 || details.statusCode === 404) return true;

  const description = [
    stringValue(details.name),
    stringValue(details.message),
  ].join(' ');
  return /\b(?:file|object|key) not found\b|\bno such (?:file|key)\b/iu.test(
    description,
  );
}

export function nextPublishedAssetStates(
  assets: ResumeRecord[],
  assetId: string,
  publishedAt: Date,
): PublishedAssetState[] {
  return assets
    .filter(
      (asset): asset is ResumeRecord & { id: string } =>
        typeof asset.id === 'string',
    )
    .map((asset) => {
      const selected = asset.id === assetId;
      return {
        id: asset.id,
        isPublished: selected,
        publishedAt: selected ? publishedAt : null,
        status: selected
          ? 'published'
          : stringValue(asset.status) === 'published'
            ? 'generated'
            : stringValue(asset.status),
      };
    });
}

export async function generateResumeAsset(
  options: GenerateResumeAssetOptions = {},
) {
  const source = await loadPublishedResumeSource();
  const tailoringRecord = options.tailoringId
    ? await getResumeTailoringConfig(options.tailoringId)
    : await ensureCanonicalResumeTailoringConfig();
  const tailoring = options.tailoring
    ? { ...(tailoringRecord?.config ?? {}), ...options.tailoring }
    : tailoringRecord?.config;
  const collection = await getCollection('ResumeAsset');
  const now = new Date();
  const title = titleForAsset(
    options.tailoringName ||
      stringValue(tailoringRecord?.name) ||
      stringValue(tailoring?.name),
  );
  const tailoringId = options.tailoringId || stringValue(tailoringRecord?.id);
  options.assertWriteAllowed?.();
  const asset = await collection.create({
    applicationId: stringValue(options.applicationId),
    assetType: 'resume',
    context: '',
    generatedAt: now,
    isPublished: false,
    slug: `resume-${randomUUID()}`,
    sourcePath: options.sourcePath ?? 'admin',
    status: 'generated',
    targetOpportunityId: stringValue(options.targetOpportunityId),
    tailoringId,
    title,
  });

  const assetId = stringValue(asset.id);
  if (!assetId) {
    error(500, 'Generated resume asset did not receive an ID.');
  }

  // Lazily import the resume renderer. It transitively pulls in a bundled
  // TypeScript compiler whose ts.sys reference to __filename crashes at module
  // load in the ESM production build. Importing it only when actually generating
  // a PDF keeps the resume admin page and /resume.pdf loadable.
  try {
    const filesystem = options.filesystem ?? (await getResumeFilesystem());
    const { generateResumeArtifacts, getDefaultPuppeteerExecutablePath } =
      await import('@willgriffin/iolaus-resume');
    const artifact = await generateResumeArtifacts({
      executablePath: await getDefaultPuppeteerExecutablePath(),
      filesystem,
      outputDir: `generated-resumes/${assetId}`,
      pdfPathBasename: 'resume.pdf',
      source,
      tailoring,
      tailoringPath:
        options.tailoringSlug ||
        stringValue(tailoringRecord?.configSlug) ||
        stringValue(tailoring?.outputSlug) ||
        undefined,
    });

    try {
      options.assertWriteAllowed?.();
    } catch (cause) {
      await Promise.all(
        [
          artifact.htmlPath,
          artifact.markdownPath,
          artifact.pdfPath,
          artifact.textPath,
        ].map(async (path) => {
          try {
            await filesystem.delete(path);
          } catch {
            // Lock loss remains the actionable failure if cleanup is unavailable.
          }
        }),
      );
      throw cause;
    }

    Object.assign(asset, {
      generatedAt: now,
      generatedPath: `generated-resumes/${assetId}`,
      htmlPath: artifact.htmlPath,
      markdownPath: artifact.markdownPath,
      notes: tailoringRecord
        ? `Generated from tailoring config ${tailoringRecord.id}`
        : '',
      outputSlug: artifact.slug,
      pdfBasename: artifact.pdfBasename,
      pdfPath: artifact.pdfPath,
      sourcePath: options.sourcePath ?? 'admin',
      status: 'generated',
      textPath: artifact.textPath,
      title,
    });
    options.assertWriteAllowed?.();
    await asset.save();
    try {
      options.assertWriteAllowed?.();
    } catch (cause) {
      await Promise.all([
        (async () => {
          try {
            await collection.delete(assetId);
          } catch {
            // Lock loss remains actionable if record compensation fails.
          }
        })(),
        Promise.all(
          [
            artifact.htmlPath,
            artifact.markdownPath,
            artifact.pdfPath,
            artifact.textPath,
          ].map(async (path) => {
            try {
              await filesystem.delete(path);
            } catch {
              // Lock loss remains actionable if filesystem cleanup fails.
            }
          }),
        ),
      ]);
      throw cause;
    }
  } catch (cause) {
    // If a guarded application workflow lost its lifecycle lock, do not turn
    // this into a visible failed asset after another request may have closed
    // the application.
    options.assertWriteAllowed?.();
    Object.assign(asset, {
      notes:
        options.failureNote ??
        'Resume generation failed before artifacts were saved.',
      status: 'failed',
    });
    try {
      options.assertWriteAllowed?.();
      await asset.save();
    } catch {
      // Preserve the generation failure when its status cannot be persisted.
    }
    throw cause;
  }

  return JSON.parse(JSON.stringify(asset)) as ResumeRecord;
}

export async function regenerateResumeAsset(
  assetId: string,
  filesystem?: FilesystemInterface,
) {
  const id = assetId.trim();
  if (!id) {
    error(400, 'Missing resume asset ID.');
  }

  const collection = await getCollection('ResumeAsset');
  const asset = await collection.get(id);
  if (!asset) {
    error(404, 'Resume asset not found.');
  }

  const record = asset as unknown as Record<string, unknown>;
  return await generateResumeAsset({
    filesystem,
    tailoringId: stringValue(record.tailoringId),
    targetOpportunityId: stringValue(record.targetOpportunityId),
  });
}

export async function loadResumeAssetPreviews(
  assets: ResumeRecord[],
  filesystem?: FilesystemInterface,
  content: ResumeArtifactContent = 'all',
): Promise<ResumeAssetPreview[]> {
  const fs =
    content === 'none' ? null : (filesystem ?? (await getResumeFilesystem()));
  return await Promise.all(
    assets.map(async (asset) => {
      const id = stringValue(asset.id);
      const [markdown, text] = await Promise.all([
        fs && (content === 'all' || content === 'markdown')
          ? readTextArtifact(fs, stringValue(asset.markdownPath))
          : unloadedTextArtifact(stringValue(asset.markdownPath)),
        fs && (content === 'all' || content === 'text')
          ? readTextArtifact(fs, stringValue(asset.textPath))
          : unloadedTextArtifact(stringValue(asset.textPath)),
      ]);

      return {
        ...asset,
        markdownBody: markdown.body,
        markdownStatus: markdown.status,
        pdfHref:
          id && stringValue(asset.pdfPath)
            ? `/admin/resume-assets/${id}/pdf`
            : '',
        textBody: text.body,
        textStatus: text.status,
      };
    }),
  );
}

function applicationShouldTrackDefaultResume(record: Record<string, unknown>) {
  return (
    stringValue(record.resumeMode) === 'default' &&
    DEFAULT_RESUME_REFRESHABLE_APPLICATION_STATUSES.has(
      stringValue(record.status),
    )
  );
}

export async function updateDefaultResumeApplicationsForCanonicalAsset(
  assetId: string,
): Promise<number> {
  return await withCanonicalResumePublicationLock(async () => {
    const publishedAsset = await getPublishedResumeAsset();
    if (stringValue(publishedAsset?.id) !== assetId) return 0;
    return await updateDefaultResumeApplicationsForCanonicalAssetUnlocked(
      assetId,
    );
  });
}

async function updateDefaultResumeApplicationsForCanonicalAssetUnlocked(
  assetId: string,
): Promise<number> {
  if (!assetId) return 0;
  const collection = await getCollection('Application');
  let updated = 0;

  for (
    let offset = 0;
    ;
    offset += DEFAULT_RESUME_APPLICATION_REFRESH_PAGE_SIZE
  ) {
    const records = (await collection.list({
      limit: DEFAULT_RESUME_APPLICATION_REFRESH_PAGE_SIZE,
      offset,
    })) as unknown as Array<
      Record<string, unknown> & { save?: () => Promise<void> }
    >;

    for (const record of records) {
      if (!applicationShouldTrackDefaultResume(record)) continue;
      if (stringValue(record.resumeAssetId) === assetId) continue;
      record.resumeAssetId = assetId;
      if (typeof record.save === 'function') await record.save();
      updated += 1;
    }

    if (records.length < DEFAULT_RESUME_APPLICATION_REFRESH_PAGE_SIZE) break;
  }

  return updated;
}

export async function refreshPublishedCanonicalResumeAsset(
  options: RefreshCanonicalResumeAssetOptions = {},
): Promise<PublishedCanonicalRefreshResult> {
  const asset = await generateAndPublishCanonicalResumeAsset(options);
  const updatedApplications =
    await updateDefaultResumeApplicationsForCanonicalAsset(
      stringValue(asset.id),
    );
  return { asset, updatedApplications };
}

async function generateAndPublishCanonicalResumeAsset(
  options: RefreshCanonicalResumeAssetOptions = {},
): Promise<ResumeRecord> {
  return await withCanonicalResumePublicationLock(
    async () => await generateAndPublishCanonicalResumeAssetUnlocked(options),
  );
}

async function generateAndPublishCanonicalResumeAssetUnlocked(
  options: RefreshCanonicalResumeAssetOptions = {},
): Promise<ResumeRecord> {
  return (await generateAndPublishCanonicalResumeAssetWithPdfUnlocked(options))
    .asset;
}

async function generateAndPublishCanonicalResumeAssetWithPdfUnlocked(
  options: RefreshCanonicalResumeAssetOptions = {},
): Promise<PublishedResumeAsset> {
  const generated = await generateResumeAsset({
    filesystem: options.filesystem,
    ...options.generation,
  });
  try {
    return await publishResumeAssetWithPdfUnlocked(
      stringValue(generated.id),
      options.filesystem,
    );
  } catch (cause) {
    if (options.publicationFailureNote) {
      await markResumeAssetFailed(
        stringValue(generated.id),
        options.publicationFailureNote,
      );
    }
    throw cause;
  }
}

async function markResumeAssetFailed(
  assetId: string,
  notes: string,
): Promise<void> {
  try {
    const collection = await getCollection('ResumeAsset');
    const asset = await collection.get(assetId);
    if (!asset) return;
    const record = asset as unknown as Record<string, unknown> & {
      save: () => Promise<void>;
    };
    record.notes = notes;
    record.status = 'failed';
    await record.save();
  } catch (cause) {
    console.warn('Unable to record a failed public resume recovery.', cause);
  }
}

export async function publishResumeAsset(
  assetId: string,
  filesystem?: FilesystemInterface,
) {
  if (!assetId) {
    error(400, 'Missing resume asset ID.');
  }

  return await withCanonicalResumePublicationLock(
    async () => await publishResumeAssetUnlocked(assetId, filesystem),
  );
}

async function publishResumeAssetUnlocked(
  assetId: string,
  filesystem?: FilesystemInterface,
): Promise<ResumeRecord> {
  return (await publishResumeAssetWithPdfUnlocked(assetId, filesystem)).asset;
}

async function publishResumeAssetWithPdfUnlocked(
  assetId: string,
  filesystem?: FilesystemInterface,
): Promise<PublishedResumeAsset> {
  const collection = await getCollection('ResumeAsset');
  const asset = await collection.get(assetId);
  if (!asset) {
    error(404, 'Resume asset not found.');
  }

  const assetRecord = asset as unknown as Record<string, unknown> & {
    save: () => Promise<void>;
  };
  if (stringValue(assetRecord.applicationId)) {
    error(
      403,
      'Application-owned materials cannot be published as the canonical resume.',
    );
  }
  const pdfPath = stringValue(assetRecord.pdfPath);
  if (!pdfPath) {
    error(400, 'Resume asset has no generated PDF path.');
  }

  const fs = filesystem ?? (await getResumeFilesystem());
  const pdf = await fs.read(pdfPath, { raw: true });

  const now = new Date();
  const assets = await listResumeAssets();
  const nextStates = nextPublishedAssetStates(assets, assetId, now);
  await Promise.all(
    nextStates.map(async (state) => {
      if (state.id === assetId) return;
      const existing = assets.find((asset) => asset.id === state.id);
      if (!existing?.isPublished && existing?.status !== 'published') return;
      const record = await collection.get(state.id);
      if (!record) return;
      const mutable = record as unknown as Record<string, unknown> & {
        save: () => Promise<void>;
      };
      mutable.isPublished = state.isPublished;
      mutable.status = state.status;
      mutable.publishedAt = state.publishedAt;
      await record.save();
    }),
  );

  Object.assign(asset, {
    isPublished: true,
    publishedAt: now,
    status: 'published',
  });
  await asset.save();

  // The asset PDF is immutable and is the source of truth for public reads.
  // Update this compatibility alias only after publication state is durable, so
  // a failed state transition cannot expose an uncommitted candidate.
  try {
    await fs.write(PUBLISHED_RESUME_PDF_PATH, bufferValue(pdf), {
      createParents: true,
    });
  } catch {
    // Public delivery reads the immutable published asset first; an alias
    // refresh failure must not invalidate the durable publication state.
    console.warn('Unable to refresh the published resume compatibility alias.');
  }

  return {
    asset: JSON.parse(JSON.stringify(asset)) as ResumeRecord,
    pdf: {
      body: bufferValue(pdf),
      filename: stringValue(assetRecord.pdfBasename) || 'resume.pdf',
    },
  };
}

export async function loadPublishedResumePdf(
  filesystem?: FilesystemInterface,
): Promise<ResumePdf | null> {
  const fs = filesystem ?? (await getResumeFilesystem());
  let asset: ResumeRecord | null = null;
  try {
    asset = await getPublishedResumeAsset();
  } catch {
    asset = null;
  }

  if (asset) {
    const filename = stringValue(asset.pdfBasename) || 'resume.pdf';
    const pdfPath = stringValue(asset.pdfPath);
    if (pdfPath) {
      const assetPdf = await readResumePdf(fs, pdfPath, filename);
      if (assetPdf) return assetPdf;
    }

    // Retain the alias as a migration fallback for legacy published assets,
    // but never prefer it over the PDF selected by the published record.
    const publishedPdf = await readResumePdf(
      fs,
      PUBLISHED_RESUME_PDF_PATH,
      filename,
    );
    if (publishedPdf) return publishedPdf;
  }

  return await readResumePdf(
    fs,
    CURRENT_RESUME_PDF_PATH,
    CURRENT_RESUME_PDF_BASENAME,
  );
}

function recordTimestamp(record: ResumeRecord): number | null {
  const value = record.updated_at ?? record.updatedAt ?? record.generatedAt;
  const timestamp =
    value instanceof Date ? value.getTime() : Date.parse(String(value));
  return Number.isFinite(timestamp) ? timestamp : null;
}

async function hasRecentPublicResumeRecoveryFailure(
  scope: string,
): Promise<boolean> {
  if (hasRecentTransientPublicResumeRecoveryFailure(scope)) return true;
  const assets = await listResumeAssets();
  return assets.some((asset) => {
    if (
      stringValue(asset.sourcePath) !== PUBLIC_RESUME_RECOVERY_SOURCE_PATH ||
      stringValue(asset.status) !== 'failed'
    ) {
      return false;
    }

    const timestamp = recordTimestamp(asset);
    return (
      timestamp !== null &&
      timestamp + PUBLIC_RESUME_RECOVERY_COOLDOWN_MS > Date.now()
    );
  });
}

export async function ensurePublishedResumePdf(
  filesystem?: FilesystemInterface,
): Promise<ResumePdf> {
  const existing = await loadPublishedResumePdf(filesystem);
  if (existing) return existing;
  if (
    hasRecentTransientPublicResumeRecoveryFailure(
      PUBLIC_RESUME_RECOVERY_FALLBACK_SCOPE,
    )
  ) {
    error(503, 'Published resume PDF recovery is temporarily unavailable.');
  }

  // Recovery keeps no shared response state. It does hold the publication lock
  // through rendering so an older recovery cannot publish after a newer source
  // refresh, and so a second request can reuse the newly restored PDF.
  let recovery: { asset: ResumeRecord | null; pdf: ResumePdf | null };
  let recoveryCallbackStarted = false;
  try {
    recovery = await withCanonicalResumePublicationLock(
      async (scope) => {
        recoveryCallbackStarted = true;
        const restored = await loadPublishedResumePdf(filesystem);
        if (restored) {
          transientPublicResumeRecoveryFailures.delete(scope);
          return { asset: null, pdf: restored };
        }
        try {
          if (await hasRecentPublicResumeRecoveryFailure(scope)) {
            error(
              503,
              'Published resume PDF recovery is temporarily unavailable.',
            );
          }
          const published =
            await generateAndPublishCanonicalResumeAssetWithPdfUnlocked({
              filesystem,
              generation: {
                failureNote: PUBLIC_RESUME_RECOVERY_FAILURE_NOTE,
                sourcePath: PUBLIC_RESUME_RECOVERY_SOURCE_PATH,
              },
              publicationFailureNote:
                PUBLIC_RESUME_RECOVERY_PUBLICATION_FAILURE_NOTE,
            });
          transientPublicResumeRecoveryFailures.delete(scope);
          return { asset: published.asset, pdf: published.pdf };
        } catch (cause) {
          let failureWasPersisted = false;
          try {
            failureWasPersisted =
              await hasRecentPublicResumeRecoveryFailure(scope);
          } catch {
            // A failed status check must not replace the recovery error.
          }
          if (!failureWasPersisted) {
            // Source, tailoring, and collection failures can happen before a
            // ResumeAsset exists to record the attempt. Keep a scoped,
            // short-lived guard in that case so a public outage does not create
            // a retry queue.
            rememberTransientPublicResumeRecoveryFailure(scope);
          }
          throw cause;
        }
      },
      {
        lockTimeout: PUBLIC_RESUME_RECOVERY_LOCK_TIMEOUT,
      },
    );
  } catch (cause) {
    if (!recoveryCallbackStarted) {
      // A database or advisory-lock failure occurs before the callback can know
      // its database scope. A process-local fallback prevents that outage from
      // becoming a retry queue until a stored PDF becomes available again.
      rememberTransientPublicResumeRecoveryFailure(
        PUBLIC_RESUME_RECOVERY_FALLBACK_SCOPE,
      );
    }
    throw cause;
  }

  const recovered = recovery.asset;
  if (!recovered) {
    if (recovery.pdf) {
      transientPublicResumeRecoveryFailures.delete(
        PUBLIC_RESUME_RECOVERY_FALLBACK_SCOPE,
      );
      return recovery.pdf;
    }
    error(503, 'Published resume PDF could not be generated.');
  }

  // Complete this while the request context is still active. A background task
  // could outlive an RLS transaction and leave default applications linked to
  // the previous asset. The PDF itself remains deliverable if this secondary
  // application-link update cannot be completed.
  try {
    await updateDefaultResumeApplicationsForCanonicalAsset(
      stringValue(recovered.id),
    );
  } catch (cause) {
    console.warn(
      'Published resume recovered, but default application links could not be refreshed.',
      cause,
    );
  }

  if (recovery.pdf) {
    transientPublicResumeRecoveryFailures.delete(
      PUBLIC_RESUME_RECOVERY_FALLBACK_SCOPE,
    );
    return recovery.pdf;
  }
  error(503, 'Published resume PDF could not be generated.');
}
