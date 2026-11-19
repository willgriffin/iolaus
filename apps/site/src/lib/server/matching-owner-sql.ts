/** Live row status is an additional gate after native request identity verification. */
export function liveMatchingOwnerSql(profileAlias: string): string {
  return `EXISTS (
    SELECT 1 FROM memberships mm
    JOIN users mu ON mu.id = mm.user_id AND mu.status = 'active'
    JOIN tenants mt ON mt.id = mm.tenant_id AND mt.status = 'active'
    WHERE mm.tenant_id = ${profileAlias}.tenant_id
      AND CAST(mm.user_id AS TEXT) = ${profileAlias}.owner_user_id
      AND mm.status = 'active' AND mm.role_id IS NOT NULL
  )`;
}
