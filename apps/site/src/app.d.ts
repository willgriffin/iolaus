import type { SessionLocals } from '@happyvertical/smrt-users/sveltekit';
import type { WorkspaceSubject } from '$lib/server/workspace-subject';

declare global {
  namespace App {
    // interface Error {}
    interface Locals extends SessionLocals {
      /** Set only by the server hook after live membership verification. */
      workspaceSubject?: WorkspaceSubject;
      /** Set when a shared-mode session's operator invitation is missing/revoked. */
      invitationRequired?: boolean;
    }
    // interface PageData {}
    // interface PageState {}
    // interface Platform {}
  }

  interface Window {
    LanguageModel?: {
      availability?: () => Promise<string>;
      create: (opts: {
        initialPrompts?: Array<{ role: string; content: string }>;
      }) => Promise<AISession>;
    };
    ai?: {
      languageModel?: AILegacyNamespace;
      assistant?: AILegacyNamespace;
    };
  }

  interface AILegacyNamespace {
    capabilities?: () => Promise<{ available: string }>;
    create: (opts: { systemPrompt: string }) => Promise<AISession>;
  }

  interface AISession {
    prompt: (text: string) => Promise<string>;
    promptStreaming?: (text: string) => AsyncIterable<string>;
  }
}
