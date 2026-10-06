/** Explicit local opt-in; the server must also enforce this at every chat endpoint. */
export function isAdminAssistantEnabled(
  environment: Record<string, string | undefined> = process.env,
): boolean {
  return environment.IOLAUS_ASSISTANT_ENABLED?.trim().toLowerCase() === 'true';
}
