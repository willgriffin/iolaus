import { error } from '@sveltejs/kit';
import {
  PROFILE_LINK_PROVIDERS,
  providerForLink,
} from '$lib/profile-link-catalog';
import { isOwnerAuthorityDenial, runAsOwner } from './owner-principal.js';
import {
  createPrivateRecord,
  getPrivateRecord,
  listPrivateRecords,
  requireWorkspaceSubject,
} from './private-workspace.js';
import { invalidatePublishedResumeCache } from './resume-data.js';
import {
  requireCandidateWorkspaceSubject,
  withVerifiedWorkspaceSubject,
  workspaceSubjectFromLocals,
} from './workspace-subject.js';
import { workspaceWorkflowOperation } from './workspace-workflow-capabilities.js';

function subjectFor(locals: App.Locals) {
  return requireWorkspaceSubject(
    requireCandidateWorkspaceSubject(workspaceSubjectFromLocals(locals)),
  );
}
function safeUrl(value: unknown) {
  const href = typeof value === 'string' ? value.trim() : '';
  if (!href) return '';
  try {
    const url = new URL(href);
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username ||
      url.password
    )
      throw new Error();
    return href;
  } catch {
    error(400, 'Use an HTTP or HTTPS link.');
  }
}
export async function loadProfileLinkEditor(locals: App.Locals) {
  const subject = subjectFor(locals);
  const profile = await getPrivateRecord(
    'CandidateProfile',
    subject.profileId,
    subject,
  );
  if (profile?.active !== true)
    error(403, 'Active candidate profile required.');
  const links = await listPrivateRecords('CandidateProfileLink', subject, {
    limit: 1000,
    orderBy: 'id ASC',
  });
  const claimed = new Set<string>();
  const providers = PROFILE_LINK_PROVIDERS.map((provider) => {
    const link = links.find(
      (row) =>
        !claimed.has(String(row.id)) &&
        providerForLink(row)?.id === provider.id,
    );
    if (link) claimed.add(String(link.id));
    return {
      ...provider,
      link: link
        ? {
            id: String(link.id),
            href: typeof link.href === 'string' ? link.href : '',
            label: typeof link.label === 'string' ? link.label : '',
            useOnResume: link.useOnResume !== false,
          }
        : null,
    };
  });
  return {
    providers,
    customLinks: links
      .filter((row) => !claimed.has(String(row.id)))
      .map((row) => ({
        id: String(row.id),
        href: typeof row.href === 'string' ? row.href : '',
        label: typeof row.label === 'string' ? row.label : '',
        useOnResume: row.useOnResume !== false,
      })),
  };
}
export async function saveProfileLink(locals: App.Locals, form: FormData) {
  const subject = subjectFor(locals);
  const providerId = String(form.get('provider') ?? '');
  const provider = PROFILE_LINK_PROVIDERS.find(
    (item) => item.id === providerId,
  );
  const custom = providerId === 'custom';
  const id = String(form.get('id') ?? '').trim();
  const href = safeUrl(form.get('href'));
  const label = custom
    ? String(form.get('label') ?? '').trim()
    : provider?.label;
  if (
    (!provider && !custom) ||
    !label ||
    label.length > 160 ||
    href.length > 2000
  )
    error(400, 'Invalid profile link.');
  if (!id && !href) return { ok: true, message: 'Nothing to save.' };
  if (!href) error(400, 'Enter a link before saving.');
  if (provider?.hosts) {
    const hostname = new URL(href).hostname.toLowerCase();
    if (!provider.hosts.includes(hostname))
      error(400, `Use a ${provider.label} link for this card.`);
  }
  const operation = workspaceWorkflowOperation('profile.manage');
  try {
    return await runAsOwner(
      locals,
      async (run) => {
        await run.assertOperation(operation.collection, operation.action);
        return await withVerifiedWorkspaceSubject(subject, async (verified) => {
          const owned = requireWorkspaceSubject(verified);
          const profile = await getPrivateRecord(
            'CandidateProfile',
            owned.profileId,
            owned,
          );
          if (profile?.active !== true)
            error(403, 'Active candidate profile required.');
          return await runAsOwner(
            locals,
            async (write) => {
              await write.assertOperation(
                operation.collection,
                operation.action,
              );
              return await withVerifiedWorkspaceSubject(
                owned,
                async (current) => {
                  const active = requireWorkspaceSubject(current);
                  const currentProfile = await getPrivateRecord(
                    'CandidateProfile',
                    active.profileId,
                    active,
                  );
                  if (currentProfile?.active !== true)
                    error(403, 'Active candidate profile required.');
                  if (id) {
                    const record = await getPrivateRecord(
                      'CandidateProfileLink',
                      id,
                      active,
                    );
                    if (!record || typeof record.save !== 'function')
                      error(404, 'Profile link not found.');
                    record.href = href;
                    if (custom) record.label = label;
                    await record.save();
                  } else {
                    const rows = await listPrivateRecords(
                      'CandidateProfileLink',
                      active,
                      { limit: 1000 },
                    );
                    await createPrivateRecord('CandidateProfileLink', active, {
                      profileKey:
                        typeof currentProfile.profileKey === 'string'
                          ? currentProfile.profileKey
                          : 'default',
                      label,
                      href,
                      sortOrder: rows.length,
                      useOnResume: true,
                    });
                  }
                  invalidatePublishedResumeCache();
                  return { ok: true, message: 'Profile link saved.' };
                },
              );
            },
            { action: 'admin.profile-links.write' },
          );
        });
      },
      { action: 'admin.profile-links.manage' },
    );
  } catch (cause) {
    if (isOwnerAuthorityDenial(cause)) error(403, 'Forbidden');
    throw cause;
  }
}
