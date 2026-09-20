import { createHash } from 'node:crypto';

const ROOTS = Object.freeze([
  'profiles',
  'users',
  'memberships',
  'oidc_profile_email_reservations',
]);
const SHA256_HEX = /^[a-f0-9]{64}$/u;

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function one(rows, name) {
  if (!Array.isArray(rows) || rows.length !== 1) {
    throw new Error(`Preservation preflight requires exactly one ${name} row.`);
  }
  return rows[0];
}

function selector(row, fields) {
  return fields.map((field) => String(row[field] ?? '')).join('\u0000');
}

function resolveParent(source, target, table, fields, label) {
  const sourceRow = one(source[table], `source ${label}`);
  const matches = (target[table] ?? []).filter(
    (candidate) => selector(candidate, fields) === selector(sourceRow, fields),
  );
  if (matches.length !== 1) {
    throw new Error(
      `Preservation preflight could not resolve exactly one target ${label}.`,
    );
  }
  return { source: sourceRow, target: matches[0] };
}

function targetDisposition(targetRows, candidate, label) {
  const matches = (targetRows ?? []).filter((row) =>
    row.id === candidate.id ||
    (typeof candidate.email_key === 'string' &&
      candidate.email_key !== '' &&
      row.email_key === candidate.email_key),
  );
  if (matches.length === 0) return 'insert';
  if (matches.length !== 1 || matches[0].id !== candidate.id) throw new Error(`Preservation preflight found an identity conflict for ${label}.`);
  const candidateKeys = Object.keys(candidate);
  const matchedComparable = Object.fromEntries(
    candidateKeys.map((key) => [key, matches[0]?.[key]]),
  );
  if (
    matches.length !== 1 ||
    digest(matchedComparable) !== digest(candidate)
  ) {
    throw new Error(`Preservation preflight found a no-overwrite conflict for ${label}.`);
  }
  return 'noop';
}

/**
 * Build the only target-only business-state transfer permitted for #33.
 * Inputs are deliberately supplied by a protected snapshot reader; the result
 * contains hashes and dispositions only, never row values or object paths.
 */
function buildPreservation(source, target) {
  const user = one(source.users, 'source user');
  const profile = one(source.profiles, 'source profile');
  const membership = one(source.memberships, 'source membership');
  const reservation = one(source.oidc_profile_email_reservations, 'source OIDC reservation');
  if (user.profile_id !== profile.id || membership.user_id !== user.id || reservation.profile_id !== profile.id) {
    throw new Error('Preservation preflight found an invalid owner closure.');
  }

  const tenant = resolveParent(source, target, 'tenants', ['slug', 'context'], 'tenant');
  const role = resolveParent(source, target, 'roles', ['slug', 'context'], 'role');
  const profileType = resolveParent(source, target, 'profile_types', ['slug', 'context'], 'profile type');
  if (membership.tenant_id !== tenant.source.id || (profile.tenant_id !== null && profile.tenant_id !== tenant.source.id) || membership.role_id !== role.source.id || profile.type_id !== profileType.source.id) {
    throw new Error('Preservation preflight found a root that does not bind its semantic parents.');
  }

  const remapped = {
    users: { ...user },
    profiles: { ...profile, tenant_id: profile.tenant_id === null ? null : tenant.target.id, type_id: profileType.target.id },
    memberships: { ...membership, tenant_id: tenant.target.id, role_id: role.target.id },
    oidc_profile_email_reservations: { ...reservation },
  };
  const dispositions = Object.fromEntries(
    ROOTS.map((table) => [table, targetDisposition(target[table], remapped[table], table)]),
  );
  return { remapped, dispositions, tenant, role, profileType };
}

export function planFinalCutoverPreservation(source, target) {
  const { remapped, dispositions, tenant, role, profileType } = buildPreservation(
    source,
    target,
  );
  return {
    schema: 'iolaus/final-cutover-preservation-preflight:v1',
    dispositions,
    closureCounts: Object.fromEntries(ROOTS.map((table) => [table, 1])),
    parentCounts: { tenants: 1, roles: 1, profile_types: 1 },
    sessionsCopied: false,
    sessionRowsObserved: Array.isArray(source.sessions) ? source.sessions.length : 0,
    transferDigest: digest({
      roots: ROOTS.map((table) => [table, digest(remapped[table])]),
      parents: [tenant.target.id, role.target.id, profileType.target.id].length,
    }),
  };
}

/**
 * Apply only preflight-approved absent rows. The caller supplies a transaction
 * scoped database adapter; values never appear in the returned receipt.
 */
export async function applyFinalCutoverPreservation(database, source, target) {
  if (typeof database.transaction !== 'function') throw new Error('Preservation application requires a transaction-scoped database adapter.');
  const { remapped, dispositions } = buildPreservation(source, target);
  const inserted = [];
  await database.transaction(async (transaction) => { for (const table of ROOTS) {
    if (dispositions[table] === 'noop') continue;
    const row = remapped[table]; const columns = Object.keys(row);
    await transaction.query(
      `INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`,
      columns.map((column) => row[column]),
    );
    inserted.push(table);
  }});
  return {
    insertedCounts: Object.fromEntries(ROOTS.map((table) => [table, Number(inserted.includes(table))])),
    noopCounts: Object.fromEntries(ROOTS.map((table) => [table, Number(dispositions[table] === 'noop')])),
    sessionsCopied: false,
  };
}

export function planExtraAsset(sourceAsset, targetAsset) {
  if (!sourceAsset || !SHA256_HEX.test(sourceAsset.sha256)) {
    throw new Error('Preservation preflight requires a protected extra-asset receipt.');
  }
  if (targetAsset === null || targetAsset === undefined) {
    return { disposition: 'copy', sha256: sourceAsset.sha256 };
  }
  if (!SHA256_HEX.test(targetAsset.sha256)) {
    throw new Error('Preservation preflight requires a protected extra-asset receipt.');
  }
  if (targetAsset.sha256 !== sourceAsset.sha256) {
    throw new Error('Preservation preflight found a no-overwrite asset conflict.');
  }
  return { disposition: 'noop', sha256: sourceAsset.sha256 };
}

/** Manifest entries are read by the existing files operator and retained in a
 * protected artifact. This receipt intentionally reports no object names. */
export function planSourceAssetParity(sourceManifest, targetManifest) {
  if (!Array.isArray(sourceManifest) || !sourceManifest.length || !Array.isArray(targetManifest) || !targetManifest.length) throw new Error('Source asset parity requires non-empty validated manifests.');
  for (const manifest of [sourceManifest, targetManifest]) { const keys = new Set(); for (const entry of manifest) { if (!entry || typeof entry.key !== 'string' || !entry.key || !SHA256_HEX.test(entry.sha256) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0 || keys.has(entry.key)) throw new Error('Source asset parity manifest is invalid.'); keys.add(entry.key); } }
  const targetByKey = new Map((targetManifest ?? []).map((entry) => [entry.key, entry]));
  const missing = [];
  const changed = [];
  for (const source of sourceManifest ?? []) {
    const target = targetByKey.get(source.key);
    if (!target) missing.push(source);
    else if (target.sha256 !== source.sha256 || target.bytes !== source.bytes) changed.push(source);
  }
  if (missing.length || changed.length) {
    throw new Error('Source asset parity is incomplete; do not reuse the target bucket.');
  }
  const sourceKeys = new Set((sourceManifest ?? []).map((entry) => entry.key));
  const extra = (targetManifest ?? []).filter((entry) => !sourceKeys.has(entry.key));
  return {
    sourceObjectCount: (sourceManifest ?? []).length,
    targetObjectCount: (targetManifest ?? []).length,
    targetOnlyObjectCount: extra.length,
    sourceBytes: (sourceManifest ?? []).reduce((sum, entry) => sum + entry.bytes, 0),
    reuseTargetBucket: true,
    sourceManifestDigest: digest(
      sourceManifest.map((entry) => [entry.key, entry.sha256, entry.bytes]).sort(),
    ),
  };
}
