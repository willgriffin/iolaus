export interface DbMigrateOptions {
  maintenanceWindow: boolean;
}

/**
 * The atomic native migration mode is intentionally opt-in. Reject every
 * other argument so an operator cannot mistake an ignored flag for approval
 * to run DDL while serving traffic.
 */
export function parseDbMigrateOptions(
  args: readonly string[],
): DbMigrateOptions {
  let maintenanceWindow = false;
  for (const argument of args) {
    if (argument === '--') continue;
    if (argument === '--maintenance-window') {
      maintenanceWindow = true;
      continue;
    }
    throw new Error(
      `Unknown db:migrate argument ${JSON.stringify(
        argument,
      )}. Only --maintenance-window is supported.`,
    );
  }
  return { maintenanceWindow };
}
