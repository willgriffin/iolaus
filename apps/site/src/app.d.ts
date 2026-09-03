import type { SessionLocals } from '@happyvertical/smrt-users/sveltekit';

declare global {
  namespace App {
    // interface Error {}
    interface Locals extends SessionLocals {}
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
