declare module '@happyvertical/smrt-virt-web' {
  import type {
    SmrtWebCollectionDefinition,
    WebMcpRegistrationDefinition,
  } from '@happyvertical/smrt-web';

  // The generated public registry excludes private admin models. Their curated
  // UI collection metadata lives in admin-resource-definitions.ts instead.
  export interface SmrtWebCollectionDefinitions {
    [name: string]: SmrtWebCollectionDefinition<Record<string, unknown>>;
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
