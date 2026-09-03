declare module '@happyvertical/smrt-virt-web' {
  import type {
    SmrtWebCollectionDefinition,
    WebMcpRegistrationDefinition,
  } from '@happyvertical/smrt-web';

  export interface SmrtWebCollectionDefinitions {
    applications: SmrtWebCollectionDefinition<Record<string, unknown>>;
    opportunities: SmrtWebCollectionDefinition<Record<string, unknown>>;
    tasks: SmrtWebCollectionDefinition<Record<string, unknown>>;
  }

  export const collectionDefinitions: SmrtWebCollectionDefinitions;
  /** Generated browser-native tools for API-exposed model actions. */
  export const webMcpToolDefinitions: readonly WebMcpRegistrationDefinition[];
  export function getCollectionDefinition<
    K extends keyof SmrtWebCollectionDefinitions,
  >(name: K): SmrtWebCollectionDefinitions[K];
  export const manifestHash: string;
  export default collectionDefinitions;
}
