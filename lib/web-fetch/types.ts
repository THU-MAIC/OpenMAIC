import type { FetchUrlOptions, ExtractedWebPage } from './builtin-extraction';

export interface WebFetchCredentials {
  apiKey?: string;
  baseUrl?: string;
  proxy?: string;
  options?: Record<string, string | number | boolean>;
}

export interface WebFetchResult {
  title?: string;
  markdown: string;
  finalUrl?: string;
  contentType?: string;
}

/** Metadata is client-safe; adapters load server transports only when called. */
export interface WebFetchMetadata {
  id: string;
  name: string;
  nameKey?: string;
  icon?: string;
  requiresApiKey: boolean;
  defaultBaseUrl?: string;
  /** Share an existing preset's credentials instead of creating a separate service. */
  credentialPresets?: readonly string[];
  acceptsWorkspaceBaseUrl?: (baseUrl: string) => boolean;
  resolveCredentials: (credentials?: WebFetchCredentials) => WebFetchCredentials;
}

type ExtractOptions = FetchUrlOptions & { credentials?: WebFetchCredentials };
export type WebFetchProvider = WebFetchMetadata &
  (
    | {
        hosted: false;
        extract: (url: string, options: ExtractOptions) => Promise<ExtractedWebPage>;
      }
    | { hosted: true; extract: (url: string, options: ExtractOptions) => Promise<WebFetchResult> }
  );

/** Display-only data sent by the settings API. */
export interface WebFetchProviderInfo {
  id: string;
  name: string;
  nameKey?: string;
  icon?: string;
  requiresApiKey: boolean;
  credentialPresets?: readonly string[];
}
